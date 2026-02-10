import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { BaseHandler } from './base-handler';
import { resolveTenantFromRequest } from '../lib/tenant/resolver';
import { validateJWTFromEvent } from '../lib/auth/jwt-validator';
import { loadTenantCognitoConfig } from '../lib/tenant/cognito-config';
import { createTenantCorsHeaders } from '../lib/cors';
import { extractRequestId } from '../lib/errors';
import { logSecurityEvent } from '../lib/logger';
import { generateDownloadUrl, getOutputBucket } from '../../lib/s3/client';

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
 * Batch Status Handler - Aggregated Multi-Job Status Polling
 *
 * Allows clients to poll for status of multiple jobs using a single requestId.
 * Reduces API calls from N jobs to 1 request per polling cycle.
 *
 * Endpoint: GET /bg-remover/status/batch/{requestId}
 *
 * Query Strategy:
 * - Uses GSI2 for efficient lookup (GSI2PK = REQUEST#{requestId})
 * - Single query operation, no table scans
 * - Only works for jobs created after GSI2 implementation
 * - Old jobs without GSI2PK can be cleaned up using cleanup-jobs-without-gsi2.ts script
 *
 * Response includes:
 * - All child job statuses
 * - Aggregated progress across all jobs
 * - Overall completion status
 */
export class BatchStatusHandler extends BaseHandler {
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

  private buildTenantCorsHeaders(event: any, tenant: string): Record<string, string> {
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
    console.log('Batch Status function called', JSON.stringify(event, null, 2));
    const httpMethod = event.requestContext?.http?.method || event.httpMethod;
    const stage = this.context.stage;
    const corsTenant = await this.resolveCorsTenant(event, stage);
    const corsHeaders = this.buildTenantCorsHeaders(event, corsTenant);
    const traceRequestId = extractRequestId(event);

    if (httpMethod === 'OPTIONS') {
      return this.createCorsJsonResponse('', 200, corsHeaders, {
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
      });
    }

    const batchRequestId = event.pathParameters?.requestId;

    if (!batchRequestId) {
      return this.createCorsErrorResponse('requestId path parameter is required', 400, corsHeaders);
    }

    // Validate requestId is not empty
    if (!batchRequestId.trim()) {
      return this.createCorsErrorResponse('Invalid requestId format', 400, corsHeaders);
    }

    // ===== TENANT RESOLUTION =====
    let tenant: string;
    try {
      tenant = await resolveTenantFromRequest(event, stage);
      console.info('Resolved tenant for batch status request', { tenant, batchRequestId });
    } catch (error) {
      console.error('Tenant resolution failed, using default', {
        error: error instanceof Error ? error.message : String(error),
        batchRequestId,
      });
      tenant = process.env.TENANT || 'carousel-labs';
    }

    // ===== JWT AUTHENTICATION =====
    const requireAuth = true;

    // Load tenant-specific Cognito configuration for JWT validation
    let cognitoConfig;
    try {
      cognitoConfig = await loadTenantCognitoConfig(tenant, stage);
      console.debug('Using Cognito config for tenant', {
        tenant,
        userPoolId: cognitoConfig.userPoolId,
        batchRequestId,
      });
    } catch (error) {
      console.error('Failed to load tenant Cognito config, falling back to default', {
        tenant,
        error: error instanceof Error ? error.message : String(error),
        batchRequestId,
      });
      cognitoConfig = undefined;
    }

    const authResult = await validateJWTFromEvent(event, cognitoConfig, {
      required: requireAuth,
      expectedTenant: tenant,
      enforceTenantMatch: true,
    });

    if (!authResult.isValid && requireAuth) {
      logSecurityEvent('auth_failure', {
        authMethod: 'jwt',
        tenant,
        batchRequestId,
        error: authResult.error,
        requestId: traceRequestId,
      });
      console.warn('Authentication failed', {
        error: authResult.error,
        tenant,
        stage,
        path: event.requestContext?.http?.path,
        batchRequestId,
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
        batchRequestId,
        userId: authResult.userId,
        email: authResult.email,
        groups: authResult.groups,
        requestId: traceRequestId,
      });
    }

    console.info('Batch status request', {
      batchRequestId,
      tenant,
      method: httpMethod,
      userId: authResult.userId || 'anonymous',
    });

    if (httpMethod === 'GET') {
      return this.getBatchStatus(tenant, batchRequestId, authResult.userId, corsHeaders);
    }

    return this.createCorsErrorResponse('Method not allowed', 405, corsHeaders);
  }

  private async getBatchStatus(
    tenant: string,
    batchRequestId: string,
    userId: string | undefined,
    corsHeaders: Record<string, string>
  ): Promise<any> {
    try {
      // Query GSI2 for all jobs with this requestId
      // GSI2PK = REQUEST#{requestId}
      // GSI2SK = TENANT#{tenant}#JOB#{jobId}
      const gsi2pk = `REQUEST#${batchRequestId}`;

      console.log('[BatchStatus] Querying GSI2 for batch request', {
        tableName,
        gsi2pk,
        batchRequestId,
        tenant,
      });

      const result = await dynamoDB.send(new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :gsi2pk',
        ExpressionAttributeValues: {
          ':gsi2pk': { S: gsi2pk },
        },
      }));

      console.log('[BatchStatus] GSI2 query result', {
        itemCount: result.Items?.length || 0,
        tenant,
        batchRequestId,
      });

      if (!result.Items || result.Items.length === 0) {
        console.warn('[BatchStatus] No jobs found for batch request', {
          tenant,
          batchRequestId,
          gsi2pk,
        });
        return this.createCorsErrorResponse('No jobs found for this batch request', 404, corsHeaders);
      }

      const jobs = result.Items.map(item => unmarshall(item));

      // Authorization check: Verify user owns at least one job
      const stage = this.context.stage;
      if (stage === 'prod' && userId) {
        const userOwnsJob = jobs.some(job => job.userId === userId);
        if (!userOwnsJob) {
          console.warn('Unauthorized batch access attempt', {
            tenant,
            batchRequestId,
            userId,
          });
          return this.createCorsErrorResponse('Unauthorized', 403, corsHeaders);
        }
      }

      // Aggregate progress across all jobs
      const aggregatedProgress = {
        total: 0,
        completed: 0,
        failed: 0,
        processing: 0,
        pending: 0,
      };

      const jobStatuses: any[] = [];
      let allCompleted = true;
      let anyFailed = false;

      for (const job of jobs) {
        // Add to aggregated progress
        if (job.progress) {
          aggregatedProgress.total += job.progress.total || 0;
          aggregatedProgress.completed += job.progress.completed || 0;
          aggregatedProgress.failed += job.progress.failed || 0;
          aggregatedProgress.processing += job.progress.processing || 0;
          aggregatedProgress.pending += job.progress.pending || 0;
        }

        // Track overall status
        if (job.status !== 'completed' && job.status !== 'failed') {
          allCompleted = false;
        }
        if (job.status === 'failed') {
          anyFailed = true;
        }

        // Enrich processedImages with full metadata from group-level fields
        // For batch jobs, metadata is stored at the job level (productName, multilingualDescription, etc.)
        // not on individual images to avoid DynamoDB size limits
        let enrichedProcessedImages: any[] = [];
        if (job.processedImages && Array.isArray(job.processedImages)) {
          enrichedProcessedImages = await Promise.all(
            job.processedImages.map(async (img: any) => {
              const resolvedUrl = await resolveOutputUrl(tenant, this.context.stage, img.outputKey, img.outputUrl);

              // Use group-level metadata from job record (shared across all images in the group)
              const bilingualDescription = job.multilingualDescription ? {
                en: {
                  title: job.productName || 'Product',
                  short: job.multilingualDescription.en?.short,
                  description: job.multilingualDescription.en?.long || job.multilingualDescription.en?.short,
                },
                is: {
                  title: job.productName || 'Product',
                  short: job.multilingualDescription.is?.short,
                  description: job.multilingualDescription.is?.long || job.multilingualDescription.is?.short,
                },
              } : undefined;

              return {
                imageId: img.imageId,
                processedUrl: resolvedUrl || img.outputUrl,
                width: img.width || img.metadata?.width,
                height: img.height || img.metadata?.height,
                status: img.status,
                processingTimeMs: img.processingTimeMs || img.metadata?.processingTimeMs || 0,
                // Add group-level metadata for display (shared across all images)
                productName: job.productName,
                bilingualDescription,
                price: job.groupPricing?.suggested,
                keywords: job.seoKeywords?.slice(0, 5), // First 5 SEO keywords only
                category: job.category,
                rating: job.predictedRating,
              };
            })
          );
        }

        // Build job status response
        jobStatuses.push({
          jobId: job.jobId,
          status: job.status,
          progress: job.progress || { total: 0, completed: 0, failed: 0, processing: 0, pending: 0 },
          images: job.images || [],
          processedImages: enrichedProcessedImages,
          error: job.error,
          createdAt: job.createdAt,
          updatedAt: job.updatedAt,
        });
      }

      // Determine overall batch status
      let batchStatus = 'processing';
      if (allCompleted) {
        batchStatus = anyFailed ? 'completed_with_errors' : 'completed';
      }

      const response = {
        success: true,
        requestId: batchRequestId,
        status: batchStatus,
        jobs: jobStatuses,
        aggregatedProgress,
        allCompleted,
        totalJobs: jobs.length,
        timestamp: new Date().toISOString(),
      };

      console.log('[BatchStatus] Batch status retrieved', {
        tenant,
        batchRequestId,
        totalJobs: jobs.length,
        batchStatus,
        aggregatedProgress,
      });

      return this.createCorsJsonResponse(response, 200, corsHeaders, {
        'Cache-Control': allCompleted ? 'public, max-age=300' : 'no-cache',
      });

    } catch (error) {
      console.error('[BatchStatus] Error retrieving batch status', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        tenant,
        batchRequestId,
      });

      return this.createCorsErrorResponse(
        'Failed to retrieve batch status',
        500,
        corsHeaders,
        { message: error instanceof Error ? error.message : 'Unknown error' }
      );
    }
  }
}

export const handler = (event: any, context: any) => {
  const handlerInstance = new BatchStatusHandler(context);
  return handlerInstance.handle(event);
};
