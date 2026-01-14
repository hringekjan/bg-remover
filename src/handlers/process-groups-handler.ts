import { randomUUID } from 'crypto';
import { BaseHandler } from './base-handler';
import { ProcessGroupsRequestSchema, type ProcessGroupsRequest } from '../lib/types';
import { validateRequest } from '../lib/validation';
import { resolveTenantFromRequest } from '../lib/tenant/resolver';
import { loadConfig } from '../lib/config/loader';
import { getServiceEndpoint } from '../lib/tenant/config';
import { getModelForTask, PIPELINES } from '../lib/bedrock/model-registry';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { DynamoDBClient, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { issueJobToken } from '../lib/job-token';

const lambdaClient = new LambdaClient({});
const dynamoDB = new DynamoDBClient({});
const s3Client = new S3Client({});
const tableName = process.env.DYNAMODB_TABLE || `carousel-main-${process.env.STAGE || 'dev'}`;
const workerFunctionName = process.env.WORKER_FUNCTION_NAME!;

// Validate TEMP_IMAGES_BUCKET environment variable
const tempImagesBucket = process.env.TEMP_IMAGES_BUCKET;
if (!tempImagesBucket) {
  throw new Error('TEMP_IMAGES_BUCKET environment variable is required');
}
if (!tempImagesBucket.match(/^bg-remover-temp-images-(dev|prod)$/)) {
  throw new Error(`Invalid TEMP_IMAGES_BUCKET format: ${tempImagesBucket}. Expected: bg-remover-temp-images-{stage}`);
}

/**
 * Process Groups Handler - Phase 3: Process Approved Groups
 *
 * Agentic workflow using model registry pipelines:
 * 1. Accept approved product groups from frontend
 * 2. For each group, process full-quality images using agentic pipeline
 * 3. Use async worker pattern for long-running processing
 * 4. Track job status in DynamoDB
 * 5. Return job IDs for status tracking
 *
 * Cost optimization:
 * - Only processes user-approved groups (no wasted processing)
 * - Uses full_analysis pipeline for complete product analysis
 * - Async processing prevents timeout issues
 */
export class ProcessGroupsHandler extends BaseHandler {
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

    try {
      // Get stage first
      const stage = process.env.STAGE || 'dev';

      // Extract tenant
      const tenant = await resolveTenantFromRequest(event, stage);

      console.log('[ProcessGroups] Processing approved groups', {
        tenant,
        stage,
        requestId,
      });

      // Parse and validate request
      const body = JSON.parse(event.body || '{}');
      const validation = validateRequest(ProcessGroupsRequestSchema, body, 'process-groups');

      if (!validation.success) {
        return this.badRequest({
          error: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          errors: validation.error?.details,
        });
      }

      const request = validation.data as ProcessGroupsRequest;
      const { groups, originalImages, processingOptions } = request;

      // Set default processing options if not provided
      const options = processingOptions || {
        outputFormat: 'png' as const,
        generateDescription: true,
        languages: ['en', 'is'],
        generatePriceSuggestion: false,
        generateRatingSuggestion: false,
      };

      console.log('[ProcessGroups] Request validated', {
        groupCount: groups.length,
        imageCount: Object.keys(originalImages).length,
        outputFormat: options.outputFormat,
        tenant,
      });

      // Load tenant config for service API keys
      const { secrets } = await loadConfig(stage, tenant);

      if (!secrets.serviceApiKey) {
        console.error('[ProcessGroups] Service API key not configured', { tenant, stage });
        return this.internalError({
          error: 'CONFIGURATION_ERROR',
          message: 'Service API key not configured for tenant',
        });
      }

      // Determine which pipeline to use based on processing options
      const pipelineName = this.selectPipeline(options);
      console.log('[ProcessGroups] Selected pipeline', {
        pipeline: pipelineName,
        generateDescription: options.generateDescription,
        languages: options.languages,
        tenant,
      });

      // Create jobs for each group and invoke workers asynchronously
      const jobs = [];

      for (const group of groups) {
        const jobId = randomUUID();
        const groupImages = group.imageIds
          .map(imageId => originalImages[imageId])
          .filter(Boolean);

        if (groupImages.length === 0) {
          console.warn('[ProcessGroups] Group has no valid images', {
            groupId: group.groupId,
            requestedImageIds: group.imageIds,
          });
          continue;
        }

        console.log('[ProcessGroups] Creating job for group', {
          jobId,
          groupId: group.groupId,
          imageCount: groupImages.length,
          productName: group.productName,
        });

        // Upload images to S3 to avoid Lambda 1MB payload limit
        console.log('[ProcessGroups] Uploading images to S3', {
          jobId,
          imageCount: groupImages.length,
          groupId: group.groupId,
        });

        // Use Promise.allSettled for fault tolerance
        const uploadResults = await Promise.allSettled(
          groupImages.map((base64, index) =>
            this.uploadImageToS3(
              tenant,
              jobId,
              index,
              base64,
              `${group.productName || 'product'}_${index + 1}.jpg`
            )
          )
        );

        const s3ImageKeys: string[] = [];
        const failedUploads: number[] = [];

        uploadResults.forEach((result, index) => {
          if (result.status === 'fulfilled') {
            s3ImageKeys.push(result.value);
          } else {
            console.error('[ProcessGroups] Image upload failed', {
              jobId,
              groupId: group.groupId,
              index,
              error: result.reason instanceof Error ? result.reason.message : String(result.reason),
            });
            failedUploads.push(index);
          }
        });

        // If all uploads failed, update job status and continue to next group
        if (s3ImageKeys.length === 0) {
          console.error('[ProcessGroups] All images failed to upload for group', {
            jobId,
            groupId: group.groupId,
            failedCount: failedUploads.length,
          });

          await this.createJobRecord(tenant, jobId, {
            groupId: group.groupId,
            imageCount: 0,
            productName: group.productName,
            pipeline: pipelineName,
            status: 'failed',
            createdAt: new Date().toISOString(),
            requestId,
            error: 'All image uploads failed',
            failedImages: failedUploads,
            images: [],
            progress: {
              total: 0,
              completed: 0,
              failed: 0,
              processing: 0,
              pending: 0,
            },
            continuationToken: null,
            resumable: true,
          });
          continue; // Skip this group, try next one
        }

        // If some uploads failed, log warning but continue with partial set
        if (failedUploads.length > 0) {
          console.warn('[ProcessGroups] Partial upload success', {
            jobId,
            groupId: group.groupId,
            successCount: s3ImageKeys.length,
            failedCount: failedUploads.length,
          });
        }

        console.log('[ProcessGroups] Images uploaded to S3', {
          jobId,
          groupId: group.groupId,
          successCount: s3ImageKeys.length,
          failedCount: failedUploads.length,
          s3Keys: s3ImageKeys,
        });

        // Prepare resumable state for images once upload results are known
        const imageStates = s3ImageKeys.map((s3Key, index) => ({
          s3Key,
          index,
          status: 'pending' as const,
          filename: `${group.productName || 'product'}_${index + 1}`,
          attempts: 0,
          lastAttemptAt: null,
          error: null,
        }));

        // Store job metadata in DynamoDB with resumable state
        await this.createJobRecord(tenant, jobId, {
          groupId: group.groupId,
          imageCount: s3ImageKeys.length,
          productName: group.productName,
          pipeline: pipelineName,
          status: 'pending',
          createdAt: new Date().toISOString(),
          requestId,
          // Resumable state
          images: imageStates,
          progress: {
            total: s3ImageKeys.length,
            completed: 0,
            failed: 0,
            processing: 0,
            pending: s3ImageKeys.length,
          },
          continuationToken: null, // For future resume functionality
          resumable: true,
        });

        // Build group context for enhanced AI-generated content
        const groupContext = {
          totalImages: group.imageIds.length,
          // Note: Frontend grouping metadata would be passed here in production
          // For now, we derive from the group itself
          category: group.productName ? this.extractCategory(group.productName) : undefined,
          confidence: 0.85, // Default confidence (would come from frontend metadata)
          avgSimilarity: 0.90, // Default similarity (would come from frontend metadata)
        };

        // Prepare worker payload with S3 keys instead of base64 (solves 1MB limit)
        const workerPayload = {
          jobId,
          tenant,
          stage,
          groupId: group.groupId,
          images: s3ImageKeys.map((s3Key, index) => ({
            s3Bucket: tempImagesBucket,
            s3Key: s3Key,
            filename: `${group.productName || 'product'}_${index + 1}`,
            isPrimary: index === 0, // First image is primary
          })),
          productName: group.productName,
          pipeline: pipelineName,
          processingOptions: options,
          serviceApiKey: secrets.serviceApiKey,
          requestId,

          // NEW: Add group context for better AI descriptions
          groupContext,
        };

        // Invoke worker Lambda asynchronously
        const invokeCommand = new InvokeCommand({
          FunctionName: workerFunctionName,
          InvocationType: 'Event', // Async invocation
          Payload: Buffer.from(JSON.stringify(workerPayload)),
        });

        try {
          await lambdaClient.send(invokeCommand);
          console.log('[ProcessGroups] Worker invoked', {
            jobId,
            groupId: group.groupId,
            functionName: workerFunctionName,
          });

          jobs.push({
            jobId,
            groupId: group.groupId,
            status: 'pending',
            imageCount: groupImages.length,
            productName: group.productName,
            jobToken: issueJobToken({
              jobId,
              tenant,
            }),
          });
        } catch (error) {
          console.error('[ProcessGroups] Failed to invoke worker', {
            jobId,
            groupId: group.groupId,
            error: error instanceof Error ? error.message : String(error),
          });

          // Update job status to failed
          await this.updateJobStatus(tenant, jobId, 'failed', {
            error: 'Failed to start processing',
          });
        }
      }

      if (jobs.length === 0) {
        return this.badRequest({
          error: 'NO_VALID_GROUPS',
          message: 'No valid groups could be processed',
        });
      }

      return this.success({
        jobs,
        summary: {
          totalGroups: groups.length,
          jobsCreated: jobs.length,
          pipeline: pipelineName,
        },
        statusEndpoint: `/bg-remover/status/{jobId}`,
        requestId,
      });
    } catch (error) {
      console.error('[ProcessGroups] Request failed', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        requestId,
      });

      return this.internalError({
        error: 'PROCESSING_FAILED',
        message: error instanceof Error ? error.message : 'Unknown error occurred',
        requestId,
      });
    }
  }

  /**
   * Upload image to S3 temporary bucket and return S3 key
   * Solves Lambda 1MB payload limit by storing images in S3
   */
  private async uploadImageToS3(
    tenant: string,
    jobId: string,
    imageIndex: number,
    base64Data: string,
    filename: string
  ): Promise<string> {
    // Remove data URL prefix if present
    const base64Image = base64Data.replace(/^data:image\/\w+;base64,/, '');
    const imageBuffer = Buffer.from(base64Image, 'base64');

    // S3 key: temp/{tenant}/{jobId}/{index}_{filename}
    const s3Key = `temp/${tenant}/${jobId}/${imageIndex}_${filename}`;

    // Detect actual image format from base64 data URL
    const formatMatch = base64Data.match(/^data:image\/(\w+);base64,/);
    const format = formatMatch?.[1] || 'jpeg';
    const contentTypeMap: Record<string, string> = {
      png: 'image/png',
      jpeg: 'image/jpeg',
      jpg: 'image/jpeg',
      webp: 'image/webp',
      heic: 'image/heic',
    };
    const contentType = contentTypeMap[format.toLowerCase()] || 'application/octet-stream';

    await s3Client.send(new PutObjectCommand({
      Bucket: tempImagesBucket,
      Key: s3Key,
      Body: imageBuffer,
      ContentType: contentType,
      ServerSideEncryption: 'AES256', // Enable S3-managed encryption
      Metadata: {
        tenant,
        jobId,
        originalFilename: filename,
      },
      // Note: Lifecycle policy handles deletion after 24 hours
    }));

    console.log('[ProcessGroups] Image uploaded to S3', {
      jobId,
      s3Key,
      sizeBytes: imageBuffer.length,
    });

    return s3Key;
  }

  /**
   * Extract category from product name for pricing/rating context
   */
  private extractCategory(productName: string): string {
    const name = productName.toLowerCase();

    // Category detection patterns
    if (name.match(/dress|shirt|pants|jacket|coat|sweater|clothing|apparel/)) {
      return 'clothing';
    }
    if (name.match(/phone|laptop|computer|tablet|electronics|device|gadget/)) {
      return 'electronics';
    }
    if (name.match(/chair|table|sofa|desk|furniture|cabinet/)) {
      return 'furniture';
    }
    if (name.match(/necklace|ring|bracelet|earring|jewelry|watch/)) {
      return 'jewelry';
    }
    if (name.match(/vintage|antique|collectible|rare/)) {
      return 'vintage';
    }
    if (name.match(/handmade|craft|artisan|custom/)) {
      return 'handmade';
    }
    if (name.match(/sports|fitness|athletic|gym/)) {
      return 'sports';
    }

    return 'general';
  }

  /**
   * Select appropriate pipeline based on processing options
   *
   * Agentic pattern: Choose the right workflow based on user requirements
   */
  private selectPipeline(options: {
    outputFormat: 'png' | 'jpeg' | 'webp';
    generateDescription: boolean;
    languages: string[];
    generatePriceSuggestion: boolean;
    generateRatingSuggestion: boolean;
    quality?: number;
    autoTrim?: boolean;
    centerSubject?: boolean;
    enhanceColors?: boolean;
  }): string {

    // If multilingual descriptions requested, use multilingual pipeline
    if (options.generateDescription && options.languages && options.languages.length > 1) {
      return 'multilingual';
    }

    // If description requested but no translations, use full analysis
    if (options.generateDescription) {
      return 'full_analysis';
    }

    // Otherwise, basic processing (no AI-generated descriptions)
    return 'basic_processing';
  }

  /**
   * Create job record in DynamoDB
   */
  private async createJobRecord(
    tenant: string,
    jobId: string,
    metadata: Record<string, any>
  ): Promise<void> {
    const pk = `TENANT#${tenant}#BG_REMOVER_JOB#${jobId}`;
    const sk = 'METADATA';
    const gsi1pk = `TENANT#${tenant}#BG_REMOVER_JOBS`;
    const gsi1sk = `${new Date().toISOString()}#JOB#${jobId}`;

    const item = marshall({
      PK: pk,
      SK: sk,
      GSI1PK: gsi1pk,
      GSI1SK: gsi1sk,
      jobId,
      tenant,
      entityType: 'BG_REMOVER_JOB',
      ...metadata,
      ttl: Math.floor(Date.now() / 1000) + 86400 * 7, // 7 days retention
    });

    await dynamoDB.send(
      new PutItemCommand({
        TableName: tableName,
        Item: item,
      })
    );
  }

  /**
   * Resume a failed or partial job
   */
  private async resumeJob(tenant: string, jobId: string): Promise<any> {
    try {
      // Load current job state
      const { DynamoDBDocumentClient, GetCommand } = await import('@aws-sdk/lib-dynamodb');
      const docClient = DynamoDBDocumentClient.from(dynamoDB);

      const response = await docClient.send(new GetCommand({
        TableName: tableName,
        Key: {
          PK: `TENANT#${tenant}#BG_REMOVER_JOB#${jobId}`,
          SK: 'METADATA',
        },
      }));

      const job = response.Item;
      if (!job) {
        throw new Error(`Job ${jobId} not found`);
      }

      if (!job.resumable) {
        throw new Error(`Job ${jobId} is not resumable`);
      }

      if (job.status === 'completed') {
        throw new Error(`Job ${jobId} is already completed`);
      }

      // Check if job can be resumed
      const pendingImages = job.images?.filter((img: any) => img.status === 'pending' || img.status === 'failed') || [];
      if (pendingImages.length === 0) {
        throw new Error(`Job ${jobId} has no pending or failed images to resume`);
      }

      console.log('[ProcessGroups] Resuming job', {
        jobId,
        tenant,
        pendingImages: pendingImages.length,
        totalImages: job.images?.length || 0,
      });

      // Update job status to processing
      await this.updateJobStatus(tenant, jobId, 'processing', {
        resumedAt: new Date().toISOString(),
        resumeAttempt: (job.resumeAttempt || 0) + 1,
      });

      // Reconstruct image data for worker
      const imagesForWorker = job.images.map((img: any, index: number) => ({
        s3Bucket: tempImagesBucket,
        s3Key: img.s3Key,
        filename: img.filename,
        isPrimary: index === 0, // First image is primary
      }));

      // Invoke worker with resume flag
      const workerPayload = {
        jobId,
        tenant,
        stage: process.env.STAGE || 'dev',
        groupId: job.groupId,
        images: imagesForWorker,
        productName: job.productName,
        pipeline: job.pipeline,
        processingOptions: job.processingOptions || {},
        serviceApiKey: '', // Will be loaded by worker
        requestId: randomUUID(),
        resume: true, // Flag to indicate this is a resume operation
      };

      const invokeCommand = new InvokeCommand({
        FunctionName: workerFunctionName,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify(workerPayload)),
      });

      await lambdaClient.send(invokeCommand);

      console.log('[ProcessGroups] Resume worker invoked', {
        jobId,
        functionName: workerFunctionName,
      });

      return {
        jobId,
        status: 'resuming',
        message: `Resuming job with ${pendingImages.length} pending images`,
      };
    } catch (error) {
      console.error('[ProcessGroups] Failed to resume job', {
        jobId,
        tenant,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Update job status in DynamoDB
   */
  private async updateJobStatus(
    tenant: string,
    jobId: string,
    status: string,
    result?: Record<string, any>
  ): Promise<void> {
    const pk = `TENANT#${tenant}#BG_REMOVER_JOB#${jobId}`;
    const sk = 'METADATA';

    const updateExpression = result
      ? 'SET #status = :status, #result = :result, #updatedAt = :updatedAt'
      : 'SET #status = :status, #updatedAt = :updatedAt';

    const expressionAttributeValues = result
      ? marshall({
          ':status': status,
          ':result': result,
          ':updatedAt': new Date().toISOString(),
        })
      : marshall({
          ':status': status,
          ':updatedAt': new Date().toISOString(),
        });

    await dynamoDB.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: marshall({ PK: pk, SK: sk }),
        UpdateExpression: updateExpression,
        ExpressionAttributeNames: {
          '#status': 'status',
          '#updatedAt': 'updatedAt',
          ...(result && { '#result': 'result' }),
        },
        ExpressionAttributeValues: expressionAttributeValues,
      })
    );
  }
}

// Export handler function for Lambda
export const processGroups = async (event: any) => {
  const handler = new ProcessGroupsHandler();
  return handler.handle(event);
};
