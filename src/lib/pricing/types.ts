/**
 * Type definitions for pricing module
 */

/**
 * Product condition states
 */
export type ProductCondition =
  | 'new_with_tags'
  | 'like_new'
  | 'very_good'
  | 'good'
  | 'fair'
  | 'poor';

/**
 * Overall quality assessment from vision analysis
 */
export type OverallAssessment = 'excellent' | 'good' | 'fair' | 'poor';

/**
 * Pricing impact direction
 */
export type PricingImpact = 'increase' | 'neutral' | 'decrease';

/**
 * Product context for analysis
 */
export interface ProductContext {
  category?: string;
  brand?: string;
  claimedCondition?: ProductCondition;
  description?: string;
}

/**
 * Product features with proper condition typing
 * Used for similarity analysis and pricing multiplier application
 */
export interface ProductFeatures {
  category?: string;
  brand?: string;
  material?: string;
  colors?: string[];
  size?: string;
  condition?: ProductCondition;  // Properly typed condition field
}

/**
 * Type guard to validate product condition values at runtime
 *
 * This function provides compile-time type safety for condition validation,
 * eliminating the need for unsafe type assertions (as ProductCondition).
 *
 * @param value - Value to validate
 * @returns true if value is a valid ProductCondition, false otherwise
 */
export function isValidProductCondition(value: string | undefined): value is ProductCondition {
  const validConditions: readonly ProductCondition[] = [
    'new_with_tags',
    'like_new',
    'very_good',
    'good',
    'fair',
    'poor',
  ];
  return value !== undefined && validConditions.includes(value as ProductCondition);
}

/**
 * Pricing suggestion response
 */
export interface PricingSuggestion {
  suggestedPrice: number;
  priceRange: {
    min: number;
    max: number;
  };
  confidence: number;
  currency: string;
  factors: {
    basePrice: number;
    seasonalMultiplier: number;
    conditionMultiplier: number;
    visualQualityMultiplier: number;
    visualQualityDetails: string;
    visualQualityAssessment?: {
      conditionScore: number;
      photoQualityScore: number;
      visibleDefects: string[];
      overallAssessment: OverallAssessment;
      pricingImpact: PricingImpact;
    };
    similarProducts?: Array<{
      productId: string;
      similarity: number;
      salePrice: number;
      saleDate: string;
      condition: ProductCondition;
    }>;
  };
  reasoning: string;
}
