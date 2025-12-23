import { BaseHandler } from './base-handler';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import {
  ProcessRequestSchema,
  JobStatusParamsSchema,
  type ProcessResult,
  type ProductDescription,
  type MultilingualProductDescription,
  type BilingualProductDescription,
  createProcessResult
} from '../lib/types';
import { languageManager } from '../lib/language-manager';
import { multilingualDescriptionGenerator } from '../lib/multilingual-description';
import { validateRequest, validatePathParams, ValidationError } from '../lib/validation';
import { resolveTenantFromRequest, loadTenantConfig } from '../lib/tenant/resolver';
import {
  processImageFromUrl,
  processImageFromBase64,
} from '../lib/bedrock/image-processor';
import { uploadProcessedImage, generateOutputKey } from '../lib/s3/client';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { validateJWTFromEvent } from '../lib/auth/jwt-validator';
import { validateAndDebitCredits, refundCredits } from '../lib/credits/client';

export class ProcessHandler extends BaseHandler {
  async handle(event: any): Promise<any> {
    console.log('Process function called with event:', JSON.stringify(event, null, 2));
    const httpMethod = event.requestContext?.http?.method || event.httpMethod;

    if (httpMethod === 'OPTIONS') {
      return this.createJsonResponse('', 200, {
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      });
    }

    if (httpMethod !== 'POST') {
      return this.createErrorResponse('Method Not Allowed', 405);
    }

    // ===== JWT AUTHENTICATION =====
    // Validate JWT token (optional in dev mode, required in prod)
    const stage = this.context.stage;
    const requireAuth = stage === 'prod' || process.env.REQUIRE_AUTH === 'true';

    const authResult = await validateJWTFromEvent(event, undefined, {
      required: requireAuth
    });

    if (!authResult.isValid && requireAuth) {
      console.warn('Authentication failed', {
        error: authResult.error,
        stage,
        path: event.requestContext?.http?.path,
      });

      return this.createErrorResponse('Valid JWT token required', 401, {
        'WWW-Authenticate': 'Bearer realm="bg-remover", error="invalid_token"',
      });
    }

    if (authResult.isValid && authResult.userId) {
      console.info('Authenticated request', {
        userId: authResult.userId,
        email: authResult.email,
        groups: authResult.groups,
      });
    } else {
      console.info('Unauthenticated request (dev mode)', {
        stage,
        requireAuth,
        path: event.requestContext?.http?.path,
      });
    }
    // ===== END JWT AUTHENTICATION =====

    const processingStartTime = Date.now();
    const jobId = randomUUID();

    // Resolve tenant from request (header, domain, or default)
    const tenant = await resolveTenantFromRequest(event, stage);

    // Track credit transaction for potential refund on failure
    let creditTransactionId: string | undefined;
    let creditsDebited = false;

    try {
      // Parse and validate request body
      let body: any;
      try {
        body = JSON.parse(event.body || '{}');
      } catch (error) {
        console.warn('Invalid JSON in request body', { error: error instanceof Error ? error.message : String(error) });
        return this.createErrorResponse('Request body must be valid JSON', 400);
      }

      const validation = validateRequest(ProcessRequestSchema, body, 'process-request');
      if (!validation.success) {
        console.warn('Request validation failed', {
          tenant,
          errors: validation.error?.details,
        });
        return this.createErrorResponse(
          validation.error?.message || 'Validation failed',
          400,
          validation.error?.details
        );
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

      console.info('Processing image request', {
        jobId,
        tenant,
        productId,
        hasUrl: !!imageUrl,
        hasBase64: !!imageBase64,
        outputFormat,
        quality,
      });

      // ===== CREDITS VALIDATION =====
      // Validate and debit credits before processing (1 credit per image)
      // Only require credits for authenticated requests in production
      const userId = authResult.userId || 'anonymous';
      const creditsRequired = stage === 'prod' || process.env.REQUIRE_CREDITS === 'true';

      if (creditsRequired && authResult.isValid && authResult.userId) {
        console.info('Validating credits', {
          jobId,
          tenant,
          userId: authResult.userId,
          imageCount: 1,
        });

        const creditResult = await validateAndDebitCredits(
          tenant,
          authResult.userId,
          1, // 1 credit per image
          jobId,
          productId
        );

        if (!creditResult.success) {
          console.warn('Insufficient credits', {
            jobId,
            tenant,
            userId: authResult.userId,
            error: creditResult.error,
            errorCode: creditResult.errorCode,
          });

          return this.createErrorResponse(
            creditResult.error || 'Insufficient credits',
            creditResult.httpStatus || 402,
            { errorCode: creditResult.errorCode, jobId }
          );
        }

        // Track successful debit for potential refund
        creditTransactionId = creditResult.transactionId;
        creditsDebited = true;

        console.info('Credits debited successfully', {
          jobId,
          tenant,
          userId: authResult.userId,
          creditsUsed: creditResult.creditsUsed,
          newBalance: creditResult.newBalance,
          transactionId: creditResult.transactionId,
        });
      } else if (!creditsRequired) {
        console.info('Credits not required (dev mode)', {
          jobId,
          tenant,
          stage,
          requireCredits: creditsRequired,
        });
      }
      // ===== END CREDITS VALIDATION =====

      // Load tenant-specific configuration
      const config = await loadTenantConfig(tenant, stage);

      // Process the image
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
        bilingualDescription?: BilingualProductDescription; // Backwards compatibility
      };

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

      if (imageUrl) {
        result = await processImageFromUrl(imageUrl, processingOptions, tenant);
      } else if (imageBase64) {
        result = await processImageFromBase64(imageBase64, 'image/png', processingOptions, tenant);
      } else {
        return this.createErrorResponse('No image provided', 400);
      }

      // For dev: Return base64 data URL instead of uploading to S3
      // In production, this would upload to S3 and return a presigned URL
      const contentType = outputFormat === 'png' ? 'image/png' :
                         outputFormat === 'webp' ? 'image/webp' : 'image/jpeg';

      const base64Image = result.outputBuffer.toString('base64');
      const outputUrl = `data:${contentType};base64,${base64Image}`;

      const processingTimeMs = Date.now() - processingStartTime;

      console.info('Image processed successfully', {
        jobId,
        processingTimeMs,
        outputSize: base64Image.length,
        originalSize: result.metadata.originalSize,
        processedSize: result.metadata.processedSize,
        tenant,
        outputFormat,
      });

      // Emit CarouselImageProcessed event
      try {
        const eventBridge = new EventBridgeClient({ region: this.context.region });
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
        const eventBridgeCommand = {
          Entries: [
            {
              Source: 'carousel.bg-remover',
              DetailType: 'CarouselImageProcessed',
              Detail: JSON.stringify(eventDetail),
            },
          ],
        };
        await eventBridge.send(new PutEventsCommand(eventBridgeCommand));
        console.info('CarouselImageProcessed event emitted', { jobId, tenant });
      } catch (error) {
        console.error('Failed to emit CarouselImageProcessed event', {
          jobId,
          tenant,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // Emit AI Rating Suggestion event if rating was generated
      if (generateRatingSuggestion && multilingualDescription?.ratingSuggestion) {
        try {
          const ratingEventDetail = {
            ratingId: `ai-rating-${jobId}`,
            productId,
            vendorId: null, // Will be set when product is created
            buyerId: null, // AI-generated, no buyer
            rating: multilingualDescription.ratingSuggestion.overallRating,
            comment: `AI-generated rating suggestion: ${multilingualDescription.ratingSuggestion.breakdown.description}`,
            conditionAsExpected: null,
            createdAt: new Date().toISOString(),
            ratingSource: 'ai_suggested',
            status: 'pending',
            aiMetadata: {
              confidence: multilingualDescription.ratingSuggestion.confidence,
              breakdown: multilingualDescription.ratingSuggestion.breakdown,
              factors: multilingualDescription.ratingSuggestion.factors,
              jobId,
              productName,
              tenant_id: tenant,
            },
            auditTrail: [{
              action: 'created',
              actorId: 'bg-remover-service',
              actorRole: 'system',
              timestamp: new Date().toISOString(),
              newRating: multilingualDescription.ratingSuggestion.overallRating,
              reason: 'AI-generated rating suggestion from image analysis',
            }],
          };

          const ratingEventCommand = {
            Entries: [
              {
                Source: 'carousel.bg-remover',
                DetailType: 'CarouselAIRatingSuggested',
                Detail: JSON.stringify(ratingEventDetail),
              },
            ],
          };
          await eventBridge.send(new PutEventsCommand(ratingEventCommand));
          console.info('CarouselAIRatingSuggested event emitted', { jobId, tenant, rating: multilingualDescription.ratingSuggestion.overallRating });
        } catch (error) {
          console.error('Failed to emit CarouselAIRatingSuggested event', {
            jobId,
            tenant,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Generate multilingual descriptions if requested
      let multilingualDescription: MultilingualProductDescription | undefined;
      let bilingualDescription: BilingualProductDescription | undefined;

      if (generateDescription) {
        try {
          // Extract product features from existing description or generate basic ones
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

          // Generate multilingual descriptions
          multilingualDescription = await multilingualDescriptionGenerator.generateMultilingualDescriptions(
            productFeatures,
            languages,
            generatePriceSuggestion,
            generateRatingSuggestion
          );

          // For backwards compatibility, create bilingual description from multilingual
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
          // Continue without descriptions - don't fail the entire request
        }
      }

      return this.createJsonResponse({
        success: true,
        jobId,
        outputUrl,
        processingTimeMs,
        metadata: result.metadata,
        productDescription: result.productDescription,
        multilingualDescription,
        bilingualDescription,
      });
    } catch (error) {
      const processingTimeMs = Date.now() - processingStartTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      console.error('Image processing failed', {
        jobId,
        error: errorMessage,
        processingTimeMs,
        tenant,
      });

      // ===== CREDITS REFUND ON FAILURE =====
      // If we debited credits and processing failed, issue a refund
      if (creditsDebited && creditTransactionId && authResult.userId) {
        console.info('Initiating credit refund due to processing failure', {
          jobId,
          tenant,
          userId: authResult.userId,
          originalTransactionId: creditTransactionId,
        });

        try {
          const refundResult = await refundCredits(
            tenant,
            authResult.userId, // walletId = userId
            1, // 1 credit per image
            jobId,
            creditTransactionId
          );

          if (refundResult.success) {
            console.info('Credit refund successful', {
              jobId,
              tenant,
              userId: authResult.userId,
              newBalance: refundResult.newBalance,
              refundTransactionId: refundResult.transactionId,
            });
          } else {
            console.error('Credit refund failed', {
              jobId,
              tenant,
              userId: authResult.userId,
              error: refundResult.error,
              errorCode: refundResult.errorCode,
              originalTransactionId: creditTransactionId,
            });
            // Note: Don't fail the response - the processing already failed
            // This should be handled via dead-letter queue or manual reconciliation
          }
        } catch (refundError) {
          console.error('Credit refund exception', {
            jobId,
            tenant,
            userId: authResult.userId,
            error: refundError instanceof Error ? refundError.message : String(refundError),
            originalTransactionId: creditTransactionId,
          });
        }
      }
      // ===== END CREDITS REFUND =====

      // Handle validation errors
      if (error instanceof Error && error.name === 'ZodError') {
        return this.createErrorResponse(`Validation error: ${errorMessage}`, 400);
      }

      return this.createErrorResponse(errorMessage, 500);
    }
  }
}

// Export the handler function for Lambda
export const process = async (event: any) => {
  const handler = new ProcessHandler();
  return handler.handle(event);
};