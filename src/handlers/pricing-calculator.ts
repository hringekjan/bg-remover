/**
 * Pricing Calculator Handler - HTTP API for VisualSimilarityPricingEngine
 *
 * Exposes the VisualSimilarityPricingEngine as a Lambda HTTP API endpoint
 * that can be called by the frontend to calculate pricing suggestions.
 *
 * API Contract:
 * - POST /bg-remover/pricing/calculate
 * - Authentication: x-tenant-id header (required)
 * - Request body: { productId, category, brand?, condition, images[], description? }
 * - Response: { suggestedPrice, priceRange, confidence, factors, reasoning, requestId, responseTimeMs }
 *
 * Performance:
 * - Memory: 1024MB (for Bedrock API calls + image processing)
 * - Timeout: 30 seconds (suitable for image analysis + DynamoDB queries)
 * - Cache hit rate: >60% after warm-up through EmbeddingCache
 *
 * @module handlers/pricing-calculator
 */

import { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import { VisualSimilarityPricingEngine } from '../lib/pricing/visual-similarity-pricing';
import { Logger } from '@aws-lambda-powertools/logger';
import { z } from 'zod';
import type { ProductCondition, PricingSuggestion } from '../lib/pricing/types';
import { isValidProductCondition } from '../lib/pricing/types';

// Logger instance for structured logging
const logger = new Logger({
  serviceName: 'bg-remover-pricing-calculator',
});

// Global pricing engine instance - persists across Lambda invocations for cache reuse
let pricingEngine: VisualSimilarityPricingEngine | null = null;

/**
 * Request validation schema using Zod
 * Validates product details and images for pricing calculation
 */
const PricingRequestSchema = z.object({
  productId: z
    .string()
    .min(1, 'Product ID is required')
    .max(100, 'Product ID too long')
    .describe('Unique identifier for the product'),
  category: z
    .string()
    .min(1, 'Category is required')
    .max(100, 'Category too long')
    .describe('Product category for similarity matching'),
  brand: z
    .string()
    .max(100, 'Brand too long')
    .optional()
    .describe('Product brand (optional)'),
  condition: z
    .enum(['new_with_tags', 'like_new', 'very_good', 'good', 'fair', 'poor'] as const)
    .default('like_new')
    .describe('Condition of the product'),
  images: z
    .array(z.string().url('Each image must be a valid URL'))
    .min(1, 'At least one image is required')
    .max(10, 'Maximum 10 images allowed')
    .describe('Product images (URLs)'),
  description: z
    .string()
    .max(1000, 'Description too long')
    .optional()
    .describe('Product description (optional)'),
  language: z
    .enum(['en', 'is'])
    .default('en')
    .optional()
    .describe('Language code for response formatting'),
  currency: z
    .string()
    .length(3, 'Currency must be a 3-letter ISO code')
    .optional()
    .describe('Currency code for pricing (e.g., USD, EUR, ISK)'),
});

type PricingRequest = z.infer<typeof PricingRequestSchema>;

/**
 * Pricing response type matching frontend expectations
 */
interface PricingResponse extends PricingSuggestion {
  requestId: string;
  responseTimeMs: number;
}

/**
 * Initialize or reuse the pricing engine instance
 * Uses global variable to persist cache across invocations
 *
 * @param tenantId - Tenant identifier for multi-tenant isolation
 * @param stage - Environment stage (dev, prod)
 * @returns VisualSimilarityPricingEngine instance
 */
function initializePricingEngine(tenantId: string, stage: string): VisualSimilarityPricingEngine {
  if (pricingEngine) {
    logger.info('Reusing cached pricing engine', { tenantId, stage });
    return pricingEngine;
  }

  logger.info('Initializing new pricing engine', { tenantId, stage });

  pricingEngine = new VisualSimilarityPricingEngine(tenantId, stage, {
    cacheMaxSizeBytes: parseInt(process.env.CACHE_MAX_SIZE_BYTES || '419430400'), // 400MB
    cacheTtlMs: parseInt(process.env.CACHE_TTL_MS || '300000'), // 5 minutes
    dynamoDBTable: process.env.SALES_TABLE_NAME,
    embeddingsBucket: process.env.EMBEDDINGS_BUCKET,
    region: process.env.AWS_REGION || 'eu-west-1',
    bedrockRegion: process.env.BEDROCK_REGION || 'us-east-1',
  });

  return pricingEngine;
}

/**
 * Lambda handler for POST /bg-remover/pricing/calculate
 *
 * Validates product details, initializes pricing engine, and returns
 * AI-suggested pricing based on visual similarity to historical sales.
 *
 * @param event - APIGatewayProxyEventV2 request
 * @param context - Lambda context
 * @returns APIGatewayProxyResultV2 response
 */
export async function handler(
  event: APIGatewayProxyEventV2,
  context: Context
): Promise<APIGatewayProxyResultV2> {
  const startTime = Date.now();
  const requestId = event.requestContext?.requestId || context.awsRequestId;

  try {
    logger.info('Pricing calculator request received', {
      requestId,
      method: event.requestContext?.http?.method,
      path: event.requestContext?.http?.path,
    });

    // Handle CORS preflight
    if (event.requestContext?.http?.method === 'OPTIONS') {
      return buildCorsResponse(200, { message: 'OK' });
    }

    // Validate HTTP method
    if (event.requestContext?.http?.method !== 'POST') {
      return buildErrorResponse(405, 'Method not allowed. Use POST.', requestId);
    }

    // Extract tenant from headers (required for multi-tenant isolation)
    const tenantId = event.headers['x-tenant-id'];
    if (!tenantId) {
      logger.warn('Missing x-tenant-id header', { requestId });
      return buildErrorResponse(400, 'Missing x-tenant-id header', requestId);
    }

    // Parse and validate request body
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(event.body || '{}');
    } catch (error) {
      logger.warn('Failed to parse request body', {
        requestId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return buildErrorResponse(400, 'Invalid JSON in request body', requestId);
    }

    // Validate request with Zod
    const validationResult = PricingRequestSchema.safeParse(parsedBody);
    if (!validationResult.success) {
      const errorMessages = validationResult.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ');

      logger.warn('Request validation failed', {
        requestId,
        errors: errorMessages,
      });

      return buildErrorResponse(400, `Validation error: ${errorMessages}`, requestId);
    }

    const validated = validationResult.data;

    logger.info('Pricing request validated', {
      requestId,
      tenantId,
      productId: validated.productId,
      category: validated.category,
      condition: validated.condition,
      imageCount: validated.images.length,
    });

    // Initialize pricing engine (reuses cached instance)
    const stage = process.env.STAGE || 'dev';
    const engine = initializePricingEngine(tenantId, stage);

    // Generate embedding for primary product image using Titan Embeddings
    // This produces a 1024-dimensional vector for visual similarity search
    let productEmbedding: number[];
    const visionAnalysisService = engine.getVisionAnalysisService();

    try {
      productEmbedding = await visionAnalysisService.generateEmbedding(
        validated.images[0]
      );

      logger.info('Successfully generated product embedding', {
        requestId,
        dimensions: productEmbedding.length,
        magnitude: Math.sqrt(
          productEmbedding.reduce((sum, v) => sum + v * v, 0)
        ),
      });
    } catch (error) {
      const embedError = error instanceof Error ? error.message : String(error);
      logger.error('Failed to generate product embedding', {
        requestId,
        error: embedError,
        imageUrl: validated.images[0],
      });

      return buildErrorResponse(
        503,
        'Embedding generation service temporarily unavailable',
        requestId
      );
    }

    // Validate embedding dimensions (must be exactly 1024)
    if (!productEmbedding || productEmbedding.length !== 1024) {
      logger.error('Invalid embedding dimensions', {
        requestId,
        expectedDimensions: 1024,
        actualDimensions: productEmbedding?.length || 0,
      });

      return buildErrorResponse(
        500,
        'Failed to generate valid product embedding',
        requestId
      );
    }

    // Generate pricing suggestion
    // Use first image as primary product image with generated embedding
    const suggestion = await engine.generatePriceSuggestion(
      validated.images[0], // Primary product image URL
      productEmbedding, // 1024-dimensional embedding from Titan Embeddings
      {
        category: validated.category,
        brand: validated.brand,
        condition: validated.condition as ProductCondition,
      },
      validated.category,
      validated.language || 'en'
    );

    const responseTime = Date.now() - startTime;

    const response: PricingResponse = {
      ...suggestion,
      requestId,
      responseTimeMs: responseTime,
    };

    logger.info('Pricing calculation succeeded', {
      requestId,
      tenantId,
      productId: validated.productId,
      suggestedPrice: suggestion.suggestedPrice,
      confidence: suggestion.confidence,
      responseTimeMs: responseTime,
    });

    return buildSuccessResponse(200, response);

  } catch (error) {
    const responseTime = Date.now() - startTime;

    logger.error('Pricing calculation failed', {
      requestId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      responseTimeMs: responseTime,
    });

    // Return 503 for service errors (retryable)
    if (
      error instanceof Error &&
      (error.message.includes('DynamoDB') ||
        error.message.includes('S3') ||
        error.message.includes('Bedrock'))
    ) {
      return buildErrorResponse(503, 'Pricing service temporarily unavailable', requestId);
    }

    // Return 500 for other errors
    return buildErrorResponse(500, 'Internal server error', requestId);
  }
}

/**
 * Build successful response with proper headers
 * TODO: Migrate to tenant-aware CORS using createTenantCorsHeaders from lib/cors.ts
 */
function buildSuccessResponse(
  statusCode: number,
  body: PricingResponse
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': 'null',  // Secure: no wildcard CORS
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-tenant-id',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',  // Prevent cache poisoning
      'X-Request-ID': body.requestId,
      'X-Response-Time': body.responseTimeMs.toString(),
    },
    body: JSON.stringify(body),
  };
}

/**
 * Build error response with proper headers and error details
 * TODO: Migrate to tenant-aware CORS using createTenantCorsHeaders from lib/cors.ts
 */
function buildErrorResponse(
  statusCode: number,
  message: string,
  requestId: string
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': 'null',  // Secure: no wildcard CORS
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-tenant-id',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',  // Prevent cache poisoning
      'X-Request-ID': requestId,
    },
    body: JSON.stringify({
      error: message,
      requestId,
      timestamp: new Date().toISOString(),
    }),
  };
}

/**
 * Build CORS preflight response
 * TODO: Migrate to tenant-aware CORS using createTenantCorsHeaders from lib/cors.ts
 */
function buildCorsResponse(
  statusCode: number,
  body: any
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': 'null',  // Secure: no wildcard CORS
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-tenant-id',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',  // Prevent cache poisoning
    },
    body: JSON.stringify(body),
  };
}
