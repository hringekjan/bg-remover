import { randomUUID } from 'crypto';
import { BaseHandler } from './base-handler';
import { DynamoDBClient, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { batchProcessForGrouping } from '../lib/product-identity/product-identity-service';
import { getServiceEndpoint } from '../lib/tenant/config';
import { loadConfig } from '../lib/config/loader';

const dynamoDB = new DynamoDBClient({});
const tableName = process.env.DYNAMODB_TABLE!;

interface GroupingWorkerPayload {
  jobId: string;
  tenant: string;
  stage: string;
  images: Array<{
    imageId?: string;
    imageBase64: string;
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
  async handle(event: any): Promise<any> {
    const payload = typeof event === 'string' ? JSON.parse(event) : event;
    const {
      jobId,
      tenant,
      stage,
      images,
      thumbnailSize,
      similarityThreshold,
      includeExistingEmbeddings,
      requestId,
    } = payload as GroupingWorkerPayload;

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

      // OPTIMIZATION: Parallel thumbnail generation with early exit on minimum viable set
      const MIN_THUMBNAILS_FOR_GROUPING = Math.max(2, Math.floor(images.length * 0.3)); // 30% minimum
      const thumbnails: { id: string; buffer: Buffer; metadata: any }[] = [];

      // Pre-resolve service endpoint to avoid repeated calls
      const imageOptimizerUrl = await getServiceEndpoint('image-optimizer', tenant);

      // Create all thumbnail promises upfront for maximum parallelism
      const thumbnailPromises = images.map(async (image, index) => {
        const imageId = image.imageId || `img_${randomUUID()}`;

        try {
          const thumbnailResponse = await fetch(imageOptimizerUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Tenant-Id': tenant,
              'x-api-key': serviceApiKey,
            },
            body: JSON.stringify({
              imageBase64: image.imageBase64,
              outputFormat: 'jpeg',
              quality: 75, // Reduced from 80 for faster processing
              targetSize: thumbnailSize,
            }),
          });

          if (!thumbnailResponse.ok) {
            console.warn('[GroupImagesWorker] Thumbnail failed, continuing', {
              imageId,
              status: thumbnailResponse.status,
            });
            return null;
          }

          const thumbnailData = await thumbnailResponse.json();
          const thumbnailBuffer = Buffer.from(thumbnailData.outputBase64, 'base64');

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
      await dynamoDB.send(new PutItemCommand({
        TableName: tableName,
        Item: marshall({
          PK: pk,
          SK: sk,
          ...additionalFields,
          status,
          updatedAt: new Date().toISOString(),
          ttl: Math.floor(Date.now() / 1000) + 86400 * 7, // 7 days retention
        }),
      }));

      console.info('Grouping job status updated', { tenant, jobId, status });
    } catch (error) {
      console.error('Failed to update grouping job status', {
        tenant,
        jobId,
        status,
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't throw - allow processing to continue
    }
  }
}

// Export handler function for Lambda
export const groupImagesWorker = async (event: any) => {
  const handler = new GroupImagesWorkerHandler();
  return handler.handle(event);
};