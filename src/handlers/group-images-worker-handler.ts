import { randomUUID } from 'crypto';
import { BaseHandler } from './base-handler';
import { DynamoDBClient, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { marshall } from '@aws-sdk/util-dynamodb';
import { batchProcessForGrouping } from '../lib/product-identity/product-identity-service';
import { getServiceEndpoint } from '../lib/tenant/config';
import { loadConfig } from '../lib/config/loader';
import { Readable } from 'stream';
import { EventTracker } from '../lib/event-tracking';

const dynamoDB = new DynamoDBClient({});
const eventTracker = new EventTracker(dynamoDB);
const s3Client = new S3Client({});
const tableName = process.env.DYNAMODB_TABLE!;
const tempImagesBucket = process.env.TEMP_IMAGES_BUCKET;

interface GroupingWorkerPayload {
  jobId: string;
  tenant: string;
  stage: string;
  images: Array<{
    imageId?: string;
    imageBase64?: string;
    s3Key?: string;
    s3Bucket?: string;
    filename: string;
    metadata?: any;
  }>;
  thumbnailSize: { width: number; height: number };
  similarityThreshold: number;
  includeExistingEmbeddings: boolean;
  requestId: string;
}

/**
 * Group Images Worker Handler - Async Background Processing
 *
 * Performs the actual grouping work that was moved from the coordinator
 * to avoid API Gateway 30s timeout limits.
 */
export class GroupImagesWorkerHandler extends BaseHandler {
  private ensureAllowedBucket(bucket: string): string {
    const allowedPattern = /^bg-remover-temp-images-(dev|prod)$/;
    if (!allowedPattern.test(bucket)) {
      throw new Error(`Invalid image bucket: ${bucket}`);
    }
    return bucket;
  }

  private async streamToBuffer(stream: Readable | Uint8Array | Buffer): Promise<Buffer> {
    if (Buffer.isBuffer(stream)) {
      return stream;
    }
    if (stream instanceof Uint8Array) {
      return Buffer.from(stream);
    }
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  private async downloadImageFromS3(bucket: string, key: string, jobId: string): Promise<string> {
    const safeBucket = this.ensureAllowedBucket(bucket);
    console.log('[GroupImagesWorker] Downloading image from S3', {
      jobId,
      bucket: safeBucket,
      key,
    });

    const response = await s3Client.send(new GetObjectCommand({
      Bucket: safeBucket,
      Key: key,
    }));

    if (!response.Body) {
      throw new Error(`Empty S3 response for ${key}`);
    }

    const buffer = await this.streamToBuffer(response.Body as Readable);
    return buffer.toString('base64');
  }

  private validateTenantScopedKey(tenant: string, key: string): void {
    const expectedPrefix = `temp/${tenant}/`;
    if (!key.startsWith(expectedPrefix) || key.includes('..')) {
      throw new Error(`Invalid s3Key: must start with ${expectedPrefix}`);
    }
  }

  private async resolveImageBase64(
    image: GroupingWorkerPayload['images'][number],
    jobId: string,
    tenant: string
  ): Promise<string> {
    if (image.imageBase64) {
      return image.imageBase64;
    }
    if (image.s3Key) {
      this.validateTenantScopedKey(tenant, image.s3Key);
      const bucket = image.s3Bucket || tempImagesBucket;
      if (!bucket) {
        throw new Error('TEMP_IMAGES_BUCKET is not configured');
      }
      return this.downloadImageFromS3(bucket, image.s3Key, jobId);
    }
    throw new Error('Image data missing: no imageBase64 or s3Key provided');
  }

  private async fetchWithTimeout(input: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async initializeImagesArray(tenant: string, jobId: string, imageIds: string[]): Promise<void> {
    const images = imageIds.map(imageId => ({
      imageId,
      status: 'pending' as const,
      progress: 0,
    }));

    const pk = `TENANT#${tenant}`;
    const sk = `BG_REMOVER_GROUPING_JOB#${jobId}`;

    await dynamoDB.send(new UpdateItemCommand({
      TableName: tableName,
      Key: marshall({ PK: pk, SK: sk }),
      UpdateExpression: 'SET images = :images',
      ExpressionAttributeValues: marshall({ ':images': images }),
    }));
  }

  private async updateImageProgress(
    tenant: string,
    jobId: string,
    imageId: string,
    status: 'pending' | 'processing' | 'completed' | 'failed',
    progress: number,
    currentStep?: string,
    processedUrl?: string
  ): Promise<void> {
    const pk = `TENANT#${tenant}`;
    const sk = `BG_REMOVER_GROUPING_JOB#${jobId}`;

    // Read current job to find image index
    const { Item } = await dynamoDB.send(new PutItemCommand({
      TableName: tableName,
      Key: marshall({ PK: pk, SK: sk }),
    }));

    if (!Item) return;

    const job = Item as any;
    const images = job.images?.L || [];
    const imageIndex = images.findIndex((img: any) => img.M?.imageId?.S === imageId);

    if (imageIndex === -1) return;

    // Build update expression dynamically
    const updates: string[] = [`images[${imageIndex}].#status = :status`, `images[${imageIndex}].progress = :progress`];
    const expressionAttributeNames: Record<string, string> = { '#status': 'status' };
    const expressionAttributeValues: Record<string, any> = {
      ':status': { S: status },
      ':progress': { N: String(progress) },
    };

    if (currentStep) {
      updates.push(`images[${imageIndex}].currentStep = :step`);
      expressionAttributeValues[':step'] = { S: currentStep };
    }

    if (processedUrl) {
      updates.push(`images[${imageIndex}].processedUrl = :url`);
      expressionAttributeValues[':url'] = { S: processedUrl };
    }

    await dynamoDB.send(new UpdateItemCommand({
      TableName: tableName,
      Key: marshall({ PK: pk, SK: sk }),
      UpdateExpression: `SET ${updates.join(', ')}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
    }));
  }

  private async handlePayload(payload: GroupingWorkerPayload): Promise<void> {
    const {
      jobId,
      tenant,
      stage,
      images,
      thumbnailSize,
      similarityThreshold,
      includeExistingEmbeddings,
      requestId,
    } = payload;

    console.log('[GroupImagesWorker] Starting grouping job', {
      jobId,
      tenant,
      imageCount: images.length,
      requestId,
    });

    const processingStartTime = Date.now();

    try {
      // Load config to get service API key
      const { secrets } = await loadConfig(stage, tenant);
      if (!secrets.serviceApiKey) {
        throw new Error('Image optimizer API key not configured');
      }
      const serviceApiKey = secrets.serviceApiKey;

      // Update job status to processing
      await this.updateJobStatus(tenant, jobId, 'processing', {
        startedAt: new Date().toISOString(),
      });

      // Initialize images array for progress tracking
      const imageIds = images.map(img => img.imageId || `img_${randomUUID()}`);
      await this.initializeImagesArray(tenant, jobId, imageIds);

      // OPTIMIZATION: Parallel thumbnail generation with early exit on minimum viable set
      const MIN_THUMBNAILS_FOR_GROUPING = Math.max(2, Math.floor(images.length * 0.3)); // 30% minimum
      const thumbnails: { id: string; buffer: Buffer; metadata: any }[] = [];

      // Pre-resolve service endpoint to avoid repeated calls
      const imageOptimizerUrl = await getServiceEndpoint('image-optimizer', tenant);

      // Create all thumbnail promises upfront for maximum parallelism
      const thumbnailPromises = images.map(async (image, index) => {
        const imageId = image.imageId || `img_${randomUUID()}`;

        try {
          // Update status to processing
          await this.updateImageProgress(tenant, jobId, imageId, 'processing', 30, 'Generating thumbnail');

          const imageBase64 = await this.resolveImageBase64(image, jobId, tenant);
          const thumbnailResponse = await this.fetchWithTimeout(imageOptimizerUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Tenant-Id': tenant,
              'x-api-key': serviceApiKey,
            },
            body: JSON.stringify({
              imageBase64,
              outputFormat: 'jpeg',
              quality: 75, // Reduced from 80 for faster processing
              targetSize: thumbnailSize,
            }),
          }, 15000);

          if (!thumbnailResponse.ok) {
            console.warn('[GroupImagesWorker] Thumbnail failed, continuing', {
              imageId,
              status: thumbnailResponse.status,
            });
            await this.updateImageProgress(tenant, jobId, imageId, 'failed', 30, 'Thumbnail generation failed');
            return null;
          }

          const thumbnailData = await thumbnailResponse.json();
          const thumbnailBuffer = Buffer.from(thumbnailData.outputBase64, 'base64');

          // Update progress after thumbnail completes
          await this.updateImageProgress(tenant, jobId, imageId, 'processing', 50, 'Thumbnail generated');

          return {
            id: imageId,
            buffer: thumbnailBuffer,
            metadata: {
              filename: image.filename,
              uploadedAt: image.metadata?.uploadedAt || new Date().toISOString(),
              originalSize: image.metadata?.originalSize,
              thumbnailSize: thumbnailData.metadata,
            },
          };
        } catch (error) {
          console.warn('[GroupImagesWorker] Thumbnail error, continuing', {
            imageId,
            error: error instanceof Error ? error.message : String(error),
          });
          await this.updateImageProgress(tenant, jobId, imageId, 'failed', 30, error instanceof Error ? error.message : 'Thumbnail error');
          return null;
        }
      });

      // Execute all thumbnails in parallel with concurrency control
      const thumbnailResults = await Promise.allSettled(thumbnailPromises);
      const successfulThumbnails = thumbnailResults
        .map((result, index) => result.status === 'fulfilled' ? result.value : null)
        .filter((thumbnail): thumbnail is NonNullable<typeof thumbnail> => thumbnail !== null);

      thumbnails.push(...successfulThumbnails);

      console.log('[GroupImagesWorker] Thumbnails completed', {
        requested: images.length,
        successful: thumbnails.length,
        minRequired: MIN_THUMBNAILS_FOR_GROUPING,
        duration: Date.now() - processingStartTime,
      });

      // Early exit if insufficient thumbnails for meaningful grouping
      if (thumbnails.length < MIN_THUMBNAILS_FOR_GROUPING) {
        console.warn('[GroupImagesWorker] Insufficient thumbnails for grouping', {
          successful: thumbnails.length,
          required: MIN_THUMBNAILS_FOR_GROUPING,
        });
        // Continue with fallback single-image groups
      }

      // If thumbnail generation failed for all images, use fallback mode
      if (thumbnails.length === 0) {
        console.warn('[GroupImagesWorker] Thumbnail generation failed, using fallback mode', {
          totalImages: images.length,
          tenant,
        });

        const fallbackGroups = images.map((image, i) => {
          const imageId = image.imageId || `img_${randomUUID()}`;
          return {
            groupId: `pg_${randomUUID()}`,
            imageIds: [imageId],
            imageCount: 1,
            thumbnails: [],
            confidence: 1.0,
            primaryImageId: imageId,
            productName: '',
            category: '',
            metadata: {
              filename: image.filename,
              uploadedAt: image.metadata?.uploadedAt || new Date().toISOString(),
              originalSize: image.metadata?.originalSize,
              fallbackMode: true,
            },
          };
        });

        await this.updateJobStatus(tenant, jobId, 'completed', {
          groups: fallbackGroups,
          summary: {
            totalImages: images.length,
            processedImages: images.length,
            groupsFound: 0,
            singleImageProducts: images.length,
            existingMatched: 0,
            similarityThreshold,
            fallbackMode: true,
            warning: 'Image similarity grouping unavailable - created individual groups for each image',
          },
          processingTimeMs: Date.now() - processingStartTime,
          completedAt: new Date().toISOString(),
        });

      await eventTracker.recordEvent(tenant, 'BATCH_COMPLETED', Date.now() - processingStartTime);
      await this.updateUploadAggregateStatus(tenant, jobId, 'completed', {
        groupingStatus: 'completed',
      });

      console.log('[GroupImagesWorker] Fallback grouping completed', { jobId, tenant });
      return { success: true, jobId, groupsCount: fallbackGroups.length };
    }

      console.log('[GroupImagesWorker] All thumbnails generated', {
        total: thumbnails.length,
        tenant,
      });

      // Step 2: Batch process for grouping using Titan embeddings on thumbnails
      const groupingResult = await batchProcessForGrouping(
        thumbnails,
        tenant,
        includeExistingEmbeddings
      );

      console.log('[GroupImagesWorker] Grouping completed', {
        groupsFound: groupingResult.groups.length,
        ungrouped: groupingResult.ungrouped.length,
        processed: groupingResult.processed,
        existingMatched: groupingResult.existingMatched,
        tenant,
      });

      // Step 3: Prepare response with groups and thumbnails
      const groupsWithThumbnails = groupingResult.groups.map(group => {
        const groupThumbnails = group.imageIds.map(imageId => {
          const thumbnail = thumbnails.find(t => t.id === imageId);
          return thumbnail ? {
            imageId,
            thumbnail: thumbnail.buffer.toString('base64'),
            filename: thumbnail.metadata.filename,
            dimensions: thumbnail.metadata.thumbnailSize,
          } : null;
        }).filter(Boolean);

        return {
          groupId: group.groupId,
          imageIds: group.imageIds,
          imageCount: group.imageIds.length,
          thumbnails: groupThumbnails,
          confidence: group.confidence,
          primaryImageId: group.primaryImageId,
          productName: group.productName,
          category: group.category,
        };
      });

      // Include ungrouped images (single-image products)
      const ungroupedWithThumbnails = groupingResult.ungrouped.map(imageId => {
        const thumbnail = thumbnails.find(t => t.id === imageId);
        if (!thumbnail) return null;

        return {
          groupId: `pg_${randomUUID()}`, // Create single-image group
          imageIds: [imageId],
          imageCount: 1,
          thumbnails: [{
            imageId,
            thumbnail: thumbnail.buffer.toString('base64'),
            filename: thumbnail.metadata.filename,
            dimensions: thumbnail.metadata.thumbnailSize,
          }],
          confidence: 1.0, // Single image = 100% confidence
          primaryImageId: imageId,
        };
      }).filter(Boolean);

      const allGroups = [...groupsWithThumbnails, ...ungroupedWithThumbnails];

      // Mark all successfully processed images as completed
      for (const thumbnail of thumbnails) {
        await this.updateImageProgress(tenant, jobId, thumbnail.id, 'completed', 100, 'Grouped');
      }

      // Store results in DynamoDB
      await this.updateJobStatus(tenant, jobId, 'completed', {
        groups: allGroups,
        summary: {
          totalImages: images.length,
          processedImages: thumbnails.length,
          groupsFound: groupingResult.groups.length,
          singleImageProducts: groupingResult.ungrouped.length,
          existingMatched: groupingResult.existingMatched,
          similarityThreshold,
        },
        processingTimeMs: Date.now() - processingStartTime,
        completedAt: new Date().toISOString(),
      });

      await eventTracker.recordEvent(tenant, 'BATCH_COMPLETED', Date.now() - processingStartTime);
      await this.updateUploadAggregateStatus(tenant, jobId, 'completed', {
        groupingStatus: 'completed',
      });

      console.log('[GroupImagesWorker] Grouping job completed successfully', {
        jobId,
        tenant,
        groupsCount: allGroups.length,
        processingTimeMs: Date.now() - processingStartTime,
      });

      return { success: true, jobId, groupsCount: allGroups.length };

    } catch (error) {
      const processingTimeMs = Date.now() - processingStartTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      console.error('[GroupImagesWorker] Grouping job failed', {
        jobId,
        tenant,
        error: errorMessage,
        processingTimeMs,
      });

      await this.updateJobStatus(tenant, jobId, 'failed', {
        error: errorMessage,
        processingTimeMs,
        completedAt: new Date().toISOString(),
      });

      await eventTracker.recordEvent(tenant, 'PROCESSING_FAILED', processingTimeMs, errorMessage);
      await this.updateUploadAggregateStatus(tenant, jobId, 'failed', {
        groupingStatus: 'failed',
        error: errorMessage,
      });

      return { success: false, error: errorMessage };
    }
  }

  private async updateJobStatus(
    tenant: string,
    jobId: string,
    status: string,
    additionalFields: Record<string, any> = {}
  ): Promise<void> {
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

      Object.entries(additionalFields).forEach(([key, value], index) => {
        if (value === undefined || value === null) return;
        const attrName = `#f${index}`;
        const valName = `:v${index}`;
        expressionAttributeNames[attrName] = key;
        expressionAttributeValues[valName] = value;
        updateExpressions.push(`${attrName} = ${valName}`);
      });

      await dynamoDB.send(new UpdateItemCommand({
        TableName: tableName,
        Key: marshall({ PK: pk, SK: sk }),
        UpdateExpression: `SET ${updateExpressions.join(', ')}`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: marshall(expressionAttributeValues, { removeUndefinedValues: true }),
      }));

      console.info('Grouping job status updated atomically', { tenant, jobId, status });
    } catch (error) {
      console.error('Failed to update grouping job status atomically', {
        tenant,
        jobId,
        status,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async updateUploadAggregateStatus(
    tenant: string,
    uploadId: string,
    status: 'completed' | 'failed',
    additionalFields: Record<string, any> = {}
  ): Promise<void> {
    const pk = `TENANT#${tenant}#BG_REMOVER_UPLOAD#${uploadId}`;
    const sk = 'METADATA';
    const now = new Date().toISOString();
    const expressionParts = ['#status = :status', 'updatedAt = :now'];
    const expressionNames: Record<string, string> = { '#status': 'status' };
    const expressionValues: Record<string, any> = {
      ':status': status,
      ':now': now,
    };

    let index = 0;
    for (const [key, value] of Object.entries(additionalFields)) {
      const nameKey = `#f${index}`;
      const valueKey = `:v${index}`;
      expressionNames[nameKey] = key;
      expressionValues[valueKey] = value;
      expressionParts.push(`${nameKey} = ${valueKey}`);
      index += 1;
    }

    await dynamoDB.send(new UpdateItemCommand({
      TableName: tableName,
      Key: marshall({ PK: pk, SK: sk }),
      UpdateExpression: `SET ${expressionParts.join(', ')}`,
      ExpressionAttributeNames: expressionNames,
      ExpressionAttributeValues: marshall(expressionValues, { removeUndefinedValues: true }),
    }));
  }

  async handle(event: any): Promise<any> {
    if (event?.Records?.length) {
      for (const record of event.Records) {
        const body = typeof record.body === 'string' ? record.body : JSON.stringify(record.body);
        const payload = JSON.parse(body) as GroupingWorkerPayload;
        await this.handlePayload(payload);
      }
      return { processed: event.Records.length };
    }

    const payload = typeof event === 'string' ? JSON.parse(event) : event;
    await this.handlePayload(payload as GroupingWorkerPayload);
    return { processed: 1 };
  }
}

// Export handler function for Lambda
export const groupImagesWorker = async (event: any) => {
  const handler = new GroupImagesWorkerHandler();
  return handler.handle(event);
};
