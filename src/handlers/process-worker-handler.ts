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
import { addProductsToBooking, createProductInCarouselApi, normalizeSizingInCarouselApi, type CreateProductRequest } from '../../lib/carousel-api/client';
import { EventTracker } from '../lib/event-tracking';
import { PricingIntelligenceService, PricingSuggestion } from '../lib/pricing-intelligence';
import { extractAttributes, type ExtractionResult } from '../lib/ai-extractor';
import { ratingGenerator } from '../lib/quality-assessment/rating-generator';
import { VisionAnalysisService } from '../lib/pricing/vision-analysis';
import { extractSizeHint } from '../lib/sizing/size-hints';

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
const GARMENT_TYPES = new Set([
  'TSHIRT_KNIT_TOP',
  'SHIRT_BUTTONDOWN',
  'SWEATER_HOODIE',
  'JACKET_COAT',
  'BLAZER_SUIT',
  'JEANS_TROUSERS',
  'SKIRT',
  'SHORTS',
  'DRESS',
  'JUMPSUIT',
  'BRA',
  'UNDERWEAR',
  'TIGHTS',
  'SHOES',
  'RINGS',
  'HATS',
  'BELTS',
  'GLOVES',
]);

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
   * Prices are in ISK for Icelandic market
   */
  private generatePriceSuggestion(
    productFeatures: any,
    groupContext?: GroupProcessingPayload['groupContext']
  ): { min: number; max: number; suggested: number } {
    // Icelandic market base prices by category (in ISK)
    // USD to ISK conversion is approximately 140 ISK per 1 USD
    const categoryBasePrices: Record<string, number> = {
      clothing: 5000,      // ~35 USD
      electronics: 25000,   // ~180 USD
      furniture: 35000,     // ~250 USD
      books: 3000,         // ~20 USD
      art: 75000,          // ~535 USD
      jewelry: 40000,       // ~285 USD
      collectibles: 15000,  // ~105 USD
      vintage: 25000,      // ~180 USD
      handmade: 20000,     // ~140 USD
      sports: 15000,       // ~105 USD
      home: 15000,         // ~105 USD
      accessories: 10000,  // ~70 USD
      general: 8000,       // ~55 USD default
    };

    let basePrice = categoryBasePrices.general; // Default base price

    // Get category from product features or group context
    const category = (groupContext?.category || productFeatures.category || 'general').toLowerCase();
    
    // Find matching category base price
    for (const [cat, price] of Object.entries(categoryBasePrices)) {
      if (category.includes(cat)) {
        basePrice = price;
        break;
      }
    }

    if (groupContext) {
      // Adjust based on image quality signals
      if (groupContext.signalBreakdown) {
        const composition = groupContext.signalBreakdown.composition;
        const background = groupContext.signalBreakdown.background;

        // Professional photography = premium pricing (5% boost)
        if (composition > 0.85 && background > 0.85) {
          basePrice *= 1.05;
        }

        // Multiple angles = higher value perception (3% boost per additional image beyond first)
        if (groupContext.totalImages >= 3) {
          basePrice *= 1.03;
        }
      }
    }

    // Apply condition-based pricing (more moderate multipliers)
    const condition = productFeatures.condition || 'good';
    const conditionMultipliers: Record<string, number> = {
      new_with_tags: 1.0,
      like_new: 0.90,
      very_good: 0.80,
      good: 0.70,
      fair: 0.55,
    };
    basePrice *= conditionMultipliers[condition] || 0.70;

    // Apply brand premium if available
    if (productFeatures.brand) {
      const brandPremium = this.calculateBrandPremium(productFeatures.brand);
      basePrice *= brandPremium;
    }

    return {
      min: Math.round(basePrice * 0.85),
      max: Math.round(basePrice * 1.25),
      suggested: Math.round(basePrice / 100) * 100, // Round to nearest 100 ISK
    };
  }

  /**
   * Generate price suggestion using the new Pricing Intelligence Module
   * Uses historical sales data, category baselines, and recency weighting
   */
  private async generatePriceSuggestionWithIntelligence(
    productName: string,
    category?: string,
    brand?: string,
    condition?: string
  ): Promise<{ min: number; max: number; suggested: number; confidence: string }> {
    try {
      const pricingService = new PricingIntelligenceService();
      
      const suggestion: PricingSuggestion = await pricingService.getSuggestion({
        productName,
        category,
      });

      console.log('[Worker] Pricing intelligence suggestion', {
        productName,
        suggestedPrice: suggestion.suggestedPrice,
        minPrice: suggestion.minPrice,
        maxPrice: suggestion.maxPrice,
        confidence: suggestion.confidence,
        sources: suggestion.sources,
      });

      return {
        min: suggestion.minPrice,
        max: suggestion.maxPrice,
        suggested: suggestion.suggestedPrice,
        confidence: suggestion.confidence,
      };
    } catch (error) {
      console.warn('[Worker] Pricing intelligence failed, falling back to legacy method', {
        productName,
        error: error instanceof Error ? error.message : String(error),
      });
      
      // Fallback to legacy method
      const legacyResult = this.generatePriceSuggestion({ name: productName, brand, category, condition });
      return {
        ...legacyResult,
        confidence: 'low',
      };
    }
  }

  /**
   * Calculate brand premium multiplier
   */
  private calculateBrandPremium(brand: string): number {
    const premiumBrands = ['louis vuitton', 'gucci', 'prada', 'chanel', 'hermès', 'cartier', 'rolex'];
    const luxuryBrands = ['armani', 'versace', 'dior', 'balenciaga', 'tiffany', 'omega'];
    const designerBrands = ['zara', 'h&m', 'uniqlo', 'mango', 'cos', '&otherstories'];
    
    const brandLower = brand.toLowerCase();
    
    if (premiumBrands.some(b => brandLower.includes(b))) return 2.5;
    if (luxuryBrands.some(b => brandLower.includes(b))) return 2.0;
    if (designerBrands.some(b => brandLower.includes(b))) return 1.4;
    
    return 1.0; // No premium for unknown brands
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
    const { jobId, tenant, groupId, images, pipeline, processingOptions, stage, groupContext, userId, bookingId, authToken } = payload;
    
    // Use let for productName since it may be updated based on AI-derived name
    let productName = payload.productName;

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
      let extractedAttributes: ExtractionResult | undefined;

      console.log('[Worker] Checking description generation condition', {
        jobId,
        groupId,
        generateDescription: processingOptions?.generateDescription,
        imageResultsLength: imageResults.length,
        willGenerate: !!(processingOptions?.generateDescription && imageResults.length > 0),
        processingOptionsKeys: Object.keys(processingOptions || {}),
      });

      // Declare primaryResult outside conditional block for broader scope
      const primaryResult = imageResults.length > 0 ? imageResults[0] : null;

      if (processingOptions.generateDescription && primaryResult) {
        const languages = processingOptions.languages || ['en', 'is'];

        // Declare variables outside try block for broader scope
        let contextPrompt = '';
        let productFeatures: any;

        try {
          // Check if we already have AI-generated bilingual descriptions from the pipeline
          // Note: primaryResult.bilingualDescription would come from the pipeline if available
          // For now, we build it from productDescription
          if (primaryResult.productDescription?.short) {
            console.log('[Worker] Using product description from pipeline');
            multilingualDescription = {
              en: {
                short: primaryResult.productDescription.short,
                long: primaryResult.productDescription.long || primaryResult.productDescription.short,
                keywords: primaryResult.productDescription.keywords || [],
                category: primaryResult.productDescription.category || 'general',
                colors: primaryResult.productDescription.colors,
                condition: primaryResult.productDescription.condition || 'good',
              },
              is: {
                short: primaryResult.productDescription.short,
                long: primaryResult.productDescription.long || primaryResult.productDescription.short,
                keywords: primaryResult.productDescription.keywords || [],
                category: primaryResult.productDescription.category || 'general',
                colors: primaryResult.productDescription.colors,
                condition: primaryResult.productDescription.condition || 'good',
              },
            };
          } else {
            // Build context prompt from group metadata
            contextPrompt = this.buildGroupContextPrompt(
              groupContext,
              imageResults.length,
              productName
            );

            productFeatures = {
              name: productName || 'Product',
              category: groupContext?.category || primaryResult.productDescription?.category || 'general',
              colors: primaryResult.productDescription?.colors,
              condition: primaryResult.productDescription?.condition || 'good' as const,
              brand: primaryResult.productDescription?.priceSuggestion?.factors.brand,
              // Add group-aware fields
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
          }

          // NEW: Extract comprehensive attributes from multilingual descriptions
          // This extracts brand, material, colors, pattern, style, keywords, and category
          if (multilingualDescription) {
            try {
              extractedAttributes = extractAttributes({
                productName: productName || 'Product',
                bilingualDescription: multilingualDescription,
              });

              console.log('[Worker] Extracted product attributes', {
                jobId,
                groupId,
                brand: extractedAttributes.brand,
                material: extractedAttributes.material,
                colors: extractedAttributes.colors,
                pattern: extractedAttributes.pattern,
                style: extractedAttributes.style,
                keywords: extractedAttributes.keywords?.slice(0, 5),
                category: extractedAttributes.category?.path,
                aiConfidence: extractedAttributes.aiConfidence,
              });

              // Enrich multilingual description with extracted attributes
              if (multilingualDescription.en && extractedAttributes) {
                multilingualDescription.en = {
                  ...multilingualDescription.en,
                  keywords: extractedAttributes.keywords || multilingualDescription.en.keywords || [],
                  category: extractedAttributes.category?.path || multilingualDescription.en.category || 'general',
                  colors: extractedAttributes.colors || multilingualDescription.en.colors,
                };
              }
              if (multilingualDescription.is && extractedAttributes) {
                multilingualDescription.is = {
                  ...multilingualDescription.is,
                  keywords: extractedAttributes.keywords || multilingualDescription.is.keywords || [],
                  category: extractedAttributes.category?.path || multilingualDescription.is.category || 'general',
                  colors: extractedAttributes.colors || multilingualDescription.is.colors,
                };
              }
            } catch (error) {
              console.warn('[Worker] Failed to extract attributes', {
                jobId,
                groupId,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }

          // NEW: Generate price and quality suggestions if requested
          if ((processingOptions.generatePriceSuggestion || processingOptions.generateRatingSuggestion) &&
              primaryResult && primaryResult.productDescription && multilingualDescription) {
            try {
              let visionScore: number | undefined;

              // Get vision quality score for pricing/rating adjustments
              if (processingOptions.generatePriceSuggestion || processingOptions.generateRatingSuggestion) {
                try {
                  const visionService = new VisionAnalysisService();
                  const visionResult = await visionService.analyzeCondition(primaryResult.outputBuffer);
                  visionScore = visionResult.conditionScore; // 1-10 scale

                  console.log('[Worker] Vision quality analysis complete', {
                    jobId,
                    groupId,
                    visionScore,
                    photoQuality: visionResult.photoQualityScore,
                  });
                } catch (visionError) {
                  console.warn('[Worker] Vision analysis failed, continuing without it', {
                    jobId,
                    groupId,
                    error: visionError instanceof Error ? visionError.message : String(visionError),
                  });
                }
              }

              // Generate price suggestion
              if (processingOptions.generatePriceSuggestion && primaryResult.mistralResult) {
                try {
                  const pricingService = new PricingIntelligenceService();
                  const priceSuggestion = await pricingService.getSuggestionFromAI(
                    primaryResult.mistralResult,
                    productName || 'Product',
                    visionScore
                  );

                  // Add to English description
                  if (multilingualDescription.en) {
                    multilingualDescription.en.priceSuggestion = priceSuggestion;
                  }

                  // Add to Icelandic description (convert USD to ISK)
                  if (multilingualDescription.is) {
                    multilingualDescription.is.priceSuggestion = {
                      ...priceSuggestion,
                      currency: 'ISK',
                      suggestedPrice: Math.round(priceSuggestion.suggestedPrice * 140), // USD to ISK
                      priceRange: {
                        min: Math.round(priceSuggestion.priceRange.min * 140),
                        max: Math.round(priceSuggestion.priceRange.max * 140),
                      },
                    };
                  }

                  console.log('[Worker] Price suggestion generated', {
                    jobId,
                    groupId,
                    suggestedPrice: priceSuggestion.suggestedPrice,
                    confidence: priceSuggestion.confidence,
                    priceRange: priceSuggestion.priceRange,
                  });
                } catch (pricingError) {
                  console.error('[Worker] Failed to generate price suggestion', {
                    jobId,
                    groupId,
                    error: pricingError instanceof Error ? pricingError.message : String(pricingError),
                  });
                  // Don't throw - pricing is optional
                }
              }

              // Generate rating suggestion
              if (processingOptions.generateRatingSuggestion && primaryResult.mistralResult) {
                try {
                  const ratingSuggestionEn = ratingGenerator.generateRating(
                    primaryResult.mistralResult,
                    visionScore,
                    'en'
                  );
                  const ratingSuggestionIs = ratingGenerator.generateRating(
                    primaryResult.mistralResult,
                    visionScore,
                    'is'
                  );

                  // Add to descriptions
                  if (multilingualDescription.en) {
                    multilingualDescription.en.ratingSuggestion = ratingSuggestionEn;
                  }
                  if (multilingualDescription.is) {
                    multilingualDescription.is.ratingSuggestion = ratingSuggestionIs;
                  }

                  console.log('[Worker] Rating suggestion generated', {
                    jobId,
                    groupId,
                    overallRating: ratingSuggestionEn.overallRating,
                    confidence: ratingSuggestionEn.confidence,
                    breakdown: ratingSuggestionEn.breakdown,
                  });
                } catch (ratingError) {
                  console.error('[Worker] Failed to generate rating suggestion', {
                    jobId,
                    groupId,
                    error: ratingError instanceof Error ? ratingError.message : String(ratingError),
                  });
                  // Don't throw - rating is optional
                }
              }
            } catch (error) {
              console.error('[Worker] Failed to generate suggestions', {
                jobId,
                groupId,
                error: error instanceof Error ? error.message : String(error),
              });
              // Don't throw - suggestions are optional and shouldn't break the pipeline
            }
          }

          // NEW: Derive a better product name if current one is generic
          // Use AI-generated elegant name from the primary result or generated description
          const aiDerivedName = multilingualDescription?.en?.short || primaryResult.productDescription?.short;
          
          // Check if productName is generic (Product, Product 1, product 1, etc.)
          const cleanName = (productName || '').toLowerCase().trim();
          const isGenericName = !productName || 
            cleanName === 'product' || 
            cleanName.match(/^product\s*\d*$/);
          
          if (aiDerivedName && isGenericName) {
            // Extract first meaningful phrase from short description as product name
            let derivedName = aiDerivedName;
            // Remove condition-related text from the beginning
            derivedName = derivedName
              .replace(/^(Brand new|New|Like new|Barely used|Beautiful|Lovely|Nice|Decent)\s+/i, '')
              .split(/[,.]/)[0] // Take first phrase before comma or period
              .trim();
            
            // Capitalize first letter
            derivedName = derivedName.charAt(0).toUpperCase() + derivedName.slice(1);
            
            productName = derivedName;
            console.info('[Worker] Generic product name replaced with AI-derived name', { 
              jobId, 
              groupId, 
              originalName: productName,
              aiShortDescription: aiDerivedName,
              derivedName: productName
            });
          }

          // Generate group-aware pricing if requested
          if (processingOptions.generatePriceSuggestion) {
            groupPricing = this.generatePriceSuggestion(productFeatures, groupContext);
          }

          // Generate group-aware rating prediction if requested
          if (processingOptions.generateRatingSuggestion) {
            predictedRating = this.predictRating(groupContext, productFeatures);
          }

          // Generate SEO keywords from all images in group
          // Prefer extracted keywords, fallback to generated SEO keywords
          seoKeywords = extractedAttributes?.keywords || this.generateSEOKeywords(
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
      const primaryDescription = multilingualDescription?.en || imageResults[0]?.productDescription;
      const descriptionText = primaryDescription?.long || primaryDescription?.short || '';

      const sizeHint = extractSizeHint(`${productName || ''} ${descriptionText}`);
      let normalizedSizingPayload: Record<string, unknown> | undefined;
      if (sizeHint && userId) {
        const candidate = String(groupContext?.category || '')
          .toUpperCase()
          .replace(/[^A-Z0-9_]/g, '_');
        const garmentType = GARMENT_TYPES.has(candidate) ? candidate : undefined;

        if (garmentType) {
          const { sizingPayload, error } = await normalizeSizingInCarouselApi(
            tenant,
            userId,
            {
              category: 'CLOTHING',
              garment_type: garmentType,
              sizing: {
                input_system: sizeHint.input_system,
                input_label: sizeHint.input_label,
              },
            },
            authToken
          );
          if (error) {
            console.warn('[Worker] Sizing normalization failed', { error, garmentType, sizeHint });
          } else if (sizingPayload) {
            normalizedSizingPayload = sizingPayload;
          }
        }
      }

      // Enhance processed images with group-aware metadata
      const enhancedImages = processedImages.map(img => ({
        ...img,
        metadata: {
          ...(img.metadata || {}),
          ...(sizeHint ? { sizing: sizeHint } : {}),
        },
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
            currency: 'ISK',
            // Include price suggestion if generated
            ...(multilingualDescription?.en?.priceSuggestion && {
              suggested: multilingualDescription.en.priceSuggestion.suggestedPrice,
              min: multilingualDescription.en.priceSuggestion.priceRange.min,
              max: multilingualDescription.en.priceSuggestion.priceRange.max,
              confidence: multilingualDescription.en.priceSuggestion.confidence,
            }),
          },
          // Include rating suggestion if generated
          ...(multilingualDescription?.en?.ratingSuggestion && {
            qualityRating: {
              overall: multilingualDescription.en.ratingSuggestion.overallRating,
              quality: multilingualDescription.en.ratingSuggestion.breakdown.quality,
              condition: multilingualDescription.en.ratingSuggestion.breakdown.condition,
              value: multilingualDescription.en.ratingSuggestion.breakdown.value,
              authenticity: multilingualDescription.en.ratingSuggestion.breakdown.authenticity,
              confidence: multilingualDescription.en.ratingSuggestion.confidence,
            },
          }),
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
            tags: seoKeywords || [],
            brand: extractedAttributes?.brand, // Auto-detected brand
          },
          features: {
            material: extractedAttributes?.material, // Auto-detected material (e.g., "100% Cotton")
            style: extractedAttributes?.style?.[0], // Primary style (e.g., "Casual")
            attributes: [
              ...(extractedAttributes?.careInstructions || []), // Care instructions
              ...(extractedAttributes?.pattern ? [`Pattern: ${extractedAttributes.pattern}`] : []),
              ...(extractedAttributes?.style?.slice(1) || []).map(s => `Style: ${s}`), // Additional styles
            ],
            specifications: {
              ...(extractedAttributes?.pattern && { pattern: extractedAttributes.pattern }),
              ...(extractedAttributes?.season && { season: extractedAttributes.season }),
            },
          },
          colorAnalysis: {
            dominantColors: [], // TODO: Extract from image analysis
            colorPalette: extractedAttributes?.colors || primaryDescription?.colors || [], // Auto-detected color names
          },
          imageMetadata: processedImages[0] ? {
            width: processedImages[0].width || processedImages[0].metadata?.width || 1024,
            height: processedImages[0].height || processedImages[0].metadata?.height || 1024,
            format: 'png' as const,
            fileSize: processedImages[0].metadata?.processedSize || 0,
            sourceImageKey: images[0]?.s3Key || '',
            processedImageKey: processedImages[0].outputKey || ''
          } : undefined,
          sizing: normalizedSizingPayload,
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
        category: extractedAttributes?.category?.path || groupContext?.category,
        // Store extracted attributes for frontend display
        brand: extractedAttributes?.brand,
        material: extractedAttributes?.material,
        colors: extractedAttributes?.colors,
        careInstructions: extractedAttributes?.careInstructions,
        conditionRating: extractedAttributes?.conditionRating,
        pattern: extractedAttributes?.pattern,
        style: extractedAttributes?.style,
        sustainability: extractedAttributes?.sustainability,
        aiConfidence: extractedAttributes?.aiConfidence,
        moderationLabels: primaryResult?.rekognitionAnalysis?.moderationLabels,
        // Store processedImages array with full metadata for frontend display
        processedImages: processedImages.map(img => ({
          imageId: img.imageId,
          outputUrl: img.outputUrl,
          outputKey: img.outputKey,
          status: 'completed',
          width: img.width || img.metadata?.width,
          height: img.height || img.metadata?.height,
          // Use processingTimeMs from img if available, fallback to metadata
          processingTimeMs: (img as any).processingTimeMs || (img as any).metadata?.processingTimeMs || (img as any).processingTimeMs || 0,
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
          category: extractedAttributes?.category?.path || groupContext?.category,
          rating: predictedRating,
          // Add extracted attributes to each image metadata
          brand: extractedAttributes?.brand,
          material: extractedAttributes?.material,
          colors: extractedAttributes?.colors,
          careInstructions: extractedAttributes?.careInstructions || (img as any)?.rekognitionAnalysis?.careInstructions,
          conditionRating: extractedAttributes?.conditionRating,
          pattern: extractedAttributes?.pattern,
          style: extractedAttributes?.style,
          sustainability: extractedAttributes?.sustainability,
          moderationLabels: (img as any)?.rekognitionAnalysis?.moderationLabels,
        })),
      });

      // Record batch telemetry with concurrency metrics
      // Convert quality number (1-100) to 'low' | 'medium' | 'high' for telemetry
      const qualityValue = processingOptions.quality;
      let qualityLevel: 'low' | 'medium' | 'high' = 'medium';
      if (typeof qualityValue === 'number') {
        if (qualityValue <= 33) qualityLevel = 'low';
        else if (qualityValue >= 67) qualityLevel = 'high';
        else qualityLevel = 'medium';
      }

      const totalCost = calculateBgRemoverCost({
        imageSize: processedImages.reduce((sum, img) => sum + (img.metadata?.processedSize || 0), 0) / processedImages.length,
        processingTime: processingTimeMs,
        qualityLevel,
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

      // Convert numeric quality to string level for telemetry
      const qualityLevelValue: 'low' | 'medium' | 'high' = typeof quality === 'number' 
        ? (quality <= 33 ? 'low' : quality >= 67 ? 'high' : 'medium')
        : 'medium';

      const cost = calculateBgRemoverCost({
        imageSize: result.metadata.processedSize,
        processingTime: processingTimeMs,
        qualityLevel: qualityLevelValue,
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
          qualityLevel: qualityLevelValue,
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
