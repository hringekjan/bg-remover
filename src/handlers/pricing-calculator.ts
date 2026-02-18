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

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import { VisualSimilarityPricingEngine } from '../lib/pricing/visual-similarity-pricing';
import { Logger } from '@aws-lambda-powertools/logger';
import { z } from 'zod';
import type { ProductCondition, PricingSuggestion } from '../lib/pricing/types';
import { createTenantCorsHeaders, createBasicCorsHeaders } from '../lib/cors';

// Logger instance for structured logging
const logger = new Logger({
  serviceName: 'bg-remover-pricing-calculator',
});

// Global pricing engine instance - persists across Lambda invocations for cache reuse
let pricingEngine: VisualSimilarityPricingEngine | null = null;
const USD_TO_ISK_RATE = Number.parseFloat(process.env.USD_TO_ISK_RATE || '140');
const MIN_ISK_SUGGESTED_PRICE = Number.parseFloat(process.env.MIN_ISK_SUGGESTED_PRICE || '1000');
const DEFAULT_PRICE_FLOOR_BY_CURRENCY: Record<string, number> = {
  ISK: 1000,
  USD: 10,
  EUR: 10,
};
const DEFAULT_PRICE_CEILING_BY_CURRENCY: Record<string, number> = {
  ISK: 1_000_000,
  USD: 10_000,
  EUR: 10_000,
};
const MIN_SUGGESTED_PRICE = Number.parseFloat(process.env.MIN_SUGGESTED_PRICE || '');
const MAX_SUGGESTED_PRICE = Number.parseFloat(process.env.MAX_SUGGESTED_PRICE || '');

/**
 * Response options interface for consistent response building
 */
interface ResponseOptions {
  requestId: string;
  tenantId: string;
  correlationId?: string;
}

/**
 * Response builder for standardized API responses
 */
class ResponseBuilder {
  /**
   * Build successful response with proper headers
   */
  static success<T>(
    statusCode: number,
    body: T,
    event: APIGatewayProxyEventV2,
    options: ResponseOptions
  ): APIGatewayProxyResultV2 {
    const corsHeaders = createTenantCorsHeaders(event, options.tenantId);
    return {
      statusCode,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'X-Request-ID': options.requestId,
        ...(options.correlationId && { 'X-Correlation-ID': options.correlationId }),
      },
      body: JSON.stringify(body),
    };
  }

  /**
   * Build error response with proper headers and error details
   */
  static error(
    statusCode: number,
    message: string,
    event: APIGatewayProxyEventV2,
    options: ResponseOptions
  ): APIGatewayProxyResultV2 {
    const corsHeaders = createTenantCorsHeaders(event, options.tenantId);
    return {
      statusCode,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'X-Request-ID': options.requestId,
        ...(options.correlationId && { 'X-Correlation-ID': options.correlationId }),
      },
      body: JSON.stringify({
        error: message,
        requestId: options.requestId,
        correlationId: options.correlationId,
        timestamp: new Date().toISOString(),
      }),
    };
  }

  /**
   * Build CORS preflight response
   */
  static cors(
    event: APIGatewayProxyEventV2,
    options: ResponseOptions
  ): APIGatewayProxyResultV2 {
    const corsHeaders = createTenantCorsHeaders(event, options.tenantId);
    return {
      statusCode: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'X-Request-ID': options.requestId,
      },
      body: JSON.stringify({ message: 'OK' }),
    };
  }

  /**
   * Build error response before tenant resolution (uses basic CORS)
   */
  static errorBeforeTenant(
    statusCode: number,
    message: string,
    requestId: string
  ): APIGatewayProxyResultV2 {
    const corsHeaders = createBasicCorsHeaders();
    return {
      statusCode,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'X-Request-ID': requestId,
      },
      body: JSON.stringify({
        error: message,
        requestId,
        timestamp: new Date().toISOString(),
      }),
    };
  }
}

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

function normalizeIskSuggestion(suggestion: PricingSuggestion, targetCurrency: string): PricingSuggestion {
  if (targetCurrency !== 'ISK') return suggestion;
  if (!Number.isFinite(suggestion.suggestedPrice) || suggestion.suggestedPrice <= 0) return suggestion;
  if (!Number.isFinite(USD_TO_ISK_RATE) || USD_TO_ISK_RATE <= 0) return suggestion;

  // If the suggestion is implausibly low for ISK, treat it as USD and convert.
  if (suggestion.suggestedPrice >= MIN_ISK_SUGGESTED_PRICE) return suggestion;

  const convert = (value: number) => Math.round(value * USD_TO_ISK_RATE);
  const converted: PricingSuggestion = {
    ...suggestion,
    suggestedPrice: convert(suggestion.suggestedPrice),
    priceRange: {
      min: convert(suggestion.priceRange.min),
      max: convert(suggestion.priceRange.max),
    },
    factors: {
      ...suggestion.factors,
      basePrice: convert(suggestion.factors.basePrice),
      similarProducts: suggestion.factors.similarProducts?.map((item) => ({
        ...item,
        salePrice: convert(item.salePrice),
      })),
    },
  };

  return converted;
}

function applyPriceGuards(suggestion: PricingSuggestion, targetCurrency: string): PricingSuggestion {
  const currency = targetCurrency.toUpperCase();
  const defaultFloor = DEFAULT_PRICE_FLOOR_BY_CURRENCY[currency] ?? 1;
  const defaultCeiling = DEFAULT_PRICE_CEILING_BY_CURRENCY[currency] ?? Number.MAX_SAFE_INTEGER;
  const floor = Number.isFinite(MIN_SUGGESTED_PRICE) ? MIN_SUGGESTED_PRICE : defaultFloor;
  const ceiling = Number.isFinite(MAX_SUGGESTED_PRICE) ? MAX_SUGGESTED_PRICE : defaultCeiling;

  const clamp = (value: number) => Math.min(Math.max(value, floor), ceiling);
  const minClamped = clamp(suggestion.priceRange.min);
  const maxClamped = clamp(suggestion.priceRange.max);
  const rangeMin = Math.min(minClamped, maxClamped);
  const rangeMax = Math.max(minClamped, maxClamped);

  return {
    ...suggestion,
    suggestedPrice: clamp(suggestion.suggestedPrice),
    priceRange: { min: rangeMin, max: rangeMax },
    factors: {
      ...suggestion.factors,
      basePrice: clamp(suggestion.factors.basePrice),
    },
  };
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
 * Check if error is retryable (service temporarily unavailable)
 */
function isRetryableError(error: Error): boolean {
  const retryablePatterns = [
    'DynamoDB',
    'S3',
    'Bedrock',
    'Service Temporarily Unavailable',
    'ThrottlingException',
    'ProvisionedThroughputExceededException',
  ];
  return retryablePatterns.some(pattern => error.message.includes(pattern));
}

/**
 * Lambda handler for POST /bg-remover/pricing/calculate
 *
 * Validates product details, initializes pricing engine, and returns
 * AI-suggested pricing based on visual similarity to historical sales.
 */
export async function handler(
  event: APIGatewayProxyEventV2,
  context: Context
): Promise<APIGatewayProxyResultV2> {
  const startTime = Date.now();
  const requestId = event.requestContext?.requestId || context.awsRequestId;
  const tenantId = event.headers['x-tenant-id'] || process.env.TENANT || 'carousel-labs';

  const responseOptions: ResponseOptions = {
    requestId,
    tenantId,
    correlationId: event.headers['x-correlation-id'] || event.headers['X-Correlation-Id'],
  };

  try {
    logger.info('Pricing calculator request received', {
      requestId,
      method: event.requestContext?.http?.method,
      path: event.requestContext?.http?.path,
      tenantId,
    });

    // Handle CORS preflight
    if (event.requestContext?.http?.method === 'OPTIONS') {
      return ResponseBuilder.cors(event, responseOptions);
    }

    // Validate HTTP method
    if (event.requestContext?.http?.method !== 'POST') {
      return ResponseBuilder.error(405, 'Method not allowed. Use POST.', event, responseOptions);
    }

    // Extract tenant from headers (required for multi-tenant isolation)
    if (!event.headers['x-tenant-id']) {
      logger.warn('Missing x-tenant-id header', { requestId });
      return ResponseBuilder.error(400, 'Missing x-tenant-id header', event, responseOptions);
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
      return ResponseBuilder.error(400, 'Invalid JSON in request body', event, responseOptions);
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

      return ResponseBuilder.error(400, `Validation error: ${errorMessages}`, event, responseOptions);
    }

    const validated = validationResult.data;
    const resolvedTenantId = event.headers['x-tenant-id'];

    logger.info('Pricing request validated', {
      requestId,
      tenantId: resolvedTenantId,
      productId: validated.productId,
      category: validated.category,
      condition: validated.condition,
      imageCount: validated.images.length,
    });

    // Initialize pricing engine (reuses cached instance)
    const stage = process.env.STAGE || 'dev';
    const engine = initializePricingEngine(resolvedTenantId, stage);

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

      return ResponseBuilder.error(
        503,
        'Embedding generation service temporarily unavailable',
        event,
        { ...responseOptions, tenantId: resolvedTenantId }
      );
    }

    // Validate embedding dimensions (must be exactly 1024)
    if (!productEmbedding || productEmbedding.length !== 1024) {
      logger.error('Invalid embedding dimensions', {
        requestId,
        expectedDimensions: 1024,
        actualDimensions: productEmbedding?.length || 0,
      });

      return ResponseBuilder.error(
        500,
        'Failed to generate valid product embedding',
        event,
        { ...responseOptions, tenantId: resolvedTenantId }
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
    const targetCurrency = validated.currency || suggestion.currency;
    const normalizedSuggestion = normalizeIskSuggestion(
      { ...suggestion, currency: targetCurrency },
      targetCurrency
    );
    const guardedSuggestion = applyPriceGuards(normalizedSuggestion, targetCurrency);

    const responseTime = Date.now() - startTime;

    const response: PricingResponse = {
      ...guardedSuggestion,
      requestId,
      responseTimeMs: responseTime,
    };

    logger.info('Pricing calculation succeeded', {
      requestId,
      tenantId: resolvedTenantId,
      productId: validated.productId,
      suggestedPrice: suggestion.suggestedPrice,
      confidence: suggestion.confidence,
      responseTimeMs: responseTime,
    });

    return ResponseBuilder.success(200, response, event, { ...responseOptions, tenantId: resolvedTenantId });

  } catch (error) {
    const responseTime = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error('Pricing calculation failed', {
      requestId,
      error: errorMessage,
      stack: error instanceof Error ? error.stack : undefined,
      responseTimeMs: responseTime,
    });

    // Return 503 for retryable service errors
    if (error instanceof Error && isRetryableError(error)) {
      return ResponseBuilder.error(503, 'Pricing service temporarily unavailable', event, responseOptions);
    }

    // Return 500 for other errors
    return ResponseBuilder.error(500, 'Internal server error', event, responseOptions);
  }
}
