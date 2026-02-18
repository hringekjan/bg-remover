// src/lib/suggestion-engine.ts
import type { ProductCondition, PriceSuggestion, RatingSuggestion, LanguageCode } from './types';

/**
 * AI-Powered Suggestion Engine for Price and Rating Analysis
 * Provides intelligent pricing and quality assessment for products
 */

interface MarketData {
  category: string;
  condition: ProductCondition;
  averagePrice: number;
  priceRange: { min: number; max: number };
  marketDemand: 'low' | 'medium' | 'high';
  seasonality?: string;
  rarity?: 'common' | 'uncommon' | 'rare' | 'vintage';
}

interface ProductFeatures {
  category: string;
  brand?: string;
  material?: string;
  craftsmanship?: string;
  age?: string;
  condition: ProductCondition;
  colors?: string[];
  size?: string;
  occasion?: string;
}

/**
 * Suggestion Engine for price and rating analysis
 */
export class SuggestionEngine {
  private static instance: SuggestionEngine;
  private marketDataCache = new Map<string, MarketData>();

  private constructor() {
    this.initializeMarketData();
  }

  public static getInstance(): SuggestionEngine {
    if (!SuggestionEngine.instance) {
      SuggestionEngine.instance = new SuggestionEngine();
    }
    return SuggestionEngine.instance;
  }

  /**
   * Generate price suggestion for a product
   */
  public generatePriceSuggestion(
    productFeatures: ProductFeatures,
    language: LanguageCode = 'en'
  ): PriceSuggestion {
    const safeCondition = productFeatures.condition || 'good';
    const marketData = this.getMarketData(productFeatures.category, safeCondition);

    // Base price calculation
    let basePrice = marketData.averagePrice;
    const factors: PriceSuggestion['factors'] = {
      condition: safeCondition,
      brand: productFeatures.brand,
      category: productFeatures.category,
      marketDemand: marketData.marketDemand,
      seasonality: marketData.seasonality,
      rarity: marketData.rarity,
    };

    // Adjust for condition
    const conditionMultipliers: Record<ProductCondition, number> = {
      'new_with_tags': 1.0,
      'like_new': 0.85,
      'very_good': 0.70,
      'good': 0.55,
      'fair': 0.40,
    };
    basePrice *= conditionMultipliers[safeCondition];

    // Adjust for brand premium
    if (productFeatures.brand) {
      const brandPremium = this.calculateBrandPremium(productFeatures.brand);
      basePrice *= brandPremium;
      factors.brand = productFeatures.brand;
    }

    // Adjust for material quality
    if (productFeatures.material) {
      const materialMultiplier = this.calculateMaterialPremium(productFeatures.material);
      basePrice *= materialMultiplier;
    }

    // Adjust for craftsmanship
    if (productFeatures.craftsmanship) {
      const craftsmanshipMultiplier = this.calculateCraftsmanshipPremium(productFeatures.craftsmanship);
      basePrice *= craftsmanshipMultiplier;
    }

    // Adjust for rarity
    if (marketData.rarity) {
      const rarityMultiplier = this.calculateRarityPremium(marketData.rarity);
      basePrice *= rarityMultiplier;
    }

    // Calculate confidence based on available data
    const confidence = this.calculatePriceConfidence(productFeatures, marketData);

    // Create price range (±20% of suggested price)
    const priceRange = {
      min: Math.max(0, basePrice * 0.8),
      max: basePrice * 1.2,
    };

    const suggestedPrice = Math.round(basePrice * 100) / 100; // Round to 2 decimal places

    return {
      suggestedPrice,
      currency: this.getCurrencyForLanguage(language),
      confidence,
      priceRange,
      factors,
    };
  }

  /**
   * Generate rating suggestion for a product
   */
  public generateRatingSuggestion(
    productFeatures: ProductFeatures,
    language: LanguageCode = 'en'
  ): RatingSuggestion {
    // Calculate individual ratings
    const quality = this.calculateQualityRating(productFeatures);
    const condition = this.calculateConditionRating(productFeatures.condition || 'good');
    const value = this.calculateValueRating(productFeatures);
    const authenticity = this.calculateAuthenticityRating(productFeatures);

    // Calculate overall rating (weighted average)
    const overallRating = Math.round(
      (quality * 0.3 + condition * 0.3 + value * 0.2 + authenticity * 0.2) * 10
    ) / 10;

    // Calculate confidence
    const confidence = this.calculateRatingConfidence(productFeatures);

    // Generate description
    const description = this.generateRatingDescription(overallRating, language);

    const factors: RatingSuggestion['factors'] = {
      materialQuality: this.getMaterialQualityLevel(productFeatures.material),
      craftsmanship: this.getCraftsmanshipLevel(productFeatures.craftsmanship),
      authenticity: this.getAuthenticityLevel(productFeatures),
      marketValue: this.getMarketValueLevel(productFeatures),
    };

    return {
      overallRating,
      confidence,
      breakdown: {
        quality,
        condition,
        value,
        authenticity,
        description,
      },
      factors,
    };
  }

  /**
   * Get both price and rating suggestions
   */
  public generateSuggestions(
    productFeatures: ProductFeatures,
    language: LanguageCode = 'en'
  ): { price: PriceSuggestion; rating: RatingSuggestion } {
    return {
      price: this.generatePriceSuggestion(productFeatures, language),
      rating: this.generateRatingSuggestion(productFeatures, language),
    };
  }

  // Private helper methods

  private initializeMarketData(): void {
    // Initialize with common product categories and market data
    const categories = [
      'clothing', 'electronics', 'furniture', 'books', 'art', 'jewelry',
      'collectibles', 'vintage', 'handmade', 'sports', 'automotive', 'home'
    ];

    const conditions: ProductCondition[] = ['new_with_tags', 'like_new', 'very_good', 'good', 'fair'];

    categories.forEach(category => {
      conditions.forEach(condition => {
        const marketData = this.generateMarketData(category, condition);
        const key = `${category}_${condition}`;
        this.marketDataCache.set(key, marketData);
      });
    });
  }

  private generateMarketData(category: string, condition: ProductCondition): MarketData {
    // Base prices by category (in USD)
    const categoryBasePrices: Record<string, number> = {
      clothing: 25,
      electronics: 150,
      furniture: 200,
      books: 15,
      art: 500,
      jewelry: 100,
      collectibles: 75,
      vintage: 80,
      handmade: 50,
      sports: 60,
      automotive: 300,
      home: 80,
    };

    const basePrice = categoryBasePrices[category] || 50;
    const conditionMultiplier = this.getConditionMultiplier(condition);
    
    return {
      category,
      condition,
      averagePrice: basePrice * conditionMultiplier,
      priceRange: {
        min: basePrice * conditionMultiplier * 0.7,
        max: basePrice * conditionMultiplier * 1.3,
      },
      marketDemand: this.getMarketDemand(category, condition),
      seasonality: this.getSeasonality(category),
      rarity: this.getRarityLevel(category),
    };
  }

  private getMarketData(category: string, condition: ProductCondition): MarketData {
    const key = `${category}_${condition}`;
    return this.marketDataCache.get(key) || this.generateMarketData(category, condition);
  }

  private getConditionMultiplier(condition: ProductCondition): number {
    const multipliers: Record<ProductCondition, number> = {
      'new_with_tags': 1.0,
      'like_new': 0.85,
      'very_good': 0.70,
      'good': 0.55,
      'fair': 0.40,
    };
    return multipliers[condition];
  }

  private calculateBrandPremium(brand: string): number {
    // Premium brands get higher multipliers
    const premiumBrands = ['louis vuitton', 'gucci', 'prada', 'chanel', 'hermès'];
    const luxuryBrands = ['armani', 'versace', 'dior', 'balenciaga'];
    const designerBrands = ['zara', 'h&m', 'uniqlo', 'mango'];
    
    const brandLower = brand.toLowerCase();
    
    if (premiumBrands.some(b => brandLower.includes(b))) return 3.0;
    if (luxuryBrands.some(b => brandLower.includes(b))) return 2.5;
    if (designerBrands.some(b => brandLower.includes(b))) return 1.5;
    
    return 1.0; // No premium for unknown brands
  }

  private calculateMaterialPremium(material: string): number {
    const materialPremiums: Record<string, number> = {
      'leather': 1.5,
      'silk': 1.4,
      'cashmere': 1.6,
      'wool': 1.2,
      'cotton': 1.0,
      'polyester': 0.8,
      'gold': 2.0,
      'silver': 1.3,
      'platinum': 2.5,
      'diamonds': 3.0,
      'pearls': 2.2,
      'wood': 1.1,
      'metal': 1.0,
      'glass': 0.9,
      'ceramic': 1.0,
    };

    const materialLower = material.toLowerCase();
    return materialPremiums[materialLower] || 1.0;
  }

  private calculateCraftsmanshipPremium(craftsmanship: string): number {
    const craftsmanshipLevels: Record<string, number> = {
      'handmade': 1.8,
      'artisan': 1.6,
      'handcrafted': 1.5,
      'custom': 1.7,
      'bespoke': 1.9,
      'mass-produced': 0.8,
      'machine-made': 0.7,
      'factory': 0.6,
    };

    const craftsmanshipLower = craftsmanship.toLowerCase();
    return craftsmanshipLevels[craftsmanshipLower] || 1.0;
  }

  private calculateRarityPremium(rarity: string): number {
    const rarityMultipliers: Record<string, number> = {
      'vintage': 1.8,
      'rare': 2.2,
      'uncommon': 1.4,
      'common': 1.0,
    };

    return rarityMultipliers[rarity] || 1.0;
  }

  private calculatePriceConfidence(features: ProductFeatures, marketData: MarketData): number {
    let confidence = 0.5; // Base confidence

    if (features.brand) confidence += 0.2;
    if (features.material) confidence += 0.1;
    if (features.craftsmanship) confidence += 0.1;
    if (features.age) confidence += 0.1;

    return Math.min(1.0, confidence);
  }

  private calculateQualityRating(features: ProductFeatures): number {
    let quality = 3.0; // Base quality

    // Material quality
    if (features.material) {
      const materialRating = this.getMaterialQualityRating(features.material);
      quality += materialRating - 3.0;
    }

    // Craftsmanship
    if (features.craftsmanship) {
      const craftsmanshipRating = this.getCraftsmanshipRating(features.craftsmanship);
      quality += craftsmanshipRating - 3.0;
    }

    // Condition
    quality += this.getConditionQualityBoost(features.condition);

    return Math.max(1.0, Math.min(5.0, Math.round(quality * 10) / 10));
  }

  private calculateConditionRating(condition: ProductCondition): number {
    const conditionRatings: Record<ProductCondition, number> = {
      'new_with_tags': 5.0,
      'like_new': 4.5,
      'very_good': 4.0,
      'good': 3.0,
      'fair': 2.0,
    };

    return conditionRatings[condition];
  }

  private calculateValueRating(features: ProductFeatures): number {
    // Value is about price vs quality ratio
    const quality = this.calculateQualityRating(features);
    const condition = this.calculateConditionRating(features.condition);
    
    // Higher quality and condition = better value
    return Math.round(((quality + condition) / 2) * 10) / 10;
  }

  private calculateAuthenticityRating(features: ProductFeatures): number {
    let authenticity = 3.5; // Base authenticity

    if (features.brand) {
      const brandAuthenticity = this.getBrandAuthenticity(features.brand);
      authenticity += brandAuthenticity - 3.0;
    }

    return Math.max(1.0, Math.min(5.0, Math.round(authenticity * 10) / 10));
  }

  private calculateRatingConfidence(features: ProductFeatures): number {
    let confidence = 0.4; // Base confidence

    if (features.brand) confidence += 0.2;
    if (features.material) confidence += 0.15;
    if (features.craftsmanship) confidence += 0.15;
    if (features.age) confidence += 0.1;

    return Math.min(1.0, confidence);
  }

  private generateRatingDescription(rating: number, language: LanguageCode): string {
    const descriptions = {
      en: {
        5: 'Exceptional quality with outstanding craftsmanship and materials.',
        4.5: 'Excellent quality with superior craftsmanship and premium materials.',
        4: 'Very good quality with solid craftsmanship and reliable materials.',
        3.5: 'Good quality with decent craftsmanship and standard materials.',
        3: 'Average quality with basic craftsmanship and common materials.',
        2.5: 'Below average quality with limited craftsmanship.',
        2: 'Poor quality with minimal craftsmanship and basic materials.',
        1.5: 'Very poor quality with substandard materials.',
        1: 'Extremely poor quality with unacceptable materials and craftsmanship.',
      },
      is: {
        5: 'Einstaklega góð gæði með framúrskarandi handverki og efni.',
        4.5: 'Frábær gæði með yfirlegu handverki og hágæða efni.',
        4: 'Mjög góð gæði með góðu handverki og áreiðanlegu efni.',
        3.5: 'Góð gæði með sanngjörnu handverki og venjulegu efni.',
        3: 'Meðalgæði með grunnhandverki og algengu efni.',
        2.5: 'Neðan meðal gæði með takmörkuðu handverki.',
        2: 'Lág gæði með lágmarks handverki og grunnefni.',
        1.5: 'Mjög lág gæði með lélegu efni.',
        1: 'Óásættanleg gæði með óásættanlegu efni og handverki.',
      },
    };

    // Find closest rating description
    const langDescriptions = descriptions[language as keyof typeof descriptions] || descriptions.en;
    
    // Find exact match or closest
    if (langDescriptions[rating as keyof typeof langDescriptions]) {
      return langDescriptions[rating as keyof typeof langDescriptions];
    }

    // Find closest rating
    const ratings = Object.keys(langDescriptions).map(Number).sort((a, b) => Math.abs(a - rating) - Math.abs(b - rating));
    const closestRating = ratings[0];
    
    return langDescriptions[closestRating as keyof typeof langDescriptions];
  }

  private getCurrencyForLanguage(language: LanguageCode): string {
    const currencyMap: Record<LanguageCode, string> = {
      'en': 'USD',
      'is': 'ISK',
      'de': 'EUR',
      'fr': 'EUR',
      'es': 'EUR',
      'it': 'EUR',
      'nl': 'EUR',
      'pt': 'EUR',
      'sv': 'SEK',
      'da': 'DKK',
      'no': 'NOK',
      'fi': 'EUR',
      'pl': 'PLN',
      'ru': 'RUB',
      'ja': 'JPY',
      'ko': 'KRW',
      'zh': 'CNY',
    };

    return currencyMap[language] || 'USD';
  }

  private getMarketDemand(category: string, condition: ProductCondition): 'low' | 'medium' | 'high' {
    const highDemandCategories = ['electronics', 'collectibles', 'vintage'];
    const mediumDemandCategories = ['clothing', 'home', 'sports'];
    
    if (highDemandCategories.includes(category)) return 'high';
    if (mediumDemandCategories.includes(category)) return 'medium';
    return 'low';
  }

  private getSeasonality(category: string): string {
    const seasonalCategories: Record<string, string> = {
      'clothing': 'seasonal',
      'sports': 'seasonal',
      'electronics': 'stable',
      'art': 'stable',
      'jewelry': 'stable',
    };

    return seasonalCategories[category] || 'stable';
  }

  private getRarityLevel(category: string): 'common' | 'uncommon' | 'rare' | 'vintage' {
    const rarityMap: Record<string, 'common' | 'uncommon' | 'rare' | 'vintage'> = {
      'art': 'rare',
      'jewelry': 'uncommon',
      'collectibles': 'rare',
      'vintage': 'vintage',
      'handmade': 'uncommon',
      'books': 'common',
      'clothing': 'common',
      'electronics': 'common',
    };

    return rarityMap[category] || 'common';
  }

  private getMaterialQualityRating(material: string): number {
    const qualityRatings: Record<string, number> = {
      'gold': 5.0,
      'platinum': 5.0,
      'diamonds': 5.0,
      'pearls': 4.8,
      'cashmere': 4.5,
      'silk': 4.3,
      'leather': 4.0,
      'wool': 3.8,
      'cotton': 3.5,
      'silver': 4.0,
      'wood': 3.5,
      'metal': 3.0,
      'glass': 3.0,
      'ceramic': 3.2,
      'polyester': 2.5,
    };

    const materialLower = material.toLowerCase();
    return qualityRatings[materialLower] || 3.0;
  }

  private getCraftsmanshipRating(craftsmanship: string): number {
    const craftsmanshipRatings: Record<string, number> = {
      'handmade': 4.8,
      'artisan': 4.6,
      'handcrafted': 4.5,
      'custom': 4.7,
      'bespoke': 4.9,
      'mass-produced': 2.5,
      'machine-made': 2.0,
      'factory': 1.8,
    };

    const craftsmanshipLower = craftsmanship.toLowerCase();
    return craftsmanshipRatings[craftsmanshipLower] || 3.0;
  }

  private getConditionQualityBoost(condition: ProductCondition): number {
    const boosts: Record<ProductCondition, number> = {
      'new_with_tags': 1.0,
      'like_new': 0.8,
      'very_good': 0.5,
      'good': 0.0,
      'fair': -0.5,
    };

    return boosts[condition];
  }

  private getBrandAuthenticity(brand: string): number {
    // Known authentic brands get higher ratings
    const authenticBrands = ['louis vuitton', 'gucci', 'prada', 'chanel', 'hermès', 'armani'];
    const brandLower = brand.toLowerCase();
    
    if (authenticBrands.some(b => brandLower.includes(b))) return 4.5;
    return 3.5;
  }

  private getMaterialQualityLevel(material?: string): 'poor' | 'fair' | 'good' | 'excellent' {
    if (!material) return 'good';
    
    const qualityLevel = this.getMaterialQualityRating(material);
    if (qualityLevel >= 4.5) return 'excellent';
    if (qualityLevel >= 3.5) return 'good';
    if (qualityLevel >= 2.5) return 'fair';
    return 'poor';
  }

  private getCraftsmanshipLevel(craftsmanship?: string): 'poor' | 'fair' | 'good' | 'excellent' {
    if (!craftsmanship) return 'good';
    
    const craftsmanshipRating = this.getCraftsmanshipRating(craftsmanship);
    if (craftsmanshipRating >= 4.5) return 'excellent';
    if (craftsmanshipRating >= 3.5) return 'good';
    if (craftsmanshipRating >= 2.5) return 'fair';
    return 'poor';
  }

  private getAuthenticityLevel(features: ProductFeatures): 'questionable' | 'likely' | 'confirmed' {
    if (features.brand && this.getBrandAuthenticity(features.brand) > 4.0) {
      return 'confirmed';
    }
    if (features.craftsmanship && this.getCraftsmanshipRating(features.craftsmanship) > 4.0) {
      return 'likely';
    }
    return 'questionable';
  }

  private getMarketValueLevel(features: ProductFeatures): 'undervalued' | 'fair' | 'overpriced' {
    const quality = this.calculateQualityRating(features);
    const condition = this.calculateConditionRating(features.condition);
    const avg = (quality + condition) / 2;
    
    if (avg >= 4.5) return 'undervalued';
    if (avg <= 2.5) return 'overpriced';
    return 'fair';
  }
}

// Export singleton instance
export const suggestionEngine = SuggestionEngine.getInstance();