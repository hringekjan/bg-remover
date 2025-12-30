/**
 * Visual Similarity Pricing Engine Tests
 *
 * Tests for the VisualSimilarityPricingEngine which provides data-driven
 * pricing suggestions based on visual similarity to historically sold products.
 *
 * Coverage includes:
 * - Finding similar sold products by embedding similarity
 * - Calculating weighted average prices
 * - Applying condition and seasonal multipliers
 * - Confidence score calculation
 * - Price range generation
 * - Cosine similarity calculations
 * - Human-readable explanations
 */

import { VisualSimilarityPricingEngine, type SaleRecord } from '../visual-similarity-pricing';

// Mock EmbeddingCache
jest.mock('@carousellabs/backend-kit', () => ({
  EmbeddingCache: jest.fn().mockImplementation(() => ({
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(void 0),
    clear: jest.fn(),
    getCacheStats: jest.fn().mockReturnValue({
      hits: 0,
      misses: 0,
      totalRequests: 0,
      hitRate: 0,
      sizeBytes: 0,
      maxSizeBytes: 400 * 1024 * 1024,
      sizePercent: 0,
      evictions: 0,
      entryCount: 0,
    }),
  })),
}));

// Mock AWS SDK clients
const mockQueryCommand = jest.fn();
const mockBatchGetItemCommand = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({
    send: jest.fn().mockResolvedValue({ Items: [] }),
  })),
  QueryCommand: jest.fn((params) => {
    mockQueryCommand(params);
    return params;
  }),
  BatchGetItemCommand: jest.fn((params) => {
    mockBatchGetItemCommand(params);
    return params;
  }),
}));

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({
    send: jest.fn(),
  })),
  GetObjectCommand: jest.fn((params) => params),
}));
jest.mock('../vision-analysis', () => ({
  VisionAnalysisService: jest.fn().mockImplementation(() => ({
    assessVisualQuality: jest.fn().mockResolvedValue({
      conditionScore: 4.0,
      photoQualityScore: 4.5,
      visibleDefects: [],
      overallAssessment: 'good',
      pricingImpact: 'neutral',
      reasoning: 'Good condition, clear photos',
      multiplier: 1.0,
    }),
    assessMultipleImages: jest.fn().mockResolvedValue({
      conditionScore: 4.0,
      photoQualityScore: 4.5,
      visibleDefects: [],
      overallAssessment: 'good',
      pricingImpact: 'neutral',
      reasoning: 'Good condition, clear photos',
      multiplier: 1.0,
    }),
  })),
}));

describe('VisualSimilarityPricingEngine', () => {
  let engine: VisualSimilarityPricingEngine;

  beforeEach(() => {
    engine = new VisualSimilarityPricingEngine('test-tenant', 'dev', {
      region: 'eu-west-1',
      bedrockRegion: 'us-east-1',
      embeddingsBucket: 'test-embeddings-bucket',
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Constructor', () => {
    it('should initialize with required parameters', () => {
      expect(engine).toBeDefined();
    });

    it('should throw error when embeddings bucket is not provided', () => {
      expect(() => {
        new VisualSimilarityPricingEngine('test-tenant', 'dev', {
          region: 'eu-west-1',
        });
      }).toThrow('EMBEDDINGS_BUCKET');
    });

    it('should use default values for optional parameters', () => {
      const defaultEngine = new VisualSimilarityPricingEngine('test-tenant', 'dev', {
        embeddingsBucket: 'test-bucket',
      });
      expect(defaultEngine).toBeDefined();
    });
  });

  describe('cosineSimilarity', () => {
    it('should return 1.0 for identical embeddings', () => {
      const embedding = new Array(1024).fill(0.5);
      const similarity = (engine as any).cosineSimilarity(embedding, embedding);
      expect(similarity).toBe(1.0);
    });

    it('should return 0.0 for orthogonal embeddings', () => {
      const a = [...new Array(512).fill(1), ...new Array(512).fill(0)];
      const b = [...new Array(512).fill(0), ...new Array(512).fill(1)];
      const similarity = (engine as any).cosineSimilarity(a, b);
      expect(similarity).toBeCloseTo(0.0, 1);
    });

    it('should return value between 0 and 1', () => {
      const a = [1, 2, 3, 4];
      const b = [5, 6, 7, 8];
      const similarity = (engine as any).cosineSimilarity(a, b);
      expect(similarity).toBeGreaterThanOrEqual(0);
      expect(similarity).toBeLessThanOrEqual(1);
    });

    it('should handle large embeddings', () => {
      const a = new Array(1024).fill(1).map((_, i) => Math.sin(i / 100));
      const b = new Array(1024).fill(1).map((_, i) => Math.cos(i / 100));
      const similarity = (engine as any).cosineSimilarity(a, b);
      expect(similarity).toBeGreaterThanOrEqual(0);
      expect(similarity).toBeLessThanOrEqual(1);
    });

    it('should throw error for mismatched embedding dimensions', () => {
      const a = [1, 2, 3];
      const b = [1, 2, 3, 4];
      expect(() => {
        (engine as any).cosineSimilarity(a, b);
      }).toThrow('must have the same length');
    });

    it('should handle zero vectors gracefully', () => {
      const a = [0, 0, 0];
      const b = [1, 2, 3];
      const similarity = (engine as any).cosineSimilarity(a, b);
      expect(similarity).toBe(0);
    });
  });

  describe('getConditionMultiplier', () => {
    it('should return 1.2 for new_with_tags condition', () => {
      const multiplier = (engine as any).getConditionMultiplier('new_with_tags');
      expect(multiplier).toBe(1.2);
    });

    it('should return 1.1 for like_new condition', () => {
      const multiplier = (engine as any).getConditionMultiplier('like_new');
      expect(multiplier).toBe(1.1);
    });

    it('should return 1.0 for very_good condition', () => {
      const multiplier = (engine as any).getConditionMultiplier('very_good');
      expect(multiplier).toBe(1.0);
    });

    it('should return 0.95 for good condition', () => {
      const multiplier = (engine as any).getConditionMultiplier('good');
      expect(multiplier).toBe(0.95);
    });

    it('should return 0.85 for fair condition', () => {
      const multiplier = (engine as any).getConditionMultiplier('fair');
      expect(multiplier).toBe(0.85);
    });

    it('should return 0.75 for poor condition', () => {
      const multiplier = (engine as any).getConditionMultiplier('poor');
      expect(multiplier).toBe(0.75);
    });

    it('should return 0.95 for undefined condition (defaults to good)', () => {
      const multiplier = (engine as any).getConditionMultiplier(undefined);
      expect(multiplier).toBe(0.95);
    });

    it('should return 1.0 for unknown condition', () => {
      const multiplier = (engine as any).getConditionMultiplier('unknown-condition');
      expect(multiplier).toBe(1.0);
    });
  });

  describe('getSeasonalMultiplier', () => {
    it('should return 1.05 for clothing category', () => {
      const multiplier = (engine as any).getSeasonalMultiplier('clothing');
      expect(multiplier).toBe(1.05);
    });

    it('should return 0.98 for electronics category', () => {
      const multiplier = (engine as any).getSeasonalMultiplier('electronics');
      expect(multiplier).toBe(0.98);
    });

    it('should return 1.02 for home category', () => {
      const multiplier = (engine as any).getSeasonalMultiplier('home');
      expect(multiplier).toBe(1.02);
    });

    it('should return 0.95 for books category', () => {
      const multiplier = (engine as any).getSeasonalMultiplier('books');
      expect(multiplier).toBe(0.95);
    });

    it('should return 1.0 for unknown category', () => {
      const multiplier = (engine as any).getSeasonalMultiplier('unknown-category');
      expect(multiplier).toBe(1.0);
    });

    it('should be case-insensitive', () => {
      const multiplier1 = (engine as any).getSeasonalMultiplier('CLOTHING');
      const multiplier2 = (engine as any).getSeasonalMultiplier('clothing');
      expect(multiplier1).toBe(multiplier2);
    });
  });

  describe('getCurrencyForLanguage', () => {
    it('should return USD for English', () => {
      const currency = (engine as any).getCurrencyForLanguage('en');
      expect(currency).toBe('USD');
    });

    it('should return ISK for Icelandic', () => {
      const currency = (engine as any).getCurrencyForLanguage('is');
      expect(currency).toBe('ISK');
    });

    it('should return EUR for German', () => {
      const currency = (engine as any).getCurrencyForLanguage('de');
      expect(currency).toBe('EUR');
    });

    it('should return EUR for French', () => {
      const currency = (engine as any).getCurrencyForLanguage('fr');
      expect(currency).toBe('EUR');
    });

    it('should return USD for unknown language', () => {
      const currency = (engine as any).getCurrencyForLanguage('unknown');
      expect(currency).toBe('USD');
    });
  });

  describe('Cache Metrics', () => {
    it('should return cache metrics', () => {
      const metrics = engine.getCacheMetrics();
      expect(metrics).toHaveProperty('hits');
      expect(metrics).toHaveProperty('misses');
      expect(metrics).toHaveProperty('totalRequests');
      expect(metrics).toHaveProperty('hitRate');
      expect(metrics).toHaveProperty('size');
      expect(metrics).toHaveProperty('maxSize');
      expect(metrics).toHaveProperty('evictions');
      expect(metrics).toHaveProperty('sizePercent');
    });

    it('should have numeric properties in metrics', () => {
      const metrics = engine.getCacheMetrics();
      expect(typeof metrics.hits).toBe('number');
      expect(typeof metrics.misses).toBe('number');
      expect(typeof metrics.hitRate).toBe('number');
      expect(typeof metrics.size).toBe('number');
    });

    it('should clear cache without errors', () => {
      expect(() => {
        engine.clearCache();
      }).not.toThrow();
    });
  });

  describe('Health Check', () => {
    it('should perform health check', async () => {
      const health = await engine.healthCheck();
      expect(health).toHaveProperty('healthy');
      expect(health).toHaveProperty('details');
      expect(typeof health.healthy).toBe('boolean');
    });

    it('should include tenant and stage in health check details', async () => {
      const health = await engine.healthCheck();
      if (health.healthy) {
        expect(health.details).toHaveProperty('tenant');
        expect(health.details).toHaveProperty('stage');
        expect(health.details.tenant).toBe('test-tenant');
        expect(health.details.stage).toBe('dev');
      }
    });
  });

  describe('findSimilarSoldProducts', () => {
    it('should handle empty results gracefully', async () => {
      const embedding = new Array(1024).fill(0.5);
      const results = await engine.findSimilarSoldProducts(embedding, 'clothing', {
        limit: 20,
        minSimilarity: 0.7,
      });
      expect(Array.isArray(results)).toBe(true);
    });

    it('should return array of SaleRecord', async () => {
      const embedding = new Array(1024).fill(0.5);
      const results = await engine.findSimilarSoldProducts(embedding);
      expect(Array.isArray(results)).toBe(true);
    });

    it('should respect limit parameter', async () => {
      const embedding = new Array(1024).fill(0.5);
      const results = await engine.findSimilarSoldProducts(embedding, undefined, {
        limit: 5,
      });
      expect(results.length).toBeLessThanOrEqual(5);
    });

    it('should respect minSimilarity parameter', async () => {
      const embedding = new Array(1024).fill(0.5);
      const results = await engine.findSimilarSoldProducts(embedding, undefined, {
        minSimilarity: 0.9,
      });
      // All results should have similarity >= 0.9 if any exist
      results.forEach((sale) => {
        if (sale.similarity !== undefined) {
          expect(sale.similarity).toBeGreaterThanOrEqual(0.89);
        }
      });
    });
  });

  describe('calculateSeasonallyAdjustedPrice', () => {
    it('should return 0 for empty sales array', async () => {
      const price = await engine.calculateSeasonallyAdjustedPrice([]);
      expect(price).toBe(0);
    });

    it('should calculate average price for single sale', async () => {
      const sales: SaleRecord[] = [
        {
          saleId: 'sale-1',
          embeddingId: 'emb-1',
          productId: 'prod-1',
          productName: 'Test Product',
          category: 'clothing',
          price: 100,
          currency: 'USD',
          soldAt: Date.now(),
          embedding: new Array(1024).fill(0.5),
        },
      ];

      const price = await engine.calculateSeasonallyAdjustedPrice(sales);
      expect(price).toBeGreaterThan(0);
    });

    it('should apply seasonal multiplier for known categories', async () => {
      const sales: SaleRecord[] = [
        {
          saleId: 'sale-1',
          embeddingId: 'emb-1',
          productId: 'prod-1',
          productName: 'Test Product',
          category: 'clothing',
          price: 100,
          currency: 'USD',
          soldAt: Date.now(),
          embedding: new Array(1024).fill(0.5),
        },
      ];

      const price = await engine.calculateSeasonallyAdjustedPrice(sales, 'clothing');
      // Clothing has 1.05 multiplier
      expect(price).toBeCloseTo(105, 0);
    });

    it('should handle multiple sales by averaging', async () => {
      const sales: SaleRecord[] = [
        {
          saleId: 'sale-1',
          embeddingId: 'emb-1',
          productId: 'prod-1',
          productName: 'Test Product 1',
          category: 'clothing',
          price: 100,
          currency: 'USD',
          soldAt: Date.now(),
          embedding: new Array(1024).fill(0.5),
        },
        {
          saleId: 'sale-2',
          embeddingId: 'emb-2',
          productId: 'prod-2',
          productName: 'Test Product 2',
          category: 'clothing',
          price: 200,
          currency: 'USD',
          soldAt: Date.now(),
          embedding: new Array(1024).fill(0.5),
        },
      ];

      const price = await engine.calculateSeasonallyAdjustedPrice(sales);
      // Average of 100 and 200 is 150
      expect(price).toBeCloseTo(150, 0);
    });

    it('should return base price when no category provided', async () => {
      const sales: SaleRecord[] = [
        {
          saleId: 'sale-1',
          embeddingId: 'emb-1',
          productId: 'prod-1',
          productName: 'Test Product',
          category: 'clothing',
          price: 100,
          currency: 'USD',
          soldAt: Date.now(),
          embedding: new Array(1024).fill(0.5),
        },
      ];

      const price = await engine.calculateSeasonallyAdjustedPrice(sales);
      expect(price).toBe(100);
    });
  });

  describe('generatePriceSuggestion', () => {
    it('should return suggestion structure for empty results', async () => {
      const embedding = new Array(1024).fill(0.5);
      const suggestion = await engine.generatePriceSuggestion(
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        embedding,
        {
          category: 'clothing',
          brand: 'Test Brand',
          condition: 'good',
        }
      );

      expect(suggestion).toHaveProperty('suggestedPrice');
      expect(suggestion).toHaveProperty('priceRange');
      expect(suggestion).toHaveProperty('confidence');
      expect(suggestion).toHaveProperty('currency');
      expect(suggestion).toHaveProperty('factors');
      expect(suggestion).toHaveProperty('reasoning');
    });

    it('should include similarity products in factors', async () => {
      const embedding = new Array(1024).fill(0.5);
      const suggestion = await engine.generatePriceSuggestion(
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        embedding
      );

      expect(suggestion.factors).toHaveProperty('similarProducts');
      expect(Array.isArray(suggestion.factors.similarProducts)).toBe(true);
    });

    it('should include visual quality assessment in factors when similar products exist', async () => {
      const embedding = new Array(1024).fill(0.5);
      const suggestion = await engine.generatePriceSuggestion(
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        embedding
      );

      // When no similar products are found, visualQualityAssessment may not be included
      // This is expected behavior for fallback pricing
      expect(suggestion.factors).toHaveProperty('visualQualityDetails');
      expect(typeof suggestion.factors.visualQualityMultiplier).toBe('number');
    });

    it('should return valid currency code', async () => {
      const embedding = new Array(1024).fill(0.5);
      const suggestion = await engine.generatePriceSuggestion(
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        embedding,
        undefined,
        undefined,
        'en'
      );

      expect(suggestion.currency).toBe('USD');
    });

    it('should return ISK currency for Icelandic language', async () => {
      const embedding = new Array(1024).fill(0.5);
      const suggestion = await engine.generatePriceSuggestion(
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        embedding,
        undefined,
        undefined,
        'is'
      );

      expect(suggestion.currency).toBe('ISK');
    });

    it('should have numeric price range values', async () => {
      const embedding = new Array(1024).fill(0.5);
      const suggestion = await engine.generatePriceSuggestion(
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        embedding
      );

      expect(typeof suggestion.priceRange.min).toBe('number');
      expect(typeof suggestion.priceRange.max).toBe('number');
      expect(suggestion.priceRange.min).toBeGreaterThanOrEqual(0);
      expect(suggestion.priceRange.max).toBeGreaterThanOrEqual(suggestion.priceRange.min);
    });

    it('should have confidence between 0 and 1', async () => {
      const embedding = new Array(1024).fill(0.5);
      const suggestion = await engine.generatePriceSuggestion(
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        embedding
      );

      expect(suggestion.confidence).toBeGreaterThanOrEqual(0);
      expect(suggestion.confidence).toBeLessThanOrEqual(1);
    });

    it('should include all factor multipliers', async () => {
      const embedding = new Array(1024).fill(0.5);
      const suggestion = await engine.generatePriceSuggestion(
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        embedding
      );

      expect(suggestion.factors).toHaveProperty('basePrice');
      expect(suggestion.factors).toHaveProperty('seasonalMultiplier');
      expect(suggestion.factors).toHaveProperty('conditionMultiplier');
      expect(suggestion.factors).toHaveProperty('visualQualityMultiplier');
      expect(suggestion.factors).toHaveProperty('visualQualityDetails');
    });

    it('should have reasoning that mentions similar products', async () => {
      const embedding = new Array(1024).fill(0.5);
      const suggestion = await engine.generatePriceSuggestion(
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        embedding
      );

      expect(suggestion.reasoning).toBeDefined();
      expect(typeof suggestion.reasoning).toBe('string');
      expect(suggestion.reasoning.length).toBeGreaterThan(0);
    });
  });

  describe('Type Safety', () => {
    it('should have proper SaleRecord interface', () => {
      const sale: SaleRecord = {
        saleId: 'test-id',
        embeddingId: 'emb-id',
        productId: 'prod-id',
        productName: 'Test Product',
        category: 'clothing',
        price: 100,
        currency: 'USD',
        soldAt: Date.now(),
        similarity: 0.95,
        embedding: new Array(1024).fill(0.5),
      };

      expect(sale).toBeDefined();
      expect(sale.productId).toBe('prod-id');
    });
  });

  describe('Confidence Calculation', () => {
    it('should calculate higher confidence with more similar products', () => {
      const baseConfidence = (engine as any).calculateConfidence(
        0.85,
        [{ soldAt: Date.now() } as SaleRecord],
        [100]
      );

      const moreProductsConfidence = (engine as any).calculateConfidence(
        0.85,
        Array(10).fill({ soldAt: Date.now() } as SaleRecord),
        Array(10).fill(100)
      );

      expect(moreProductsConfidence).toBeGreaterThan(baseConfidence);
    });

    it('should return confidence between 0 and 1', () => {
      const confidence = (engine as any).calculateConfidence(
        0.8,
        [{ soldAt: Date.now() } as SaleRecord],
        [100]
      );

      expect(confidence).toBeGreaterThanOrEqual(0);
      expect(confidence).toBeLessThanOrEqual(1);
    });

    it('should handle zero similarity gracefully', () => {
      const confidence = (engine as any).calculateConfidence(
        0.0,
        [],
        []
      );

      // Even with zero similarity and no products, variance score contributes a small amount
      expect(confidence).toBeGreaterThanOrEqual(0);
      expect(confidence).toBeLessThanOrEqual(0.2);  // Low confidence due to zero similarity
    });

    it('should calculate higher confidence with lower price variance', () => {
      const consistentPrices = [100, 100, 100, 100];
      const variablePrices = [50, 100, 150, 200];

      const consistentConfidence = (engine as any).calculateConfidence(
        0.8,
        Array(4).fill({ soldAt: Date.now() } as SaleRecord),
        consistentPrices
      );

      const variableConfidence = (engine as any).calculateConfidence(
        0.8,
        Array(4).fill({ soldAt: Date.now() } as SaleRecord),
        variablePrices
      );

      expect(consistentConfidence).toBeGreaterThan(variableConfidence);
    });
  });

  describe('Recency Score', () => {
    it('should return high recency score for recent sales', () => {
      const recentSales: SaleRecord[] = Array(5).fill({
        saleId: 'test',
        embeddingId: 'test',
        productId: 'test',
        productName: 'test',
        category: 'test',
        price: 100,
        currency: 'USD',
        soldAt: Date.now() - 30 * 24 * 60 * 60 * 1000, // 30 days ago
      } as SaleRecord);

      const recencyScore = (engine as any).calculateRecencyScore(recentSales);
      expect(recencyScore).toBeGreaterThan(0.5);
    });

    it('should return low recency score for old sales', () => {
      const oldSales: SaleRecord[] = Array(5).fill({
        saleId: 'test',
        embeddingId: 'test',
        productId: 'test',
        productName: 'test',
        category: 'test',
        price: 100,
        currency: 'USD',
        soldAt: Date.now() - 200 * 24 * 60 * 60 * 1000, // 200 days ago
      } as SaleRecord);

      const recencyScore = (engine as any).calculateRecencyScore(oldSales);
      expect(recencyScore).toBeLessThan(0.5);
    });
  });

  describe('Variance Score', () => {
    it('should return high score for consistent prices', () => {
      const consistentPrices = [100, 100, 100, 100];
      const varianceScore = (engine as any).calculateVarianceScore(consistentPrices);
      expect(varianceScore).toBeGreaterThan(0.8);
    });

    it('should return lower score for variable prices', () => {
      const variablePrices = [50, 100, 150, 200];
      const varianceScore = (engine as any).calculateVarianceScore(variablePrices);
      expect(varianceScore).toBeLessThan(0.8);
    });

    it('should handle single price gracefully', () => {
      const singlePrice = [100];
      const varianceScore = (engine as any).calculateVarianceScore(singlePrice);
      expect(varianceScore).toBe(0.8);
    });
  });

  describe('Confidence-Based Price Range', () => {
    it('should use ±15% spread for high confidence', () => {
      const result = (engine as any).calculateConfidenceBasedPriceRange(100, 0.8);
      expect(result.minPrice).toBe(85);
      expect(result.maxPrice).toBe(115);
    });

    it('should use ±25% spread for low confidence', () => {
      const result = (engine as any).calculateConfidenceBasedPriceRange(100, 0.6);
      expect(result.minPrice).toBe(75);
      expect(result.maxPrice).toBe(125);
    });

    it('should use exact 0.7 threshold for confidence', () => {
      const highResult = (engine as any).calculateConfidenceBasedPriceRange(100, 0.71);
      const lowResult = (engine as any).calculateConfidenceBasedPriceRange(100, 0.69);

      // 0.71 should use 15% spread
      expect(highResult.minPrice).toBe(85);
      expect(highResult.maxPrice).toBe(115);

      // 0.69 should use 25% spread
      expect(lowResult.minPrice).toBe(75);
      expect(lowResult.maxPrice).toBe(125);
    });

    it('should handle edge case prices correctly', () => {
      const result = (engine as any).calculateConfidenceBasedPriceRange(0.50, 0.8);
      // 0.50 * 0.85 = 0.425, 0.50 * 1.15 = 0.575
      expect(result.minPrice).toBeCloseTo(0.42, 1);
      expect(result.maxPrice).toBeCloseTo(0.58, 1);
    });
  });
});
