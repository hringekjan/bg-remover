/**
 * Pricing Intelligence Module
 * 
 * Provides intelligent pricing suggestions based on:
 * - Historical sales data analysis
 * - Category baseline calculations
 * - Product name parsing for brand/condition extraction
 * - Recency-weighted averaging
 * - AI-powered predictions
 */

export { PricingIntelligenceService } from './pricing-intelligence';
export { CategoryBaselineAnalyzer } from './category-baseline';
export { analyzeProductName, calculateAdjustments } from './product-name-analyzer';
export { RecencyWeightEngine, calculateWeightedAverage, calculateRecencyWeight, calculateWeightedStats, calculateRecencyConfidence } from './recency-weight';
export { type PricingSuggestion, type PricingFactors, type ConfidenceLevel, type HistoricalSale, type PricingRequest, type CategoryBaseline, type AIPricingConfig } from './types';
export { PricingMemoryIntegration, getPricingMemory, PRICING_MEMORY_CATEGORIES, calculateSeasonalMultiplier, aggregateWeeklyInsights } from './pricing-memory';
