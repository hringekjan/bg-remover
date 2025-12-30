/**
 * Vector Search Integration Example
 *
 * This module shows how to integrate the VectorSearchService with
 * the VisualSimilarityPricingEngine for production use.
 *
 * Key Integration Points:
 * 1. Initialize VectorSearchService with config
 * 2. Call findSimilar() with query embedding
 * 3. Use results for pricing recommendations
 * 4. Monitor performance metrics
 *
 * @module lib/sales-intelligence/vector-search-integration
 */

import { VectorSearchService, type SimilarProduct } from './vector-search';
import { Logger } from '@aws-lambda-powertools/logger';

/**
 * Integration example for VisualSimilarityPricingEngine
 *
 * Usage:
 * ```typescript
 * const integration = new VectorSearchIntegration({
 *   tenantId: 'carousel-labs',
 *   stage: process.env.STAGE || 'dev',
 *   tableName: process.env.SALES_TABLE,
 *   embeddingsBucket: process.env.EMBEDDINGS_BUCKET,
 * });
 *
 * const similarProducts = await integration.findSimilarForPricing(
 *   queryEmbedding,
 *   { category: 'dress', limit: 20 }
 * );
 *
 * const suggestedPrice = integration.calculatePricingSuggestion(similarProducts);
 * ```
 */
export class VectorSearchIntegration {
  private vectorSearch: VectorSearchService;
  private logger: Logger;

  constructor(
    private options: {
      tenantId: string;
      stage: string;
      tableName?: string;
      embeddingsBucket: string;
      region?: string;
      logger?: Logger;
    }
  ) {
    this.logger = options.logger || new Logger({ serviceName: 'VectorSearchIntegration' });

    this.vectorSearch = new VectorSearchService({
      tenantId: options.tenantId,
      stage: options.stage,
      tableName: options.tableName,
      embeddingsBucket: options.embeddingsBucket,
      region: options.region,
      logger: this.logger,
    });
  }

  /**
   * Find similar products for pricing analysis
   *
   * Wrapper around VectorSearchService.findSimilar() with pricing-specific defaults:
   * - Default limit: 20 similar products
   * - Default similarity threshold: 0.75
   * - Default days back: 90 (quarterly trend)
   *
   * @param queryEmbedding - 1024-dimensional embedding
   * @param options - Search options (category, limit, minSimilarity)
   * @returns Array of similar products sorted by similarity
   */
  async findSimilarForPricing(
    queryEmbedding: number[],
    options: {
      category?: string;
      limit?: number;
      minSimilarity?: number;
      daysBack?: number;
    } = {}
  ): Promise<SimilarProduct[]> {
    const {
      category,
      limit = 20,
      minSimilarity = 0.75,
      daysBack = 90,
    } = options;

    try {
      this.logger.info('Starting similar product search for pricing', {
        category,
        limit,
        minSimilarity,
        daysBack,
      });

      const startTime = Date.now();

      const results = await this.vectorSearch.findSimilar(queryEmbedding, {
        limit,
        minSimilarity,
        category,
        daysBack,
      });

      const duration = Date.now() - startTime;

      this.logger.info('Similar product search complete', {
        results: results.length,
        duration,
        ...this.vectorSearch.getMetrics(),
      });

      return results;
    } catch (error) {
      this.logger.error('Failed to find similar products for pricing', { error });
      throw error;
    }
  }

  /**
   * Calculate pricing suggestion based on similar products
   *
   * Strategy:
   * 1. Filter by high similarity (>0.80)
   * 2. Remove outliers (top 10% and bottom 10% by price)
   * 3. Calculate median price as baseline
   * 4. Adjust based on product condition/wear
   *
   * @param similarProducts - Array of similar products from search
   * @returns Object with pricing suggestion and confidence metrics
   */
  calculatePricingSuggestion(similarProducts: SimilarProduct[]): {
    suggestedPrice: number;
    minPrice: number;
    maxPrice: number;
    confidence: number;
    sampleSize: number;
    reason: string;
  } {
    if (similarProducts.length === 0) {
      return {
        suggestedPrice: 0,
        minPrice: 0,
        maxPrice: 0,
        confidence: 0,
        sampleSize: 0,
        reason: 'No similar products found',
      };
    }

    // Filter high-similarity matches (>0.80)
    const highSimilarity = similarProducts.filter((p) => p.similarity > 0.80);

    if (highSimilarity.length === 0) {
      return {
        suggestedPrice: 0,
        minPrice: 0,
        maxPrice: 0,
        confidence: 0,
        sampleSize: similarProducts.length,
        reason: 'No highly similar products (similarity > 0.80)',
      };
    }

    // Extract prices
    const prices = highSimilarity.map((p) => p.salePrice).sort((a, b) => a - b);

    // Remove outliers: top 10% and bottom 10%
    const outlierThreshold = Math.ceil(prices.length * 0.1);
    const trimmedPrices = prices.slice(outlierThreshold, prices.length - outlierThreshold);

    if (trimmedPrices.length === 0) {
      return {
        suggestedPrice: 0,
        minPrice: 0,
        maxPrice: 0,
        confidence: 0,
        sampleSize: prices.length,
        reason: 'Too few products after outlier removal',
      };
    }

    // Calculate statistics
    const minPrice = Math.min(...trimmedPrices);
    const maxPrice = Math.max(...trimmedPrices);
    const medianPrice = trimmedPrices[Math.floor(trimmedPrices.length / 2)];

    // Confidence based on similarity and sample size
    const avgSimilarity = highSimilarity.reduce((sum, p) => sum + p.similarity, 0) / highSimilarity.length;
    const sampleConfidence = Math.min(highSimilarity.length / 10, 1.0); // 10+ samples = 100% confidence
    const similarityConfidence = (avgSimilarity - 0.75) / 0.25; // 0.75 = 0%, 1.0 = 100%
    const confidence = Math.min((sampleConfidence + similarityConfidence) / 2, 1.0);

    this.logger.info('Calculated pricing suggestion', {
      suggestedPrice: medianPrice,
      minPrice,
      maxPrice,
      sampleSize: trimmedPrices.length,
      avgSimilarity: avgSimilarity.toFixed(3),
      confidence: (confidence * 100).toFixed(1) + '%',
    });

    return {
      suggestedPrice: Math.round(medianPrice * 100) / 100, // Round to 2 decimals
      minPrice: Math.round(minPrice * 100) / 100,
      maxPrice: Math.round(maxPrice * 100) / 100,
      confidence,
      sampleSize: trimmedPrices.length,
      reason: `Median of ${trimmedPrices.length} similar products (avg similarity: ${avgSimilarity.toFixed(3)})`,
    };
  }

  /**
   * Batch pricing recommendations for multiple products
   *
   * @param products - Array of products with embeddings
   * @returns Pricing suggestions for each product
   */
  async batchPricingRecommendations(
    products: Array<{
      productId: string;
      embedding: number[];
      category?: string;
    }>
  ): Promise<
    Array<{
      productId: string;
      suggestion: {
        suggestedPrice: number;
        minPrice: number;
        maxPrice: number;
        confidence: number;
        sampleSize: number;
        reason: string;
      };
    }>
  > {
    const batchResults: Array<{
      productId: string;
      suggestion: {
        suggestedPrice: number;
        minPrice: number;
        maxPrice: number;
        confidence: number;
        sampleSize: number;
        reason: string;
      };
    }> = [];

    for (const product of products) {
      try {
        const similar = await this.findSimilarForPricing(product.embedding, {
          category: product.category,
          limit: 20,
        });

        const suggestion = this.calculatePricingSuggestion(similar);

        batchResults.push({
          productId: product.productId,
          suggestion,
        });

        this.logger.debug('Batch pricing - processed product', {
          productId: product.productId,
          suggestedPrice: suggestion.suggestedPrice,
        });
      } catch (error) {
        this.logger.warn('Failed to generate pricing for product', {
          productId: product.productId,
          error,
        });

        batchResults.push({
          productId: product.productId,
          suggestion: {
            suggestedPrice: 0,
            minPrice: 0,
            maxPrice: 0,
            confidence: 0,
            sampleSize: 0,
            reason: 'Failed to calculate pricing',
          },
        });
      }
    }

    return batchResults;
  }

  /**
   * Get performance metrics from vector search
   */
  getMetrics() {
    return this.vectorSearch.getMetrics();
  }

  /**
   * Reset metrics
   */
  resetMetrics() {
    this.vectorSearch.resetMetrics();
  }
}

/**
 * Factory function for integration with VisualSimilarityPricingEngine
 */
export function createVectorSearchIntegration(
  tenantId: string,
  stage: string,
  embeddingsBucket: string
): VectorSearchIntegration {
  return new VectorSearchIntegration({
    tenantId,
    stage,
    embeddingsBucket,
    region: process.env.AWS_REGION || 'eu-west-1',
    logger: new Logger({
      serviceName: 'VectorSearchIntegration',
    }),
  });
}
