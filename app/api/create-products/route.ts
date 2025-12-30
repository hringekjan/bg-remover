/**
 * Product Auto-Creation Endpoint
 *
 * POST /bg-remover/create-products
 *
 * Processes image groups, removes backgrounds, uploads to S3,
 * and creates products in carousel-api in one atomic operation.
 *
 * This endpoint connects the existing BulkUploadWizard UI to product creation.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import {
  processImageFromUrl,
  processImageFromBase64,
  createProcessResult,
} from '@/lib/bedrock/image-processor';
import { uploadProcessedImage, generateOutputKey, getOutputBucket } from '@/lib/s3/client';
import { createProductInCarouselApi, batchCreateProducts, CreateProductRequest } from '@/lib/carousel-api/client';
import { BatchResult, ProductCreationResult, setJobStatus } from '@/lib/dynamo/job-store';
import { validateJWTFromEvent } from '@/src/lib/auth/jwt-validator';
import { resolveTenantFromRequest } from '@/src/lib/tenant/resolver';
import { validateAndDebitCredits, refundCredits } from '@/src/lib/credits/client';

/**
 * Request validation schema
 */
const ImageInputSchema = z.object({
  url: z.string().url().optional(),
  base64: z.string().optional(),
}).refine(data => data.url || data.base64, {
  message: 'Either url or base64 must be provided',
});

const ProductGroupSchema = z.object({
  productId: z.string().optional(), // Optional group identifier
  images: z.array(ImageInputSchema).min(1).max(20),
  metadata: z.object({
    title: z.string().min(1).max(200),
    description: z.string().max(5000).optional(),
    price: z.number().min(0).max(1000000).optional(),
    category: z.string().max(100).optional(),
    location: z.string().max(200).optional(),
  }),
});

const CreateProductsRequestSchema = z.object({
  productGroups: z.array(ProductGroupSchema).min(1).max(50),
  options: z.object({
    outputFormat: z.enum(['webp', 'png', 'jpeg']).default('webp'),
    quality: z.number().min(1).max(100).default(90),
    removeBackground: z.boolean().default(true),
    generateDescription: z.boolean().default(false),
    languages: z.array(z.string()).default(['en']),
  }).optional(),
});

type CreateProductsRequest = z.infer<typeof CreateProductsRequestSchema>;

/**
 * Response format
 */
interface CreateProductsResponse {
  jobId: string;
  status: 'pending' | 'processing' | 'completed' | 'partial' | 'failed';
  totalGroups: number;
  products: Array<{
    productId?: string;
    carouselApiProductId?: string;
    status: 'pending' | 'created' | 'failed';
    error?: string;
    imageCount: number;
  }>;
  processingTimeMs?: number;
}

/**
 * Process a single image: bg removal + upload to S3
 */
async function processAndUploadImage(
  imageInput: { url?: string; base64?: string },
  tenant: string,
  productGroupId: string,
  outputFormat: 'webp' | 'png' | 'jpeg',
  quality: number,
  removeBackground: boolean
): Promise<{ s3Url?: string; error?: string }> {
  const startTime = Date.now();

  try {
    // Process image (these functions throw on error)
    let result: { outputBuffer: Buffer; metadata: any };

    if (imageInput.url) {
      result = await processImageFromUrl(imageInput.url, {
        format: outputFormat,
        quality,
      });
    } else if (imageInput.base64) {
      result = await processImageFromBase64(imageInput.base64, 'image/png', {
        format: outputFormat,
        quality,
      });
    } else {
      return { error: 'No image URL or base64 provided' };
    }

    // Upload to S3
    const outputKey = generateOutputKey(tenant, productGroupId, outputFormat);
    const contentType = outputFormat === 'png' ? 'image/png' :
                       outputFormat === 'webp' ? 'image/webp' : 'image/jpeg';

    const outputBucket = await getOutputBucket(tenant);

    const s3Url = await uploadProcessedImage(
      outputBucket,
      outputKey,
      result.outputBuffer,
      contentType,
      {
        'product-group-id': productGroupId,
        'tenant': tenant,
        'original-url': imageInput.url || 'base64-upload',
      }
    );

    return { s3Url };

  } catch (error) {
    console.error('Image processing failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Process a product group: process images → upload to S3 → create product
 */
async function processProductGroup(
  group: z.infer<typeof ProductGroupSchema>,
  tenant: string,
  userId: string,
  options: NonNullable<CreateProductsRequest['options']>,
  index: number,
  timeoutMs?: number
): Promise<ProductCreationResult> {
  const productGroupId = group.productId || `group-${index}-${randomUUID().substring(0, 8)}`;
  const startTime = Date.now();

  console.log('Processing product group', {
    productGroupId,
    imageCount: group.images.length,
    title: group.metadata.title,
    timeoutMs,
  });

  try {
    // Step 1: Process all images in parallel with timeout protection
    const processingPromise = Promise.all(
      group.images.map(img =>
        processAndUploadImage(
          img,
          tenant,
          productGroupId,
          options.outputFormat,
          options.quality,
          options.removeBackground
        )
      )
    );

    // Apply timeout if specified
    let imageProcessingResults;
    if (timeoutMs && timeoutMs > 0) {
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Group processing timeout')), timeoutMs)
      );
      imageProcessingResults = await Promise.race([processingPromise, timeoutPromise]);
    } else {
      imageProcessingResults = await processingPromise;
    }

    // Check for processing failures
    const failedImages = imageProcessingResults.filter(r => r.error);
    if (failedImages.length === group.images.length) {
      // All images failed
      return {
        productId: productGroupId,
        status: 'failed',
        error: `All ${group.images.length} images failed processing`,
        imageCount: 0,
        metadata: {
          title: group.metadata.title,
          category: group.metadata.category,
        },
      };
    }

    // Get successful S3 URLs
    const s3Urls = imageProcessingResults
      .filter(r => r.s3Url)
      .map(r => r.s3Url!);

    const processingTime = Date.now() - startTime;
    console.log('Images processed successfully', {
      productGroupId,
      successfulImages: s3Urls.length,
      failedImages: failedImages.length,
      processingTimeMs: processingTime,
      memoryUsed: process.memoryUsage().heapUsed / 1024 / 1024, // MB
    });

    // Step 2: Create product in carousel-api
    const productData: CreateProductRequest = {
      title: group.metadata.title,
      description: group.metadata.description,
      price: group.metadata.price,
      category: group.metadata.category,
      location: group.metadata.location,
      images: s3Urls,
    };

    const { product, error } = await createProductInCarouselApi(
      tenant,
      userId,
      productData
    );

    if (error || !product) {
      return {
        productId: productGroupId,
        status: 'failed',
        error: error || 'Product creation failed',
        imageCount: s3Urls.length,
        metadata: {
          title: group.metadata.title,
          category: group.metadata.category,
        },
      };
    }

    console.log('Product created successfully', {
      productGroupId,
      carouselApiProductId: product.id,
      imageCount: s3Urls.length,
    });

    return {
      productId: productGroupId,
      carouselApiProductId: product.id,
      status: 'created',
      imageCount: s3Urls.length,
      metadata: {
        title: product.title,
        category: product.category,
      },
    };

  } catch (error) {
    const isTimeout = error instanceof Error && error.message.includes('timeout');

    console.error('Product group processing failed', {
      productGroupId,
      error: error instanceof Error ? error.message : String(error),
      isTimeout,
      processingTimeMs: Date.now() - startTime,
      memoryUsed: process.memoryUsage().heapUsed / 1024 / 1024, // MB
    });

    return {
      productId: productGroupId,
      status: 'failed',
      error: error instanceof Error ? error.message : 'Unknown error',
      imageCount: 0,
      metadata: {
        title: group.metadata.title,
        category: group.metadata.category,
      },
    };
  }
}

/**
 * Process array of items in batches with concurrency control
 *
 * @param items - Array of items to process
 * @param batchSize - Max concurrent operations (default: 5)
 * @param processor - Async function to process each item
 * @returns Array of results in same order as input
 */
async function processBatches<T, R>(
  items: T[],
  batchSize: number,
  processor: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];

  // Process in batches to control concurrency
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map((item, batchIndex) => processor(item, i + batchIndex))
    );
    results.push(...batchResults);

    // Log batch completion
    console.log('Batch completed', {
      batchNumber: Math.floor(i / batchSize) + 1,
      totalBatches: Math.ceil(items.length / batchSize),
      processedItems: Math.min(i + batchSize, items.length),
      totalItems: items.length,
    });

    // Explicit memory cleanup hint between batches
    if (global.gc && i + batchSize < items.length) {
      global.gc();
    }
  }

  return results;
}

/**
 * Calculate per-group timeout with minimum threshold enforcement
 *
 * @param totalGroups - Total number of product groups to process
 * @param lambdaTimeout - Lambda function timeout in seconds (default: 300s)
 * @returns Timeout in milliseconds per group (enforcing 15s minimum)
 */
const calculatePerGroupTimeout = (totalGroups: number, lambdaTimeout: number): number => {
  const SAFETY_BUFFER_MS = 30000;
  const MIN_GROUP_TIMEOUT_MS = 15000; // Minimum 15s per group

  const remainingTime = (lambdaTimeout * 1000) - SAFETY_BUFFER_MS;
  const perGroupTimeout = Math.floor(remainingTime / totalGroups);

  // Enforce minimum timeout
  const finalTimeout = Math.max(perGroupTimeout, MIN_GROUP_TIMEOUT_MS);

  console.log('Timeout calculation', {
    totalGroups,
    lambdaTimeoutSec: lambdaTimeout,
    safetyBufferMs: SAFETY_BUFFER_MS,
    remainingTimeMs: remainingTime,
    calculatedPerGroupMs: perGroupTimeout,
    finalPerGroupMs: finalTimeout,
    enforced: finalTimeout !== perGroupTimeout,
  });

  return finalTimeout;
};

/**
 * POST /bg-remover/create-products
 *
 * Main endpoint handler
 */
export async function POST(request: NextRequest) {
  const startTime = Date.now();
  const jobId = randomUUID();
  let creditTransactionId: string | undefined;
  let totalImages = 0;

  try {
    // ===== JWT AUTHENTICATION =====
    const stage = process.env.STAGE || 'dev';
    const requireAuth = stage === 'prod' || process.env.REQUIRE_AUTH === 'true';

    // Convert NextRequest headers to Lambda-compatible format
    const authHeaders = {
      authorization: request.headers.get('authorization') || '',
    };

    const authResult = await validateJWTFromEvent({ headers: authHeaders }, undefined, {
      required: requireAuth
    });

    if (!authResult.isValid && requireAuth) {
      console.warn('Authentication failed for create-products endpoint', {
        error: authResult.error,
        stage,
      });

      return NextResponse.json({
        error: 'Unauthorized',
        message: 'Valid JWT token required'
      }, {
        status: 401,
        headers: {
          'WWW-Authenticate': 'Bearer realm="bg-remover", error="invalid_token"'
        }
      });
    }

    // Extract tenant and user from authenticated context
    const requestedTenant = request.headers.get('x-tenant-id') || 'carousel-labs';
    const userId = authResult.userId || 'system';

    // ===== TENANT AUTHORIZATION - PREVENT CROSS-TENANT ACCESS =====
    // Extract tenant from JWT claims (matches carousel-api pattern)
    let userTenantId: string | undefined;
    if (authResult.isValid && authResult.payload) {
      const claims = authResult.payload;
      userTenantId = (claims['custom:tenant'] as string) ||
        (authResult.groups?.find(g => g.startsWith('tenant:'))?.replace('tenant:', '')) ||
        undefined;
    }

    // Verify user belongs to requested tenant
    if (userTenantId && userTenantId !== requestedTenant) {
      console.error('SECURITY: Tenant authorization failed - cross-tenant access attempt blocked', {
        userTenantId,
        requestedTenant,
        userId,
        userEmail: authResult.payload?.['email'],
        timestamp: new Date().toISOString(),
        authorizationResult: 'DENIED',
        severity: 'CRITICAL',
        jobId,
      });

      return NextResponse.json({
        error: 'Forbidden',
        message: 'Access denied: You do not have permission to create products for this tenant',
      }, { status: 403 });
    }

    // Log successful authorization
    console.log('Authorization successful - tenant access granted', {
      userId,
      userEmail: authResult.payload?.['email'],
      userTenantId: userTenantId || 'not-in-jwt',
      requestedTenant,
      timestamp: new Date().toISOString(),
      authorizationResult: 'ALLOWED',
      jobId,
    });

    const tenant = requestedTenant;

    console.log('Create products request', {
      tenant,
      userId,
      authenticated: authResult.isValid,
      jobId,
    });

    // Parse and validate request body
    const body = await request.json();
    const validatedRequest = CreateProductsRequestSchema.parse(body);

    const options = validatedRequest.options || {
      outputFormat: 'webp' as const,
      quality: 90,
      removeBackground: true,
      generateDescription: false,
      languages: ['en'],
    };

    totalImages = validatedRequest.productGroups.reduce((sum, g) => sum + g.images.length, 0);
    const totalGroups = validatedRequest.productGroups.length;

    // ===== CREDITS VALIDATION AND DEDUCTION =====
    const creditsRequired = stage === 'prod' || process.env.REQUIRE_CREDITS === 'true';

    if (creditsRequired && authResult.isValid && authResult.userId) {
      console.info('Validating and debiting credits', {
        jobId,
        tenant,
        userId: authResult.userId,
        totalImages,
        totalGroups,
      });

      const creditResult = await validateAndDebitCredits(
        tenant,
        authResult.userId,
        totalImages, // 1 credit per image across all groups
        jobId,
        undefined // No single productId for multi-product batch
      );

      if (!creditResult.success) {
        console.warn('Insufficient credits for create-products', {
          jobId,
          tenant,
          userId: authResult.userId,
          totalImages,
          error: creditResult.error,
          errorCode: creditResult.errorCode,
        });

        return NextResponse.json({
          error: 'Insufficient credits',
          message: creditResult.error || 'Not enough credits to process images',
          requiredCredits: totalImages,
          errorCode: creditResult.errorCode,
          jobId,
        }, { status: 402 }); // 402 Payment Required
      }

      creditTransactionId = creditResult.transactionId;

      console.info('Credits debited successfully', {
        jobId,
        tenant,
        userId: authResult.userId,
        creditsUsed: creditResult.creditsUsed,
        newBalance: creditResult.newBalance,
        transactionId: creditResult.transactionId,
      });
    }
    // ===== END CREDITS VALIDATION =====

    // Persist job to DynamoDB
    await setJobStatus(jobId, {
      jobId,
      status: 'processing',
      tenant,
      userId,
      totalGroups: validatedRequest.productGroups.length,
      totalImages,
      createdAt: new Date().toISOString(),
      metadata: {
        stage: process.env.STAGE || 'dev',
        requireAuth,
        creditsRequired,
      },
    });

    console.log('Job persisted to DynamoDB', { jobId, status: 'processing' });

    // Calculate per-group timeout to stay within Lambda's 300s limit
    const LAMBDA_TIMEOUT_SEC = 300; // 300 seconds (5 minutes)
    const perGroupTimeoutMs = calculatePerGroupTimeout(totalGroups, LAMBDA_TIMEOUT_SEC);

    console.log('Processing product groups', {
      jobId,
      groupCount: totalGroups,
      totalImages,
      perGroupTimeoutMs,
      estimatedTotalTimeMs: perGroupTimeoutMs * totalGroups,
    });

    // Log timeout warning if likely to fail
    if (perGroupTimeoutMs < 10000) {
      console.warn('Low per-group timeout - risk of timeouts', {
        perGroupTimeoutMs,
        totalGroups,
        recommendation: 'Consider reducing batch size or using async processing',
      });
    }

    // Process product groups in parallel batches
    // Max 5 groups at a time to prevent memory issues (3008MB limit)
    const CONCURRENCY_LIMIT = 5;

    const results = await processBatches(
      validatedRequest.productGroups,
      CONCURRENCY_LIMIT,
      (group, index) => processProductGroup(
        group,
        tenant,
        userId,
        options,
        index,
        perGroupTimeoutMs
      )
    );

    // Calculate summary stats
    const successfulProducts = results.filter(r => r.status === 'created').length;
    const failedProducts = results.filter(r => r.status === 'failed').length;

    // Calculate successful and failed image counts for refund logic
    const successfulImageCount = results
      .filter(r => r.status === 'created')
      .reduce((sum, r) => sum + r.imageCount, 0);
    const failedImageCount = totalImages - successfulImageCount;

    const processingTimeMs = Date.now() - startTime;

    // Determine overall status
    let status: 'completed' | 'partial' | 'failed';
    if (successfulProducts === validatedRequest.productGroups.length) {
      status = 'completed';
    } else if (successfulProducts > 0) {
      status = 'partial';
    } else {
      status = 'failed';
    }

    // ===== CREDITS REFUND FOR FAILED IMAGES =====
    if (creditsRequired && creditTransactionId && failedImageCount > 0 && authResult.userId) {
      console.info('Refunding credits for failed images', {
        jobId,
        tenant,
        userId: authResult.userId,
        failedImageCount,
        successfulImageCount,
        transactionId: creditTransactionId,
      });

      const refundResult = await refundCredits(
        tenant,
        authResult.userId,
        failedImageCount, // Refund 1 credit per failed image
        jobId,
        creditTransactionId
      );

      if (refundResult.success) {
        console.info('Credits refunded successfully', {
          jobId,
          tenant,
          userId: authResult.userId,
          refundedCredits: failedImageCount,
          newBalance: refundResult.newBalance,
          refundTransactionId: refundResult.transactionId,
        });
      } else {
        console.error('Failed to refund credits', {
          jobId,
          tenant,
          userId: authResult.userId,
          failedImageCount,
          error: refundResult.error,
          errorCode: refundResult.errorCode,
        });
      }
    }
    // ===== END CREDITS REFUND =====

    // Update job status in DynamoDB
    await setJobStatus(jobId, {
      jobId,
      status,
      tenant,
      userId,
      results,
      processingTimeMs,
      completedAt: new Date().toISOString(),
      productCreation: {
        products: results,
        totalProducts: results.length,
        successfulProducts: results.filter(r => r.status === 'created').length,
        failedProducts: results.filter(r => r.status === 'failed').length,
      },
    });

    console.log('Job completed and persisted', {
      jobId,
      status,
      successfulProducts: results.filter(r => r.status === 'created').length
    });

    console.log('Product creation completed', {
      jobId,
      status,
      totalGroups: validatedRequest.productGroups.length,
      successfulProducts,
      failedProducts,
      successfulImageCount,
      failedImageCount,
      processingTimeMs,
      creditTransactionId,
    });

    const response: CreateProductsResponse = {
      jobId,
      status,
      totalGroups: validatedRequest.productGroups.length,
      products: results,
      processingTimeMs,
    };

    return NextResponse.json(response, { status: 200 });

  } catch (error) {
    console.error('Create products error', {
      jobId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    // ===== REFUND CREDITS ON COMPLETE FAILURE =====
    // If we debited credits but processing failed completely, refund all credits
    const stage = process.env.STAGE || 'dev';
    const creditsRequired = stage === 'prod' || process.env.REQUIRE_CREDITS === 'true';

    if (creditsRequired && creditTransactionId && totalImages > 0) {
      console.info('Refunding all credits due to processing failure', {
        jobId,
        totalImages,
        transactionId: creditTransactionId,
      });

      try {
        // Extract userId from headers as fallback (auth might have succeeded before error)
        const userId = request.headers.get('x-user-id') || 'system';
        const tenant = request.headers.get('x-tenant-id') || 'carousel-labs';

        const refundResult = await refundCredits(
          tenant,
          userId,
          totalImages,
          jobId,
          creditTransactionId
        );

        if (refundResult.success) {
          console.info('Full refund successful', {
            jobId,
            refundedCredits: totalImages,
            newBalance: refundResult.newBalance,
          });
        } else {
          console.error('Full refund failed', {
            jobId,
            error: refundResult.error,
          });
        }
      } catch (refundError) {
        console.error('Exception during refund', {
          jobId,
          error: refundError instanceof Error ? refundError.message : String(refundError),
        });
      }
    }
    // ===== END REFUND =====

    // Handle Zod validation errors
    if (error instanceof z.ZodError) {
      return NextResponse.json({
        error: 'Validation error',
        details: error.errors.map(e => ({
          field: e.path.join('.'),
          message: e.message,
        })),
      }, { status: 400 });
    }

    return NextResponse.json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}

/**
 * OPTIONS /bg-remover/create-products
 *
 * CORS preflight handler
 */
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Tenant-Id, X-User-Id',
    },
  });
}
