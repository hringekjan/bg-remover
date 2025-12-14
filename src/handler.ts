// This is the new handler file for the bg-remover service.
// It will contain the logic for the health, process, and status endpoints.

import { loadConfig } from './lib/config/loader';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { ProcessRequestSchema, JobStatusParamsSchema, type ProcessResult, type ProductDescription, type BilingualProductDescription, createProcessResult } from './lib/types';
import { validateRequest, validatePathParams, ValidationError } from './lib/validation';
import { resolveTenantFromRequest, loadTenantConfig } from './lib/tenant/resolver';
import {
  processImageFromUrl,
  processImageFromBase64,
} from './lib/bedrock/image-processor';
import { uploadProcessedImage, generateOutputKey } from './lib/s3/client';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { validateJWTFromEvent } from './lib/auth/jwt-validator';
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { validateAndDebitCredits, refundCredits } from './lib/credits/client';

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
  }[];
}

const startTime = Date.now();

exports.health = async (event: any) => {
   console.log('Health check requested', {
     path: event.requestContext?.http?.path,
     method: event.requestContext?.http?.method,
   });
   // Check if the request path matches /bg-remover/health
   // Note: API Gateway includes stage prefix (e.g., /dev/bg-remover/health)
   // We need to strip the stage prefix for path comparison
   const path = event.requestContext?.http?.path || '';
   const pathWithoutStage = path.replace(/^\/[^\/]+/, ''); // Remove stage prefix
   if (pathWithoutStage !== '/bg-remover/health') {
     console.warn('Health check 404 - unexpected path:', path, 'stripped:', pathWithoutStage);
     return {
       statusCode: 404,
       body: JSON.stringify({ message: 'Not Found' }),
     };
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
    body: JSON.stringify(response),
  };
};

exports.process = async (event: any) => {
  console.log('Process function called with event:', JSON.stringify(event, null, 2));
  const httpMethod = event.requestContext?.http?.method || event.httpMethod;
  if (httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Tenant-Id',
      },
      body: '',
    };
  }

  if (httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ message: 'Method Not Allowed' }),
    };
  }

  // ===== JWT AUTHENTICATION =====
  // Validate JWT token (optional in dev mode, required in prod)
  const stage = global.process.env.STAGE || 'dev';
  const requireAuth = stage === 'prod' || global.process.env.REQUIRE_AUTH === 'true';

  const authResult = await validateJWTFromEvent(event, undefined, {
    required: requireAuth
  });

  if (!authResult.isValid && requireAuth) {
    console.warn('Authentication failed', {
      error: authResult.error,
      stage,
      path: event.requestContext?.http?.path,
    });

    return {
      statusCode: 401,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'WWW-Authenticate': 'Bearer realm="bg-remover", error="invalid_token"',
      },
      body: JSON.stringify({
        error: 'Unauthorized',
        message: 'Valid JWT token required',
        details: authResult.error,
      }),
    };
  }

  if (authResult.isValid && authResult.userId) {
    console.info('Authenticated request', {
      userId: authResult.userId,
      email: authResult.email,
      groups: authResult.groups,
    });
  } else {
    console.info('Unauthenticated request (dev mode)', {
      stage,
      requireAuth,
      path: event.requestContext?.http?.path,
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
      console.warn('Invalid JSON in request body', { error: error instanceof Error ? error.message : String(error) });
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'Invalid JSON',
          message: 'Request body must be valid JSON',
        }),
      };
    }

    const validation = validateRequest(ProcessRequestSchema, body, 'process-request');
    if (!validation.success) {
      console.warn('Request validation failed', {
        tenant,
        errors: validation.error?.details,
      });
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: validation.error?.message || 'Validation failed',
          details: validation.error?.details,
        }),
      };
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
    } = validatedRequest;

    console.info('Processing image request', {
      jobId,
      tenant,
      productId,
      hasUrl: !!imageUrl,
      hasBase64: !!imageBase64,
      outputFormat,
      quality,
    });

    // ===== CREDITS VALIDATION =====
    // Validate and debit credits before processing (1 credit per image)
    // Only require credits for authenticated requests in production
    const userId = authResult.userId || 'anonymous';
    const creditsRequired = stage === 'prod' || global.process.env.REQUIRE_CREDITS === 'true';

    if (creditsRequired && authResult.isValid && authResult.userId) {
      console.info('Validating credits', {
        jobId,
        tenant,
        userId: authResult.userId,
        imageCount: 1,
      });

      const creditResult = await validateAndDebitCredits(
        tenant,
        authResult.userId,
        1, // 1 credit per image
        jobId,
        productId
      );

      if (!creditResult.success) {
        console.warn('Insufficient credits', {
          jobId,
          tenant,
          userId: authResult.userId,
          error: creditResult.error,
          errorCode: creditResult.errorCode,
        });

        return {
          statusCode: creditResult.httpStatus || 402,
          headers: {
            'Access-Control-Allow-Origin': '*',
          },
          body: JSON.stringify({
            error: 'Payment Required',
            message: creditResult.error || 'Insufficient credits',
            errorCode: creditResult.errorCode,
            jobId,
          }),
        };
      }

      // Track successful debit for potential refund
      creditTransactionId = creditResult.transactionId;
      creditsDebited = true;

      console.info('Credits debited successfully', {
        jobId,
        tenant,
        userId: authResult.userId,
        creditsUsed: creditResult.creditsUsed,
        newBalance: creditResult.newBalance,
        transactionId: creditResult.transactionId,
      });
    } else if (!creditsRequired) {
      console.info('Credits not required (dev mode)', {
        jobId,
        tenant,
        stage,
        requireCredits: creditsRequired,
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
      result = await processImageFromUrl(imageUrl, processingOptions, tenant);
    } else if (imageBase64) {
      result = await processImageFromBase64(imageBase64, 'image/png', processingOptions, tenant);
    } else {
      return {
        statusCode: 400,
        body: JSON.stringify(
          createProcessResult(false, undefined, undefined, 'No image provided', Date.now() - processingStartTime)
        ),
      };
    }

    // For dev: Return base64 data URL instead of uploading to S3
    // In production, this would upload to S3 and return a presigned URL
    const contentType = outputFormat === 'png' ? 'image/png' :
                       outputFormat === 'webp' ? 'image/webp' : 'image/jpeg';

    const base64Image = result.outputBuffer.toString('base64');
    const outputUrl = `data:${contentType};base64,${base64Image}`;

    const processingTimeMs = Date.now() - processingStartTime;

    console.info('Image processed successfully', {
      jobId,
      processingTimeMs,
      outputSize: base64Image.length,
      originalSize: result.metadata.originalSize,
      processedSize: result.metadata.processedSize,
      tenant,
      outputFormat,
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
      console.info('CarouselImageProcessed event emitted', { jobId, tenant });
    } catch (error) {
      console.error('Failed to emit CarouselImageProcessed event', {
        jobId,
        tenant,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        jobId,
        outputUrl,
        processingTimeMs,
        metadata: result.metadata,
        productDescription: result.productDescription,
        bilingualDescription: result.bilingualDescription,
      }),
    };
  } catch (error) {
    const processingTimeMs = Date.now() - processingStartTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    console.error('Image processing failed', {
      jobId,
      error: errorMessage,
      processingTimeMs,
      tenant,
    });

    // ===== CREDITS REFUND ON FAILURE =====
    // If we debited credits and processing failed, issue a refund
    if (creditsDebited && creditTransactionId && authResult.userId) {
      console.info('Initiating credit refund due to processing failure', {
        jobId,
        tenant,
        userId: authResult.userId,
        originalTransactionId: creditTransactionId,
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
          console.info('Credit refund successful', {
            jobId,
            tenant,
            userId: authResult.userId,
            newBalance: refundResult.newBalance,
            refundTransactionId: refundResult.transactionId,
          });
        } else {
          console.error('Credit refund failed', {
            jobId,
            tenant,
            userId: authResult.userId,
            error: refundResult.error,
            errorCode: refundResult.errorCode,
            originalTransactionId: creditTransactionId,
          });
          // Note: Don't fail the response - the processing already failed
          // This should be handled via dead-letter queue or manual reconciliation
        }
      } catch (refundError) {
        console.error('Credit refund exception', {
          jobId,
          tenant,
          userId: authResult.userId,
          error: refundError instanceof Error ? refundError.message : String(refundError),
          originalTransactionId: creditTransactionId,
        });
      }
    }
    // ===== END CREDITS REFUND =====

    // Handle validation errors
    if (error instanceof Error && error.name === 'ZodError') {
      return {
        statusCode: 400,
        body: JSON.stringify(
          createProcessResult(false, undefined, undefined, `Validation error: ${errorMessage}`, processingTimeMs)
        ),
      };
    }

    return {
      statusCode: 500,
      body: JSON.stringify(
        createProcessResult(false, undefined, undefined, errorMessage, processingTimeMs)
      ),
    };
  }
};



// Job status types
interface JobStatus {
  jobId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress?: number;
  result?: {
    success: boolean;
    outputUrl?: string;
    error?: string;
    processingTimeMs?: number;
    metadata?: {
      width: number;
      height: number;
      originalSize: number;
      processedSize: number;
    };
  };
  createdAt: string;
  updatedAt: string;
}

// In-memory job storage (for demo - use DynamoDB in production)
const jobStorage = new Map<string, JobStatus>();

exports.status = async (event: any) => {
   // Check if the request path matches /bg-remover/status/{jobId}
   const path = event.requestContext?.http?.path || '';
   const pathWithoutStage = path.replace(/^\/[^\/]+/, ''); // Remove stage prefix
   if (!event.pathParameters?.jobId || !pathWithoutStage?.startsWith('/bg-remover/status/')) {
     return {
       statusCode: 404,
       body: JSON.stringify({ message: 'Not Found' }),
     };
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
    });

    return {
      statusCode: 401,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'WWW-Authenticate': 'Bearer realm="bg-remover", error="invalid_token"',
      },
      body: JSON.stringify({
        error: 'Unauthorized',
        message: 'Valid JWT token required',
      }),
    };
  }
  // ===== END JWT AUTHENTICATION =====

  if (httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Tenant-Id',
      },
      body: '',
    };
  }

  if (httpMethod === 'GET') {
    try {
      const pathValidation = validatePathParams(event.pathParameters, ['jobId'], 'status-get');
      if (!pathValidation.success) {
        return {
          statusCode: 400,
          body: JSON.stringify({
            error: pathValidation.error?.message || 'Invalid path parameters',
            details: pathValidation.error?.details,
          }),
        };
      }

      const validation = validateRequest(JobStatusParamsSchema, { jobId }, 'job-status-params');
      if (!validation.success) {
        return {
          statusCode: 400,
          body: JSON.stringify({
            error: validation.error?.message || 'Invalid job ID format',
            details: validation.error?.details,
          }),
        };
      }

      const job = jobStorage.get(jobId);

      if (!job) {
        return {
          statusCode: 404,
          body: JSON.stringify({
            error: 'Job not found',
            jobId,
            message: 'The job may have expired or does not exist. Jobs are stored for 24 hours.',
          }),
        };
      }

      return {
        statusCode: 200,
        body: JSON.stringify({
          jobId: job.jobId,
          status: job.status,
          progress: job.progress,
          result: job.result,
          createdAt: job.createdAt,
          updatedAt: job.updatedAt,
          expiresAt: new Date(new Date(job.createdAt).getTime() + 24 * 60 * 60 * 1000).toISOString(),
        }),
      };
    } catch (error) {
      console.error('Error fetching job status', {
        jobId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      return {
        statusCode: 500,
        body: JSON.stringify({
          error: 'Internal server error',
          message: 'Failed to fetch job status',
        }),
      };
    }
  }

  if (httpMethod === 'DELETE') {
    try {
      const pathValidation = validatePathParams(event.pathParameters, ['jobId'], 'status-delete');
      if (!pathValidation.success) {
        return {
          statusCode: 400,
          body: JSON.stringify({
            error: pathValidation.error?.message || 'Invalid path parameters',
            details: pathValidation.error?.details,
          }),
        };
      }

      const validation = validateRequest(JobStatusParamsSchema, { jobId }, 'job-status-params');
      if (!validation.success) {
        return {
          statusCode: 400,
          body: JSON.stringify({
            error: validation.error?.message || 'Invalid job ID format',
            details: validation.error?.details,
          }),
        };
      }

      const job = jobStorage.get(jobId);

      if (!job) {
        return {
          statusCode: 404,
          body: JSON.stringify({ error: 'Job not found' }),
        };
      }

      if (job.status !== 'pending' && job.status !== 'processing') {
        return {
          statusCode: 409,
          body: JSON.stringify({
            error: 'Cannot cancel job',
            message: `Job is already ${job.status}`,
          }),
        };
      }

      job.status = 'failed';
      job.result = {
        success: false,
        error: 'Job cancelled by user',
      };
      job.updatedAt = new Date().toISOString();
      jobStorage.set(jobId, job);

      return {
        statusCode: 200,
        body: JSON.stringify({
          jobId,
          status: 'cancelled',
          message: 'Job has been cancelled',
        }),
      };
    } catch (error) {
      console.error('Error cancelling job', {
        jobId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Internal server error' }),
      };
    }
  }

  return {
    statusCode: 405,
    body: JSON.stringify({ message: 'Method Not Allowed' }),
  };
};

/**
 * Settings Handler
 * GET /bg-remover/settings - Retrieve similarity detection settings
 * PUT /bg-remover/settings - Update similarity detection settings
 */
exports.settings = async (event: any) => {
  console.log('Settings handler invoked', {
    httpMethod: event.requestContext?.http?.method,
    headers: event.headers,
  });

  const httpMethod = event.requestContext?.http?.method || 'GET';
  const stage = process.env.STAGE || 'dev';

  // Extract tenant from host header (e.g., api.dev.carousellabs.co -> carousel-labs)
  const host = event.headers?.host || '';
  const tenant = host.includes('carousellabs') ? 'carousel-labs' : 'hringekjan';

  // CORS headers
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  // Handle OPTIONS preflight
  if (httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: '',
    };
  }

  // ===== JWT AUTHENTICATION =====
  // Settings endpoint requires authentication (sensitive configuration)
  const requireAuth = stage === 'prod' || global.process.env.REQUIRE_AUTH === 'true';

  const authResult = await validateJWTFromEvent(event, undefined, {
    required: requireAuth
  });

  if (!authResult.isValid && requireAuth) {
    console.warn('Authentication failed for settings endpoint', {
      error: authResult.error,
      stage,
      path: event.requestContext?.http?.path,
    });

    return {
      statusCode: 401,
      headers: {
        ...corsHeaders,
        'WWW-Authenticate': 'Bearer realm="bg-remover", error="invalid_token"',
      },
      body: JSON.stringify({
        error: 'Unauthorized',
        message: 'Valid JWT token required',
        details: authResult.error,
      }),
    };
  }

  if (authResult.isValid && authResult.userId) {
    console.info('Authenticated settings request', {
      userId: authResult.userId,
      email: authResult.email,
      method: httpMethod,
    });
  }
  // ===== END JWT AUTHENTICATION =====

  const ssmClient = new SSMClient({ region: process.env.AWS_REGION || 'eu-west-1' });
  const ssmPath = `/tf/${stage}/${tenant}/services/bg-remover/settings`;

  // Default settings
  const defaultSettings = {
    detectDuplicates: true,
    groupByColor: true,
    duplicateThreshold: 0.85,  // Lowered from 0.95 for bg-removed images
    colorGroups: 3,
    maxImagesPerGroup: 10,
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

      console.log('Retrieved settings from SSM', { ssmPath, settings });

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings }),
      };
    } catch (error: any) {
      if (error.name === 'ParameterNotFound') {
        console.log('Settings parameter not found, returning defaults', { ssmPath });
        return {
          statusCode: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ settings: defaultSettings }),
        };
      }

      console.error('Error retrieving settings from SSM', {
        error: error.message,
        ssmPath,
      });

      return {
        statusCode: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: 'Failed to retrieve settings',
          message: error.message,
        }),
      };
    }
  }

  // PUT - Update settings
  if (httpMethod === 'PUT') {
    try {
      const body = JSON.parse(event.body || '{}');
      const { settings } = body;

      // Validate settings
      if (!settings || typeof settings !== 'object') {
        return {
          statusCode: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            error: 'Invalid request body',
            message: 'Settings object is required',
          }),
        };
      }

      // Validate settings fields
      const validationErrors: string[] = [];
      if (typeof settings.detectDuplicates !== 'boolean') {
        validationErrors.push('detectDuplicates must be a boolean');
      }
      if (typeof settings.groupByColor !== 'boolean') {
        validationErrors.push('groupByColor must be a boolean');
      }
      if (typeof settings.duplicateThreshold !== 'number' || settings.duplicateThreshold < 0 || settings.duplicateThreshold > 1) {
        validationErrors.push('duplicateThreshold must be a number between 0 and 1');
      }
      if (typeof settings.colorGroups !== 'number' || settings.colorGroups < 1 || settings.colorGroups > 10) {
        validationErrors.push('colorGroups must be a number between 1 and 10');
      }
      if (typeof settings.maxImagesPerGroup !== 'number' || settings.maxImagesPerGroup < 1) {
        validationErrors.push('maxImagesPerGroup must be a positive number');
      }

      if (validationErrors.length > 0) {
        return {
          statusCode: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            error: 'Invalid settings',
            details: validationErrors,
          }),
        };
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

      console.log('Saved settings to SSM', { ssmPath, settings });

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: true,
          settings,
          message: 'Settings saved successfully',
        }),
      };
    } catch (error: any) {
      console.error('Error saving settings to SSM', {
        error: error.message,
        ssmPath,
      });

      return {
        statusCode: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: 'Failed to save settings',
          message: error.message,
        }),
      };
    }
  }

  return {
    statusCode: 405,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: 'Method Not Allowed' }),
  };
};
