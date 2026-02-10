import { randomUUID } from 'crypto';
import { BaseHandler } from './base-handler';
import { ProcessGroupsRequestSchema, type ProcessGroupsRequest } from '../lib/types';
import { validateRequest } from '../lib/validation';
import { resolveTenantFromRequest } from '../lib/tenant/resolver';
import { loadConfig } from '../lib/config/loader';
import { getServiceEndpoint } from '../lib/tenant/config';
import { getModelForTask, PIPELINES } from '../lib/bedrock/model-registry';
import { createTenantCorsHeaders } from '../lib/cors';
import { validateJWTFromEvent, getCognitoConfigForTenantAsync } from '../lib/auth/jwt-validator';
import { issueJobToken } from '../lib/job-token';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { DynamoDBClient, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { marshall } from '@aws-sdk/util-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
const lambdaClient = new LambdaClient({
  requestHandler: new NodeHttpHandler({
    connectionTimeout: 5000,
    requestTimeout: 10000,
  }),
});
const dynamoDB = new DynamoDBClient({
  requestHandler: new NodeHttpHandler({
    connectionTimeout: 5000,
    requestTimeout: 10000,
  }),
});
const s3Client = new S3Client({
  requestHandler: new NodeHttpHandler({
    connectionTimeout: 10000,
    requestTimeout: 30000,
  }),
});
const tableName = process.env.DYNAMODB_TABLE || `carousel-main-${process.env.STAGE || 'dev'}`;
const workerFunctionName = process.env.WORKER_FUNCTION_NAME!;

/**
 * Simple semaphore for concurrency control
 */
class Semaphore {
  private permits: number;
  private waitQueue: (() => void)[] = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    return new Promise<void>(resolve => this.waitQueue.push(resolve));
  }

  release(): void {
    this.permits++;
    if (this.waitQueue.length > 0) {
      const resolve = this.waitQueue.shift()!;
      this.permits--;
      resolve();
    }
  }
}

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

  private resolveS3Bucket(bucket?: string): string {
    const resolved = bucket || tempImagesBucket;
    const allowedPattern = /^bg-remover-temp-images-(dev|prod)$/;
    if (!allowedPattern.test(resolved)) {
      throw new Error(`Invalid image bucket: ${resolved}`);
    }
    return resolved;
  }

  /**
   * Execute async tasks with concurrency limit using Promise.allSettled for error handling
   */
  private async executeWithConcurrencyLimit<T>(
    tasks: (() => Promise<T>)[],
    limit: number
  ): Promise<PromiseSettledResult<T>[]> {
    const semaphore = new Semaphore(limit);
    const promises = tasks.map(async (task) => {
      await semaphore.acquire();
      try {
        const value = await task();
        return { status: 'fulfilled' as const, value };
      } catch (reason) {
        return { status: 'rejected' as const, reason };
      } finally {
        semaphore.release();
      }
    });
    return Promise.all(promises);
  }

  async handle(event: any): Promise<any> {
    const requestId = event.requestContext?.requestId || randomUUID();
    const httpMethod = event.requestContext?.http?.method || event.httpMethod;

    // Handle CORS preflight
    if (httpMethod === 'OPTIONS') {
      const corsHeaders = createTenantCorsHeaders(event, 'unknown');
      return this.createJsonResponse('', 200, {
        ...corsHeaders,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      });
    }

    if (httpMethod !== 'POST') {
      const corsHeaders = createTenantCorsHeaders(event, 'unknown');
      return this.createErrorResponse('Method Not Allowed', 405, corsHeaders);
    }

    let corsHeaders = createTenantCorsHeaders(event, 'unknown');

    try {
      // Get stage first
      const stage = process.env.STAGE || 'dev';

      // Extract tenant
      const tenant = await resolveTenantFromRequest(event, stage);
      corsHeaders = createTenantCorsHeaders(event, tenant);

      console.log('[ProcessGroups] Processing approved groups', {
        tenant,
        stage,
        requestId,
      });

      // Load tenant-specific Cognito config for JWT validation
      const cognitoConfig = await getCognitoConfigForTenantAsync(tenant, stage);
      const authResult = await validateJWTFromEvent(event, cognitoConfig, {
        required: true,
        expectedTenant: tenant,
        enforceTenantMatch: true,
      });
      if (!authResult.isValid || !authResult.userId) {
        return this.createErrorResponse(
          'Valid JWT token required',
          401,
          corsHeaders,
          { error: authResult.error }
        );
      }

      // Parse and validate request
      const body = JSON.parse(event.body || '{}');
      const validation = validateRequest(ProcessGroupsRequestSchema, body, 'process-groups');

      if (!validation.success) {
        return this.badRequest({
          error: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          errors: validation.error?.details,
        }, corsHeaders);
      }

      const request = validation.data as ProcessGroupsRequest;
      const { groups, originalImages, originalImageKeys, processingOptions, bookingId } = request;

      // Set default processing options if not provided
      const options = processingOptions || {
        outputFormat: 'png' as const,
        generateDescription: true,
        languages: ['en', 'is'],
        generatePriceSuggestion: false,
        generateRatingSuggestion: false,
      };

      const base64ImageCount = originalImages ? Object.keys(originalImages).length : 0;
      const s3ImageCount = originalImageKeys ? Object.keys(originalImageKeys).length : 0;

      console.log('[ProcessGroups] Request validated', {
        groupCount: groups.length,
        imageCount: base64ImageCount + s3ImageCount,
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
        }, corsHeaders);
      }

      // Determine which pipeline to use based on processing options
      const pipelineName = this.selectPipeline(options);
      console.log('[ProcessGroups] Selected pipeline', {
        pipeline: pipelineName,
        generateDescription: options.generateDescription,
        languages: options.languages,
        tenant,
      });

      // Create jobs for each group with concurrent processing limited to 5 groups
      const groupTasks = groups.map(group => async (): Promise<any> => {
        const jobId = randomUUID();
        const imageSources = group.imageIds
          .map((imageId, index) => {
            const s3Ref = originalImageKeys?.[imageId];
            if (s3Ref?.s3Key) {
              return {
                imageId,
                index,
                s3Key: s3Ref.s3Key,
                s3Bucket: s3Ref.s3Bucket,
              };
            }
            const base64 = originalImages?.[imageId];
            if (base64) {
              return {
                imageId,
                index,
                base64,
              };
            }
            return null;
          })
          .filter((source): source is { imageId: string; index: number; base64?: string; s3Key?: string; s3Bucket?: string } => Boolean(source));

        if (imageSources.length === 0) {
          console.warn('[ProcessGroups] Group has no valid images', {
            groupId: group.groupId,
            requestedImageIds: group.imageIds,
          });
          return null;
        }

        console.log('[ProcessGroups] Creating job for group', {
          jobId,
          groupId: group.groupId,
          imageCount: imageSources.length,
          productName: group.productName,
        });

        const base64Sources = imageSources.filter((source) => source.base64);
        const uploadedKeysByImageId = new Map<string, string>();
        const failedUploads: number[] = [];

        if (base64Sources.length > 0) {
          console.log('[ProcessGroups] Uploading images to S3', {
            jobId,
            imageCount: base64Sources.length,
            groupId: group.groupId,
          });

          // Use Promise.allSettled for fault tolerance within group
          const uploadResults = await Promise.allSettled(
            base64Sources.map((source) =>
              this.uploadImageToS3(
                tenant,
                jobId,
                source.index,
                source.base64 || '',
                `${group.productName || 'product'}_${source.index + 1}.jpg`
              )
            )
          );

          uploadResults.forEach((result, index) => {
            const source = base64Sources[index];
            if (!source) {
              return;
            }
            if (result.status === 'fulfilled') {
              uploadedKeysByImageId.set(source.imageId, result.value);
            } else {
              const errorMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
              console.error('[ProcessGroups] Image upload failed', {
                jobId,
                groupId: group.groupId,
                imageId: source.imageId,
                index: source.index,
                filename: `${group.productName || 'product'}_${source.index + 1}.jpg`,
                error: errorMsg,
                suggestion: this.getUploadErrorSuggestion(errorMsg),
              });
              failedUploads.push(source.index);
            }
          });
        }

        const resolvedImages = imageSources
          .map((source) => {
            const filename = `${group.productName || 'product'}_${source.index + 1}`;
            if (source.s3Key) {
              return {
                imageId: source.imageId, // Preserve photoId from frontend for matching
                s3Bucket: this.resolveS3Bucket(source.s3Bucket),
                s3Key: source.s3Key,
                filename,
              };
            }
            const uploadedKey = uploadedKeysByImageId.get(source.imageId);
            if (!uploadedKey) {
              return null;
            }
            return {
              imageId: source.imageId, // Preserve photoId from frontend for matching
              s3Bucket: tempImagesBucket,
              s3Key: uploadedKey,
              filename,
            };
          })
          .filter((image): image is { imageId: string; s3Bucket: string; s3Key: string; filename: string } => Boolean(image));

        // If all uploads failed, update job status and skip this group
        if (resolvedImages.length === 0) {
          console.error('[ProcessGroups] All images failed to upload for group', {
            jobId,
            groupId: group.groupId,
            failedCount: failedUploads.length,
            failedImages: failedUploads,
          });

          await this.createJobRecord(tenant, jobId, {
            groupId: group.groupId,
            imageCount: 0,
            productName: group.productName,
            pipeline: pipelineName,
            status: 'failed',
            createdAt: new Date().toISOString(),
            requestId,
            error: `Upload failed for ${failedUploads.length} image(s). Please check the images are valid and retry.`,
            errorDetails: {
              failedCount: failedUploads.length,
              failedIndices: failedUploads,
              suggestion: 'Ensure all images are valid image files (PNG, JPEG, WebP) under 10MB. Try converting to PNG if issues persist.',
              retryable: true,
            },
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
          return null;
        }

        // If some uploads failed, log warning but continue with partial set
        if (failedUploads.length > 0) {
          console.warn('[ProcessGroups] Partial upload success', {
            jobId,
            groupId: group.groupId,
            successCount: resolvedImages.length,
            failedCount: failedUploads.length,
            failedIndices: failedUploads,
            suggestion: 'Some images failed to upload. The group will process with available images. You can retry the failed images separately if needed.',
          });
        }

        console.log('[ProcessGroups] Images uploaded to S3', {
          jobId,
          groupId: group.groupId,
          successCount: resolvedImages.length,
          failedCount: failedUploads.length,
          s3Keys: resolvedImages.map((image) => image.s3Key),
        });

        // Prepare resumable state for images once upload results are known
        const imageStates = resolvedImages.map((image, index) => ({
          imageId: image.imageId, // Preserve photoId for frontend matching
          s3Key: image.s3Key,
          s3Bucket: image.s3Bucket,
          index,
          status: 'pending' as const,
          filename: image.filename,
          isPrimary: index === 0, // First image is primary
          attempts: 0,
          lastAttemptAt: null,
          error: null,
        }));

        // Store job metadata in DynamoDB with resumable state
        await this.createJobRecord(tenant, jobId, {
          groupId: group.groupId,
          imageCount: resolvedImages.length,
          productName: group.productName,
          pipeline: pipelineName,
          status: 'pending',
          createdAt: new Date().toISOString(),
          requestId,
          // Resumable state
          images: imageStates,
          progress: {
            total: resolvedImages.length,
            completed: 0,
            failed: 0,
            processing: 0,
            pending: resolvedImages.length,
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

        const authToken = event.headers?.authorization || event.headers?.Authorization;

        // Prepare worker payload with S3 keys instead of base64 (solves 1MB limit)
        const workerPayload = {
          jobId,
          tenant,
          stage,
          userId: authResult.userId,
          authToken,
          bookingId,
          groupId: group.groupId,
          images: resolvedImages.map((image, index) => ({
            imageId: image.imageId, // Preserve photoId for frontend matching
            s3Bucket: image.s3Bucket,
            s3Key: image.s3Key,
            filename: image.filename,
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

          return {
            jobId,
            groupId: group.groupId,
            status: 'pending',
            imageCount: resolvedImages.length,
            productName: group.productName,
            jobToken: issueJobToken({
              jobId,
              tenant,
            }),
          };
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
          return null;
        }
      });

      // Execute group tasks with concurrency limit of 5
      const groupResults = await this.executeWithConcurrencyLimit(groupTasks, 5);

      // Collect successful jobs and log failed groups
      const jobs: any[] = [];
      groupResults.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          if (result.value) {
            jobs.push(result.value);
          }
        } else {
          console.error('[ProcessGroups] Group processing failed', {
            groupIndex: index,
            groupId: groups[index].groupId,
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          });
        }
      });

      if (jobs.length === 0) {
        return this.badRequest({
          error: 'NO_VALID_GROUPS',
          message: 'No valid groups could be processed',
        }, corsHeaders);
      }

      return this.createJsonResponse(
        {
          jobs,
          summary: {
            totalGroups: groups.length,
            jobsCreated: jobs.length,
            pipeline: pipelineName,
          },
          statusEndpoint: `/bg-remover/status/{jobId}`,
          requestId,
        },
        200, // Status code
        {
          ...corsHeaders,
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        }
      );
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
      }, corsHeaders);
    }
  }

  /**
   * Upload image to S3 temporary bucket and return S3 key
   * Solves Lambda 1MB payload limit by storing images in S3
   */
  private sanitizeS3KeyComponent(value: string, label: string): string {
    const sanitized = value.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
    if (!sanitized) {
      throw new Error(`Invalid ${label} for S3 key`);
    }
    return sanitized;
  }

  private sanitizeFileName(fileName: string): string {
    const lastDot = fileName.lastIndexOf('.');
    const base = lastDot > 0 ? fileName.slice(0, lastDot) : fileName;
    const ext = lastDot > 0 ? fileName.slice(lastDot + 1) : '';
    const safeBase = this.sanitizeS3KeyComponent(base, 'filename');
    const safeExt = ext ? this.sanitizeS3KeyComponent(ext, 'file extension') : '';
    return safeExt ? `${safeBase}.${safeExt}` : safeBase;
  }

  /**
   * Validate base64 image data before processing
   * Returns { valid: true } or { valid: false, error: string }
   */
  private validateBase64Image(base64Data: string): { valid: boolean; error?: string } {
    if (!base64Data || typeof base64Data !== 'string') {
      return { valid: false, error: 'Image data is empty or not a string' };
    }

    // Check for valid data URL prefix
    const dataUrlMatch = base64Data.match(/^data:image\/(\w+);base64,/);
    if (!dataUrlMatch) {
      // Allow raw base64 without prefix too
      if (!/^[A-Za-z0-9+/=]+$/.test(base64Data.trim())) {
        return { valid: false, error: 'Invalid base64 image format - expected data URL or base64 string' };
      }
    }

    // Extract and validate the base64 content
    const base64Content = dataUrlMatch ? base64Data.replace(/^data:image\/\w+;base64,/, '') : base64Data;
    
    // Check for common base64 issues
    if (base64Content.length < 10) {
      return { valid: false, error: 'Image data is too short (less than 10 characters)' };
    }

    // Validate base64 padding and characters
    const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
    const cleanedBase64 = base64Content.replace(/\s/g, ''); // Remove whitespace
    if (!base64Regex.test(cleanedBase64)) {
      return { valid: false, error: 'Invalid base64 characters - only alphanumeric, +, /, and = are allowed' };
    }

    // Check if it's likely a valid image size (not too small, not too large)
    const byteCount = Math.ceil((cleanedBase64.length * 3) / 4);
    const maxSizeBytes = 10 * 1024 * 1024; // 10MB limit
    if (byteCount < 100) {
      return { valid: false, error: 'Image appears too small (less than 100 bytes) - may be invalid' };
    }
    if (byteCount > maxSizeBytes) {
      return { valid: false, error: `Image exceeds maximum size of ${maxSizeBytes / 1024 / 1024}MB` };
    }

    return { valid: true };
  }

  /**
   * Sleep utility for retry delays
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Provide actionable suggestions based on upload error messages
   */
  private getUploadErrorSuggestion(error: string): string {
    const lowerError = error.toLowerCase();
    
    if (lowerError.includes('validation') || lowerError.includes('invalid') || lowerError.includes('decode')) {
      return 'The image file appears to be corrupted or in an unsupported format. Please try converting it to PNG or JPEG.';
    }
    if (lowerError.includes('too large') || lowerError.includes('size') || lowerError.includes('limit')) {
      return 'The image exceeds the maximum file size. Please compress or resize the image before uploading.';
    }
    if (lowerError.includes('network') || lowerError.includes('timeout') || lowerError.includes('connection')) {
      return 'Network issue detected. Please retry the upload or check your connection.';
    }
    if (lowerError.includes('access denied') || lowerError.includes('forbidden') || lowerError.includes('permission')) {
      return 'Permission denied. Please contact support if this persists.';
    }
    if (lowerError.includes('bucket') || lowerError.includes('not found') || lowerError.includes('exist')) {
      return 'Storage configuration error. Please contact support.';
    }
    
    return 'Please retry the upload. If the problem persists, try a different image or contact support.';
  }

  /**
   * Upload image to S3 with retry logic
   * Solves Lambda 1MB payload limit by storing images in S3
   */
  private async uploadImageToS3(
    tenant: string,
    jobId: string,
    imageIndex: number,
    base64Data: string,
    filename: string
  ): Promise<string> {
    // Validate base64 data before processing
    const validation = this.validateBase64Image(base64Data);
    if (!validation.valid) {
      console.error('[ProcessGroups] Base64 validation failed', {
        jobId,
        imageIndex,
        filename,
        error: validation.error,
      });
      throw new Error(`Invalid image data: ${validation.error}`);
    }

    // Remove data URL prefix if present
    const base64Image = base64Data.replace(/^data:image\/\w+;base64,/, '');
    let imageBuffer: Buffer;
    try {
      imageBuffer = Buffer.from(base64Image, 'base64');
    } catch (error) {
      console.error('[ProcessGroups] Base64 decode failed', {
        jobId,
        imageIndex,
        filename,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error('Failed to decode base64 image data');
    }

    // S3 key: temp/{tenant}/{jobId}/{index}_{filename}
    const safeTenant = this.sanitizeS3KeyComponent(tenant, 'tenant');
    const safeJobId = this.sanitizeS3KeyComponent(jobId, 'jobId');
    const safeFileName = this.sanitizeFileName(filename);
    const s3Key = `temp/${safeTenant}/${safeJobId}/${imageIndex}_${safeFileName}`;

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

    // Retry configuration
    const maxRetries = 3;
    const baseDelayMs = 500;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
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
            uploadAttempt: String(attempt),
          },
          // Note: Lifecycle policy handles deletion after 24 hours
        }));

        console.log('[ProcessGroups] Image uploaded to S3', {
          jobId,
          s3Key,
          sizeBytes: imageBuffer.length,
          attempt,
        });

        return s3Key;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        console.warn('[ProcessGroups] S3 upload attempt failed', {
          jobId,
          s3Key,
          attempt,
          maxRetries,
          error: lastError.message,
        });

        if (attempt < maxRetries) {
          // Exponential backoff with jitter
          const delayMs = baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 100;
          await this.sleep(delayMs);
        }
      }
    }

    // All retries failed
    console.error('[ProcessGroups] S3 upload failed after all retries', {
      jobId,
      s3Key,
      maxRetries,
      error: lastError?.message,
    });
    throw lastError;
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

    // GSI2: For batch status queries by requestId
    const gsi2pk = metadata.requestId ? `REQUEST#${metadata.requestId}` : undefined;
    const gsi2sk = metadata.requestId ? `TENANT#${tenant}#JOB#${jobId}` : undefined;

    const item = marshall({
      PK: pk,
      SK: sk,
      GSI1PK: gsi1pk,
      GSI1SK: gsi1sk,
      ...(gsi2pk && { GSI2PK: gsi2pk }),
      ...(gsi2sk && { GSI2SK: gsi2sk }),
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
      const imagesForWorker = job.images.map((img: any) => ({
        s3Bucket: img.s3Bucket || tempImagesBucket,
        s3Key: img.s3Key,
        filename: img.filename,
        isPrimary: img.isPrimary !== undefined ? img.isPrimary : false, // Use stored value or default to false
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
