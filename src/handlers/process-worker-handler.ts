import { DynamoDBClient, UpdateItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { marshall } from '@aws-sdk/util-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { BaseHandler } from './base-handler';
import { randomUUID } from 'crypto';
import {
  ProcessRequestSchema,
  type ProcessResult,
  type ProductDescription,
  type MultilingualProductDescription,
  type BilingualProductDescription,
} from '../lib/types';
import { validateRequest } from '../lib/validation';
import { resolveTenantFromRequest, loadTenantConfig } from '../lib/tenant/resolver';
import {
  processImageFromUrl,
  processImageFromBase64,
} from '../lib/bedrock/image-processor';
import { uploadProcessedImage, generateOutputKey, getOutputBucket } from '../../lib/s3/client';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { refundCredits } from '../lib/credits/client';
import { multilingualDescriptionGenerator } from '../lib/multilingual-description';
import { bgRemoverTelemetry, calculateBgRemoverCost } from '../lib/telemetry/bg-remover-telemetry';
import { addProductsToBooking, createProductInCarouselApi, type CreateProductRequest } from '../../lib/carousel-api/client';
import { EventTracker } from '../lib/event-tracking';

const dynamoDB = new DynamoDBClient({
  requestHandler: new NodeHttpHandler({
    connectionTimeout: 5000,
    requestTimeout: 10000,
  }),
});
const eventTracker = new EventTracker(dynamoDB);
const s3Client = new S3Client({
  requestHandler: new NodeHttpHandler({
    connectionTimeout: 10000,
    requestTimeout: 30000,
  }),
});
const eventBridgeClient = new EventBridgeClient({ 
  region: process.env.AWS_REGION || 'eu-west-1',
  requestHandler: new NodeHttpHandler({
    connectionTimeout: 5000,
    requestTimeout: 10000,
  }),
});
const tableName = process.env.DYNAMODB_TABLE || `carousel-main-${process.env.STAGE || 'dev'}`;

interface JobPayload {
  jobId: string;
  tenant: string;
  userId: string;
  creditTransactionId?: string;
  requestBody: any;
  stage: string;
}

interface GroupProcessingPayload {
  jobId: string;
  tenant: string;
  stage: string;
  userId: string;
  authToken?: string;
  bookingId?: string;
  groupId: string;
  images: Array<{
    imageId: string;           // Frontend photoId for matching
    imageBase64?: string;      // Legacy: direct base64 data
    s3Bucket?: string;         // NEW: S3 bucket name
    s3Key?: string;            // NEW: S3 object key
    filename: string;
    isPrimary: boolean;
  }>;
  productName?: string;
  pipeline: string;
  processingOptions: any;
  serviceApiKey: string;
  requestId: string;
  groupContext?: {
    totalImages: number;
    signalBreakdown?: {
      composition: number;
      background: number;
      spatial: number;
      feature: number;
      semantic: number;
    };
    rekognitionLabels?: Array<{ Name: string; Confidence: number }>;
    category?: string;
    confidence?: number;
    avgSimilarity?: number;
  };
}

/**
 * Process Worker Handler - Async background processing
 *
 * This handler is invoked asynchronously from the main process handler.
 * It performs the actual image processing and updates job status in DynamoDB.
 *
 * Key features:
 * - Long-running processing (up to 15 minutes)
 * - No HTTP API Gateway timeout constraints
 * - Automatic credit refunds on failure
 * - Job status updates in DynamoDB
 */
export class ProcessWorkerHandler extends BaseHandler {
  async handle(event: any): Promise<any> {
    const payload = typeof event === 'string' ? JSON.parse(event) : event;

    // Detect payload type: group processing vs single image
    if (this.isGroupProcessingPayload(payload)) {
      return this.handleGroupProcessing(payload as GroupProcessingPayload);
    } else {
      return this.handleSingleImageProcessing(payload as JobPayload);
    }
  }

  /**
   * Check if payload is for group processing (multi-image workflow)
   */
  private isGroupProcessingPayload(payload: any): boolean {
    return !!(payload.groupId && payload.images && Array.isArray(payload.images) && payload.pipeline);
  }

  /**
   * Download image from S3 and convert to base64
   * Solves Lambda 1MB payload limit by storing images in S3
   * Includes retry logic with exponential backoff for resilience
   */
  private async downloadImageFromS3(
    bucket: string,
    key: string,
    jobId: string,
    maxRetries: number = 3
  ): Promise<string> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log('[Worker] Downloading image from S3', {
          jobId,
          bucket,
          key,
          attempt,
          maxRetries,
        });

        const response = await s3Client.send(new GetObjectCommand({
          Bucket: bucket,
          Key: key,
        }));

        // Read stream into buffer
        const chunks: Uint8Array[] = [];
        for await (const chunk of response.Body as any) {
          chunks.push(chunk);
        }
        const buffer = Buffer.concat(chunks);

        console.log('[Worker] Image downloaded from S3', {
          jobId,
          sizeBytes: buffer.length,
          key,
          attempt,
        });

        // Convert to base64
        return buffer.toString('base64');
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error('[Worker] S3 download failed', {
          jobId,
          bucket,
          key,
          attempt,
          maxRetries,
          error: errorMessage,
        });

        // If this was the last attempt, throw error
        if (attempt === maxRetries) {
          throw new Error(
            `Failed to download image from S3 after ${maxRetries} attempts: ${key}. ` +
            `Last error: ${errorMessage}`
          );
        }

        // Exponential backoff: 1s, 2s, 4s
        const delayMs = 1000 * Math.pow(2, attempt - 1);
        console.warn('[Worker] Retrying S3 download after delay', {
          jobId,
          attempt,
          nextAttempt: attempt + 1,
          delayMs,
        });

        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    // This should never be reached due to throw in loop, but TypeScript requires it
    throw new Error('Unreachable code in downloadImageFromS3');
  }

  /**
   * Build rich context prompt from group metadata for AI description generation
   */
  private buildGroupContextPrompt(
    groupContext: GroupProcessingPayload['groupContext'],
    processedCount: number,
    productName?: string
  ): string {
    if (!groupContext) return '';

    const parts: string[] = [];

    if (productName) {
      parts.push(`Product: ${productName}`);
    }
    parts.push(`Available views: ${groupContext.totalImages} images`);

    if (groupContext.totalImages > 1) {
      parts.push(`Multiple angles available (front, side, back, detail shots)`);
    }

    if (groupContext.signalBreakdown) {
      if (groupContext.signalBreakdown.composition > 0.85) {
        parts.push(`Professional photography detected`);
      }
      if (groupContext.signalBreakdown.background > 0.80) {
        parts.push(`Studio background quality`);
      }
    }

    if (groupContext.rekognitionLabels && groupContext.rekognitionLabels.length > 0) {
      const labels = groupContext.rekognitionLabels
        .slice(0, 5)
        .map(l => l.Name)
        .join(', ');
      parts.push(`Detected features: ${labels}`);
    }

    if (groupContext.confidence && groupContext.confidence > 0.90) {
      parts.push(`High confidence grouping (${(groupContext.confidence * 100).toFixed(0)}%)`);
    }

    return parts.join('. ');
  }

  /**
   * Generate price suggestion enhanced with group quality signals
   */
  private generatePriceSuggestion(
    productFeatures: any,
    groupContext?: GroupProcessingPayload['groupContext']
  ): { min: number; max: number; suggested: number } {
    let basePrice = 50; // Default base price

    if (groupContext) {
      // Adjust based on image quality signals
      if (groupContext.signalBreakdown) {
        const composition = groupContext.signalBreakdown.composition;
        const background = groupContext.signalBreakdown.background;

        // Professional photography = premium pricing
        if (composition > 0.85 && background > 0.85) {
          basePrice *= 1.5;
        }

        // Multiple angles = higher value perception
        if (groupContext.totalImages >= 5) {
          basePrice *= 1.2;
        }
      }

      // Category-based pricing
      const category = groupContext.category?.toLowerCase() || '';
      if (category.includes('jewelry') || category.includes('vintage')) {
        basePrice *= 2.0;
      } else if (category.includes('electronics')) {
        basePrice *= 1.5;
      } else if (category.includes('furniture')) {
        basePrice *= 1.3;
      }
    }

    // Apply condition-based pricing
    const condition = productFeatures.condition || 'good';
    const conditionMultipliers: Record<string, number> = {
      new_with_tags: 1.0,
      like_new: 0.85,
      very_good: 0.70,
      good: 0.55,
      fair: 0.40,
    };
    basePrice *= conditionMultipliers[condition] || 0.55;

    return {
      min: Math.floor(basePrice * 0.8),
      max: Math.ceil(basePrice * 1.2),
      suggested: Math.floor(basePrice),
    };
  }

  /**
   * Predict product rating based on group quality signals
   */
  private predictRating(
    groupContext?: GroupProcessingPayload['groupContext'],
    productFeatures?: any
  ): number {
    let rating = 3.5; // Base rating

    if (groupContext) {
      // Multiple professional angles
      if (groupContext.totalImages >= 4) {
        rating += 0.5;
      }

      // Professional photography
      if ((groupContext.signalBreakdown?.composition ?? 0) > 0.85) {
        rating += 0.3;
      }

      // Studio quality
      if ((groupContext.signalBreakdown?.background ?? 0) > 0.80) {
        rating += 0.2;
      }

      // High grouping confidence
      if (groupContext.confidence && groupContext.confidence > 0.90) {
        rating += 0.3;
      }
    }

    // Cap at 5.0
    return Math.min(5.0, rating);
  }

  /**
   * Calculate overall quality score from group signals
   */
  private calculateQualityScore(groupContext: GroupProcessingPayload['groupContext']): number {
    if (!groupContext) return 0.5;

    let score = 0;

    // Signal breakdown contributes 60% of score
    if (groupContext.signalBreakdown) {
      const avg = (
        groupContext.signalBreakdown.composition +
        groupContext.signalBreakdown.background +
        groupContext.signalBreakdown.spatial +
        groupContext.signalBreakdown.feature +
        groupContext.signalBreakdown.semantic
      ) / 5;
      score += avg * 0.6;
    }

    // Grouping confidence contributes 20%
    if (groupContext.confidence) {
      score += groupContext.confidence * 0.2;
    }

    // Average similarity contributes 20%
    if (groupContext.avgSimilarity) {
      score += groupContext.avgSimilarity * 0.2;
    }

    return Math.min(1.0, score);
  }

  /**
   * Generate SEO keywords from all images in group
   */
  private generateSEOKeywords(
    groupContext: GroupProcessingPayload['groupContext'],
    productName: string,
    multilingualDescription?: any
  ): string[] {
    const keywords = new Set<string>();

    // From product name
    keywords.add(productName.toLowerCase());

    // From Rekognition labels (all images in group)
    if (groupContext?.rekognitionLabels) {
      groupContext.rekognitionLabels.forEach(label => {
        if (label.Confidence > 80) {
          keywords.add(label.Name.toLowerCase());
        }
      });
    }

    // From descriptions
    if (multilingualDescription?.en?.description) {
      const words = multilingualDescription.en.description
        .toLowerCase()
        .split(/\s+/)
        .filter((w: string) => w.length > 3);
      words.forEach((w: string) => keywords.add(w));
    }

    // Category-based keywords
    if (groupContext?.category) {
      keywords.add(groupContext.category.toLowerCase());
    }

    return Array.from(keywords).slice(0, 20);
  }

  /**
   * Handle group processing workflow (Phase 3: Process approved groups)
   *
   * Agentic workflow:
   * 1. Process all images in the group using selected pipeline
   * 2. Generate multilingual descriptions for the product
   * 3. Create product in carousel-api with all images
   * 4. Update job status with product creation result
   */
  private async handleGroupProcessing(payload: GroupProcessingPayload): Promise<any> {
    const { jobId, tenant, groupId, images, productName, pipeline, processingOptions, stage, groupContext, userId, bookingId, authToken } = payload;

    console.log('[Worker] Processing group', {
      jobId,
      groupId,
      tenant,
      imageCount: images.length,
      pipeline,
      productName,
      processingOptions,
    });

    const processingStartTime = Date.now();

    const maxConcurrent = Math.min(images.length, 5); // Limit concurrency to prevent Lambda memory issues

    // Initialize variables before try block so they're accessible in catch block
    let completedCount = 0;
    let failedCount = 0;
    let imageStates: Array<any> = [];

    try {
      // Update job status to processing
      await this.updateJobStatus(tenant, jobId, 'processing', {
        startedAt: new Date().toISOString(),
        groupId,
        imageCount: images.length,
        pipeline,
      });

      // Load tenant config
      const config = await loadTenantConfig(tenant, stage);
      const outputBucket = await getOutputBucket(tenant, stage);

      // Process each image in the group concurrently for better scalability
      console.log(`[Worker] Processing ${images.length} images concurrently (max ${maxConcurrent} at once)`, {
        jobId,
        groupId,
      });

      // Load current job state for resumable operations
      const currentJobState = await this.loadJobState(tenant, jobId);
      imageStates = currentJobState?.images || images.map((img, index) => ({
        s3Key: img.s3Key || `temp/${tenant}/${jobId}/${index}_${img.filename}`,
        index,
        status: 'pending' as const,
        filename: img.filename,
        attempts: 0,
        lastAttemptAt: null,
        error: null,
      }));

      // Update progress tracking based on resumable state
      completedCount = imageStates.filter(img => img.status === 'completed').length;
      failedCount = imageStates.filter(img => img.status === 'failed').length;

      const imagePromises = images.map(async (image, index) => {
        // Skip already completed images
        if (imageStates[index]?.status === 'completed') {
          console.log(`[Worker] Skipping already completed image ${index + 1}/${images.length}`, {
            jobId,
            groupId,
            filename: image.filename,
          });
          return imageStates[index]; // Return cached result
        }

        // Skip images that have failed too many times (max 3 attempts)
        if (imageStates[index]?.attempts >= 3 && imageStates[index]?.status === 'failed') {
          console.log(`[Worker] Skipping image ${index + 1}/${images.length} - max retries exceeded`, {
            jobId,
            groupId,
            filename: image.filename,
            attempts: imageStates[index].attempts,
          });
          failedCount++;
          return null;
        }

        try {
          // Update image status to processing - starting
          this.updateImageStatusInMemory(imageStates, index, 'processing', undefined, 'starting');

          console.log(`[Worker] Starting processing for image ${index + 1}/${images.length}`, {
            jobId,
            groupId,
            filename: image.filename,
            isPrimary: image.isPrimary,
            attempt: (imageStates[index]?.attempts || 0) + 1,
          });

          const imageProcessingOptions = {
            format: processingOptions.outputFormat || 'png',
            quality: processingOptions.quality,
            autoTrim: processingOptions.autoTrim,
            centerSubject: processingOptions.centerSubject,
            enhanceColors: processingOptions.enhanceColors,
            generateDescription: processingOptions.generateDescription && image.isPrimary, // Only generate for primary image
            productName: productName || `Product ${groupId}`,
          };

          // Download from S3 if S3 keys provided, otherwise use legacy base64
          let imageBase64 = image.imageBase64;
          if (image.s3Bucket && image.s3Key) {
            // Update step: downloading
            this.updateImageStatusInMemory(imageStates, index, 'processing', undefined, 'downloading');

            console.log('[Worker] Using S3 image source', {
              jobId,
              s3Bucket: image.s3Bucket,
              s3Key: image.s3Key,
              filename: image.filename,
            });
            imageBase64 = await this.downloadImageFromS3(image.s3Bucket, image.s3Key, jobId);
          } else if (!imageBase64) {
            throw new Error(`Image data missing: neither imageBase64 nor S3 location provided for ${image.filename}`);
          }

          // Update step: removing background
          this.updateImageStatusInMemory(imageStates, index, 'processing', undefined, 'removing_background');

          const result = await processImageFromBase64(
            imageBase64,
            'image/png',
            imageProcessingOptions,
            tenant,
            stage
          );

          // Update step: uploading
          this.updateImageStatusInMemory(imageStates, index, 'processing', undefined, 'uploading');

          // Store processed image
          const contentType = (processingOptions.outputFormat || 'png') === 'png' ? 'image/png' :
                             (processingOptions.outputFormat || 'png') === 'webp' ? 'image/webp' : 'image/jpeg';
          const outputKey = generateOutputKey(tenant, jobId, processingOptions.outputFormat || 'png');
          const outputUrl = await uploadProcessedImage(
            outputBucket,
            outputKey,
            result.outputBuffer,
            contentType,
            {
              tenant,
              jobId,
              groupId,
              filename: image.filename,
              source: image.s3Key || 'base64',
            }
          );

          // Update image status to completed
          this.updateImageStatusInMemory(imageStates, index, 'completed', {
            outputUrl,
            outputKey,
            metadata: result.metadata,
            productDescription: image.isPrimary ? result.productDescription : undefined,
          });

          console.log(`[Worker] Completed processing for image ${index + 1}/${images.length}`, {
            jobId,
            groupId,
            filename: image.filename,
            processingTimeMs: Date.now() - processingStartTime,
          });

          completedCount++;
          return {
            filename: image.filename,
            outputUrl,
            outputKey,
            isPrimary: image.isPrimary,
            metadata: result.metadata,
            productDescription: image.isPrimary ? result.productDescription : undefined,
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);

          // Update image status to failed
          this.updateImageStatusInMemory(imageStates, index, 'failed', {
            error: errorMessage,
          });

          console.error(`[Worker] Failed processing for image ${index + 1}/${images.length}`, {
            jobId,
            groupId,
            filename: image.filename,
            error: errorMessage,
            attempt: imageStates[index]?.attempts || 1,
          });

          failedCount++;
          return null; // Return null for failed images
        }
      });

      // Process images concurrently with controlled concurrency
      const concurrencyLimit = Math.min(maxConcurrent, imagePromises.length);
      const processedResults = [];

      for (let i = 0; i < imagePromises.length; i += concurrencyLimit) {
        const batch = imagePromises.slice(i, i + concurrencyLimit);
        const batchResults = await Promise.all(batch);
        processedResults.push(...batchResults);

        // Update progress after each batch for real-time tracking
        const currentProgress = {
          total: images.length,
          completed: imageStates.filter(img => img.status === 'completed').length,
          failed: imageStates.filter(img => img.status === 'failed').length,
          processing: imageStates.filter(img => img.status === 'processing').length,
          pending: imageStates.filter(img => img.status === 'pending').length,
        };

        // Save progress and image states to DynamoDB for status endpoint
        await this.updateJobStatus(tenant, jobId, 'processing', {
          progress: currentProgress,
          images: imageStates.map(img => ({
            imageId: img.imageId || img.filename,
            filename: img.filename,
            status: img.status,
            currentStep: img.currentStep,
            processingTimeMs: img.processingTimeMs,
            attempts: img.attempts,
          })),
        });
      }

      // Separate processed images and descriptions
      // Filter out null results from failed images before mapping
      const processedImages = processedResults
        .filter(result => result !== null)
        .map((result, index) => ({
          imageId: images[index]?.imageId || `img_${jobId}_${index}`, // Use frontend photoId for matching
          filename: result.filename,
          outputUrl: result.outputUrl,
          outputKey: result.outputKey,
          isPrimary: result.isPrimary,
          metadata: result.metadata,
          width: result.metadata?.width,
          height: result.metadata?.height,
        }));

      const imageResults = processedResults
        .filter(result => result !== null) // Filter out null results from failed images FIRST
        .filter(result => result.isPrimary && result.productDescription)
        .map(result => ({
          productDescription: result.productDescription!,
          metadata: result.metadata,
        }));

      console.log('[Worker] All images processed', {
        jobId,
        groupId,
        processedCount: processedImages.length,
      });

      // Generate multilingual descriptions using pipeline with group context
      let multilingualDescription: MultilingualProductDescription | undefined;
      let groupPricing: { min: number; max: number; suggested: number } | undefined;
      let predictedRating: number | undefined;
      let seoKeywords: string[] = [];

      console.log('[Worker] Checking description generation condition', {
        jobId,
        groupId,
        generateDescription: processingOptions?.generateDescription,
        imageResultsLength: imageResults.length,
        willGenerate: !!(processingOptions?.generateDescription && imageResults.length > 0),
        processingOptionsKeys: Object.keys(processingOptions || {}),
      });

      if (processingOptions.generateDescription && imageResults.length > 0) {
        const primaryResult = imageResults[0];
        const languages = processingOptions.languages || ['en', 'is'];

        try {
          // Build context prompt from group metadata
          const contextPrompt = this.buildGroupContextPrompt(
            groupContext,
            imageResults.length,
            productName
          );

          const productFeatures = {
            name: productName || 'Product',
            category: groupContext?.category || primaryResult.productDescription.category || 'general',
            colors: primaryResult.productDescription.colors,
            condition: primaryResult.productDescription.condition || 'good' as const,
            brand: primaryResult.productDescription.priceSuggestion?.factors.brand,
            // NEW: Add group-aware fields
            groupContext: contextPrompt,
            imageCount: groupContext?.totalImages || images.length,
            hasMultipleAngles: (groupContext?.totalImages || images.length) > 1,
          };

          multilingualDescription = await multilingualDescriptionGenerator.generateMultilingualDescriptions(
            productFeatures,
            languages,
            processingOptions.generatePriceSuggestion || false,
            processingOptions.generateRatingSuggestion || false
          );

          // Generate group-aware pricing if requested
          if (processingOptions.generatePriceSuggestion) {
            groupPricing = this.generatePriceSuggestion(productFeatures, groupContext);
          }

          // Generate group-aware rating prediction if requested
          if (processingOptions.generateRatingSuggestion) {
            predictedRating = this.predictRating(groupContext, productFeatures);
          }

          // Generate SEO keywords from all images in group
          seoKeywords = this.generateSEOKeywords(
            groupContext,
            productName || 'Product',
            multilingualDescription
          );

          console.log('[Worker] Multilingual descriptions generated with group context', {
            jobId,
            groupId,
            languages,
            contextPrompt: contextPrompt.substring(0, 100) + '...',
            hasPricing: !!groupPricing,
            hasRating: !!predictedRating,
            seoKeywordCount: seoKeywords.length,
          });
        } catch (error) {
          console.warn('[Worker] Failed to generate multilingual descriptions', {
            jobId,
            groupId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const processingTimeMs = Date.now() - processingStartTime;

      // Enhance processed images with group-aware metadata
      const enhancedImages = processedImages.map(img => ({
        ...img,
        groupPricing,
        predictedRating,
        seoKeywords,
        groupContext: groupContext ? {
          totalAngles: groupContext.totalImages,
          qualityScore: this.calculateQualityScore(groupContext),
          category: groupContext.category,
          confidence: groupContext.confidence,
        } : undefined,
      }));

      let createdProductId: string | undefined;
      if (userId && processedImages.length > 0) {
        const primaryDescription = multilingualDescription?.en || imageResults[0]?.productDescription;
        const descriptionText = primaryDescription?.long || primaryDescription?.short;
        const priceSuggestion = groupPricing?.suggested || primaryDescription?.priceSuggestion?.suggested;

        // Build complete product metadata matching CarouselProductRegistration schema
        const productData: CreateProductRequest = {
          productId: randomUUID(),
          sku: `${groupId}-${Date.now()}`,
          content: {
            en: {
              name: productName || `Product ${groupId}`,
              description: primaryDescription?.long || descriptionText || '',
              shortDescription: primaryDescription?.short
            },
            is: {
              name: productName || `Product ${groupId}`,
              description: multilingualDescription?.is?.long || '',
              shortDescription: multilingualDescription?.is?.short
            },
            defaultLocale: 'en' as const
          },
          pricing: {
            basePrice: Math.round((priceSuggestion || 0) * 100), // Convert to cents
            currency: 'ISK'
          },
          seo: {
            metaTitle: productName || `Product ${groupId}`,
            metaDescription: primaryDescription?.short || descriptionText || '',
            keywords: seoKeywords || [],
            slug: (productName || `product-${groupId}`).toLowerCase().replace(/\s+/g, '-')
          },
          qualityMetrics: {
            confidenceScore: 0.85,
            processingTimeMs: processingTimeMs || 0,
            carouselRating: {
              averageScore: predictedRating || 0,
              totalReviews: 0,
              userReputationWeight: 1.0
            }
          },
          categorization: {
            category: groupContext?.category || primaryDescription?.category || 'uncategorized',
            subcategory: '',
            tags: seoKeywords || []
          },
          imageMetadata: processedImages[0] ? {
            width: processedImages[0].width || processedImages[0].metadata?.width || 1024,
            height: processedImages[0].height || processedImages[0].metadata?.height || 1024,
            format: 'png' as const,
            fileSize: processedImages[0].metadata?.processedSize || 0,
            sourceImageKey: images[0]?.s3Key || '',
            processedImageKey: processedImages[0].outputKey || ''
          } : undefined,
          status: 'DRAFT' as const
          // Note: createdAt and updatedAt are reserved fields set by carousel-api
        };

        const { product, error } = await createProductInCarouselApi(tenant, userId, productData, authToken);
        if (error || !product) {
          console.warn('[Worker] Failed to create product in carousel-api', {
            jobId,
            groupId,
            error: error || 'Unknown error',
          });
        } else {
          createdProductId = product.id;
          console.info('[Worker] Created product in carousel-api', {
            jobId,
            groupId,
            productId: createdProductId,
          });
        }
      }

      if (createdProductId && bookingId) {
        const { error } = await addProductsToBooking(tenant, userId, bookingId, [createdProductId], authToken);
        if (error) {
          console.warn('[Worker] Failed to attach product to booking', {
            jobId,
            groupId,
            bookingId,
            productId: createdProductId,
            error,
          });
        }
      }

      // Calculate final progress
      const finalProgress = {
        total: images.length,
        completed: completedCount,
        failed: failedCount,
        processing: 0,
        pending: images.length - completedCount - failedCount,
      };

      // Update job status to completed with resumable state
      // Note: Store minimal data to avoid DynamoDB size limits
      await this.updateJobStatus(tenant, jobId, 'completed', {
        groupId,
        pipeline,
        processingTimeMs,
        completedAt: new Date().toISOString(),
        // Store resumable state but limit size
        progress: finalProgress,
        resumable: true,
        imageCount: processedImages.length,
        // Store group-level metadata for frontend display
        productName,
        multilingualDescription,
        groupPricing,
        seoKeywords,
        predictedRating,
        category: groupContext?.category,
        // Store processedImages array with full metadata for frontend display
        processedImages: processedImages.map(img => ({
          imageId: img.imageId,
          outputUrl: img.outputUrl,
          outputKey: img.outputKey,
          status: 'completed',
          width: img.width || img.metadata?.width,
          height: img.height || img.metadata?.height,
          processingTimeMs: img.processingTimeMs || img.metadata?.processingTimeMs || 0,
          // Add rich metadata for frontend display
          productName,
          bilingualDescription: multilingualDescription ? {
            en: {
              title: productName,
              short: multilingualDescription.en?.short,
              description: multilingualDescription.en?.long,
            },
            is: {
              title: productName,
              short: multilingualDescription.is?.short,
              description: multilingualDescription.is?.long,
            },
          } : undefined,
          price: groupPricing?.suggested,
          priceRange: groupPricing ? {
            min: groupPricing.min,
            max: groupPricing.max,
          } : undefined,
          keywords: seoKeywords,
          category: groupContext?.category,
          rating: predictedRating,
        })),
      });

      // Record batch telemetry with concurrency metrics
      const totalCost = calculateBgRemoverCost({
        imageSize: processedImages.reduce((sum, img) => sum + (img.metadata?.processedSize || 0), 0) / processedImages.length,
        processingTime: processingTimeMs,
        qualityLevel: processingOptions.quality || 'medium',
        imageCount: processedImages.length,
      });

      await bgRemoverTelemetry.recordBatchJob({
        batchId: jobId,
        imagesProcessed: processedImages.length,
        successCount: processedImages.length,
        failureCount: 0,
        totalCost,
        durationMs: processingTimeMs,
        pipeline,
        concurrencyUsed: maxConcurrent,
        processingMode: 'concurrent',
      });

      console.info('[Worker] Group processing completed', {
        jobId,
        groupId,
        tenant,
        imageCount: processedImages.length,
        processingTimeMs,
      });

      return { success: true, jobId, groupId, imageCount: processedImages.length, processingTimeMs };
    } catch (error) {
      const processingTimeMs = Date.now() - processingStartTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      console.error('[Worker] Group processing failed', {
        jobId,
        groupId,
        error: errorMessage,
        processingTimeMs,
        tenant,
      });

      // Record failed batch telemetry
      await bgRemoverTelemetry.recordBatchJob({
        batchId: jobId,
        imagesProcessed: images.length,
        successCount: 0,
        failureCount: images.length,
        totalCost: 0,
        durationMs: processingTimeMs,
        pipeline,
        concurrencyUsed: maxConcurrent,
        processingMode: 'concurrent',
      });

      // Calculate final progress for failed job
      const finalProgress = {
        total: images.length,
        completed: completedCount,
        failed: failedCount,
        processing: 0,
        pending: images.length - completedCount - failedCount,
      };

      // Update job status to failed with resumable state
      // Note: Store minimal data to avoid DynamoDB size limits
      await this.updateJobStatus(tenant, jobId, 'failed', {
        groupId,
        error: errorMessage,
        processingTimeMs,
        completedAt: new Date().toISOString(),
        // Store resumable state but limit size
        progress: finalProgress,
        resumable: true,
        canResume: failedCount < images.length,
        // Don't store full images array to avoid size limits
      });

      return { success: false, error: errorMessage };
    }
  }

  /**
   * Handle single image processing workflow (existing functionality)
   */
  private async handleSingleImageProcessing(payload: JobPayload): Promise<any> {
    const { jobId, tenant, userId, creditTransactionId, requestBody, stage } = payload;

    console.log('Worker processing job', {
      jobId,
      tenant,
      userId,
      hasCreditTransaction: !!creditTransactionId,
    });

    const processingStartTime = Date.now();

    try {
      // Update job status to processing
      await this.updateJobStatus(tenant, jobId, 'processing', {
        startedAt: new Date().toISOString(),
      });

      // Parse and validate request
      const validation = validateRequest(ProcessRequestSchema, requestBody, 'process-request');
      if (!validation.success) {
        await this.updateJobStatus(tenant, jobId, 'failed', {
          error: validation.error?.message || 'Validation failed',
          errorDetails: validation.error?.details,
          completedAt: new Date().toISOString(),
        });
        return { success: false, error: 'Validation failed' };
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
        languages = ['en', 'is'],
        generatePriceSuggestion = false,
        generateRatingSuggestion = false,
      } = validatedRequest;

      // Load tenant config
      const config = await loadTenantConfig(tenant, stage);

      // Process the image
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

      let result: {
        outputBuffer: Buffer;
        metadata: {
          width: number;
          height: number;
          originalSize: number;
          processedSize: number;
        };
        productDescription?: ProductDescription;
        multilingualDescription?: MultilingualProductDescription;
        bilingualDescription?: BilingualProductDescription;
      };

      if (imageUrl) {
        result = await processImageFromUrl(imageUrl, processingOptions, tenant, stage);
      } else if (imageBase64) {
        result = await processImageFromBase64(imageBase64, 'image/png', processingOptions, tenant, stage);
      } else {
        throw new Error('No image provided');
      }

      const contentType = outputFormat === 'png' ? 'image/png' :
                         outputFormat === 'webp' ? 'image/webp' : 'image/jpeg';
      const outputBucket = await getOutputBucket(tenant, stage);
      const outputKey = generateOutputKey(tenant, productId || jobId, outputFormat || 'png');
      const outputUrl = await uploadProcessedImage(
        outputBucket,
        outputKey,
        result.outputBuffer,
        contentType,
        {
          tenant,
          jobId,
          productId: productId || 'unknown',
          source: imageUrl || 'base64',
        }
      );

      const processingTimeMs = Date.now() - processingStartTime;

      console.info('Image processed successfully', {
        jobId,
        processingTimeMs,
        outputSize: result.outputBuffer.length,
        originalSize: result.metadata.originalSize,
        processedSize: result.metadata.processedSize,
        tenant,
        outputFormat,
      });

      // Generate multilingual descriptions if requested
      let multilingualDescription: MultilingualProductDescription | undefined;
      let bilingualDescription: BilingualProductDescription | undefined;

      if (generateDescription) {
        try {
          const productFeatures = result.productDescription ? {
            name: productName || 'Product',
            category: result.productDescription.category || 'general',
            colors: result.productDescription.colors,
            condition: result.productDescription.condition || 'good',
            brand: result.productDescription.priceSuggestion?.factors.brand,
          } : {
            name: productName || 'Product',
            category: 'general',
            condition: 'good' as const,
          };

          multilingualDescription = await multilingualDescriptionGenerator.generateMultilingualDescriptions(
            productFeatures,
            languages,
            generatePriceSuggestion,
            generateRatingSuggestion
          );

          if (multilingualDescription.en && multilingualDescription.is) {
            bilingualDescription = {
              en: multilingualDescription.en,
              is: multilingualDescription.is,
            };
          }
        } catch (error) {
          console.warn('Failed to generate multilingual descriptions', {
            jobId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Emit CarouselImageProcessed event
      try {
        const eventBridge = eventBridgeClient;
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

        await eventBridge.send(new PutEventsCommand({
          Entries: [{
            Source: 'carousel.bg-remover',
            DetailType: 'CarouselImageProcessed',
            Detail: JSON.stringify(eventDetail),
          }],
        }));
        console.info('CarouselImageProcessed event emitted', { jobId, tenant });
      } catch (error) {
        console.error('Failed to emit CarouselImageProcessed event', {
          jobId,
          tenant,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // Emit AI Rating Suggestion event if rating was generated
      // Rating suggestion is stored per-language, use first language's rating
      const primaryLang = (languages && languages.length > 0) ? languages[0] : 'en';
      const primaryDescription = multilingualDescription?.[primaryLang];

      if (generateRatingSuggestion && primaryDescription?.ratingSuggestion) {
        try {
          const eventBridge = eventBridgeClient;
          const ratingEventDetail = {
            ratingId: `ai-rating-${jobId}`,
            productId,
            vendorId: null,
            buyerId: null,
            rating: primaryDescription.ratingSuggestion.overallRating,
            comment: `AI-generated rating suggestion: ${primaryDescription.ratingSuggestion.breakdown.description}`,
            conditionAsExpected: null,
            createdAt: new Date().toISOString(),
            ratingSource: 'ai_suggested',
            status: 'pending',
            aiMetadata: {
              confidence: primaryDescription.ratingSuggestion.confidence,
              breakdown: primaryDescription.ratingSuggestion.breakdown,
              factors: primaryDescription.ratingSuggestion.factors,
              jobId,
              productName,
              tenant_id: tenant,
            },
            auditTrail: [{
              action: 'created',
              actorId: 'bg-remover-service',
              actorRole: 'system',
              timestamp: new Date().toISOString(),
              newRating: primaryDescription.ratingSuggestion.overallRating,
              reason: 'AI-generated rating suggestion from image analysis',
            }],
          };

          await eventBridge.send(new PutEventsCommand({
            Entries: [{
              Source: 'carousel.bg-remover',
              DetailType: 'CarouselAIRatingSuggested',
              Detail: JSON.stringify(ratingEventDetail),
            }],
          }));
          console.info('CarouselAIRatingSuggested event emitted', {
            jobId,
            tenant,
            rating: primaryDescription.ratingSuggestion.overallRating,
          });
        } catch (error) {
          console.error('Failed to emit CarouselAIRatingSuggested event', {
            jobId,
            tenant,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Update job status to completed
      await this.updateJobStatus(tenant, jobId, 'completed', {
        outputUrl,
        outputKey,
        processingTimeMs,
        metadata: result.metadata,
        productDescription: result.productDescription,
        multilingualDescription,
        bilingualDescription,
        completedAt: new Date().toISOString(),
      });

      // Record telemetry
      const cost = calculateBgRemoverCost({
        imageSize: result.metadata.processedSize,
        processingTime: processingTimeMs,
        qualityLevel: quality || 'medium',
        imageCount: 1,
      });

      await bgRemoverTelemetry.recordImageProcessing({
        taskId: jobId,
        success: true,
        responseTimeMs: processingTimeMs,
        costUsd: cost,
        metadata: {
          imageSize: result.metadata.processedSize,
          processingMode: 'single',
          qualityLevel: quality || 'medium',
          outputFormat: outputFormat || 'png',
        },
      });
      await eventTracker.recordEvent(tenant, 'BACKGROUND_REMOVED', processingTimeMs);

      console.info('Job completed successfully', { jobId, tenant, processingTimeMs });

      return { success: true, jobId, processingTimeMs };
    } catch (error) {
      const processingTimeMs = Date.now() - processingStartTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      console.error('Image processing failed', {
        jobId,
        error: errorMessage,
        processingTimeMs,
        tenant,
      });

      // Record telemetry for failure
      await bgRemoverTelemetry.recordImageProcessing({
        taskId: jobId,
        success: false,
        responseTimeMs: processingTimeMs,
        costUsd: 0,
        error: {
          message: errorMessage,
          code: 'IMAGE_PROCESSING_FAILED',
          stack: error instanceof Error ? error.stack : undefined,
        },
      });
      await eventTracker.recordEvent(tenant, 'PROCESSING_FAILED', processingTimeMs, errorMessage);

      // Update job status to failed
      await this.updateJobStatus(tenant, jobId, 'failed', {
        error: errorMessage,
        processingTimeMs,
        completedAt: new Date().toISOString(),
      });

      // Refund credits on failure
      if (creditTransactionId && userId) {
        console.info('Initiating credit refund due to processing failure', {
          jobId,
          tenant,
          userId,
          originalTransactionId: creditTransactionId,
        });

        try {
          const refundResult = await refundCredits(
            tenant,
            userId,
            1,
            jobId,
            creditTransactionId
          );

          if (refundResult.success) {
            console.info('Credit refund successful', {
              jobId,
              tenant,
              userId,
              newBalance: refundResult.newBalance,
              refundTransactionId: refundResult.transactionId,
            });

            // Update job with refund info
            await this.updateJobStatus(tenant, jobId, 'failed', {
              refundStatus: 'completed',
              refundTransactionId: refundResult.transactionId,
            });
          } else {
            console.error('Credit refund failed', {
              jobId,
              tenant,
              userId,
              error: refundResult.error,
              errorCode: refundResult.errorCode,
            });

            await this.updateJobStatus(tenant, jobId, 'failed', {
              refundStatus: 'failed',
              refundError: refundResult.error,
            });
          }
        } catch (refundError) {
          console.error('Credit refund exception', {
            jobId,
            tenant,
            userId,
            error: refundError instanceof Error ? refundError.message : String(refundError),
          });
        }
      }

      return { success: false, error: errorMessage };
    }
  }

  /**
   * Load current job state from DynamoDB for resumable operations
   */
  private async loadJobState(tenant: string, jobId: string): Promise<any | null> {
    try {
      const { DynamoDBDocumentClient, GetCommand } = await import('@aws-sdk/lib-dynamodb');
      const docClient = DynamoDBDocumentClient.from(dynamoDB);

      const response = await docClient.send(new GetCommand({
        TableName: tableName,
        Key: {
          PK: `TENANT#${tenant}#BG_REMOVER_JOB#${jobId}`,
          SK: 'METADATA',
        },
      }));

      return response.Item || null;
    } catch (error) {
      console.warn('Failed to load job state, starting fresh', {
        tenant,
        jobId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Update individual image status in memory (will be persisted when job completes)
   * For resumable operations, we track state in memory during processing
   */
  private updateImageStatusInMemory(
    images: any[],
    imageIndex: number,
    status: 'pending' | 'processing' | 'completed' | 'failed',
    result?: Record<string, any>,
    currentStep?: string
  ): void {
    if (images[imageIndex]) {
      images[imageIndex].status = status;
      images[imageIndex].updatedAt = new Date().toISOString();
      images[imageIndex].lastAttemptAt = new Date().toISOString();
      images[imageIndex].attempts = (images[imageIndex].attempts || 0) + 1;

      // Track current processing step for progress UI
      if (currentStep) {
        images[imageIndex].currentStep = currentStep;
      } else if (status === 'completed') {
        images[imageIndex].currentStep = 'completed';
      } else if (status === 'failed') {
        images[imageIndex].currentStep = 'failed';
      }

      if (result) {
        Object.assign(images[imageIndex], result);
      }

      if (status === 'failed' && result?.error) {
        images[imageIndex].error = result.error;
      }
    }
  }

  /**
   * Update job status in DynamoDB
   * Uses UpdateItem for atomic updates to prevent overwriting other metadata
   */
  private async updateJobStatus(
    tenant: string,
    jobId: string,
    status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled',
    additionalFields: Record<string, any> = {}
  ): Promise<boolean> {
    const pk = `TENANT#${tenant}#BG_REMOVER_JOB#${jobId}`;
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

      // Map additional fields to update expression
      Object.entries(additionalFields).forEach(([key, value], index) => {
        if (value === undefined || value === null) return;

        const attrName = `#field${index}`;
        const valName = `:val${index}`;
        
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

      console.info('Job status updated atomically', { tenant, jobId, status });
      return true;
    } catch (error) {
      console.error('Failed to update job status atomically', {
        tenant,
        jobId,
        status,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}

// Export the handler function for Lambda
export const processWorker = async (event: any) => {
  const handler = new ProcessWorkerHandler();
  return handler.handle(event);
};
