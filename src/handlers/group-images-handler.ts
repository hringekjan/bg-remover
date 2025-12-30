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
const tableName = process.env.BG_REMOVER_TABLE_NAME!;

/**
 * Group Images Handler - Phase 1: Upload & Group
 *
 * Cost-optimized workflow:
 * 1. Generate thumbnails (256x256, aspect-preserved) for each image
 * 2. Generate Titan embeddings on thumbnails (30% faster)
 * 3. Cluster by similarity (0.92 threshold)
 * 4. Store groups in DynamoDB
 * 5. Return suggested groups with thumbnails to frontend
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

      console.log('[GroupImages] Processing batch grouping request', {
        tenant,
        stage,
        requestId,
      });

      // Parse and validate request
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

      // Load tenant config to get image-optimizer API key
      const { secrets } = await loadConfig(stage, tenant);

      if (!secrets.serviceApiKey) {
        console.error('[GroupImages] Image optimizer API key not configured', { tenant, stage });
        return this.internalError({
          error: 'CONFIGURATION_ERROR',
          message: 'Image optimizer API key not configured for tenant',
        });
      }

      // Step 1: Generate thumbnails for all images
      const thumbnails: { id: string; buffer: Buffer; metadata: any }[] = [];

      for (let i = 0; i < images.length; i++) {
        const image = images[i];
        const imageId = `img_${randomUUID()}`;

        console.log(`[GroupImages] Generating thumbnail ${i + 1}/${images.length}`, {
          imageId,
          filename: image.filename,
        });

        try {
          // Call image-optimizer to generate thumbnail (aspect-preserved)
          const imageOptimizerUrl = await getServiceEndpoint('image-optimizer', tenant);
          const thumbnailResponse = await fetch(imageOptimizerUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Tenant-Id': tenant,
              'x-api-key': secrets.serviceApiKey,
            },
            body: JSON.stringify({
              imageBase64: image.imageBase64,
              outputFormat: 'jpeg', // JPEG for smaller thumbnails
              quality: 80,
              targetSize: thumbnailSize,
            }),
          });

          if (!thumbnailResponse.ok) {
            const errorText = await thumbnailResponse.text();
            console.error('[GroupImages] Thumbnail generation failed', {
              imageId,
              status: thumbnailResponse.status,
              error: errorText,
            });
            continue; // Skip this image
          }

          const thumbnailData = await thumbnailResponse.json();
          const thumbnailBuffer = Buffer.from(thumbnailData.outputBase64, 'base64');

          thumbnails.push({
            id: imageId,
            buffer: thumbnailBuffer,
            metadata: {
              filename: image.filename,
              uploadedAt: image.metadata?.uploadedAt || new Date().toISOString(),
              originalSize: image.metadata?.originalSize,
              thumbnailSize: thumbnailData.metadata,
            },
          });

          console.log(`[GroupImages] Thumbnail generated`, {
            imageId,
            thumbnailSize: thumbnailBuffer.length,
            width: thumbnailData.metadata.width,
            height: thumbnailData.metadata.height,
          });
        } catch (error) {
          console.error('[GroupImages] Failed to generate thumbnail', {
            imageId,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
      }

      // If thumbnail generation failed for all images, skip similarity grouping
      // and create single-image groups (fallback mode)
      if (thumbnails.length === 0) {
        console.warn('[GroupImages] Thumbnail generation failed, using fallback mode (single-image groups)', {
          totalImages: images.length,
          tenant,
        });

        // Create single-image groups for each uploaded image
        const fallbackGroups = images.map((image, i) => {
          const imageId = `img_${randomUUID()}`;
          return {
            groupId: `pg_${randomUUID()}`,
            imageIds: [imageId],
            imageCount: 1,
            thumbnails: [],  // No thumbnails available
            confidence: 1.0,
            primaryImageId: imageId,
            productName: '', // User will fill in during review
            category: '',
            metadata: {
              filename: image.filename,
              uploadedAt: image.metadata?.uploadedAt || new Date().toISOString(),
              originalSize: image.metadata?.originalSize,
              fallbackMode: true,  // Flag to indicate no similarity was used
            },
          };
        });

        return this.success({
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
          requestId,
        });
      }

      console.log('[GroupImages] All thumbnails generated', {
        total: thumbnails.length,
        tenant,
      });

      // Step 2: Batch process for grouping using Titan embeddings on thumbnails
      const groupingResult = await batchProcessForGrouping(
        thumbnails,
        tenant,
        includeExistingEmbeddings
      );

      console.log('[GroupImages] Grouping completed', {
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

      return this.success({
        groups: allGroups,
        summary: {
          totalImages: images.length,
          processedImages: thumbnails.length,
          groupsFound: groupingResult.groups.length,
          singleImageProducts: groupingResult.ungrouped.length,
          existingMatched: groupingResult.existingMatched,
          similarityThreshold,
        },
        requestId,
      });
    } catch (error) {
      console.error('[GroupImages] Request failed', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        requestId,
      });

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
