// This is the new handler file for the bg-remover service.
// It will contain the logic for the health, process, and status endpoints.

import { loadConfig } from './lib/config/loader';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import {
  ProcessRequestSchema,
  JobStatusParamsSchema,
  type ProcessResult,
  type ProductDescription,
  type MultilingualProductDescription,
  type BilingualProductDescription,
  createProcessResult
} from './lib/types';
import { languageManager } from './lib/language-manager';
import { multilingualDescriptionGenerator } from './lib/multilingual-description';
import { validateRequest, validatePathParams, ValidationError } from './lib/validation';
import { resolveTenantFromRequest, loadTenantConfig } from './lib/tenant/resolver';
import { loadTenantCognitoConfig } from './lib/tenant/cognito-config';
import {
  processImageFromUrl,
  processImageFromBase64,
} from './lib/bedrock/image-processor';
import { uploadProcessedImage, generateOutputKey, getOutputBucket } from '../lib/s3/client';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { validateJWTFromEvent, getCognitoConfigForTenantAsync } from './lib/auth/jwt-validator';
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { validateAndDebitCredits, refundCredits } from './lib/credits/client';
import {
  getJobStatus,
  setJobStatus,
  updateJobStatus,
  deleteJob,
  createJob,
  markJobCompleted,
  markJobFailed,
  type JobStatus,
} from './lib/job-store';
import {
  ErrorCode,
  AppError,
  Errors,
  DEFAULT_HEADERS,
  createErrorResponse,
  createSuccessResponse,
  handleError,
  extractRequestId,
} from './lib/errors';
import {
  log,
  logHandlerInvocation,
  logResponse,
  logTiming,
  logServiceCall,
  logSecurityEvent,
  logCreditOperation,
  clearLogContext,
} from './lib/logger';
import { extractSizeHint } from './lib/sizing/size-hints';

interface DependencyHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  latency?: number;
  message?: string;
}

interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  dependencies: {
    [key: string]: DependencyHealth;
  };
}

const DATA_URI_PREFIX = 'data:';

function sanitizeOutputUrl(value?: string): string | undefined {
  if (!value) return value;
  if (value.startsWith(DATA_URI_PREFIX)) return undefined;
  return value;
}

function sanitizeJobResult(result?: JobStatus['result']) {
  if (!result) return undefined;
  const sanitizedUrl = sanitizeOutputUrl(result.outputUrl);
  return {
    success: result.success,
    ...(sanitizedUrl ? { outputUrl: sanitizedUrl } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(typeof result.processingTimeMs === 'number' ? { processingTimeMs: result.processingTimeMs } : {}),
    ...(result.metadata ? { metadata: result.metadata } : {}),
    // 🔧 FIX: Strip description fields to prevent 413 Content Too Large
    // These fields can contain large nested objects or bilingual content (200KB+)
    // Clients can request full metadata via separate endpoint if needed
    // ...(result.productDescription ? { productDescription: result.productDescription } : {}),
    // ...(result.multilingualDescription ? { multilingualDescription: result.multilingualDescription } : {}),
    // ...(result.bilingualDescription ? { bilingualDescription: result.bilingualDescription } : {}),
  };
}

const startTime = Date.now();

/**
 * Check DynamoDB health by attempting a simple operation
 */
async function checkDynamoDB(): Promise<DependencyHealth> {
  const startCheck = Date.now();
  try {
    const { DynamoDBClient, DescribeTableCommand } = await import('@aws-sdk/client-dynamodb');
    const client = new DynamoDBClient({ region: global.process.env.AWS_REGION || 'eu-west-1' });
    const tableName =
      global.process.env.DYNAMODB_TABLE ||
      `carousel-main-${global.process.env.STAGE || 'dev'}`;

    await client.send(new DescribeTableCommand({ TableName: tableName }));

    return {
      status: 'healthy',
      latency: Date.now() - startCheck,
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      latency: Date.now() - startCheck,
      message: error instanceof Error ? error.message : 'DynamoDB check failed',
    };
  }
}

/**
 * Check S3 health by listing buckets
 */
async function checkS3(): Promise<DependencyHealth> {
  const startCheck = Date.now();
  try {
    const { S3Client, ListBucketsCommand } = await import('@aws-sdk/client-s3');
    const client = new S3Client({ region: global.process.env.AWS_REGION || 'eu-west-1' });

    await client.send(new ListBucketsCommand({}));

    return {
      status: 'healthy',
      latency: Date.now() - startCheck,
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      latency: Date.now() - startCheck,
      message: error instanceof Error ? error.message : 'S3 check failed',
    };
  }
}

/**
 * Check Cognito JWKS health
 */
async function checkCognito(): Promise<DependencyHealth> {
  const startCheck = Date.now();
  try {
    const tenantId = global.process.env.TENANT || 'carousel-labs';
    const stage = global.process.env.STAGE || 'dev';
    const { loadTenantCognitoConfig } = await import('./lib/tenant/cognito-config');

    const config = await loadTenantCognitoConfig(tenantId, stage);
    const jwksUrl = `${config.issuer}/.well-known/jwks.json`;

    const response = await fetch(jwksUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(5000) // 5 second timeout
    });

    if (!response.ok) {
      return {
        status: 'degraded',
        latency: Date.now() - startCheck,
        message: `JWKS endpoint returned ${response.status}`,
      };
    }

    return {
      status: 'healthy',
      latency: Date.now() - startCheck,
    };
  } catch (error) {
    // Circuit breaker open or JWKS unreachable = degraded (not critical for health)
    return {
      status: 'degraded',
      latency: Date.now() - startCheck,
      message: error instanceof Error ? error.message : 'Cognito JWKS check failed',
    };
  }
}

/**
 * Check cache service health
 */
async function checkCacheService(): Promise<DependencyHealth> {
  const startCheck = Date.now();
  try {
    const { getCacheManager } = await import('./lib/cache/cache-manager');
    const tenantId = global.process.env.TENANT || 'carousel-labs';
    const cacheServiceUrl = global.process.env.CACHE_SERVICE_URL;

    if (!cacheServiceUrl) {
      return {
        status: 'healthy',
        latency: Date.now() - startCheck,
        message: 'Cache service not configured (optional)',
      };
    }

    const cacheManager = getCacheManager({
      tenantId,
      cacheServiceUrl,
      enableCacheService: true,
      enableMemoryCache: true,
    });

    const stats = cacheManager.getStats();

    // If circuit breaker is open, service is degraded (not critical)
    if (stats.cacheService.state === 'open') {
      return {
        status: 'degraded',
        latency: Date.now() - startCheck,
        message: 'Cache service circuit breaker open',
      };
    }

    return {
      status: 'healthy',
      latency: Date.now() - startCheck,
      message: `Circuit breaker: ${stats.cacheService.state}`,
    };
  } catch (error) {
    return {
      status: 'degraded',
      latency: Date.now() - startCheck,
      message: error instanceof Error ? error.message : 'Cache service check failed',
    };
  }
}

export const health = async (event: any) => {
   console.log('Health check requested', {
     path: event.requestContext?.http?.path,
     method: event.requestContext?.http?.method,
   });

   // Check if the request path matches /bg-remover/health
   const path = event.requestContext?.http?.path || '';
   const stage = global.process.env.STAGE || 'dev';
   const validPaths = [
     `/bg-remover/health`,
     `/${stage}/bg-remover/health`,
   ];

   const isValidPath = validPaths.some(p => path === p || path.endsWith('/bg-remover/health'));

   if (!isValidPath) {
     console.warn('Health check 404 - unexpected path:', path);
     return createErrorResponse(ErrorCode.NOT_FOUND, 'Endpoint not found');
   }

  // Run all health checks in parallel
  const [dynamodb, s3, cognito, cacheService] = await Promise.all([
    checkDynamoDB(),
    checkS3(),
    checkCognito(),
    checkCacheService(),
  ]);

  const dependencies = {
    dynamodb,
    s3,
    cognito,
    cacheService,
  };

  // Determine overall status based on dependency health
  const hasUnhealthy = Object.values(dependencies).some(d => d.status === 'unhealthy');
  const hasDegraded = Object.values(dependencies).some(d => d.status === 'degraded');

  let statusCode = 200;
  let overallStatus: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';

  if (hasUnhealthy) {
    // Critical dependencies (DynamoDB, S3) down = 503 Service Unavailable
    statusCode = 503;
    overallStatus = 'unhealthy';
  } else if (hasDegraded) {
    // Non-critical dependencies degraded = 207 Multi-Status
    statusCode = 207;
    overallStatus = 'degraded';
  }

  const response: HealthResponse = {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    dependencies,
  };

  // Apply tenant-aware CORS for health endpoint
  const tenant = await resolveTenantFromRequest(event, stage);
  const { createTenantCorsHeaders } = await import('./lib/cors');

  return {
    statusCode,
    headers: {
      ...createTenantCorsHeaders(event, tenant),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(response),
  };
};

export const process = async (event: any) => {
  const requestId = extractRequestId(event);
  const httpMethod = event.requestContext?.http?.method || event.httpMethod;
  const stage = global.process.env.STAGE || 'dev';

  log.debug('Process function called', {
    requestId,
    httpMethod,
    path: event.requestContext?.http?.path,
    hasBody: !!event.body,
  });

  // ===== CORS PREFLIGHT =====
  if (httpMethod === 'OPTIONS') {
    const tenant = await resolveTenantFromRequest(event, stage);
    const { createTenantCorsHeaders } = await import('./lib/cors');

    return {
      statusCode: 200,
      headers: createTenantCorsHeaders(event, tenant),
      body: '',
    };
  }

  if (httpMethod !== 'POST') {
    return createErrorResponse(ErrorCode.METHOD_NOT_ALLOWED, 'Only POST method is allowed', undefined, requestId);
  }

  // Resolve tenant from request (header, domain, or default) - MUST happen before JWT validation
  const tenant = await resolveTenantFromRequest(event, stage);

  // ===== JWT AUTHENTICATION =====
  // Always validate JWT token (API Gateway authorizer provides primary auth, this is defense in depth)
  const requireAuth = true;

  // Load tenant-specific Cognito config for JWT validation
  const cognitoConfig = await getCognitoConfigForTenantAsync(tenant, stage);
  const authResult = await validateJWTFromEvent(event, cognitoConfig, {
    required: requireAuth,
    expectedTenant: tenant,
    enforceTenantMatch: true,
  });

  if (!authResult.isValid && requireAuth) {
    logSecurityEvent('auth_failure', {
      error: authResult.error,
      stage,
      path: event.requestContext?.http?.path,
      requestId,
    });

    const response = createErrorResponse(
      ErrorCode.AUTH_ERROR,
      'Valid JWT token required',
      authResult.error,
      requestId
    );
    response.headers = {
      ...response.headers,
      'WWW-Authenticate': 'Bearer realm="bg-remover", error="invalid_token"',
    };
    return response;
  }

  if (authResult.isValid && authResult.userId) {
    logSecurityEvent('auth_success', {
      userId: authResult.userId,
      email: authResult.email,
      groups: authResult.groups,
      requestId,
    });
  } else {
    logSecurityEvent('auth_skip', {
      stage,
      requireAuth,
      path: event.requestContext?.http?.path,
      requestId,
    });
  }
  // ===== END JWT AUTHENTICATION =====

  const processingStartTime = Date.now();
  const jobId = randomUUID();

  // Tenant already resolved before JWT validation (line 345)

  // Track credit transaction for potential refund on failure
  let creditTransactionId: string | undefined;
  let creditsDebited = false;

  try {

    // Parse and validate request body
    let body: any;
    try {
      body = JSON.parse(event.body || '{}');
    } catch (error) {
      log.warn('Invalid JSON in request body', {
        error: error instanceof Error ? error.message : String(error),
        requestId,
      });
      return createErrorResponse(
        ErrorCode.VALIDATION_ERROR,
        'Request body must be valid JSON',
        undefined,
        requestId
      );
    }

    const validation = validateRequest(ProcessRequestSchema, body, 'process-request');
    if (!validation.success) {
      log.warn('Request validation failed', {
        tenant,
        errors: validation.error?.details,
        requestId,
      });
      return createErrorResponse(
        ErrorCode.VALIDATION_ERROR,
        validation.error?.message || 'Request validation failed',
        validation.error?.details,
        requestId
      );
    }

    const validatedRequest = validation.data!;

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
      languages = ['en', 'is'],
      generatePriceSuggestion = false,
      generateRatingSuggestion = false,
    } = validatedRequest;

    log.info('Processing image request', {
      jobId,
      tenant,
      productId,
      hasUrl: !!imageUrl,
      hasBase64: !!imageBase64,
      outputFormat,
      quality,
      requestId,
    });

    // ===== CREDITS VALIDATION =====
    // Validate and debit credits before processing (1 credit per image)
    // Only require credits for authenticated requests in production
    const userId = authResult.userId || 'anonymous';
    const creditsRequired = stage === 'prod' || global.process.env.REQUIRE_CREDITS === 'true';

    if (creditsRequired && authResult.isValid && authResult.userId) {
      logCreditOperation('check', true, {
        jobId,
        tenant,
        userId: authResult.userId,
        imageCount: 1,
        requestId,
      });

      const creditResult = await validateAndDebitCredits(
        tenant,
        authResult.userId,
        1, // 1 credit per image
        jobId,
        productId
      );

      if (!creditResult.success) {
        logCreditOperation('debit', false, {
          jobId,
          tenant,
          userId: authResult.userId,
          error: creditResult.error,
          errorCode: creditResult.errorCode,
          requestId,
        });

        return createErrorResponse(
          ErrorCode.INSUFFICIENT_CREDITS,
          creditResult.error || 'Insufficient credits',
          { errorCode: creditResult.errorCode, jobId },
          requestId
        );
      }

      // Track successful debit for potential refund
      creditTransactionId = creditResult.transactionId;
      creditsDebited = true;

      logCreditOperation('debit', true, {
        jobId,
        tenant,
        userId: authResult.userId,
        creditsUsed: creditResult.creditsUsed,
        newBalance: creditResult.newBalance,
        transactionId: creditResult.transactionId,
        requestId,
      });
    } else if (!creditsRequired) {
      log.debug('Credits not required (dev mode)', {
        jobId,
        tenant,
        stage,
        requireCredits: creditsRequired,
        requestId,
      });
    }
    // ===== END CREDITS VALIDATION =====

    // Load tenant-specific configuration
    const config = await loadTenantConfig(tenant, stage);

    // Create job record for status tracking
    await createJob(jobId, tenant, authResult?.userId);
    log.info('Job record created', { jobId, tenant, userId: authResult?.userId, requestId });

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
      multilingualDescription?: MultilingualProductDescription;
      bilingualDescription?: BilingualProductDescription; // Backwards compatibility
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
      result = await processImageFromUrl(imageUrl, processingOptions, tenant);
    } else if (imageBase64) {
      result = await processImageFromBase64(imageBase64, 'image/png', processingOptions, tenant);
    } else {
      return createErrorResponse(
        ErrorCode.VALIDATION_ERROR,
        'No image provided. Either imageUrl or imageBase64 is required.',
        { processingTimeMs: Date.now() - processingStartTime },
        requestId
      );
    }

    const sizeHint = extractSizeHint(
      `${productName || ''} ${result.productDescription?.short || ''} ${result.productDescription?.long || ''}`
    );
    if (sizeHint) {
      result.metadata = {
        ...result.metadata,
        sizing: sizeHint,
      };
    }

    // Upload to S3 and return URL (solves 413 Content Too Large)
    const contentType = outputFormat === 'png' ? 'image/png' :
                       outputFormat === 'webp' ? 'image/webp' : 'image/jpeg';
    const outputBucket = await getOutputBucket(tenant, stage);
    const outputKey = generateOutputKey(tenant, productId || jobId, outputFormat || 'png');
    const outputUrl = await uploadProcessedImage(
      outputBucket,
      outputKey,
      result.outputBuffer,
      contentType,
      {
        tenant,
        jobId,
        productId: productId || 'unknown',
        source: imageUrl || 'base64',
      }
    );

    const processingTimeMs = Date.now() - processingStartTime;

    logTiming('image-processing', processingTimeMs, {
      jobId,
      outputSize: result.outputBuffer.length,
      originalSize: result.metadata.originalSize,
      processedSize: result.metadata.processedSize,
      tenant,
      outputFormat,
      requestId,
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
      const eventBridgeCommand = {
        Entries: [
          {
            Source: 'carousel.bg-remover',
            DetailType: 'CarouselImageProcessed',
            Detail: JSON.stringify(eventDetail),
          },
        ],
      };
      await eventBridge.send(new PutEventsCommand(eventBridgeCommand));
      logServiceCall('eventbridge', 'putEvents', true, undefined, { jobId, tenant, requestId });
    } catch (error) {
      logServiceCall('eventbridge', 'putEvents', false, undefined, {
        jobId,
        tenant,
        error: error instanceof Error ? error.message : String(error),
        requestId,
      });
    }

    // Generate multilingual descriptions if requested
    let multilingualDescription: MultilingualProductDescription | undefined;
    let bilingualDescription: BilingualProductDescription | undefined;
    
    if (generateDescription) {
      try {
        // Extract product features from existing description or generate basic ones
        const productFeatures = result.productDescription ? {
          name: productName || 'Product',
          category: result.productDescription.category || 'general',
          colors: result.productDescription.colors,
          condition: result.productDescription.condition || 'good',
          brand: result.productDescription.priceSuggestion?.factors.brand,
        } : {
          name: productName || 'Product',
          category: 'general',
          condition: 'good' as const,
        };

        // Generate multilingual descriptions
        multilingualDescription = await multilingualDescriptionGenerator.generateMultilingualDescriptions(
          productFeatures,
          languages,
          generatePriceSuggestion,
          generateRatingSuggestion
        );

        // For backwards compatibility, create bilingual description from multilingual
        if (multilingualDescription.en && multilingualDescription.is) {
          bilingualDescription = {
            en: multilingualDescription.en,
            is: multilingualDescription.is,
          };
        }
      } catch (error) {
        log.warn('Failed to generate multilingual descriptions', {
          jobId,
          error: error instanceof Error ? error.message : String(error),
          requestId,
        });
        // Continue without descriptions - don't fail the entire request
      }
    }

    logResponse(200, processingTimeMs, { jobId, tenant, requestId });

    // Mark job as completed with result
    await markJobCompleted(jobId, {
      outputUrl,
      metadata: result.metadata,
      processingTimeMs,
      productDescription: result.productDescription,
      multilingualDescription,
      bilingualDescription,
    }, tenant);
    log.info('Job marked as completed', { jobId, tenant, requestId });

    // Apply tenant-aware CORS headers
    const { createTenantCorsHeaders } = await import('./lib/cors');
    const response = createSuccessResponse({
      success: true,
      jobId,
      outputUrl,
      processingTimeMs,
      metadata: result.metadata,
      productDescription: result.productDescription,
      multilingualDescription,
      bilingualDescription,
      requestId,
    });

    // Override with tenant-aware CORS headers
    response.headers = {
      ...createTenantCorsHeaders(event, tenant),
      'Content-Type': 'application/json',
    };

    return response;
  } catch (error) {
    const processingTimeMs = Date.now() - processingStartTime;

    log.error('Image processing failed', error, {
      jobId,
      processingTimeMs,
      tenant,
      requestId,
    });

    // ===== CREDITS REFUND ON FAILURE =====
    // If we debited credits and processing failed, issue a refund
    if (creditsDebited && creditTransactionId && authResult.userId) {
      log.info('Initiating credit refund due to processing failure', {
        jobId,
        tenant,
        userId: authResult.userId,
        originalTransactionId: creditTransactionId,
        requestId,
      });

      try {
        const refundResult = await refundCredits(
          tenant,
          authResult.userId, // walletId = userId
          1, // 1 credit per image
          jobId,
          creditTransactionId
        );

        if (refundResult.success) {
          logCreditOperation('refund', true, {
            jobId,
            tenant,
            userId: authResult.userId,
            newBalance: refundResult.newBalance,
            refundTransactionId: refundResult.transactionId,
            requestId,
          });
        } else {
          logCreditOperation('refund', false, {
            jobId,
            tenant,
            userId: authResult.userId,
            error: refundResult.error,
            errorCode: refundResult.errorCode,
            originalTransactionId: creditTransactionId,
            requestId,
          });
          // Note: Don't fail the response - the processing already failed
          // This should be handled via dead-letter queue or manual reconciliation
        }
      } catch (refundError) {
        log.error('Credit refund exception', refundError, {
          jobId,
          tenant,
          userId: authResult.userId,
          originalTransactionId: creditTransactionId,
          requestId,
        });
      }
    }
    // ===== END CREDITS REFUND =====

    // Mark job as failed
    const errorMessage = error instanceof Error ? error.message : String(error);
    await markJobFailed(jobId, errorMessage, processingTimeMs, tenant);
    log.info('Job marked as failed', { jobId, tenant, error: errorMessage, requestId });

    // Use standardized error handling
    clearLogContext();
    return handleError(error, 'process-image', requestId);
  }
};



// Job storage is now backed by DynamoDB via src/lib/job-store.ts
// This provides persistent job status storage across Lambda invocations

export const status = async (event: any) => {
  const requestId = extractRequestId(event);
  const httpMethod = event.requestContext?.http.method || event.httpMethod;
  const stage = global.process.env.STAGE || 'dev';

  // ===== CORS PREFLIGHT =====
  // Handle OPTIONS first, before any validation or authentication
  if (httpMethod === 'OPTIONS') {
    const tenant = await resolveTenantFromRequest(event, stage);
    const { createTenantCorsHeaders } = await import('./lib/cors');

    return {
      statusCode: 200,
      headers: createTenantCorsHeaders(event, tenant),
      body: '',
    };
  }

   // Check if the request path matches /bg-remover/status/{jobId}
   const path = event.requestContext?.http?.path || '';
   if (!event.pathParameters?.jobId || !path?.includes('/status/')) {
     return createErrorResponse(ErrorCode.NOT_FOUND, 'Endpoint not found', undefined, requestId);
   }

  const jobId = event.pathParameters.jobId;

  // ===== JWT AUTHENTICATION =====
  // Always validate JWT token (API Gateway authorizer provides primary auth, this is defense in depth)
  const requireAuth = true;

  // CRITICAL: Resolve tenant and load Cognito config before JWT validation
  const tenant = await resolveTenantFromRequest(event, stage);
  const cognitoConfig = await loadTenantCognitoConfig(tenant, stage);

  const authResult = await validateJWTFromEvent(event, cognitoConfig, {
    required: requireAuth,
    expectedTenant: tenant,
    enforceTenantMatch: true,
  });

  if (!authResult.isValid && requireAuth) {
    console.warn('Authentication failed for status endpoint', {
      error: authResult.error,
      jobId,
      stage,
      requestId,
    });

    const response = createErrorResponse(
      ErrorCode.AUTH_ERROR,
      'Valid JWT token required',
      undefined,
      requestId
    );
    response.headers = {
      ...response.headers,
      'WWW-Authenticate': 'Bearer realm="bg-remover", error="invalid_token"',
    };
    return response;
  }
  // ===== END JWT AUTHENTICATION =====

  if (httpMethod === 'GET') {
    try {
      const pathValidation = validatePathParams(event.pathParameters, ['jobId'], 'status-get');
      if (!pathValidation.success) {
        return createErrorResponse(
          ErrorCode.VALIDATION_ERROR,
          pathValidation.error?.message || 'Invalid path parameters',
          pathValidation.error?.details,
          requestId
        );
      }

      const validation = validateRequest(JobStatusParamsSchema, { jobId }, 'job-status-params');
      if (!validation.success) {
        return createErrorResponse(
          ErrorCode.VALIDATION_ERROR,
          validation.error?.message || 'Invalid job ID format',
          validation.error?.details,
          requestId
        );
      }

      // 🔧 FIX: Extract pagination parameters for progressive rendering
      const offset = Math.max(0, parseInt(event.queryStringParameters?.offset || '0', 10));
      const limit = Math.min(50, Math.max(1, parseInt(event.queryStringParameters?.limit || '10', 10)));

      console.log('Job status request with pagination', {
        jobId,
        offset,
        limit,
        tenant,
        requestId,
      });

      const job = await getJobStatus(jobId, tenant);

      if (!job) {
        return createErrorResponse(
          ErrorCode.NOT_FOUND,
          'Job not found. The job may have expired or does not exist. Jobs are stored for 24 hours.',
          { jobId },
          requestId
        );
      }

      // 🔧 FIX: Paginate processedImages array for batch jobs to prevent 413 Content Too Large
      let paginatedResult = sanitizeJobResult(job.result);
      let pagination;

      if (job.result && Array.isArray(job.result.processedImages)) {
        const allImages = job.result.processedImages;
        const totalImages = allImages.length;

        // Apply pagination to images array
        const paginatedImages = allImages.slice(offset, offset + limit);

        // Return minimal image fields to reduce payload size
        const minimalImages = paginatedImages.map((img: any) => ({
          imageId: img.imageId || img.filename,
          processedUrl: img.processedUrl || img.outputUrl,
          width: img.width || img.metadata?.width,
          height: img.height || img.metadata?.height,
          status: img.status || 'completed',
          processingTimeMs: img.processingTimeMs || img.metadata?.processingTimeMs || 0,
          isPrimary: img.isPrimary,
        }));

        // Build pagination metadata
        pagination = {
          offset,
          limit,
          totalImages,
          returnedImages: minimalImages.length,
          hasMore: offset + limit < totalImages,
          nextOffset: offset + limit < totalImages ? offset + limit : null,
        };

        // Replace full processedImages array with paginated subset
        paginatedResult = {
          ...paginatedResult,
          processedImages: minimalImages,
        };

        console.log('Paginated batch job images', {
          jobId,
          totalImages,
          offset,
          limit,
          returnedImages: minimalImages.length,
          hasMore: offset + limit < totalImages,
          tenant,
          requestId,
        });
      }

      const { createTenantCorsHeaders } = await import('./lib/cors');
      const responseData: any = {
        jobId: job.jobId,
        status: job.status,
        progress: job.progress,
        result: paginatedResult,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        expiresAt: new Date(new Date(job.createdAt).getTime() + 24 * 60 * 60 * 1000).toISOString(),
      };

      // Add pagination metadata if applicable
      if (pagination) {
        responseData.pagination = pagination;
      }

      const response = createSuccessResponse(responseData);

      // Override with tenant-aware CORS headers
      response.headers = {
        ...createTenantCorsHeaders(event, tenant),
        'Content-Type': 'application/json',
      };

      return response;
    } catch (error) {
      console.error('Error fetching job status', {
        jobId,
        error: error instanceof Error ? error.message : 'Unknown error',
        requestId,
      });

      return handleError(error, 'get-job-status', requestId);
    }
  }

  if (httpMethod === 'DELETE') {
    try {
      const pathValidation = validatePathParams(event.pathParameters, ['jobId'], 'status-delete');
      if (!pathValidation.success) {
        return createErrorResponse(
          ErrorCode.VALIDATION_ERROR,
          pathValidation.error?.message || 'Invalid path parameters',
          pathValidation.error?.details,
          requestId
        );
      }

      const validation = validateRequest(JobStatusParamsSchema, { jobId }, 'job-status-params');
      if (!validation.success) {
        return createErrorResponse(
          ErrorCode.VALIDATION_ERROR,
          validation.error?.message || 'Invalid job ID format',
          validation.error?.details,
          requestId
        );
      }

      const job = await getJobStatus(jobId, tenant);

      if (!job) {
        return createErrorResponse(ErrorCode.NOT_FOUND, 'Job not found', { jobId }, requestId);
      }

      if (job.status !== 'pending' && job.status !== 'processing') {
        return createErrorResponse(
          ErrorCode.CONFLICT,
          `Cannot cancel job - job is already ${job.status}`,
          { jobId, currentStatus: job.status },
          requestId
        );
      }

      // Update job status to cancelled
      await updateJobStatus(jobId, {
        status: 'cancelled',
        result: {
          success: false,
          error: 'Job cancelled by user',
        },
      }, tenant);

      // tenant was already resolved earlier at line 793
      const { createTenantCorsHeaders } = await import('./lib/cors');
      const response = createSuccessResponse({
        jobId,
        status: 'cancelled',
        message: 'Job has been cancelled',
      });

      // Override with tenant-aware CORS headers
      response.headers = {
        ...createTenantCorsHeaders(event, tenant),
        'Content-Type': 'application/json',
      };

      return response;
    } catch (error) {
      console.error('Error cancelling job', {
        jobId,
        error: error instanceof Error ? error.message : 'Unknown error',
        requestId,
      });

      return handleError(error, 'cancel-job', requestId);
    }
  }

  return createErrorResponse(ErrorCode.METHOD_NOT_ALLOWED, 'Method not allowed', undefined, requestId);
};

/**
 * Settings Handler
 * GET /bg-remover/settings - Retrieve similarity detection settings
 * PUT /bg-remover/settings - Update similarity detection settings
 */
export const settings = async (event: any) => {
  const requestId = extractRequestId(event);

  console.log('Settings handler invoked', {
    httpMethod: event.requestContext?.http?.method,
    headers: event.headers,
    requestId,
  });

  const httpMethod = event.requestContext?.http?.method || 'GET';
  const stage = global.process.env.STAGE || 'dev';

  // Resolve tenant using proper tenant resolution logic
  const { resolveTenantFromRequest } = await import('./lib/tenant/resolver');
  const tenant = await resolveTenantFromRequest(event, stage);

  console.log('Resolved tenant for settings request', {
    tenant,
    host: event.headers?.host,
    requestId,
  });

  // ===== CORS PREFLIGHT =====
  if (httpMethod === 'OPTIONS') {
    const { createTenantCorsHeaders } = await import('./lib/cors');

    return {
      statusCode: 200,
      headers: createTenantCorsHeaders(event, tenant),
      body: '',
    };
  }

  // ===== JWT AUTHENTICATION =====
  // Always validate JWT token (API Gateway authorizer provides primary auth, this is defense in depth)
  const requireAuth = true;

  // Load tenant-specific Cognito configuration for JWT validation
  const { loadTenantCognitoConfig } = await import('./lib/tenant/cognito-config');
  const cognitoConfig = await loadTenantCognitoConfig(tenant, stage);

  console.log('Loaded Cognito config for tenant', {
    tenant,
    userPoolId: cognitoConfig.userPoolId,
    issuer: cognitoConfig.issuer,
    requestId,
  });

  const authResult = await validateJWTFromEvent(event, cognitoConfig, {
    required: requireAuth,
    expectedTenant: tenant,
    enforceTenantMatch: true,
  });

  if (!authResult.isValid && requireAuth) {
    console.warn('Authentication failed for settings endpoint', {
      error: authResult.error,
      stage,
      path: event.requestContext?.http?.path,
      requestId,
    });

    const response = createErrorResponse(
      ErrorCode.AUTH_ERROR,
      'Valid JWT token required',
      authResult.error,
      requestId
    );
    response.headers = {
      ...response.headers,
      'WWW-Authenticate': 'Bearer realm="bg-remover", error="invalid_token"',
    };
    return response;
  }

  if (authResult.isValid && authResult.userId) {
    console.info('Authenticated settings request', {
      userId: authResult.userId,
      email: authResult.email,
      method: httpMethod,
      requestId,
    });
  }
  // ===== END JWT AUTHENTICATION =====

  const ssmClient = new SSMClient({ region: global.process.env.AWS_REGION || 'eu-west-1' });
  const ssmPath = `/tf/${stage}/${tenant}/services/bg-remover/settings`;

  // Default settings (includes both legacy duplicate detection and new Product Identity)
  const defaultSettings = {
    // Legacy duplicate detection settings
    detectDuplicates: true,
    groupByColor: true,
    duplicateThreshold: 0.85,  // Lowered from 0.95 for bg-removed images
    colorGroups: 3,
    maxImagesPerGroup: 10,

    // Product Identity Detection settings
    productIdentity: {
      enabled: true,
      threshold: 0.70,
      minGroupSize: 1,
      maxGroupSize: 6,
      useRekognition: true,
      signalWeights: {
        spatial: 0.40,
        feature: 0.35,
        semantic: 0.15,
        composition: 0.05,
        background: 0.05,
      },
    },
  };

  // GET - Retrieve settings
  if (httpMethod === 'GET') {
    try {
      const command = new GetParameterCommand({
        Name: ssmPath,
        WithDecryption: false,
      });

      const ssmResponse = await ssmClient.send(command);
      const settings = ssmResponse.Parameter?.Value
        ? JSON.parse(ssmResponse.Parameter.Value)
        : defaultSettings;

      console.log('Retrieved settings from SSM', { ssmPath, settings, requestId });

      const { createTenantCorsHeaders } = await import('./lib/cors');
      const response = createSuccessResponse({ settings });

      // Override with tenant-aware CORS headers
      response.headers = {
        ...createTenantCorsHeaders(event, tenant),
        'Content-Type': 'application/json',
      };

      return response;
    } catch (error: any) {
      if (error.name === 'ParameterNotFound') {
        console.log('Settings parameter not found, returning defaults', { ssmPath, requestId });
        const { createTenantCorsHeaders } = await import('./lib/cors');
        const response = createSuccessResponse({ settings: defaultSettings });

        // Override with tenant-aware CORS headers
        response.headers = {
          ...createTenantCorsHeaders(event, tenant),
          'Content-Type': 'application/json',
        };

        return response;
      }

      console.error('Error retrieving settings from SSM', {
        error: error.message,
        ssmPath,
        requestId,
      });

      return handleError(error, 'get-settings', requestId);
    }
  }

  // PUT - Update settings
  if (httpMethod === 'PUT') {
    try {
      const body = JSON.parse(event.body || '{}');
      const { settings } = body;

      // Validate settings
      if (!settings || typeof settings !== 'object') {
        return createErrorResponse(
          ErrorCode.VALIDATION_ERROR,
          'Settings object is required',
          undefined,
          requestId
        );
      }

      // Validate settings fields (legacy duplicate detection)
      const validationErrors: string[] = [];
      if (settings.detectDuplicates !== undefined && typeof settings.detectDuplicates !== 'boolean') {
        validationErrors.push('detectDuplicates must be a boolean');
      }
      if (settings.groupByColor !== undefined && typeof settings.groupByColor !== 'boolean') {
        validationErrors.push('groupByColor must be a boolean');
      }
      if (settings.duplicateThreshold !== undefined && (typeof settings.duplicateThreshold !== 'number' || settings.duplicateThreshold < 0 || settings.duplicateThreshold > 1)) {
        validationErrors.push('duplicateThreshold must be a number between 0 and 1');
      }
      if (settings.colorGroups !== undefined && (typeof settings.colorGroups !== 'number' || settings.colorGroups < 1 || settings.colorGroups > 10)) {
        validationErrors.push('colorGroups must be a number between 1 and 10');
      }
      if (settings.maxImagesPerGroup !== undefined && (typeof settings.maxImagesPerGroup !== 'number' || settings.maxImagesPerGroup < 1)) {
        validationErrors.push('maxImagesPerGroup must be a positive number');
      }

      // Validate Product Identity settings
      if (settings.productIdentity) {
        const pi = settings.productIdentity;
        if (pi.enabled !== undefined && typeof pi.enabled !== 'boolean') {
          validationErrors.push('productIdentity.enabled must be a boolean');
        }
        if (pi.threshold !== undefined && (typeof pi.threshold !== 'number' || pi.threshold < 0 || pi.threshold > 1)) {
          validationErrors.push('productIdentity.threshold must be a number between 0 and 1');
        }
        if (pi.minGroupSize !== undefined && (typeof pi.minGroupSize !== 'number' || pi.minGroupSize < 1)) {
          validationErrors.push('productIdentity.minGroupSize must be a positive number');
        }
        if (pi.maxGroupSize !== undefined && (typeof pi.maxGroupSize !== 'number' || pi.maxGroupSize < 1)) {
          validationErrors.push('productIdentity.maxGroupSize must be a positive number');
        }
        if (pi.useRekognition !== undefined && typeof pi.useRekognition !== 'boolean') {
          validationErrors.push('productIdentity.useRekognition must be a boolean');
        }
        if (pi.signalWeights) {
          const sw = pi.signalWeights;
          const weightFields = ['spatial', 'feature', 'semantic', 'composition', 'background'];
          for (const field of weightFields) {
            if (sw[field] !== undefined && (typeof sw[field] !== 'number' || sw[field] < 0 || sw[field] > 1)) {
              validationErrors.push(`productIdentity.signalWeights.${field} must be a number between 0 and 1`);
            }
          }
          // Validate sum of weights equals 1.0 (with tolerance for floating point)
          const sum = (sw.spatial ?? 0) + (sw.feature ?? 0) + (sw.semantic ?? 0) + (sw.composition ?? 0) + (sw.background ?? 0);
          if (Math.abs(sum - 1.0) > 0.01) {
            validationErrors.push('productIdentity.signalWeights must sum to 1.0');
          }
        }
      }

      if (validationErrors.length > 0) {
        return createErrorResponse(
          ErrorCode.VALIDATION_ERROR,
          'Invalid settings',
          validationErrors,
          requestId
        );
      }

      // Save to SSM
      const command = new PutParameterCommand({
        Name: ssmPath,
        Value: JSON.stringify(settings),
        Type: 'String',
        Overwrite: true,
        Description: 'BG-Remover similarity detection settings',
      });

      await ssmClient.send(command);

      console.log('Saved settings to SSM', { ssmPath, settings, requestId });

      const { createTenantCorsHeaders } = await import('./lib/cors');
      const response = createSuccessResponse({
        success: true,
        settings,
        message: 'Settings saved successfully',
      });

      // Override with tenant-aware CORS headers
      response.headers = {
        ...createTenantCorsHeaders(event, tenant),
        'Content-Type': 'application/json',
      };

      return response;
    } catch (error: any) {
      console.error('Error saving settings to SSM', {
        error: error.message,
        ssmPath,
        requestId,
      });

      return handleError(error, 'save-settings', requestId);
    }
  }

  return createErrorResponse(ErrorCode.METHOD_NOT_ALLOWED, 'Method not allowed', undefined, requestId);
};

/**
 * Process Worker - Background image processing
 *
 * This is imported from the new async pattern handlers.
 * It's exported here to maintain compatibility with serverless.yml
 */
// Commented out to prevent loading Next.js dependencies at Lambda init
// Each handler has its own entry file in src/handlers/
// export { processWorker } from './handlers/process-worker-handler';

/**
 * Create Products - Multi-image product creation endpoint
 *
 * Processes image groups, uploads to S3, and creates products in carousel-api.
 * Connects the existing BulkUploadWizard UI to product creation.
 */
// Commented out to prevent loading Next.js dependencies at Lambda init
// Each handler has its own entry file in src/handlers/
// export { createProducts } from './handlers/create-products-handler';
