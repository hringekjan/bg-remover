import { randomUUID } from 'crypto';
import { BaseHandler } from './base-handler';
import { GroupImagesRequestSchema, type GroupImagesRequest } from '../lib/types';
import { validateRequest } from '../lib/validation';
import { resolveTenantFromRequest } from '../lib/tenant/resolver';
import { batchProcessForGrouping } from '../lib/product-identity/product-identity-service';
import { getServiceEndpoint } from '../lib/tenant/config';
import { loadConfig } from '../lib/config/loader';
import { getModelForTask, PIPELINES, type ProcessingPipeline } from '../lib/bedrock/model-registry';
import { DynamoDBClient, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const dynamoDB = new DynamoDBClient({});
const lambdaClient = new LambdaClient({});
const tableName = process.env.DYNAMODB_TABLE!;

/**
 * Group Images Handler - Phase 1: Async Grouping Coordinator
 *
 * Async workflow to avoid API Gateway 30s timeout:
 * 1. Accept grouping request and create job in DynamoDB
 * 2. Invoke async worker for actual processing
 * 3. Return job ID immediately for status polling
 * 4. Worker generates thumbnails, embeddings, and clustering
 * 5. Store results for status endpoint retrieval
 */
export class GroupImagesHandler extends BaseHandler {
  /**
    * Helper methods for standard responses
    */
  protected success(data: any, statusCode: number = 200): any {
    return this.createJsonResponse(data, statusCode);
  }

  protected badRequest(error: any): any {
    return this.createErrorResponse(error.message || 'Bad Request', 400, error);
  }

  protected internalError(error: any): any {
    return this.createErrorResponse(error.message || 'Internal Server Error', 500, error);
  }

  /**
   * Fast tenant resolution - skip expensive JWT operations for quicker response
   */
  private async resolveTenantFast(event: any, stage: string): Promise<string> {
    // Strategy 1: Check X-Tenant-ID header (fastest)
    const headers = event.headers || {};
    const tenantHeader = headers['x-tenant-id'] || headers['X-Tenant-ID'] || headers['X-Tenant-Id'];
    if (tenantHeader && typeof tenantHeader === 'string' && tenantHeader.trim()) {
      return tenantHeader.trim().toLowerCase();
    }

    // Strategy 2: Domain-based resolution from Host header
    const host = headers['host'] || headers['Host'] || '';
    if (host) {
      const tenant = this.extractTenantFromHost(host);
      if (tenant) {
        return tenant;
      }
    }

    // Strategy 3: Domain-based resolution from Origin header
    const origin = headers['origin'] || headers['Origin'] || '';
    if (origin) {
      try {
        const originHost = new URL(origin).host;
        const tenant = this.extractTenantFromHost(originHost);
        if (tenant) {
          return tenant;
        }
      } catch (error) {
        // Skip invalid URLs
      }
    }

    // Strategy 4: Path parameters
    const pathParams = event.pathParameters || {};
    if (pathParams.tenant) {
      return pathParams.tenant.toLowerCase();
    }

    // Strategy 5: Environment variable default
    const envTenant = process.env.TENANT;
    if (envTenant) {
      return envTenant.toLowerCase();
    }

    // Fallback to carousel-labs
    return 'carousel-labs';
  }

  /**
   * Extract tenant from hostname (simplified version)
   */
  private extractTenantFromHost(host: string): string | null {
    const hostname = host.split(':')[0].toLowerCase();

    // Pattern: {tenant}.carousellabs.co or {tenant}.dev.carousellabs.co
    const carouselPattern = /^([a-z0-9-]+)\.(?:dev\.|prod\.)?carousellabs\.co$/;
    const carouselMatch = hostname.match(carouselPattern);
    if (carouselMatch) {
      const tenant = carouselMatch[1];
      if (!['api', 'auth', 'www', 'app', 'admin'].includes(tenant)) {
        return tenant;
      }
    }

    // Pattern: carousel.{tenant}.is
    const icelandicPattern = /^carousel\.([a-z0-9-]+)\.is$/;
    const icelandicMatch = hostname.match(icelandicPattern);
    if (icelandicMatch) {
      return icelandicMatch[1];
    }

    // Special cases
    if (hostname === 'carousel.hringekjan.is' || hostname === 'carousel.dev.hringekjan.is' ||
        hostname === 'api.hringekjan.is' || hostname === 'api.dev.hringekjan.is') {
      return 'hringekjan';
    }

    if (hostname === 'hringekjan.is' || hostname.endsWith('.hringekjan.is')) {
      return 'hringekjan';
    }

    return null;
  }

  /**
   * Invoke worker asynchronously with proper error handling and timeout protection
   * OPTIMIZATION: Removed config loading from main thread to prevent timeout
   */
  private async invokeWorkerAsync(
    jobId: string,
    tenant: string,
    stage: string,
    images: any[],
    thumbnailSize: any,
    similarityThreshold: number,
    includeExistingEmbeddings: boolean,
    workerFunctionName: string,
    requestId: string
  ): Promise<void> {
    try {
      // Prepare worker payload (config loading moved to worker to avoid blocking response)
      const workerPayload = {
        jobId,
        tenant,
        stage,
        images,
        thumbnailSize,
        similarityThreshold,
        includeExistingEmbeddings,
        requestId,
      };

      // Invoke grouping worker asynchronously with timeout protection
      const invokeCommand = new InvokeCommand({
        FunctionName: workerFunctionName,
        InvocationType: 'Event', // Async invocation - fire and forget
        Payload: Buffer.from(JSON.stringify(workerPayload)),
      });

      // Add timeout to Lambda invocation (should be fast, but protect against hangs)
      const invokePromise = lambdaClient.send(invokeCommand);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Lambda invocation timeout')), 10000) // 10s timeout
      );

      await Promise.race([invokePromise, timeoutPromise]);

      console.log('[GroupImages] Grouping worker invoked asynchronously', {
        jobId,
        workerFunctionName,
        tenant,
        imageCount: images.length,
      });

    } catch (error: any) {
      console.error('[GroupImages] Failed to invoke grouping worker', {
        jobId,
        workerFunctionName,
        error: error instanceof Error ? error.message : String(error),
        imageCount: images.length,
      });

      // Update job status to failed with detailed error info
      await this.updateJobStatus(jobId, tenant, 'failed', {
        error: 'Failed to start grouping process',
        details: error instanceof Error ? error.message : String(error),
        imageCount: images.length,
        workerFunctionName,
      });
    }
  }

  /**
   * Update job status in DynamoDB
   */
  private async updateJobStatus(jobId: string, tenant: string, status: string, additionalFields?: Record<string, any>): Promise<void> {
    const pk = `TENANT#${tenant}#BG_REMOVER_GROUPING_JOB#${jobId}`;
    const sk = 'METADATA';

    const fields: Record<string, any> = {
      status,
      updatedAt: new Date().toISOString(),
      ...additionalFields,
    };

    await dynamoDB.send(new PutItemCommand({
      TableName: tableName,
      Item: marshall({
        PK: pk,
        SK: sk,
        ...fields,
        ttl: Math.floor(Date.now() / 1000) + 86400 * 7, // 7 days retention
      }),
    }));
  }

  async handle(event: any): Promise<any> {
    const requestId = event.requestContext?.requestId || randomUUID();
    const httpMethod = event.requestContext?.http?.method || event.httpMethod;

    // Handle CORS preflight
    if (httpMethod === 'OPTIONS') {
      return this.createJsonResponse('', 200, {
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      });
    }

    if (httpMethod !== 'POST') {
      return this.createErrorResponse('Method Not Allowed', 405);
    }

    // Initialize variables for error handling
    let jobId: string | undefined;
    let tenant: string | undefined;

    try {
      // Add payload size validation (moved earlier for faster failure)
      const MAX_PAYLOAD_SIZE = 5 * 1024 * 1024; // 5MB
      if (event.body && event.body.length > MAX_PAYLOAD_SIZE) {
        return this.createErrorResponse('Payload too large', 413);
      }

      // Get stage first
      const stage = process.env.STAGE || 'dev';

      // Extract tenant (optimized - skip JWT for faster resolution)
      tenant = await this.resolveTenantFast(event, stage);

      console.log('[GroupImages] Creating async grouping job', {
        tenant,
        stage,
        requestId,
      });

      // Parse and validate request (moved earlier)
      const body = JSON.parse(event.body || '{}');
      const validation = validateRequest(GroupImagesRequestSchema, body, 'group-images');

      if (!validation.success) {
        return this.badRequest({
          error: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          errors: validation.error?.details,
        });
      }

      const request = validation.data as GroupImagesRequest;
      const {
        images,
        thumbnailSize = { width: 256, height: 256 },
        similarityThreshold = 0.92,
        includeExistingEmbeddings = true,
      } = request;

      console.log('[GroupImages] Request validated', {
        imageCount: images.length,
        thumbnailSize,
        similarityThreshold,
        includeExistingEmbeddings,
        tenant,
      });

      // Create grouping job in DynamoDB first (fast operation)
      jobId = randomUUID();
      const pk = `TENANT#${tenant}#BG_REMOVER_GROUPING_JOB#${jobId}`;
      const sk = 'METADATA';
      const gsi1pk = `TENANT#${tenant}#BG_REMOVER_GROUPING_JOBS`;
      const gsi1sk = `${new Date().toISOString()}#JOB#${jobId}`;
      const now = new Date().toISOString();

      await dynamoDB.send(new PutItemCommand({
        TableName: tableName,
        Item: marshall({
          PK: pk,
          SK: sk,
          GSI1PK: gsi1pk,
          GSI1SK: gsi1sk,
          jobId,
          tenant,
          status: 'pending',
          createdAt: now,
          updatedAt: now,
          ttl: Math.floor(Date.now() / 1000) + 86400 * 7, // 7 days retention
          entityType: 'BG_REMOVER_GROUPING_JOB',
          imageCount: images.length,
          thumbnailSize,
          similarityThreshold,
          includeExistingEmbeddings,
          requestId,
        }),
      }));

      console.log('[GroupImages] Grouping job created in DynamoDB', { jobId, tenant });

      // Load config and invoke worker asynchronously (don't await)
      const workerFunctionName = process.env.GROUPING_WORKER_FUNCTION_NAME || `${process.env.SERVICE_NAME || 'bg-remover'}-${stage}-groupImagesWorker`;

      // Fire-and-forget: invoke worker (config loading moved to worker)
      this.invokeWorkerAsync(jobId, tenant, stage, images, thumbnailSize, similarityThreshold, includeExistingEmbeddings, workerFunctionName, requestId)
        .catch(error => {
          console.error('[GroupImages] Async worker invocation failed', {
            jobId,
            error: error instanceof Error ? error.message : String(error),
          });
          // Job status will be updated by the error handling in invokeWorkerAsync
        });

      // Return job ID immediately for status polling (within 30s API Gateway limit)
      return this.success({
        jobId,
        status: 'pending',
        message: 'Grouping job accepted and queued for processing',
        statusUrl: `/bg-remover/group-status/${jobId}`,
        estimatedDuration: '30-180 seconds', // Based on image count
        requestId,
      }, 202); // 202 Accepted

    } catch (error: any) {
      console.error('[GroupImages] Request failed', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        requestId,
      });

      // If we created a job, mark it as failed
      if (jobId && tenant) {
        try {
          await this.updateJobStatus(jobId, tenant, 'failed', {
            error: error instanceof Error ? error.message : 'Unknown error occurred',
            requestId,
          });
        } catch (updateError) {
          console.error('[GroupImages] Failed to update job status', {
            jobId,
            updateError: updateError instanceof Error ? updateError.message : String(updateError),
          });
        }
      }

      return this.internalError({
        error: 'GROUPING_FAILED',
        message: error instanceof Error ? error.message : 'Unknown error occurred',
        requestId,
      });
    }
  }
}

// Export handler function for Lambda
export const groupImages = async (event: any) => {
  const handler = new GroupImagesHandler();
  return handler.handle(event);
};
