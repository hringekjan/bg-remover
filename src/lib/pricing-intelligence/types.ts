/**
 * Pricing Intelligence Types
 * 
 * Core type definitions for the pricing intelligence system.
 */

/**
 * Confidence level for pricing suggestions
 */
export type ConfidenceLevel = 'low' | 'medium' | 'high';

/**
 * Pricing suggestion output
 */
export interface PricingSuggestion {
  /** Suggested price in ISK */
  suggestedPrice: number;
  
  /** Minimum price in range */
  minPrice: number;
  
  /** Maximum price in range */
  maxPrice: number;
  
  /** Confidence level of the suggestion */
  confidence: ConfidenceLevel;
  
  /** Confidence score (0-1) */
  confidenceScore: number;
  
  /** Contributing factors for the suggestion */
  factors: PricingFactors;
  
  /** Data sources used for the suggestion */
  sources: PricingSource[];
  
  /** Explanation of how the suggestion was calculated */
  explanation: string;
  
  /** Timestamp of when suggestion was generated */
  generatedAt: string;
}

/**
 * Factors that influenced the pricing suggestion
 */
export interface PricingFactors {
  /** Category baseline contribution */
  categoryBaseline: number;
  
  /** Recency-weighted average from historical sales */
  recencyWeightedAvg: number;
  
  /** AI prediction contribution (if available) */
  aiPrediction?: number;
  
  /** Brand premium/discount applied */
  brandAdjustment: number;
  
  /** Condition premium/discount applied */
  conditionAdjustment: number;
  
  /** Seasonal adjustment multiplier */
  seasonalMultiplier: number;
  
  /** Market demand factor */
  marketDemand: 'low' | 'medium' | 'high';
  
  /** Sample size used for calculation */
  sampleSize: number;
}

/**
 * Data source used for pricing calculation
 */
export type PricingSource = 
  | 'historical_sales' 
  | 'recency_weighted'
  | 'category_baseline'
  | 'ai_prediction'
  | 'brand_database'
  | 'seasonal_pattern'
  | 'fallback_default';

/**
 * Historical sale record
 */
export interface HistoricalSale {
  /** Unique sale identifier */
  saleId: string;
  
  /** Product name from external system */
  productName: string;
  
  /** Product category */
  category?: string;
  
  /** Sale price in ISK */
  unitPrice: number;
  
  /** Quantity sold */
  quantity: number;
  
  /** Date of sale */
  saleDate: string;
  
  /** Vendor identifier */
  vendorId?: string;
  
  /** Booth number */
  boothNumber?: number;
  
  /** Tags or labels */
  tags?: string[];
}

/**
 * Category baseline statistics
 */
export interface CategoryBaseline {
  /** Category identifier */
  category: string;
  
  /** Average price in ISK */
  avgPrice: number;
  
  /** Median price in ISK */
  medianPrice: number;
  
  /** Minimum price observed */
  minPrice: number;
  
  /** Maximum price observed */
  maxPrice: number;
  
  /** Standard deviation */
  stdDev: number;
  
  /** Number of sales in sample */
  sampleSize: number;
  
  /** Price distribution (price range buckets) */
  priceDistribution: Record<string, number>;
  
  /** Last updated timestamp */
  updatedAt: string;
}

/**
 * Product name analysis result
 */
export interface ProductNameAnalysis {
  /** Extracted brand name */
  brand?: string;
  
  /** Detected condition */
  condition?: 'new_with_tags' | 'like_new' | 'very_good' | 'good' | 'fair';
  
  /** Size if detected */
  size?: string;
  
  /** Color if detected */
  color?: string;
  
  /** Product type/description */
  productType?: string;
  
  /** Gender/audience */
  gender?: 'male' | 'female' | 'unisex' | 'kids';
  
  /** All extracted keywords */
  keywords: string[];
  
  /** Confidence of extraction */
  extractionConfidence: number;
}

/**
 * Recency weight configuration
 */
export interface RecencyWeightConfig {
  /** Half-life in days for exponential decay */
  halfLifeDays: number;
  
  /** Maximum age in days to consider */
  maxAgeDays: number;
  
  /** Minimum weight threshold */
  minWeightThreshold: number;
}

/**
 * AI pricing configuration
 */
export interface AIPricingConfig {
  /** Whether AI pricing is enabled */
  enabled: boolean;
  
  /** Weight for AI prediction in hybrid calculation (0-1) */
  aiWeight: number;
  
  /** Weight for statistical prediction in hybrid calculation (0-1) */
  statisticalWeight: number;
  
  /** Confidence threshold for AI fallback */
  confidenceThreshold: number;
}

/**
 * Pricing request input
 */
export interface PricingRequest {
  /** Product name/title */
  productName: string;
  
  /** Product category (optional) */
  category?: string;
  
  /** Brand name (optional) */
  brand?: string;
  
  /** Product condition (optional) */
  condition?: string;
  
  /** Tags or keywords */
  tags?: string[];
  
  /** Image URL for AI analysis (optional) */
  imageUrl?: string;
  
  /** Current market conditions */
  marketContext?: {
    isPeakSeason?: boolean;
    demandLevel?: 'low' | 'medium' | 'high';
  };
}

/**
 * Seasonal pattern data
 */
export interface SeasonalPattern {
  /** Category or product type */
  category: string;
  
  /** Month (1-12) */
  month: number;
  
  /** Price multiplier for this month */
  multiplier: number;
  
  /** Confidence score (0-1) */
  confidence: number;
  
  /** Sample size used */
  sampleSize: number;
}

/**
 * Brand pricing data
 */
export interface BrandPricing {
  /** Brand name (lowercase) */
  brand: string;
  
  /** Average price for this brand */
  avgPrice: number;
  
  /** Premium multiplier relative to category */
  premiumMultiplier: number;
  
  /** Sample size */
  sampleSize: number;
}
