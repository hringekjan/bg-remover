import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { BaseHandler } from './base-handler';
import { resolveTenantFromRequest } from '../lib/tenant/resolver';
import { validateJWTFromEvent } from '../lib/auth/jwt-validator';
import { loadTenantCognitoConfig } from '../lib/tenant/cognito-config';
import { generateDownloadUrl, getOutputBucket } from '../../lib/s3/client';
import { verifyJobToken } from '../lib/job-token';
import { createTenantCorsHeaders } from '../lib/cors';
import { extractRequestId } from '../lib/errors';
import { logSecurityEvent } from '../lib/logger';

const dynamoDB = new DynamoDBClient({});
const tableName = process.env.DYNAMODB_TABLE || `carousel-main-${process.env.STAGE || 'dev'}`;

function sanitizeOutputUrl(value?: string): string | undefined {
  if (!value) return value;
  if (value.startsWith('data:')) return undefined;
  return value;
}

async function resolveOutputUrl(
  tenant: string,
  stage: string,
  outputKey?: string,
  outputUrl?: string
): Promise<string | undefined> {
  if (outputKey) {
    const bucket = await getOutputBucket(tenant, stage);
    return generateDownloadUrl(bucket, outputKey, 3600);
  }
  return sanitizeOutputUrl(outputUrl);
}

/**
 * Status Handler - Job Status Polling
 *
 * Allows clients to poll for job status and results.
 * Supports GET (retrieve status) and DELETE (cancel job).
 *
 * Response statuses:
 * - pending: Job queued, not yet started
 * - processing: Job currently being processed
 * - completed: Job finished successfully (includes result)
 * - failed: Job failed (includes error message)
 * - cancelled: Job was cancelled by user
 */
export class StatusHandler extends BaseHandler {
  private async resolveCorsTenant(event: any, stage: string): Promise<string> {
    try {
      return await resolveTenantFromRequest(event, stage);
    } catch (error) {
      console.warn('CORS tenant resolution failed, using default', {
        error: error instanceof Error ? error.message : String(error),
      });
      return process.env.TENANT || 'carousel-labs';
    }
  }

  private createCorsHeaders(event: any, tenant: string): Record<string, string> {
    const corsHeaders = createTenantCorsHeaders(event, tenant);
    return {
      ...corsHeaders,
      'Vary': 'Origin, Authorization, X-Tenant-Id',
    };
  }

  private createCorsJsonResponse(
    body: any,
    statusCode: number,
    corsHeaders: Record<string, string>,
    additionalHeaders: Record<string, string> = {}
  ): any {
    return this.createJsonResponse(body, statusCode, {
      ...corsHeaders,
      ...additionalHeaders,
    });
  }

  private createCorsErrorResponse(
    message: string,
    statusCode: number,
    corsHeaders: Record<string, string>,
    details?: any,
    additionalHeaders: Record<string, string> = {}
  ): any {
    const errorBody = {
      error: message,
      ...(details && { details }),
      timestamp: new Date().toISOString(),
    };

    return this.createCorsJsonResponse(errorBody, statusCode, corsHeaders, {
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      'Pragma': 'no-cache',
      'Expires': '0',
      ...additionalHeaders,
    });
  }

  async handle(event: any): Promise<any> {
    console.log('Status function called', JSON.stringify(event, null, 2));
    const httpMethod = event.requestContext?.http?.method || event.httpMethod;
    const stage = this.context.stage;
    const corsTenant = await this.resolveCorsTenant(event, stage);
    const corsHeaders = this.createCorsHeaders(event, corsTenant);
    const requestId = extractRequestId(event);

    if (httpMethod === 'OPTIONS') {
      return this.createCorsJsonResponse('', 200, corsHeaders, {
        'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
      });
    }

    const jobId = event.pathParameters?.jobId;
    const jobToken =
      event.queryStringParameters?.jobToken ||
      event.headers?.['x-job-token'] ||
      event.headers?.['X-Job-Token'];

    // 🔧 FIX: Extract pagination parameters for progressive rendering
    const offset = Math.max(0, parseInt(event.queryStringParameters?.offset || '0', 10));
    const limit = Math.min(50, Math.max(1, parseInt(event.queryStringParameters?.limit || '10', 10)));

    // ===== TENANT RESOLUTION (BEFORE AUTH) =====
    let tenant: string;
    let authResult = { isValid: false, userId: undefined as string | undefined, error: undefined as string | undefined };

    if (!jobId) {
      return this.createCorsErrorResponse('jobId path parameter is required', 400, corsHeaders);
    }

    if (httpMethod === 'GET' && jobToken) {
      const tokenResult = verifyJobToken(jobToken);
      if (tokenResult.valid && tokenResult.payload && tokenResult.payload.jobId === jobId) {
        tenant = tokenResult.payload.tenant;
        authResult = { isValid: true, userId: tokenResult.payload.userId, error: undefined };
        logSecurityEvent('auth_success', {
          authMethod: 'job_token',
          tenant,
          jobId,
          userId: tokenResult.payload.userId,
          requestId,
        });
      } else {
        console.warn('Job token invalid, falling back to JWT auth', {
          jobId,
          reason: tokenResult.reason,
        });
        logSecurityEvent('auth_failure', {
          authMethod: 'job_token',
          jobId,
          reason: tokenResult.reason,
          requestId,
        });
      }
    }

    if (!authResult.isValid) {
      try {
        tenant = await resolveTenantFromRequest(event, stage);
        console.info('Resolved tenant for status request', { tenant, jobId });
      } catch (error) {
        console.error('Tenant resolution failed, using default', {
          error: error instanceof Error ? error.message : String(error),
          jobId,
        });
        tenant = process.env.TENANT || 'carousel-labs';
      }

      // ===== JWT AUTHENTICATION (WITH TENANT-SPECIFIC CONFIG) =====
      // Always validate JWT token (API Gateway authorizer provides primary auth, this is defense in depth)
      const requireAuth = true;

      // Load tenant-specific Cognito configuration for JWT validation
      let cognitoConfig;
      try {
        cognitoConfig = await loadTenantCognitoConfig(tenant, stage);
        console.debug('Using Cognito config for tenant', {
          tenant,
          userPoolId: cognitoConfig.userPoolId,
          jobId,
        });
      } catch (error) {
        console.error('Failed to load tenant Cognito config, falling back to default', {
          tenant,
          error: error instanceof Error ? error.message : String(error),
          jobId,
        });
        // Continue with default config on error - loadTenantCognitoConfig already has fallback
        cognitoConfig = undefined;
      }

      authResult = await validateJWTFromEvent(event, cognitoConfig, {
        required: requireAuth
      });

      if (!authResult.isValid && requireAuth) {
        logSecurityEvent('auth_failure', {
          authMethod: 'jwt',
          tenant,
          jobId,
          error: authResult.error,
          requestId,
        });
        console.warn('Authentication failed', {
          error: authResult.error,
          tenant,
          stage,
          path: event.requestContext?.http?.path,
          jobId,
        });

        return this.createCorsErrorResponse(
          'Valid JWT token required',
          401,
          corsHeaders,
          undefined,
          {
            'WWW-Authenticate': 'Bearer realm="bg-remover", error="invalid_token"',
          }
        );
      } else if (authResult.isValid && authResult.userId) {
        logSecurityEvent('auth_success', {
          authMethod: 'jwt',
          tenant,
          jobId,
          userId: authResult.userId,
          email: authResult.email,
          groups: authResult.groups,
          requestId,
        });
      }
      // ===== END JWT AUTHENTICATION =====
    }

    console.info('Status request', {
      jobId,
      tenant,
      method: httpMethod,
      userId: authResult.userId || 'anonymous',
    });

    if (httpMethod === 'GET') {
      return this.getJobStatus(tenant, jobId, authResult.userId, corsHeaders, offset, limit);
    } else if (httpMethod === 'DELETE') {
      return this.cancelJob(tenant, jobId, authResult.userId, corsHeaders);
    } else {
      return this.createCorsErrorResponse('Method Not Allowed', 405, corsHeaders);
    }
  }

  /**
   * Get job status from DynamoDB
   */
  private async getJobStatus(
    tenant: string,
    jobId: string,
    userId: string | undefined,
    corsHeaders: Record<string, string>,
    offset: number = 0,
    limit: number = 10
  ): Promise<any> {
    const pk = `TENANT#${tenant}#BG_REMOVER_JOB#${jobId}`;
    const sk = 'METADATA';

    try {
      const result = await dynamoDB.send(new GetItemCommand({
        TableName: tableName,
        Key: {
          PK: { S: pk },
          SK: { S: sk },
        },
      }));

      if (!result.Item) {
        console.warn('Job not found', { tenant, jobId });
        return this.createCorsErrorResponse('Job not found', 404, corsHeaders);
      }

      const job = unmarshall(result.Item);

      // Authorization check: Only allow access if user owns the job (in prod)
      const stage = this.context.stage;
      if (stage === 'prod' && userId && job.userId !== userId) {
        console.warn('Unauthorized access attempt', {
          tenant,
          jobId,
          requestingUser: userId,
          jobOwner: job.userId,
        });
        return this.createCorsErrorResponse('Not authorized to access this job', 403, corsHeaders);
      }

      // Build response based on status
      const response: any = {
        success: true,
        jobId: job.jobId,
        status: job.status,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      };

      // Add resumable state information if available
      if (job.resumable) {
        response.resumable = true;
        response.canResume = job.canResume || (job.status === 'failed' && job.progress?.failed < job.progress?.total);

        if (job.progress) {
          response.progress = job.progress;
        }

        if (job.images) {
          // Summarize image statuses without exposing full details
          const imageSummary = {
            total: job.images.length,
            completed: job.images.filter((img: any) => img.status === 'completed').length,
            failed: job.images.filter((img: any) => img.status === 'failed').length,
            processing: job.images.filter((img: any) => img.status === 'processing').length,
            pending: job.images.filter((img: any) => img.status === 'pending').length,
          };
          response.imageSummary = imageSummary;
        }

        if (job.resumeAttempt) {
          response.resumeAttempt = job.resumeAttempt;
        }

        if (job.resumedAt) {
          response.resumedAt = job.resumedAt;
        }
      }

      // Add additional fields based on status
      if (job.status === 'completed') {
        response.outputUrl = await resolveOutputUrl(tenant, stage, job.outputKey, job.outputUrl);
        response.processingTimeMs = job.processingTimeMs;
        // 🔧 FIX: Strip metadata and description fields to prevent 413 Content Too Large
        // These fields can contain large nested objects or bilingual content (200KB+)
        // Clients can request full metadata via separate endpoint if needed
        // response.metadata = job.metadata;
        // response.productDescription = job.productDescription;
        // response.multilingualDescription = job.multilingualDescription;
        // response.bilingualDescription = job.bilingualDescription;
        response.completedAt = job.completedAt;

        // For batch jobs, include processed images with pagination
        // 🔧 FIX: Return minimal payload with pagination to prevent 413 Content Too Large
        if (job.processedImages) {
          const allImages = job.processedImages;
          const totalImages = allImages.length;

          // Slice images based on pagination params
          const paginatedImages = allImages.slice(offset, offset + limit);

          // Return minimal fields for paginated subset
          response.processedImages = await Promise.all(
            paginatedImages.map(async (img: any) => {
              const resolvedUrl = await resolveOutputUrl(tenant, stage, img.outputKey, img.outputUrl);
              // Return ONLY minimal fields - strip description to prevent 413 error
              return {
                imageId: img.imageId,
                processedUrl: resolvedUrl || img.outputUrl,
                width: img.width || img.metadata?.width,
                height: img.height || img.metadata?.height,
                status: img.status,
                processingTimeMs: img.processingTimeMs || img.metadata?.processingTimeMs || 0,
              };
            })
          );

          // Add pagination metadata for progressive rendering
          response.pagination = {
            offset,
            limit,
            totalImages,
            returnedImages: paginatedImages.length,
            hasMore: offset + limit < totalImages,
            nextOffset: offset + limit < totalImages ? offset + limit : null,
          };

          console.info('Job status pagination', {
            jobId,
            totalImages,
            offset,
            limit,
            returnedImages: paginatedImages.length,
            hasMore: offset + limit < totalImages,
          });
        }
      } else if (job.status === 'failed') {
        response.error = job.error;
        response.errorDetails = job.errorDetails;
        response.completedAt = job.completedAt;
        response.refundStatus = job.refundStatus;
        response.refundTransactionId = job.refundTransactionId;

        // For batch jobs, include group information
        if (job.groupId) {
          response.groupId = job.groupId;
          response.productName = job.productName;
        }
      } else if (job.status === 'processing') {
        response.startedAt = job.startedAt;

        // For batch jobs, include group information
        if (job.groupId) {
          response.groupId = job.groupId;
          response.productName = job.productName;
          response.pipeline = job.pipeline;
        }
      }

      console.info('Job status retrieved', { tenant, jobId, status: job.status });

      return this.createCorsJsonResponse(response, 200, corsHeaders);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      console.error('Failed to get job status', {
        tenant,
        jobId,
        error: errorMessage,
        errorName: error instanceof Error ? error.name : 'Unknown',
        tableName,
      });

      // Classify DynamoDB errors for appropriate HTTP status codes
      if (error instanceof Error) {
        // Throttling errors - temporary issue, client should retry
        if (error.name === 'ProvisionedThroughputExceededException' ||
            error.name === 'RequestLimitExceeded') {
          return this.createCorsErrorResponse(
            'Service temporarily unavailable. Please retry in a few seconds.',
            503,
            corsHeaders
          );
        }

        // Permission errors - configuration issue
        if (error.name === 'AccessDeniedException') {
          console.error('CRITICAL: DynamoDB permission denied', { tenant, jobId });
          return this.createCorsErrorResponse(
            'Unable to retrieve job status. Please contact support.',
            500,
            corsHeaders
          );
        }

        // Table not found - deployment issue
        if (error.name === 'ResourceNotFoundException') {
          console.error('CRITICAL: DynamoDB table not found', { tableName, tenant });
          return this.createCorsErrorResponse(
            'Service configuration error. Please contact support.',
            500,
            corsHeaders
          );
        }
      }

      // Generic error - sanitize message in production
      const userMessage = this.context.stage === 'prod'
        ? 'Failed to retrieve job status. Please try again later.'
        : errorMessage;

      return this.createCorsErrorResponse(userMessage, 500, corsHeaders);
    }
  }

  /**
   * Cancel a pending or processing job
   */
  private async cancelJob(
    tenant: string,
    jobId: string,
    userId: string | undefined,
    corsHeaders: Record<string, string>
  ): Promise<any> {
    const pk = `TENANT#${tenant}#BG_REMOVER_JOB#${jobId}`;
    const sk = 'METADATA';

    try {
      // First, get the current job to check ownership and status
      const getResult = await dynamoDB.send(new GetItemCommand({
        TableName: tableName,
        Key: {
          PK: { S: pk },
          SK: { S: sk },
        },
      }));

      if (!getResult.Item) {
        console.warn('Job not found for cancellation', { tenant, jobId });
        return this.createCorsErrorResponse('Job not found', 404, corsHeaders);
      }

      const job = unmarshall(getResult.Item);

      // Authorization check
      const stage = this.context.stage;
      if (stage === 'prod' && userId && job.userId !== userId) {
        console.warn('Unauthorized cancellation attempt', {
          tenant,
          jobId,
          requestingUser: userId,
          jobOwner: job.userId,
        });
        return this.createCorsErrorResponse('Not authorized to cancel this job', 403, corsHeaders);
      }

      // Check if job can be cancelled
      if (job.status === 'completed' || job.status === 'failed') {
        return this.createCorsErrorResponse(
          `Cannot cancel job with status: ${job.status}`,
          400,
          corsHeaders
        );
      }

      if (job.status === 'cancelled') {
        return this.createCorsJsonResponse({
          success: true,
          jobId,
          status: 'cancelled',
          message: 'Job already cancelled',
        }, 200, corsHeaders);
      }

      // Update job status to cancelled
      await dynamoDB.send(new UpdateItemCommand({
        TableName: tableName,
        Key: {
          PK: { S: pk },
          SK: { S: sk },
        },
        UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt, cancelledAt = :cancelledAt',
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: marshall({
          ':status': 'cancelled',
          ':updatedAt': new Date().toISOString(),
          ':cancelledAt': new Date().toISOString(),
        }),
      }));

      console.info('Job cancelled successfully', { tenant, jobId, previousStatus: job.status });

      // Note: The worker Lambda should check job status before processing
      // and abort if status is 'cancelled'

      return this.createCorsJsonResponse({
        success: true,
        jobId,
        status: 'cancelled',
        message: 'Job cancelled successfully',
        previousStatus: job.status,
      }, 200, corsHeaders);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      console.error('Failed to cancel job', {
        tenant,
        jobId,
        error: errorMessage,
      });

      return this.createCorsErrorResponse(errorMessage, 500, corsHeaders);
    }
  }
}

// Export the handler function for Lambda
export const status = async (event: any) => {
  try {
    const handler = new StatusHandler();
    return await handler.handle(event);
  } catch (error) {
    const stage = process.env.STAGE || 'dev';
    let tenant = process.env.TENANT || 'carousel-labs';
    try {
      tenant = await resolveTenantFromRequest(event, stage);
    } catch (tenantError) {
      console.warn('Fallback tenant used for error response', {
        error: tenantError instanceof Error ? tenantError.message : String(tenantError),
      });
    }

    const corsHeaders = createTenantCorsHeaders(event, tenant);

    // Catch ANY uncaught exception to prevent Lambda crashes that return HTML
    console.error('CRITICAL: Unhandled error in status handler', {
      error: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : 'Unknown',
      errorStack: error instanceof Error ? error.stack : undefined,
      path: event.requestContext?.http?.path,
      jobId: event.pathParameters?.jobId,
    });

    // Always return JSON with proper Content-Type to prevent HTML responses
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders,
        'Vary': 'Origin, Authorization, X-Tenant-Id',
      },
      body: JSON.stringify({
        error: 'Internal server error',
        message: process.env.STAGE === 'prod'
          ? 'An unexpected error occurred'
          : (error instanceof Error ? error.message : 'Unknown error'),
        timestamp: new Date().toISOString(),
      }),
    };
  }
};
