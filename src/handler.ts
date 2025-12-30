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
import {
  processImageFromUrl,
  processImageFromBase64,
} from './lib/bedrock/image-processor';
import { uploadProcessedImage, generateOutputKey, getOutputBucket } from '../lib/s3/client';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { validateJWTFromEvent } from './lib/auth/jwt-validator';
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { validateAndDebitCredits, refundCredits } from './lib/credits/client';
import {
  getJobStatus,
  setJobStatus,
  updateJobStatus,
  deleteJob,
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

interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  service: string;
  version: string;
  timestamp: string;
  uptime: number;
  checks: {
    name: string;
    status: 'pass' | 'fail';
    message?: string;
    details?: Record<string, any>;
  }[];
}

const startTime = Date.now();

export const health = async (event: any) => {
   console.log('Health check requested', {
     path: event.requestContext?.http?.path,
     method: event.requestContext?.http?.method,
   });
   // Check if the request path matches /bg-remover/health
   // Accept both /{stage}/bg-remover/health and /bg-remover/health patterns
   const path = event.requestContext?.http?.path || '';
   const stage = global.process.env.STAGE || 'dev';
   const validPaths = [
     `/bg-remover/health`,
     `/${stage}/bg-remover/health`,
   ];

   // Check if path matches any valid pattern (exact match or ends with pattern)
   const isValidPath = validPaths.some(p => path === p || path.endsWith('/bg-remover/health'));

   if (!isValidPath) {
     console.warn('Health check 404 - unexpected path:', path);
     return createErrorResponse(ErrorCode.NOT_FOUND, 'Endpoint not found');
   }

  const checks: HealthResponse['checks'] = [];

  // Check config loading
  try {
    await loadConfig();
    checks.push({ name: 'config', status: 'pass' });
  } catch (error) {
    checks.push({
      name: 'config',
      status: 'fail',
      message: error instanceof Error ? error.message : 'Config load failed',
    });
  }

  // Check environment variables
  const requiredEnvVars = ['AWS_REGION'];
  const missingEnvVars = requiredEnvVars.filter((v) => !global.process.env[v]);

  if (missingEnvVars.length === 0) {
    checks.push({ name: 'environment', status: 'pass' });
  } else {
    checks.push({
      name: 'environment',
      status: 'fail',
      message: `Missing: ${missingEnvVars.join(', ')}`,
    });
  }

  // Check cache connectivity
  try {
    const { getCacheManager, getAllCacheStats } = await import('./lib/cache/cache-manager');
    const tenantId = global.process.env.TENANT || 'carousel-labs';
    const cacheServiceUrl = global.process.env.CACHE_SERVICE_URL;

    const cacheManager = getCacheManager({
      tenantId,
      cacheServiceUrl,
      enableCacheService: !!cacheServiceUrl && !!tenantId,
      enableMemoryCache: true,
    });

    const stats = cacheManager.getStats();
    const allStats = getAllCacheStats(); // All tenant cache managers

    checks.push({
      name: 'cache',
      status: 'pass',
      message: `Memory: ${stats.memory.entries} entries, Cache Service: ${stats.cacheService.available ? `available (${stats.cacheService.state})` : 'unavailable'}`,
      details: {
        tenantManagers: Object.keys(allStats).length,
        cacheServiceAvailable: stats.cacheService.available || false,
        circuitBreakerState: stats.cacheService.state || 'unknown',
      },
    });
  } catch (error) {
    checks.push({
      name: 'cache',
      status: 'fail',
      message: error instanceof Error ? error.message : 'Cache check failed',
    });
  }

  // Determine overall status
  const failedChecks = checks.filter((c) => c.status === 'fail');
  let status: HealthResponse['status'] = 'healthy';

  if (failedChecks.length > 0) {
    status = failedChecks.length === checks.length ? 'unhealthy' : 'degraded';
  }

  const response: HealthResponse = {
    status,
    service: 'bg-remover',
    version: global.process.env.npm_package_version || '1.0.0',
    timestamp: new Date().toISOString(),
    uptime: Date.now() - startTime,
    checks,
  };

  const httpStatus = status === 'healthy' ? 200 : status === 'degraded' ? 200 : 503;

  return {
    statusCode: httpStatus,
    headers: DEFAULT_HEADERS,
    body: JSON.stringify(response),
  };
};

export const process = async (event: any) => {
  const requestId = extractRequestId(event);
  const httpMethod = event.requestContext?.http?.method || event.httpMethod;

  log.debug('Process function called', {
    requestId,
    httpMethod,
    path: event.requestContext?.http?.path,
    hasBody: !!event.body,
  });

  if (httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: DEFAULT_HEADERS,
      body: '',
    };
  }

  if (httpMethod !== 'POST') {
    return createErrorResponse(ErrorCode.METHOD_NOT_ALLOWED, 'Only POST method is allowed', undefined, requestId);
  }

  // ===== JWT AUTHENTICATION =====
  // Validate JWT token (optional in dev mode, required in prod)
  const stage = global.process.env.STAGE || 'dev';
  const requireAuth = stage === 'prod' || global.process.env.REQUIRE_AUTH === 'true';

  const authResult = await validateJWTFromEvent(event, undefined, {
    required: requireAuth
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

  // Resolve tenant from request (header, domain, or default)
  const tenant = await resolveTenantFromRequest(event, stage);

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

    // For dev: Return base64 data URL instead of uploading to S3
    // In production, this would upload to S3 and return a presigned URL
    const contentType = outputFormat === 'png' ? 'image/png' :
                       outputFormat === 'webp' ? 'image/webp' : 'image/jpeg';

    const base64Image = result.outputBuffer.toString('base64');
    const outputUrl = `data:${contentType};base64,${base64Image}`;

    const processingTimeMs = Date.now() - processingStartTime;

    logTiming('image-processing', processingTimeMs, {
      jobId,
      outputSize: base64Image.length,
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

    return createSuccessResponse({
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

    // Use standardized error handling
    clearLogContext();
    return handleError(error, 'process-image', requestId);
  }
};



// Job storage is now backed by DynamoDB via src/lib/job-store.ts
// This provides persistent job status storage across Lambda invocations

export const status = async (event: any) => {
  const requestId = extractRequestId(event);

   // Check if the request path matches /bg-remover/status/{jobId}
   const path = event.requestContext?.http?.path || '';
   const pathWithoutStage = path.replace(/^\/[^\/]+/, ''); // Remove stage prefix
   if (!event.pathParameters?.jobId || !pathWithoutStage?.startsWith('/bg-remover/status/')) {
     return createErrorResponse(ErrorCode.NOT_FOUND, 'Endpoint not found', undefined, requestId);
   }

  const jobId = event.pathParameters.jobId;
  const httpMethod = event.requestContext?.http?.method || event.httpMethod;

  // ===== JWT AUTHENTICATION =====
  // Status endpoint requires authentication (read-only, but still sensitive)
  const stage = global.process.env.STAGE || 'dev';
  const requireAuth = stage === 'prod' || global.process.env.REQUIRE_AUTH === 'true';

  const authResult = await validateJWTFromEvent(event, undefined, {
    required: requireAuth
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

  if (httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: DEFAULT_HEADERS,
      body: '',
    };
  }

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

      const job = await getJobStatus(jobId);

      if (!job) {
        return createErrorResponse(
          ErrorCode.NOT_FOUND,
          'Job not found. The job may have expired or does not exist. Jobs are stored for 24 hours.',
          { jobId },
          requestId
        );
      }

      return createSuccessResponse({
        jobId: job.jobId,
        status: job.status,
        progress: job.progress,
        result: job.result,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        expiresAt: new Date(new Date(job.createdAt).getTime() + 24 * 60 * 60 * 1000).toISOString(),
      });
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

      const job = await getJobStatus(jobId);

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

      // Update job status to cancelled/failed
      await updateJobStatus(jobId, {
        status: 'failed',
        result: {
          success: false,
          error: 'Job cancelled by user',
        },
      });

      return createSuccessResponse({
        jobId,
        status: 'cancelled',
        message: 'Job has been cancelled',
      });
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

  // Handle OPTIONS preflight
  if (httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: DEFAULT_HEADERS,
      body: '',
    };
  }

  // ===== JWT AUTHENTICATION =====
  // Settings endpoint requires authentication (sensitive configuration)
  const requireAuth = stage === 'prod' || global.process.env.REQUIRE_AUTH === 'true';

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
    required: requireAuth
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

      const response = await ssmClient.send(command);
      const settings = response.Parameter?.Value
        ? JSON.parse(response.Parameter.Value)
        : defaultSettings;

      console.log('Retrieved settings from SSM', { ssmPath, settings, requestId });

      return createSuccessResponse({ settings });
    } catch (error: any) {
      if (error.name === 'ParameterNotFound') {
        console.log('Settings parameter not found, returning defaults', { ssmPath, requestId });
        return createSuccessResponse({ settings: defaultSettings });
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

      return createSuccessResponse({
        success: true,
        settings,
        message: 'Settings saved successfully',
      });
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
