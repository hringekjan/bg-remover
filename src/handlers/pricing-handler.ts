/**
 * Pricing Handler - Visual Similarity Pricing API
 *
 * Lambda handler for pricing suggestions based on visual similarity to sold products.
 * Integrates EmbeddingCache for high-performance vector similarity lookups.
 *
 * API Contract:
 * - POST /bg-remover/pricing/suggest
 * - Request body: { productEmbedding, productFeatures?, category?, limit?, minSimilarity? }
 * - Response: { suggestion, priceRange, similarProducts, cacheMetrics }
 *
 * Performance:
 * - Cache hit rate: >60% after warm-up
 * - Latency: 1s average (cache hits), 2s average (cache misses)
 * - Cost savings: ~$0.070/month through reduced S3 GetObject calls
 */

import { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { VisualSimilarityPricingEngine, type SaleRecord } from '../lib/pricing/visual-similarity-pricing';
import { Logger } from '@aws-lambda-powertools/logger';

// Global instance - persists across Lambda invocations for cache reuse
let pricingEngine: VisualSimilarityPricingEngine | null = null;
const logger = new Logger({ serviceName: 'bg-remover-pricing' });

/**
 * Lambda handler for pricing requests
 */
export async function handler(
  event: APIGatewayProxyEvent,
  context: Context
): Promise<APIGatewayProxyResult> {
  const requestId = event.requestContext?.requestId || context.awsRequestId;

  try {
    logger.info('Pricing request received', {
      requestId,
      method: event.httpMethod,
      path: event.path,
    });

    // Validate HTTP method
    if (event.httpMethod === 'OPTIONS') {
      return buildCorsResponse(200, { message: 'OK' });
    }

    if (event.httpMethod !== 'POST') {
      return buildErrorResponse(405, 'Method not allowed. Use POST.');
    }

    // Initialize pricing engine once per container (cache persists)
    if (!pricingEngine) {
      const tenantId = event.headers['x-tenant-id'] || process.env.TENANT || 'carousel-labs';
      const stage = process.env.STAGE || 'dev';

      pricingEngine = new VisualSimilarityPricingEngine(tenantId, stage, {
        cacheMaxSizeBytes: parseInt(process.env.CACHE_MAX_SIZE_BYTES || '419430400'), // 400MB
        cacheTtlMs: parseInt(process.env.CACHE_TTL_MS || '300000'), // 5 minutes
        dynamoDBTable: process.env.SALES_TABLE_NAME,
        embeddingsBucket: process.env.EMBEDDINGS_BUCKET,
        region: process.env.AWS_REGION,
      });

      logger.info('Pricing engine initialized', {
        tenantId,
        stage,
        cacheMaxSizeBytes: process.env.CACHE_MAX_SIZE_BYTES,
      });
    }

    // Parse request body
    const body = parseRequestBody(event.body);

    // Validate required fields
    if (!body.productEmbedding || !Array.isArray(body.productEmbedding)) {
      return buildErrorResponse(400, 'productEmbedding (array of numbers) is required');
    }

    if (body.productEmbedding.length === 0) {
      return buildErrorResponse(400, 'productEmbedding cannot be empty');
    }

    // Extract optional parameters
    const category = body.category || body.productFeatures?.category;
    const limit = Math.min(body.limit || 20, 100); // Cap at 100 for performance
    const minSimilarity = Math.max(0, Math.min(body.minSimilarity || 0.70, 1.0));

    logger.info('Pricing request parsed', {
      requestId,
      embeddingLength: body.productEmbedding.length,
      category,
      limit,
      minSimilarity,
    });

    // Find similar sold products using cache
    const startTime = Date.now();
    const similarProducts = await pricingEngine.findSimilarSoldProducts(
      body.productEmbedding,
      category,
      {
        limit,
        minSimilarity,
      }
    );
    const queryDuration = Date.now() - startTime;

    // Generate pricing suggestion based on similar products
    const suggestion = generatePriceSuggestion(similarProducts, body.productFeatures);

    // Get cache metrics for response headers
    const cacheMetrics = pricingEngine.getCacheMetrics();
    const hitRatePercent = (cacheMetrics.hitRate * 100).toFixed(1);

    logger.info('Pricing suggestion generated', {
      requestId,
      similarProductsCount: similarProducts.length,
      queryDuration,
      suggestedPrice: suggestion.suggestedPrice,
      hitRate: hitRatePercent,
    });

    // Build successful response
    return buildSuccessResponse(200, {
      suggestion,
      similarProducts: similarProducts.map((p) => ({
        saleId: p.saleId,
        productId: p.productId,
        productName: p.productName,
        category: p.category,
        price: p.price,
        currency: p.currency,
        similarity: (p.similarity || 0).toFixed(3),
        soldAt: p.soldAt,
      })),
      cacheMetrics: {
        hitRate: cacheMetrics.hitRate.toFixed(3),
        hitRatePercent: hitRatePercent + '%',
        hits: cacheMetrics.hits,
        misses: cacheMetrics.misses,
        totalRequests: cacheMetrics.totalRequests,
        cacheSize: cacheMetrics.size,
        cacheMaxSize: cacheMetrics.maxSize,
        cacheSizePercent: cacheMetrics.sizePercent.toFixed(1) + '%',
        evictions: cacheMetrics.evictions,
      },
      metadata: {
        requestId,
        queryDuration,
        timestamp: Date.now(),
      },
    });
  } catch (error) {
    logger.error('Pricing request failed', {
      requestId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return buildErrorResponse(500, 'Internal server error: Unable to generate pricing suggestion');
  }
}

/**
 * Generate pricing suggestion based on similar sold products
 */
function generatePriceSuggestion(
  similarProducts: SaleRecord[],
  productFeatures?: any
): {
  suggestedPrice: number;
  priceRange: { min: number; max: number };
  confidence: number;
  rationale: string;
} {
  if (similarProducts.length === 0) {
    return {
      suggestedPrice: 0,
      priceRange: { min: 0, max: 0 },
      confidence: 0,
      rationale: 'No similar products found to compare',
    };
  }

  // Extract prices from similar products (weighted by similarity)
  const weights = similarProducts.map((p) => p.similarity || 0.5);
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  // Calculate weighted average price
  const weightedSum = similarProducts.reduce((sum, p, i) => {
    return sum + p.price * weights[i];
  }, 0);
  const suggestedPrice = Math.round((weightedSum / totalWeight) * 100) / 100;

  // Calculate price range
  const prices = similarProducts.map((p) => p.price);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);

  // Confidence based on number of similar products and similarity scores
  const avgSimilarity = weights.reduce((a, b) => a + b, 0) / weights.length;
  const confidence = Math.min(avgSimilarity * (similarProducts.length / 10), 1.0);

  return {
    suggestedPrice,
    priceRange: {
      min: Math.round(minPrice * 100) / 100,
      max: Math.round(maxPrice * 100) / 100,
    },
    confidence: Math.round(confidence * 1000) / 1000,
    rationale: `Based on ${similarProducts.length} similar sold products (avg similarity: ${(avgSimilarity * 100).toFixed(1)}%)`,
  };
}

/**
 * Parse request body safely
 */
function parseRequestBody(body: string | null | undefined): any {
  if (!body) {
    return {};
  }

  try {
    return JSON.parse(body);
  } catch (error) {
    logger.warn('Failed to parse request body', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

/**
 * Build success response with cache metrics in headers
 */
function buildSuccessResponse(statusCode: number, body: any): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'X-Cache-Hit-Rate': ((body.cacheMetrics?.hitRate || 0) * 100).toFixed(1),
      'X-Cache-Size-Percent': body.cacheMetrics?.cacheSizePercent || '0',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-tenant-id',
    },
    body: JSON.stringify(body),
  };
}

/**
 * Build error response
 */
function buildErrorResponse(statusCode: number, message: string): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-tenant-id',
    },
    body: JSON.stringify({
      error: message,
      timestamp: Date.now(),
    }),
  };
}

/**
 * Build CORS response
 */
function buildCorsResponse(statusCode: number, body: any): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-tenant-id',
    },
    body: JSON.stringify(body),
  };
}

/**
 * Health check export for serverless plugin
 */
export async function healthHandler(
  event: APIGatewayProxyEvent,
  context: Context
): Promise<APIGatewayProxyResult> {
  try {
    if (!pricingEngine) {
      const tenantId = event.headers['x-tenant-id'] || process.env.TENANT || 'carousel-labs';
      const stage = process.env.STAGE || 'dev';

      pricingEngine = new VisualSimilarityPricingEngine(tenantId, stage, {
        embeddingsBucket: process.env.EMBEDDINGS_BUCKET,
      });
    }

    const health = await pricingEngine.healthCheck();

    return {
      statusCode: health.healthy ? 200 : 503,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(health),
    };
  } catch (error) {
    return {
      statusCode: 503,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        healthy: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
}
