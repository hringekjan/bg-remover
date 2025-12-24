/**
 * POST /api/process - Single Image Background Removal
 *
 * Processes a single image to remove its background using
 * AWS Bedrock Claude Vision for intelligent subject detection
 * and Sharp for image manipulation.
 *
 * Credit Validation:
 * - Requires valid userId for credit billing
 * - Returns 402 Payment Required if insufficient credits
 * - Debits 1 credit per image processed
 * - Refunds on processing failure
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID, timingSafeEqual } from 'crypto';
import { ProcessRequestSchema, type ProcessResult, type ProductDescription, type BilingualProductDescription } from '@/lib/types';
import { resolveTenantFromRequest, loadTenantConfig } from '@/lib/tenant/resolver';
import {
  processImageFromUrl,
  processImageFromBase64,
  createProcessResult,
} from '@/lib/bedrock/image-processor';
import { uploadProcessedImage, generateOutputKey } from '@/lib/s3/client';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { validateAndDebitCredits, refundCredits } from '@/src/lib/credits/client';

// Admin/internal API keys that bypass credit validation
const ADMIN_API_KEYS = (process.env.ADMIN_API_KEYS || '').split(',').filter(Boolean);

/**
 * Timing-safe string comparison to prevent timing attacks on API key validation.
 * Always compares in constant time regardless of where strings differ.
 */
function timingSafeCompare(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }

  const aBuffer = Buffer.from(a, 'utf8');
  const bBuffer = Buffer.from(b, 'utf8');

  // If lengths differ, still perform comparison to prevent timing leak
  if (aBuffer.length !== bBuffer.length) {
    const maxLen = Math.max(aBuffer.length, bBuffer.length);
    const paddedA = Buffer.alloc(maxLen, 0);
    const paddedB = Buffer.alloc(maxLen, 0);
    aBuffer.copy(paddedA);
    bBuffer.copy(paddedB);
    timingSafeEqual(paddedA, paddedB);
    return false;
  }

  return timingSafeEqual(aBuffer, bBuffer);
}

/**
 * Check if provided API key matches any admin key using timing-safe comparison.
 */
function isValidAdminApiKey(apiKey: string): boolean {
  // Perform timing-safe comparison against all admin keys
  // This ensures constant time regardless of which key (if any) matches
  let isValid = false;
  for (const adminKey of ADMIN_API_KEYS) {
    if (timingSafeCompare(apiKey, adminKey)) {
      isValid = true;
      // Continue loop to maintain constant time
    }
  }
  return isValid;
}

/**
 * Extract user ID from request using hierarchy:
 * 1. Request body userId field
 * 2. X-User-Id header
 * 3. Authorization header (JWT sub claim)
 */
function extractUserId(request: NextRequest, bodyUserId?: string): string | null {
  // Priority 1: Explicit userId in request body
  if (bodyUserId) {
    return bodyUserId;
  }

  // Priority 2: X-User-Id header
  const headerUserId = request.headers.get('x-user-id')?.trim();
  if (headerUserId) {
    return headerUserId;
  }

  // Priority 3: Extract from Authorization JWT (if present)
  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const token = authHeader.slice(7);
      // Decode JWT payload (without verification - verification should happen at API Gateway)
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
      return payload.sub || payload.userId || payload.username || null;
    } catch {
      // Invalid JWT format, ignore
    }
  }

  return null;
}

/**
 * Check if request should bypass credit validation
 * Uses timing-safe comparison for API key validation to prevent timing attacks.
 */
function shouldBypassCreditValidation(request: NextRequest, skipFlag?: boolean): boolean {
  // Check for admin API key using timing-safe comparison
  const apiKey = request.headers.get('x-api-key');
  if (apiKey && isValidAdminApiKey(apiKey)) {
    return true;
  }

  // Check for explicit skip flag (must be combined with admin key or internal call)
  if (skipFlag && apiKey && isValidAdminApiKey(apiKey)) {
    return true;
  }

  // Dev environment can skip for testing (with explicit flag)
  if (process.env.NODE_ENV === 'development' && skipFlag) {
    console.warn('Credit validation bypassed in development mode');
    return true;
  }

  return false;
}

export const runtime = 'nodejs';
export const maxDuration = 60; // 60 seconds timeout

// Extended ProcessResult with credit information
interface ProcessResultWithCredits extends ProcessResult {
  creditsUsed?: number;
  creditsRemaining?: number;
  transactionId?: string;
}

export async function POST(request: NextRequest): Promise<NextResponse<ProcessResultWithCredits>> {
  const startTime = Date.now();
  const jobId = randomUUID();
  let creditTransactionId: string | undefined;
  let creditsDebited = false;

  try {
    // Resolve tenant from request (header, domain, or default)
    const stage = process.env.STAGE || 'dev';
    const tenant = await resolveTenantFromRequest(request, stage);

    // Parse and validate request body
    const body = await request.json();
    const validatedRequest = ProcessRequestSchema.parse(body);

    const {
      imageUrl,
      imageBase64,
      outputFormat,
      quality,
      productId,
      autoTrim,
      centerSubject,
      enhanceColors,
      targetWidth,
      targetHeight,
      generateDescription,
      productName,
      userId: bodyUserId,
      skipCreditValidation,
    } = validatedRequest;

    // Extract user ID for credit billing
    const userId = extractUserId(request, bodyUserId);
    const bypassCredits = shouldBypassCreditValidation(request, skipCreditValidation);

    console.log('Processing image request', {
      jobId,
      tenant,
      productId,
      hasUrl: !!imageUrl,
      hasBase64: !!imageBase64,
      outputFormat,
      userId: userId ? `${userId.substring(0, 8)}...` : 'anonymous',
      bypassCredits,
    });

    // Credit validation and debit (unless bypassed)
    let creditsUsed = 0;
    let creditsRemaining: number | undefined;

    if (!bypassCredits) {
      if (!userId) {
        console.warn('No userId provided for credit validation', { jobId, tenant });
        return NextResponse.json(
          {
            success: false,
            jobId,
            error: 'User identification required for credit billing. Provide userId in body, X-User-Id header, or Authorization token.',
            processingTimeMs: Date.now() - startTime,
          },
          { status: 401 }
        );
      }

      // Validate and debit credits before processing
      const creditResult = await validateAndDebitCredits(tenant, userId, 1, jobId, productId);

      if (!creditResult.success) {
        console.warn('Credit validation failed', {
          jobId,
          tenant,
          userId: userId.substring(0, 8) + '...',
          error: creditResult.error,
          errorCode: creditResult.errorCode,
        });

        return NextResponse.json(
          {
            success: false,
            jobId,
            error: creditResult.error || 'Insufficient credits',
            processingTimeMs: Date.now() - startTime,
          },
          { status: creditResult.httpStatus || 402 }
        );
      }

      creditsDebited = true;
      creditTransactionId = creditResult.transactionId;
      creditsUsed = creditResult.creditsUsed || 1;
      creditsRemaining = creditResult.newBalance;

      console.log('Credits debited successfully', {
        jobId,
        transactionId: creditTransactionId,
        creditsUsed,
        creditsRemaining,
      });
    }

    // Load tenant-specific configuration
    const config = await loadTenantConfig(tenant, stage);

    // Process the image
    let result: {
      outputBuffer: Buffer;
      metadata: {
        width: number;
        height: number;
        originalSize: number;
        processedSize: number;
      };
      productDescription?: ProductDescription;
      bilingualDescription?: BilingualProductDescription;
    };

    const processingOptions = {
      format: outputFormat,
      quality,
      autoTrim,
      centerSubject,
      enhanceColors,
      targetSize: targetWidth && targetHeight ? { width: targetWidth, height: targetHeight } : undefined,
      generateDescription,
      productName,
    };

    if (imageUrl) {
      result = await processImageFromUrl(imageUrl, processingOptions);
    } else if (imageBase64) {
      result = await processImageFromBase64(imageBase64, 'image/png', processingOptions);
    } else {
      return NextResponse.json(
        createProcessResult(false, undefined, undefined, 'No image provided', Date.now() - startTime),
        { status: 400 }
      );
    }

    // For dev: Return base64 data URL instead of uploading to S3
    // In production, this would upload to S3 and return a presigned URL
    const contentType = outputFormat === 'png' ? 'image/png' :
                       outputFormat === 'webp' ? 'image/webp' : 'image/jpeg';

    const base64Image = result.outputBuffer.toString('base64');
    const outputUrl = `data:${contentType};base64,${base64Image}`;

    const processingTimeMs = Date.now() - startTime;

    console.log('Image processed successfully', {
      jobId,
      processingTimeMs,
      outputSize: base64Image.length,
      originalSize: result.metadata.originalSize,
      processedSize: result.metadata.processedSize,
    });

    // Emit CarouselImageProcessed event
    try {
      const eventBridge = new EventBridgeClient({ region: 'eu-west-1' });
      const eventDetail = {
        file_hash: jobId,
        original_filename: imageUrl ? imageUrl.split('/').pop() || 'input.png' : 'input.png',
        output_filename: 'output.png',
        output_path: '/processed',
        output_key: `processed/${jobId}.png`,
        model_name: 'bedrock-claude-vision',
        processing_time_ms: processingTimeMs,
        timestamp: new Date().toISOString(),
        tenant_id: tenant,
        metadata: result.metadata
      };
      const event = {
        Source: 'carousel.bg-remover',
        DetailType: 'CarouselImageProcessed',
        Detail: JSON.stringify(eventDetail)
      };
      await eventBridge.send(new PutEventsCommand({ Entries: [event] }));
      console.log('CarouselImageProcessed event emitted', { jobId });
    } catch (error) {
      console.error('Failed to emit CarouselImageProcessed event', { jobId, error });
    }

    return NextResponse.json({
      success: true,
      jobId,
      outputUrl,
      processingTimeMs,
      metadata: result.metadata,
      productDescription: result.productDescription,
      bilingualDescription: result.bilingualDescription,
      // Credit information
      creditsUsed: creditsUsed > 0 ? creditsUsed : undefined,
      creditsRemaining,
      transactionId: creditTransactionId,
    });

  } catch (error) {
    const processingTimeMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    console.error('Image processing failed', {
      jobId,
      error: errorMessage,
      processingTimeMs,
      creditsDebited,
    });

    // Attempt to refund credits if processing failed after debit
    if (creditsDebited && creditTransactionId) {
      const userId = extractUserId(request, undefined);
      const tenant = request.headers.get('x-tenant-id') || 'carousel-labs';

      if (userId) {
        try {
          const refundResult = await refundCredits(tenant, userId, 1, jobId, creditTransactionId);
          if (refundResult.success) {
            console.log('Credits refunded after processing failure', {
              jobId,
              originalTransactionId: creditTransactionId,
              refundTransactionId: refundResult.transactionId,
            });
          } else {
            console.error('Failed to refund credits after processing failure', {
              jobId,
              originalTransactionId: creditTransactionId,
              error: refundResult.error,
            });
          }
        } catch (refundError) {
          console.error('Exception during credit refund', {
            jobId,
            originalTransactionId: creditTransactionId,
            error: refundError instanceof Error ? refundError.message : String(refundError),
          });
        }
      }
    }

    // Handle validation errors
    if (error instanceof Error && error.name === 'ZodError') {
      return NextResponse.json(
        createProcessResult(false, undefined, undefined, `Validation error: ${errorMessage}`, processingTimeMs),
        { status: 400 }
      );
    }

    return NextResponse.json(
      createProcessResult(false, undefined, undefined, errorMessage, processingTimeMs),
      { status: 500 }
    );
  }
}

// OPTIONS for CORS preflight
export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Tenant-Id',
    },
  });
}
