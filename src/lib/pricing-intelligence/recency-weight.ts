/**
 * Recency Weight Engine
 * 
 * Implements exponential decay weighting for historical sales data.
 * Recent sales have more influence on pricing suggestions than older sales.
 */

import type { HistoricalSale, RecencyWeightConfig } from './types';

/**
 * Default recency weight configuration
 */
export const DEFAULT_RECENCY_CONFIG: RecencyWeightConfig = {
  halfLifeDays: 30,        // Weight halves every 30 days
  maxAgeDays: 365,         // Ignore sales older than 1 year
  minWeightThreshold: 0.05, // Ignore weights below 5%
};

/**
 * Calculate weight for a sale based on its age
 */
export function calculateRecencyWeight(
  saleDate: string,
  referenceDate: Date = new Date(),
  config: RecencyWeightConfig = DEFAULT_RECENCY_CONFIG
): number {
  const saleTime = new Date(saleDate).getTime();
  const refTime = referenceDate.getTime();
  
  // Calculate age in days
  const ageDays = (refTime - saleTime) / (1000 * 60 * 60 * 24);
  
  // If sale is too old, return zero weight
  if (ageDays > config.maxAgeDays) {
    return 0;
  }
  
  // Exponential decay: weight = 2^(-age / halfLife)
  // This means weight halves every halfLifeDays
  const weight = Math.pow(2, -ageDays / config.halfLifeDays);
  
  // Apply minimum threshold
  return Math.max(weight, config.minWeightThreshold);
}

/**
 * Calculate weighted average price from historical sales
 */
export function calculateWeightedAverage(
  sales: HistoricalSale[],
  referenceDate: Date = new Date(),
  config: RecencyWeightConfig = DEFAULT_RECENCY_CONFIG
): { weightedAvg: number; totalWeight: number; validSales: number } {
  if (sales.length === 0) {
    return { weightedAvg: 0, totalWeight: 0, validSales: 0 };
  }

  let weightedSum = 0;
  let totalWeight = 0;
  let validSales = 0;

  for (const sale of sales) {
    if (sale.unitPrice <= 0) continue;

    const weight = calculateRecencyWeight(sale.saleDate, referenceDate, config);
    
    if (weight > 0) {
      weightedSum += sale.unitPrice * weight;
      totalWeight += weight;
      validSales++;
    }
  }

  if (totalWeight === 0) {
    return { weightedAvg: 0, totalWeight: 0, validSales: 0 };
  }

  return {
    weightedAvg: Math.round(weightedSum / totalWeight),
    totalWeight,
    validSales,
  };
}

/**
 * Calculate weighted statistics for a category
 */
export function calculateWeightedStats(
  sales: HistoricalSale[],
  config: RecencyWeightConfig = DEFAULT_RECENCY_CONFIG
): {
  weightedAvg: number;
  weightedMedian: number;
  weightedStdDev: number;
  totalWeight: number;
  validSales: number;
  priceRange: { min: number; max: number };
} {
  if (sales.length === 0) {
    return {
      weightedAvg: 0,
      weightedMedian: 0,
      weightedStdDev: 0,
      totalWeight: 0,
      validSales: 0,
      priceRange: { min: 0, max: 0 },
    };
  }

  // Calculate weights for all sales
  const salesWithWeights = sales
    .filter(s => s.unitPrice > 0)
    .map(sale => ({
      ...sale,
      weight: calculateRecencyWeight(sale.saleDate, new Date(), config),
    }))
    .filter(s => s.weight > 0)
    .sort((a, b) => a.unitPrice - b.unitPrice);

  if (salesWithWeights.length === 0) {
    return {
      weightedAvg: 0,
      weightedMedian: 0,
      weightedStdDev: 0,
      totalWeight: 0,
      validSales: 0,
      priceRange: { min: 0, max: 0 },
    };
  }

  // Calculate weighted average
  let weightedSum = 0;
  let totalWeight = 0;
  for (const sale of salesWithWeights) {
    weightedSum += sale.unitPrice * sale.weight;
    totalWeight += sale.weight;
  }
  const weightedAvg = Math.round(weightedSum / totalWeight);

  // Calculate weighted median
  // Find the price where cumulative weight reaches 50%
  let cumWeight = 0;
  const medianWeight = totalWeight * 0.5;
  let weightedMedian = 0;
  
  for (const sale of salesWithWeights) {
    cumWeight += sale.weight * sale.unitPrice;
    if (cumWeight >= medianWeight) {
      weightedMedian = sale.unitPrice;
      break;
    }
  }

  // Calculate weighted standard deviation
  let weightedSquareSum = 0;
  for (const sale of salesWithWeights) {
    const diff = sale.unitPrice - weightedAvg;
    weightedSquareSum += diff * diff * sale.weight;
  }
  const weightedStdDev = Math.round(Math.sqrt(weightedSquareSum / totalWeight));

  // Calculate price range
  const prices = salesWithWeights.map(s => s.unitPrice);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);

  return {
    weightedAvg,
    weightedMedian,
    weightedStdDev,
    totalWeight,
    validSales: salesWithWeights.length,
    priceRange: { min: minPrice, max: maxPrice },
  };
}

/**
 * Calculate recency confidence based on data freshness
 */
export function calculateRecencyConfidence(
  sales: HistoricalSale[],
  config: RecencyWeightConfig = DEFAULT_RECENCY_CONFIG
): number {
  if (sales.length === 0) {
    return 0;
  }

  // Calculate average recency weight
  let totalWeight = 0;
  let weightedCount = 0;

  for (const sale of sales) {
    const weight = calculateRecencyWeight(sale.saleDate, new Date(), config);
    if (weight > 0) {
      totalWeight += weight;
      weightedCount++;
    }
  }

  if (weightedCount === 0) {
    return 0;
  }

  // Normalize to 0-1 scale
  // Higher average weight = more recent data = higher confidence
  return Math.min(totalWeight / weightedCount, 1.0);
}

/**
 * Recency Weight Engine class for more complex operations
 */
export class RecencyWeightEngine {
  private config: RecencyWeightConfig;

  constructor(config: RecencyWeightConfig = DEFAULT_RECENCY_CONFIG) {
    this.config = config;
  }

  /**
   * Calculate weight for a given sale date
   */
  calculateWeight(saleDate: string): number {
    return calculateRecencyWeight(saleDate, new Date(), this.config);
  }

  /**
   * Apply weights to sales and return weighted data
   */
  applyWeights(sales: HistoricalSale[]): Array<HistoricalSale & { recencyWeight: number }> {
    return sales
      .filter(s => s.unitPrice > 0)
      .map(sale => ({
        ...sale,
        recencyWeight: this.calculateWeight(sale.saleDate),
      }))
      .filter(s => s.recencyWeight > this.config.minWeightThreshold);
  }

  /**
   * Calculate weighted statistics
   */
  calculateStats(
    sales: HistoricalSale[]
  ): ReturnType<typeof calculateWeightedStats> {
    return calculateWeightedStats(sales, this.config);
  }

  /**
   * Get confidence score for the data
   */
  getConfidence(sales: HistoricalSale[]): number {
    return calculateRecencyConfidence(sales, this.config);
  }

  /**
   * Find sales within a specific weight range
   */
  filterByWeight(
    sales: HistoricalSale[],
    minWeight: number = 0.1,
    maxWeight: number = 1.0
  ): Array<HistoricalSale & { recencyWeight: number }> {
    return this.applyWeights(sales).filter(
      s => s.recencyWeight >= minWeight && s.recencyWeight <= maxWeight
    );
  }

  /**
   * Get decay curve data for visualization
   */
  getDecayCurve(days: number = 365): Array<{ daysAgo: number; weight: number }> {
    const points: Array<{ daysAgo: number; weight: number }> = [];
    
    for (let days = 0; days <= days; days += 7) {
      // Simulate a sale 'days' days ago
      const saleDate = new Date();
      saleDate.setDate(saleDate.getDate() - days);
      
      const weight = calculateRecencyWeight(
        saleDate.toISOString(),
        new Date(),
        this.config
      );
      
      points.push({ daysAgo: days, weight });
    }
    
    return points;
  }

  /**
   * Calculate effective sample size (accounting for weight decay)
   */
  calculateEffectiveSampleSize(sales: HistoricalSale[]): number {
    const weighted = this.applyWeights(sales);
    
    if (weighted.length === 0) return 0;
    
    // Effective sample size = sum of weights^2 / sum of weights
    // This gives more weight to concentrated recent data
    let weightSum = 0;
    let weightSquaredSum = 0;
    
    for (const sale of weighted) {
      weightSum += sale.recencyWeight;
      weightSquaredSum += sale.recencyWeight * sale.recencyWeight;
    }
    
    return weightSquaredSum / weightSum;
  }
}
