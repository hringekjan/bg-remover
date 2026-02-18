/**
 * Category Baseline Analyzer
 * 
 * Calculates and manages pricing baselines from historical sales data
 * grouped by product category.
 */

import type { HistoricalSale, CategoryBaseline } from './types';

const TABLE_NAME = process.env.DYNAMODB_TABLE || `carousel-main-${process.env.STAGE || 'dev'}`;

/**
 * Analyze historical sales to calculate category baselines
 */
export class CategoryBaselineAnalyzer {
  /**
   * Calculate baseline statistics for a category from historical sales
   */
  static calculateBaseline(
    sales: HistoricalSale[],
    category: string
  ): CategoryBaseline {
    if (sales.length === 0) {
      return this.getEmptyBaseline(category);
    }

    // Filter to only include sales with prices
    const validSales = sales.filter(s => s.unitPrice > 0);
    
    if (validSales.length === 0) {
      return this.getEmptyBaseline(category);
    }

    // Extract prices
    const prices = validSales.map(s => s.unitPrice);
    
    // Calculate statistics
    const avgPrice = this.calculateAverage(prices);
    const medianPrice = this.calculateMedian(prices);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const stdDev = this.calculateStdDev(prices, avgPrice);
    
    // Calculate price distribution (buckets)
    const priceDistribution = this.calculatePriceDistribution(prices);
    
    return {
      category,
      avgPrice,
      medianPrice,
      minPrice,
      maxPrice,
      stdDev,
      sampleSize: validSales.length,
      priceDistribution,
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Calculate average price
   */
  private static calculateAverage(prices: number[]): number {
    if (prices.length === 0) return 0;
    const sum = prices.reduce((acc, p) => acc + p, 0);
    return Math.round(sum / prices.length);
  }

  /**
   * Calculate median price
   */
  private static calculateMedian(prices: number[]): number {
    if (prices.length === 0) return 0;
    
    const sorted = [...prices].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    
    if (sorted.length % 2 === 0) {
      return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
    }
    return sorted[mid];
  }

  /**
   * Calculate standard deviation
   */
  private static calculateStdDev(prices: number[], avg: number): number {
    if (prices.length === 0) return 0;
    
    const squareDiffs = prices.map(p => Math.pow(p - avg, 2));
    const avgSquareDiff = squareDiffs.reduce((acc, d) => acc + d, 0) / prices.length;
    return Math.round(Math.sqrt(avgSquareDiff));
  }

  /**
   * Calculate price distribution in buckets
   */
  private static calculatePriceDistribution(prices: number[]): Record<string, number> {
    const buckets: Record<string, number> = {
      '0-1000': 0,
      '1000-2500': 0,
      '2500-5000': 0,
      '5000-7500': 0,
      '7500-10000': 0,
      '10000-15000': 0,
      '15000-20000': 0,
      '20000-30000': 0,
      '30000+': 0,
    };

    for (const price of prices) {
      if (price < 1000) buckets['0-1000']++;
      else if (price < 2500) buckets['1000-2500']++;
      else if (price < 5000) buckets['2500-5000']++;
      else if (price < 7500) buckets['5000-7500']++;
      else if (price < 10000) buckets['7500-10000']++;
      else if (price < 15000) buckets['10000-15000']++;
      else if (price < 20000) buckets['15000-20000']++;
      else if (price < 30000) buckets['20000-30000']++;
      else buckets['30000+']++;
    }

    return buckets;
  }

  /**
   * Get empty baseline for unknown categories
   */
  private static getEmptyBaseline(category: string): CategoryBaseline {
    return {
      category,
      avgPrice: 0,
      medianPrice: 0,
      minPrice: 0,
      maxPrice: 0,
      stdDev: 0,
      sampleSize: 0,
      priceDistribution: {},
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Parse category from product name using keyword matching
   */
  static parseCategoryFromName(productName: string): string {
    const name = productName.toLowerCase();
    
    // Clothing categories
    if (name.match(/\b(buksur|pants|gallabuxur|jakki|jacket|coat|káp|vesti|vest|sweater|sweatshirt|bolur|shirt|dress|kjóll|skirt|skirta|róba|blúsa|blouse|nd|ndin|m\.|f\.|dress|suit)\b/)) {
      if (name.match(/\b(dress|kjóll|róba)\b/)) return 'dresses';
      if (name.match(/\b(jakki|káp|coat)\b/)) return 'outerwear';
      if (name.match(/\b(buksur|pants|gallabuxur)\b/)) return 'pants';
      if (name.match(/\b(vesti|vest|sweater|sweatshirt|bolur)\b/)) return 'tops';
      return 'clothing';
    }
    
    // Accessories
    if (name.match(/\b(taska|bag|veski|wallet|pung|belts|belt|húfa|hat|cap|gleraugu|glasses|skartgripir|jewelry|hlaupahringur|ring|necklace|hálkur|chain|armband|bracelet)\b/)) {
      return 'accessories';
    }
    
    // Shoes
    if (name.match(/\b(skor|shoes|skór|boots|støvlu|sneakers|sport|heels|hækla鞋|sandal)\b/)) {
      return 'shoes';
    }
    
    // Home goods
    if (name.match(/\b(teppi|rug|möttull|blanket|púði|pillow|lampa|lamp|sæta|chair|borð|table|hilla|shelf|bók|book)\b/)) {
      return 'home';
    }
    
    // Electronics
    if (name.match(/\b(sími|phone|tölva|computer|computer|veski|laptop|hljóð|headphones|veitir|router|skjár|screen)\b/)) {
      return 'electronics';
    }
    
    // Default
    return 'general';
  }

  /**
   * Find similar products by category keyword matching
   */
  static findSimilarByCategory(
    sales: HistoricalSale[],
    targetCategory: string
  ): HistoricalSale[] {
    const targetLower = targetCategory.toLowerCase();
    
    return sales.filter(sale => {
      const saleCategory = sale.category?.toLowerCase() || '';
      const productName = sale.productName.toLowerCase();
      
      // Exact match
      if (saleCategory === targetLower) return true;
      
      // Category keyword in product name
      if (this.categoryKeywordsMatch(targetLower, productName)) return true;
      
      return false;
    });
  }

  /**
   * Check if product name matches category keywords
   */
  static categoryKeywordsMatch(
    category: string,
    productName: string
  ): boolean {
    const categoryKeywords: Record<string, string[]> = {
      clothing: ['buksur', 'pants', 'jakki', 'jacket', 'káp', 'vesti', 'vest', 'bolur', 'shirt', 'dress', 'kjóll', 'skirt', 'blúsa', 'blouse'],
      outerwear: ['jakki', 'káp', 'coat', 'coat', 'winter'],
      pants: ['buksur', 'pants', 'gallabuxur', 'trousers'],
      dresses: ['dress', 'kjóll', 'róba'],
      tops: ['vesti', 'vest', 'sweater', 'sweatshirt', 'bolur', 'shirt', 'blúsa', 'blouse'],
      accessories: ['taska', 'bag', 'veski', 'wallet', 'pung', 'belt', 'húfa', 'hat', 'cap', 'gleraugu', 'skartgripir', 'hlaupahringur', 'necklace', 'chain'],
      shoes: ['skor', 'shoes', 'skór', 'boots', 'støvlu', 'sneakers', 'sandal', 'heels'],
      home: ['teppi', 'möttull', 'púði', 'lampa', 'sæta', 'borð', 'hilla', 'bók'],
      electronics: ['sími', 'phone', 'tölva', 'computer', 'veski', 'hljóð', 'veitir', 'skjár'],
    };

    const keywords = categoryKeywords[category] || [];
    return keywords.some(keyword => productName.includes(keyword));
  }

  /**
   * Calculate price percentile
   */
  static calculatePercentile(
    baseline: CategoryBaseline,
    percentile: number
  ): number {
    if (baseline.sampleSize === 0) return 0;
    
    // Use median for 50th percentile
    if (percentile === 50) return baseline.medianPrice;
    
    // Approximate other percentiles using normal distribution assumption
    const zScore = this.percentileToZScore(percentile);
    const price = baseline.avgPrice + (zScore * baseline.stdDev);
    
    return Math.max(baseline.minPrice, Math.min(baseline.maxPrice, Math.round(price)));
  }

  /**
   * Convert percentile to z-score
   */
  private static percentileToZScore(percentile: number): number {
    // Approximation of inverse normal CDF
    const p = percentile / 100;
    
    if (p < 0.5) return -this.percentileToZScore((1 - p) * 100);
    
    const a1 = -39.6968302866538;
    const a2 = 220.946098424521;
    const a3 = -275.928510446969;
    const a4 = 138.357751867269;
    const a5 = -30.6647980661472;
    const a6 = 2.50662827745924;
    
    const b1 = -54.4760987982241;
    const b2 = 161.585836858041;
    const b3 = -155.698979859887;
    const b4 = 66.8013118877197;
    const b5 = -13.2806815528857;
    
    const c1 = -0.00778489400243029;
    const c2 = -0.322396458041136;
    const c3 = -2.40075827716184;
    const c4 = -2.54973253934373;
    const c5 = 4.37466414146497;
    const c6 = 2.93816398269878;
    
    const d1 = 0.00778469570904146;
    const d2 = 0.322467129070039;
    const d3 = 2.445134137143;
    const d4 = 3.75440866190742;
    
    const pLow = 0.02425;
    const pHigh = 1 - pLow;
    
    let q: number;
    let r: number;
    
    if (p < pLow) {
      q = Math.sqrt(-2 * Math.log(p));
      return (((((c1 * q + c2) * q + c3) * q + c4) * q + c5) * q + c6) /
             ((((d1 * q + d2) * q + d3) * q + d4) * q + 1);
    }
    
    if (p <= pHigh) {
      q = p - 0.5;
      r = q * q;
      return (((((a1 * r + a2) * r + a3) * r + a4) * r + a5) * r + a6) * q /
             (((((b1 * r + b2) * r + b3) * r + b4) * r + b5) * r + 1);
    }
    
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c1 * q + c2) * q + c3) * q + c4) * q + c5) * q + c6) /
            ((((d1 * q + d2) * q + d3) * q + d4) * q + 1);
  }
}
