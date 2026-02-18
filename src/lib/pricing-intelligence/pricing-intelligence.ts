/**
 * Pricing Intelligence Service
 * 
 * Main service that orchestrates pricing suggestions by combining:
 * - Historical sales analysis
 * - Category baselines
 * - Product name analysis
 * - Recency weighting
 * - AI predictions (optional)
 */

import {
  CategoryBaselineAnalyzer,
} from './category-baseline';
import {
  analyzeProductName,
  calculateAdjustments,
} from './product-name-analyzer';
import {
  RecencyWeightEngine,
  DEFAULT_RECENCY_CONFIG,
  calculateWeightedStats,
  calculateRecencyConfidence,
} from './recency-weight';
import type {
  PricingSuggestion,
  PricingRequest,
  HistoricalSale,
  CategoryBaseline,
  ConfidenceLevel,
  PricingFactors,
  PricingSource,
  AIPricingConfig,
} from './types';

import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand as DocQueryCommand } from '@aws-sdk/lib-dynamodb';

const dynamoDB = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoDB);

const TABLE_NAME = process.env.DYNAMODB_TABLE || `carousel-main-${process.env.STAGE || 'dev'}`;

/**
 * Default AI pricing configuration
 */
const DEFAULT_AI_CONFIG: AIPricingConfig = {
  enabled: false,  // Disabled by default
  aiWeight: 0.3,
  statisticalWeight: 0.7,
  confidenceThreshold: 0.5,
};

/**
 * Seasonal adjustment multipliers by month
 */
const SEASONAL_MULTIPLIERS: Record<number, number> = {
  1: 0.95,   // January - post-holiday slowdown
  2: 0.95,   // February
  3: 1.0,    // March - spring awakening
  4: 1.05,   // April
  5: 1.1,    // May - peak season starts
  6: 1.15,   // June - peak summer
  7: 1.15,   // July - peak summer
  8: 1.1,    // August - late summer
  9: 1.0,    // September - fall transition
  10: 0.95,  // October
  11: 1.0,   // November - pre-holiday
  12: 1.1,   // December - holiday season
};

/**
 * Market demand levels by category and season
 */
const DEMAND_BY_CATEGORY: Record<string, Record<number, 'low' | 'medium' | 'high'>> = {
  outerwear: {
    1: 'high', 2: 'medium', 3: 'low', 4: 'low', 5: 'low', 6: 'low',
    7: 'low', 8: 'low', 9: 'medium', 10: 'high', 11: 'high', 12: 'high',
  },
  dresses: {
    1: 'low', 2: 'low', 3: 'medium', 4: 'medium', 5: 'high', 6: 'high',
    7: 'high', 8: 'high', 9: 'medium', 10: 'low', 11: 'low', 12: 'medium',
  },
  tops: {
    1: 'medium', 2: 'medium', 3: 'high', 4: 'high', 5: 'medium', 6: 'low',
    7: 'low', 8: 'low', 9: 'high', 10: 'high', 11: 'high', 12: 'medium',
  },
  shoes: {
    1: 'medium', 2: 'medium', 3: 'high', 4: 'high', 5: 'high', 6: 'high',
    7: 'high', 8: 'high', 9: 'high', 10: 'medium', 11: 'medium', 12: 'medium',
  },
};

/**
 * Pricing Intelligence Service
 */
export class PricingIntelligenceService {
  private tableName: string;
  private aiConfig: AIPricingConfig;

  constructor(
    tableName: string = TABLE_NAME,
    aiConfig: AIPricingConfig = DEFAULT_AI_CONFIG
  ) {
    this.tableName = tableName;
    this.aiConfig = aiConfig;
  }

  /**
   * Generate pricing suggestion for a product
   */
  async getSuggestion(request: PricingRequest): Promise<PricingSuggestion> {
    const startTime = Date.now();

    // Step 1: Parse product name for brand/condition
    const nameAnalysis = analyzeProductName(request.productName);

    // Step 2: Get category (from request or parsed)
    const category = request.category || 
      nameAnalysis.productType || 
      CategoryBaselineAnalyzer.parseCategoryFromName(request.productName);

    // Step 3: Get historical sales for this category
    const historicalSales = await this.queryHistoricalSales(category);

    // Step 4: Calculate category baseline
    const baseline = CategoryBaselineAnalyzer.calculateBaseline(
      historicalSales,
      category
    );

    // Step 5: Calculate recency-weighted statistics
    const weightEngine = new RecencyWeightEngine(DEFAULT_RECENCY_CONFIG);
    const weightedStats = weightEngine.calculateStats(historicalSales);

    // Step 6: Calculate adjustments from name analysis
    const adjustments = calculateAdjustments(nameAnalysis);

    // Step 7: Apply seasonal adjustment
    const currentMonth = new Date().getMonth() + 1;
    const seasonalMultiplier = SEASONAL_MULTIPLIERS[currentMonth] || 1.0;

    // Step 8: Get market demand level
    const marketDemand = this.getMarketDemand(category, currentMonth);

    // Step 9: Calculate final price components
    const {
      price,
      minPrice,
      maxPrice,
      explanation,
      sources,
    } = this.calculateFinalPrice(
      baseline,
      weightedStats,
      adjustments,
      seasonalMultiplier,
      marketDemand,
      historicalSales.length
    );

    // Step 10: Calculate confidence
    const confidence = this.calculateConfidence(
      weightedStats,
      nameAnalysis.extractionConfidence,
      weightEngine.getConfidence(historicalSales),
      historicalSales.length
    );

    // Step 11: Build factors object
    const factors = this.buildFactors(
      baseline.avgPrice,
      weightedStats.weightedAvg,
      adjustments,
      seasonalMultiplier,
      marketDemand,
      historicalSales.length
    );

    return {
      suggestedPrice: price,
      minPrice,
      maxPrice,
      confidence,
      confidenceScore: confidence === 'high' ? 0.85 : confidence === 'medium' ? 0.6 : 0.35,
      factors,
      sources,
      explanation,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Query historical sales from DynamoDB
   */
  private async queryHistoricalSales(category: string): Promise<HistoricalSale[]> {
    try {
      // Query by category GSI
      const response = await docClient.send(new DocQueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: {
          ':pk': `TENANT#carousel-labs#SALES`,
        },
        Limit: 1000,  // Max 1000 sales
      }));

      if (!response.Items || response.Items.length === 0) {
        return [];
      }

      // Filter by category in memory (GSI doesn't support filtering by category)
      const allSales = response.Items as unknown as HistoricalSale[];
      
      return allSales.filter(sale => {
        // Match by category or product name keywords
        if (sale.category?.toLowerCase() === category.toLowerCase()) {
          return true;
        }
        // Check category keywords in product name
        const productName = sale.productName?.toLowerCase() || '';
        return CategoryBaselineAnalyzer.categoryKeywordsMatch(category, productName);
      });
    } catch (error) {
      console.error('[PricingIntelligence] Failed to query historical sales:', error);
      return [];
    }
  }

  /**
   * Calculate final price from all components
   */
  private calculateFinalPrice(
    baseline: CategoryBaseline,
    weightedStats: ReturnType<typeof calculateWeightedStats>,
    adjustments: { brandAdjustment: number; conditionAdjustment: number },
    seasonalMultiplier: number,
    marketDemand: 'low' | 'medium' | 'high',
    sampleSize: number
  ): {
    price: number;
    minPrice: number;
    maxPrice: number;
    explanation: string;
    sources: PricingSource[];
  } {
    const sources: PricingSource[] = [];
    let basePrice: number;
    let minBase: number;
    let maxBase: number;

    if (sampleSize > 0 && weightedStats.weightedAvg > 0) {
      // Use weighted statistics
      basePrice = weightedStats.weightedAvg;
      minBase = weightedStats.priceRange.min;
      maxBase = weightedStats.priceRange.max;
      sources.push('historical_sales');
      sources.push('recency_weighted');
    } else if (baseline.sampleSize > 0) {
      // Fall back to category baseline
      basePrice = baseline.avgPrice;
      minBase = baseline.minPrice;
      maxBase = baseline.maxPrice;
      sources.push('category_baseline');
    } else {
      // No data - use default fallback
      basePrice = 5000;  // Default 5000 ISK
      minBase = 2500;
      maxBase = 10000;
      sources.push('fallback_default');
    }

    // Apply adjustments
    const adjustedPrice = basePrice * 
      adjustments.brandAdjustment * 
      adjustments.conditionAdjustment * 
      seasonalMultiplier;

    const adjustedMin = minBase * 
      adjustments.brandAdjustment * 
      adjustments.conditionAdjustment * 
      seasonalMultiplier;

    const adjustedMax = maxBase * 
      adjustments.brandAdjustment * 
      adjustments.conditionAdjustment * 
      seasonalMultiplier;

    // Round to nearest 100 ISK
    const price = Math.round(adjustedPrice / 100) * 100;
    const minPrice = Math.round(adjustedMin / 100) * 100;
    const maxPrice = Math.round(adjustedMax / 100) * 100;

    // Build explanation
    let explanation = '';
    if (adjustments.brandAdjustment !== 1.0) {
      explanation += `${adjustments.brandAdjustment > 1 ? '+' : ''}${Math.round((adjustments.brandAdjustment - 1) * 100)}% brand premium. `;
    }
    if (adjustments.conditionAdjustment !== 1.0) {
      explanation += `${adjustments.conditionAdjustment > 1 ? '+' : ''}${Math.round((adjustments.conditionAdjustment - 1) * 100)}% condition adjustment. `;
    }
    if (seasonalMultiplier !== 1.0) {
      explanation += `${seasonalMultiplier > 1 ? '+' : ''}${Math.round((seasonalMultiplier - 1) * 100)}% seasonal adjustment. `;
    }
    if (sources.includes('historical_sales')) {
      explanation += `Based on ${sampleSize} recent sales.`;
    } else if (sources.includes('category_baseline')) {
      explanation += `Based on category average from ${baseline.sampleSize} sales.`;
    }

    return { price, minPrice, maxPrice, explanation, sources };
  }

  /**
   * Get market demand level for a category and month
   */
  private getMarketDemand(category: string, month: number): 'low' | 'medium' | 'high' {
    // Check category-specific demand
    const categoryDemand = DEMAND_BY_CATEGORY[category];
    if (categoryDemand) {
      return categoryDemand[month] || 'medium';
    }

    // Default seasonal demand
    if (month >= 5 && month <= 8) {
      return 'high';  // Peak summer season
    }
    if (month === 12 || month === 1) {
      return 'medium';  // Holiday season
    }
    return 'medium';
  }

  /**
   * Calculate confidence level
   */
  private calculateConfidence(
    weightedStats: ReturnType<typeof calculateWeightedStats>,
    extractionConfidence: number,
    recencyConfidence: number,
    sampleSize: number
  ): ConfidenceLevel {
    // Factor 1: Sample size
    const sampleScore = Math.min(sampleSize / 50, 1.0);  // 50+ sales = full score

    // Factor 2: Recency of data
    const recencyScore = recencyConfidence;

    // Factor 3: Name extraction quality
    const extractionScore = extractionConfidence;

    // Weighted average
    const overallScore = (sampleScore * 0.5) + (recencyScore * 0.3) + (extractionScore * 0.2);

    if (overallScore >= 0.7 && sampleSize >= 20) {
      return 'high';
    }
    if (overallScore >= 0.4 && sampleSize >= 10) {
      return 'medium';
    }
    return 'low';
  }

  /**
   * Build factors object
   */
  private buildFactors(
    categoryBaseline: number,
    recencyWeightedAvg: number,
    adjustments: { brandAdjustment: number; conditionAdjustment: number },
    seasonalMultiplier: number,
    marketDemand: 'low' | 'medium' | 'high',
    sampleSize: number
  ): PricingFactors {
    // Use weighted average if available, otherwise baseline
    const baseValue = recencyWeightedAvg > 0 ? recencyWeightedAvg : categoryBaseline;

    return {
      categoryBaseline,
      recencyWeightedAvg,
      brandAdjustment: adjustments.brandAdjustment,
      conditionAdjustment: adjustments.conditionAdjustment,
      seasonalMultiplier,
      marketDemand,
      sampleSize,
    };
  }

  /**
   * Get price suggestion for a product using mock data (for testing)
   */
  async getSuggestionWithMockData(
    request: PricingRequest,
    mockSales: HistoricalSale[]
  ): Promise<PricingSuggestion> {
    const startTime = Date.now();

    // Parse product name
    const nameAnalysis = analyzeProductName(request.productName);

    // Get category
    const category = request.category || 
      nameAnalysis.productType || 
      CategoryBaselineAnalyzer.parseCategoryFromName(request.productName);

    // Calculate baseline from mock data
    const baseline = CategoryBaselineAnalyzer.calculateBaseline(mockSales, category);

    // Calculate weighted stats
    const weightEngine = new RecencyWeightEngine(DEFAULT_RECENCY_CONFIG);
    const weightedStats = weightEngine.calculateStats(mockSales);

    // Calculate adjustments
    const adjustments = calculateAdjustments(nameAnalysis);

    // Apply seasonal
    const currentMonth = new Date().getMonth() + 1;
    const seasonalMultiplier = SEASONAL_MULTIPLIERS[currentMonth] || 1.0;
    const marketDemand = this.getMarketDemand(category, currentMonth);

    // Calculate final price
    const { price, minPrice, maxPrice, explanation, sources } = this.calculateFinalPrice(
      baseline,
      weightedStats,
      adjustments,
      seasonalMultiplier,
      marketDemand,
      mockSales.length
    );

    // Calculate confidence
    const confidence = this.calculateConfidence(
      weightedStats,
      nameAnalysis.extractionConfidence,
      weightEngine.getConfidence(mockSales),
      mockSales.length
    );

    const factors = this.buildFactors(
      baseline.avgPrice,
      weightedStats.weightedAvg,
      adjustments,
      seasonalMultiplier,
      marketDemand,
      mockSales.length
    );

    return {
      suggestedPrice: price,
      minPrice,
      maxPrice,
      confidence,
      confidenceScore: confidence === 'high' ? 0.85 : confidence === 'medium' ? 0.6 : 0.35,
      factors,
      sources,
      explanation,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Generate pricing suggestion using AI-extracted attributes from Mistral Pixtral
   * Combines AI insights with historical data for data-grounded suggestions
   *
   * @param mistralResult - AI extraction results with pricing hints
   * @param productName - Product name
   * @param visionQualityScore - Optional vision analysis quality score (1-10 scale)
   * @returns PricingSuggestion with confidence and factors
   */
  async getSuggestionFromAI(
    mistralResult: any, // MistralPixtralAnalysisResult (import would cause circular dependency)
    productName: string,
    visionQualityScore?: number
  ): Promise<PricingSuggestion> {
    // Map Mistral attributes to PricingRequest
    const request: PricingRequest = {
      productName,
      category: mistralResult.category,
      brand: mistralResult.brand,
      condition: mistralResult.condition,
      material: mistralResult.material,
      size: mistralResult.size,
      colors: mistralResult.colors,
      // Map AI hints to request fields
      rarity: mistralResult.pricingHints?.rarity,
      craftsmanship: mistralResult.pricingHints?.craftsmanship,
      ageYears: mistralResult.pricingHints?.estimatedAgeYears
    };

    // Get base suggestion from existing pricing intelligence
    const baseSuggestion = await this.getSuggestion(request);

    // Apply vision quality multiplier if available
    if (visionQualityScore) {
      // Convert 1-10 scale to 0.75-1.15 multiplier
      // Quality score of 1 → 0.75x (25% discount)
      // Quality score of 5 → 0.93x (neutral-ish)
      // Quality score of 10 → 1.15x (15% premium)
      const qualityMultiplier = 0.75 + (visionQualityScore - 1) * 0.04444;

      baseSuggestion.suggestedPrice = Math.round(baseSuggestion.suggestedPrice * qualityMultiplier);
      baseSuggestion.priceRange.min = Math.round(baseSuggestion.priceRange.min * qualityMultiplier);
      baseSuggestion.priceRange.max = Math.round(baseSuggestion.priceRange.max * qualityMultiplier);
    }

    // Adjust confidence based on AI certainty
    // Cap at 90% of AI confidence to account for uncertainty
    const aiConfidence = mistralResult.aiConfidence?.overall || 0.75;
    baseSuggestion.confidence = Math.min(
      baseSuggestion.confidence,
      aiConfidence * 0.9
    );

    // Add AI-specific factors
    if (baseSuggestion.factors) {
      baseSuggestion.factors.rarity = mistralResult.pricingHints?.rarity;
      baseSuggestion.factors.seasonality = mistralResult.season;
    }

    return baseSuggestion;
  }
}

/**
 * Hybrid AI pricing integration
 */
export async function integrateAIPricing(
  statisticalPrice: number,
  aiPrediction: number | undefined,
  config: AIPricingConfig = DEFAULT_AI_CONFIG
): Promise<{
  finalPrice: number;
  aiContribution: number;
  statisticalContribution: number;
}> {
  if (!config.enabled || !aiPrediction) {
    return {
      finalPrice: statisticalPrice,
      aiContribution: 0,
      statisticalContribution: statisticalPrice,
    };
  }

  // Blend predictions
  const blendedPrice = (
    statisticalPrice * config.statisticalWeight +
    aiPrediction * config.aiWeight
  );

  return {
    finalPrice: Math.round(blendedPrice),
    aiContribution: aiPrediction * config.aiWeight,
    statisticalContribution: statisticalPrice * config.statisticalWeight,
  };
}

/**
 * Get seasonal multiplier for a category
 */
export function getSeasonalMultiplier(
  category: string,
  month: number = new Date().getMonth() + 1
): number {
  // Category-specific seasonal patterns
  const patterns: Record<string, number[]> = {
    outerwear: [0.9, 0.9, 0.95, 0.95, 1.0, 1.0, 1.0, 1.0, 1.0, 1.1, 1.15, 1.1],
    dresses: [0.9, 0.9, 1.0, 1.1, 1.2, 1.3, 1.3, 1.2, 1.1, 1.0, 0.95, 1.0],
    tops: [1.0, 1.0, 1.1, 1.1, 1.0, 0.95, 0.95, 0.95, 1.1, 1.1, 1.1, 1.05],
    shoes: [1.0, 1.0, 1.1, 1.1, 1.1, 1.1, 1.05, 1.05, 1.1, 1.0, 1.0, 1.0],
    swimwear: [0.8, 0.8, 0.85, 0.9, 1.1, 1.3, 1.4, 1.35, 1.1, 0.9, 0.85, 0.8],
    coats: [0.85, 0.85, 0.9, 0.9, 0.95, 0.95, 0.95, 0.95, 1.0, 1.1, 1.2, 1.2],
  };

  const pattern = patterns[category];
  if (pattern && pattern[month - 1] !== undefined) {
    return pattern[month - 1];
  }

  return SEASONAL_MULTIPLIERS[month] || 1.0;
}
