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
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { createTenantCorsHeaders } from '../lib/cors';
import { EventTracker } from '../lib/event-tracking';
import { getCognitoConfigForTenantAsync, validateJWTFromEvent } from '../lib/auth/jwt-validator';
import { extractAuthContext, isStaff } from '@carousellabs/rbac-access-kit';

const dynamoDB = new DynamoDBClient({});
const eventTracker = new EventTracker(dynamoDB);
const sqsClient = new SQSClient({});
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
  protected success(
    data: any,
    statusCode: number = 200,
    headers: Record<string, string> = {}
  ): any {
    return this.createJsonResponse(data, statusCode, headers);
  }

  protected badRequest(
    error: any,
    headers: Record<string, string> = {}
  ): any {
    return this.createErrorResponse(error.message || 'Bad Request', 400, headers, error);
  }

  protected internalError(
    error: any,
    headers: Record<string, string> = {}
  ): any {
    return this.createErrorResponse(error.message || 'Internal Server Error', 500, headers, error);
  }

  /**
   * Update job status in DynamoDB
   */
  private async updateJobStatus(jobId: string, tenant: string, status: string, additionalFields?: Record<string, any>): Promise<void> {
    const pk = `TENANT#${tenant}#BG_REMOVER_GROUPING_JOB#${jobId}`;
    const sk = 'METADATA';

    try {
      const updateExpressions: string[] = ['#status = :status', '#updatedAt = :updatedAt'];
      const expressionAttributeNames: Record<string, string> = {
        '#status': 'status',
        '#updatedAt': 'updatedAt',
      };
      const expressionAttributeValues: Record<string, any> = {
        ':status': status,
        ':updatedAt': new Date().toISOString(),
      };

      if (additionalFields) {
        Object.entries(additionalFields).forEach(([key, value], index) => {
          if (value === undefined || value === null) return;
          const attrName = `#f${index}`;
          const valName = `:v${index}`;
          expressionAttributeNames[attrName] = key;
          expressionAttributeValues[valName] = value;
          updateExpressions.push(`${attrName} = ${valName}`);
        });
      }

      await dynamoDB.send(new UpdateItemCommand({
        TableName: tableName,
        Key: marshall({ PK: pk, SK: sk }),
        UpdateExpression: `SET ${updateExpressions.join(', ')}`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: marshall(expressionAttributeValues, { removeUndefinedValues: true }),
      }));
    } catch (error) {
      console.error('[GroupImages] Failed to update job status atomically', {
        jobId,
        tenant,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async handle(event: any): Promise<any> {
    const requestId = event.requestContext?.requestId || randomUUID();
    const httpMethod = event.requestContext?.http?.method || event.httpMethod;

    // Handle CORS preflight
    if (httpMethod === 'OPTIONS') {
      const corsHeaders = createTenantCorsHeaders(event, 'unknown') as any;
      return this.createJsonResponse('', 200, {
        ...corsHeaders,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      });
    }

    if (httpMethod !== 'POST') {
      const corsHeaders = createTenantCorsHeaders(event, 'unknown') as any;
      return this.createErrorResponse('Method Not Allowed', 405, corsHeaders);
    }

    // Initialize variables for error handling
    let jobId: string | undefined;
    let tenant: string | undefined;

    try {
      // Add payload size validation (moved earlier for faster failure)
      const MAX_PAYLOAD_SIZE = 5 * 1024 * 1024; // 5MB
      // Get stage first
      const stage = process.env.STAGE || 'dev';

      // Extract tenant early for CORS and auth validation using shared resolver
      tenant = await resolveTenantFromRequest(event, stage);
      const corsHeaders = createTenantCorsHeaders(event, tenant) as any;

      // GALACTIC STANDARD RBAC: Extract and verify auth context
      let authContext: { tenantId?: string; userId?: string; roles?: string[] };
      try {
        authContext = extractAuthContext(event, { defaultTenantId: tenant });
      } catch (authError: any) {
        // Fallback: Try manual JWT validation if API Gateway didn't parse the token
        console.log('[GroupImages] Authorizer context missing, attempting manual JWT validation...');
        const validation = await validateJWTFromEvent(event);
        
        if (!validation.isValid) {
          console.warn('[GroupImages] Authentication failed', { error: validation.error });
          return this.createErrorResponse(validation.error || 'Unauthorized', 401, corsHeaders);
        }

        // Map validation result to expected context format
        authContext = {
          tenantId: validation.tenantId || tenant,
          userId: validation.userId,
          roles: validation.groups || []
        };
      }
        
      // Enforce tenant isolation
      if (authContext.tenantId && authContext.tenantId !== tenant) {
        return this.createErrorResponse('Tenant access mismatch', 403, corsHeaders);
      }

      // Allow all authenticated users (no staff-only restriction)
      // All users within a tenant can access group-images endpoint

      if (event.body && event.body.length > MAX_PAYLOAD_SIZE) {
        return this.createErrorResponse('Payload too large', 413, corsHeaders);
      }

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
        }, corsHeaders);
      }

      const request = validation.data as GroupImagesRequest;
      const {
        images,
        thumbnailSize = { width: 256, height: 256 },
        similarityThreshold = 0.92,
        includeExistingEmbeddings = true,
      } = request;

      // Validate S3 image references are tenant-scoped
      const allowedBucketPattern = /^bg-remover-temp-images-(dev|prod)$/;
      const expectedKeyPrefix = `temp/${tenant}/`;
      for (const image of images) {
        if (image.s3Bucket && !allowedBucketPattern.test(image.s3Bucket)) {
          return this.badRequest({
            error: 'INVALID_S3_BUCKET',
            message: 'Invalid s3Bucket for grouping request',
            s3Bucket: image.s3Bucket,
          }, corsHeaders);
        }
        if (image.s3Key) {
          const key = image.s3Key;
          if (!key.startsWith(expectedKeyPrefix) || key.includes('..')) {
            return this.badRequest({
              error: 'INVALID_S3_KEY',
              message: 's3Key must be scoped to the tenant upload prefix',
              expectedPrefix: expectedKeyPrefix,
              s3Key: key,
            }, corsHeaders);
          }
        }
      }

      // Validate minimum image count for grouping
      if (images.length < 1) {
        return this.badRequest({
          error: 'INSUFFICIENT_IMAGES',
          message: 'Image grouping requires at least 1 image.',
          imageCount: images.length,
          minimumRequired: 1,
        }, corsHeaders);
      }

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
      for (let i = 0; i < images.length; i += 1) {
        await eventTracker.recordEvent(tenant, 'IMAGE_UPLOADED');
      }

      const queueUrl = process.env.GROUP_IMAGES_QUEUE_URL;
      if (!queueUrl) {
        throw new Error('GROUP_IMAGES_QUEUE_URL is not configured');
      }

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

      await sqsClient.send(new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(workerPayload),
      }));

      console.log('[GroupImages] Enqueued grouping job for worker', {
        jobId,
        tenant,
        queueUrl,
        imageCount: images.length,
      });

      // Return job ID immediately for status polling (within 30s API Gateway limit)
      return this.success({
        jobId,
        status: 'pending',
        message: 'Grouping job accepted and queued for processing',
        statusUrl: `/bg-remover/group-status/${jobId}`,
        estimatedDuration: '30-180 seconds', // Based on image count
        requestId,
      }, 202, corsHeaders); // 202 Accepted

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

      const errorHeaders = tenant ? createTenantCorsHeaders(event, tenant) as any : createTenantCorsHeaders(event, 'unknown') as any;
      return this.internalError({
        error: 'GROUPING_FAILED',
        message: error instanceof Error ? error.message : 'Unknown error occurred',
        requestId,
      }, errorHeaders);
    }
  }
}

// Export handler function for Lambda
export const groupImages = async (event: any) => {
  const handler = new GroupImagesHandler();
  return handler.handle(event);
};
