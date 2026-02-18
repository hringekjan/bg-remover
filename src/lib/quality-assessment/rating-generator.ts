import type { RatingSuggestion } from '../types';
import type { MistralPixtralAnalysisResult } from '../bedrock/mistral-pixtral-analyzer';

/**
 * Rating Suggestion Generator
 * Combines AI vision analysis with quality hints to generate comprehensive product ratings
 *
 * Generates ratings across 4 dimensions:
 * - Quality (material + construction)
 * - Condition (wear level + defects)
 * - Value (quality vs price expectations)
 * - Authenticity (brand verification)
 */
export class RatingGenerator {

  /**
   * Generate comprehensive rating suggestion
   * @param mistralResult - AI extraction results with quality hints
   * @param visionScore - Optional vision analysis quality score (1-10 scale)
   * @param language - Language code for description ('en' | 'is')
   * @returns RatingSuggestion with breakdown and confidence
   */
  generateRating(
    mistralResult: MistralPixtralAnalysisResult,
    visionScore?: number,
    language: string = 'en'
  ): RatingSuggestion {

    // Calculate individual ratings (1-5 scale)
    const quality = this.calculateQualityRating(
      mistralResult.qualityHints?.materialQuality || 'fair',
      mistralResult.qualityHints?.constructionQuality || 'fair'
    );

    const condition = this.calculateConditionRating(
      mistralResult.condition,
      mistralResult.qualityHints?.wearPattern || 'light',
      visionScore
    );

    const value = this.calculateValueRating(quality, condition);

    const authenticity = this.calculateAuthenticityRating(
      mistralResult.qualityHints?.authenticity || 'likely',
      mistralResult.brand
    );

    // Weighted overall rating: quality 30%, condition 30%, value 20%, authenticity 20%
    const overallRating = Math.round(
      (quality * 0.3 + condition * 0.3 + value * 0.2 + authenticity * 0.2) * 10
    ) / 10;

    // Calculate confidence based on data availability
    const confidence = this.calculateConfidence(
      mistralResult.aiConfidence?.overall || 0.75,
      !!visionScore,
      mistralResult.qualityHints?.visibleDefects?.length || 0
    );

    // Generate human-readable description
    const description = this.generateDescription(overallRating, language);

    return {
      overallRating,
      confidence,
      breakdown: {
        quality,
        condition,
        value,
        authenticity,
        description
      },
      factors: {
        materialQuality: mistralResult.qualityHints?.materialQuality || 'fair',
        craftsmanship: mistralResult.qualityHints?.constructionQuality || 'fair',
        authenticity: mistralResult.qualityHints?.authenticity || 'likely',
        marketValue: this.assessMarketValue(quality, condition)
      }
    };
  }

  /**
   * Calculate quality rating from material and construction quality
   * @private
   */
  private calculateQualityRating(
    materialQuality: string,
    constructionQuality: string
  ): number {
    const qualityMap: Record<string, number> = {
      poor: 2.0,
      fair: 3.0,
      good: 4.0,
      excellent: 5.0
    };

    const materialScore = qualityMap[materialQuality] || 3.0;
    const constructionScore = qualityMap[constructionQuality] || 3.0;

    // Average material + construction, round to 1 decimal
    return Math.round(((materialScore + constructionScore) / 2) * 10) / 10;
  }

  /**
   * Calculate condition rating from AI condition assessment and wear pattern
   * Optionally blend with vision analysis score
   * @private
   */
  private calculateConditionRating(
    condition: string,
    wearPattern: string,
    visionScore?: number
  ): number {
    // Base condition scores
    const baseScores: Record<string, number> = {
      new_with_tags: 5.0,
      like_new: 4.5,
      very_good: 4.0,
      good: 3.0,
      fair: 2.0
    };

    let rating = baseScores[condition] || 3.0;

    // Adjust for wear pattern
    const wearAdjustment: Record<string, number> = {
      minimal: 0.2,
      light: 0.0,
      moderate: -0.3,
      heavy: -0.7
    };
    rating += wearAdjustment[wearPattern] || 0;

    // If we have vision score, blend it (50/50 weight with AI assessment)
    if (visionScore) {
      const visionRating = visionScore / 2; // Convert 1-10 scale to 0.5-5.0
      rating = (rating + visionRating) / 2;
    }

    // Clamp to 1.0-5.0 range, round to 1 decimal
    return Math.max(1.0, Math.min(5.0, Math.round(rating * 10) / 10));
  }

  /**
   * Calculate value rating as average of quality and condition
   * @private
   */
  private calculateValueRating(quality: number, condition: number): number {
    return Math.round(((quality + condition) / 2) * 10) / 10;
  }

  /**
   * Calculate authenticity rating based on AI assessment and brand presence
   * Premium brands get bonus if authenticity is confirmed
   * @private
   */
  private calculateAuthenticityRating(authenticity: string, brand?: string): number {
    const authenticityScores: Record<string, number> = {
      confirmed: 5.0,
      likely: 4.0,
      questionable: 2.5
    };

    let rating = authenticityScores[authenticity] || 3.5;

    // Premium brands get +0.5 boost if authenticity is "likely" or "confirmed"
    if (brand && authenticity !== 'questionable') {
      const premiumBrands = ['hermès', 'chanel', 'louis vuitton', 'gucci', 'prada', 'versace', 'dior', 'fendi'];
      if (premiumBrands.some(b => brand.toLowerCase().includes(b))) {
        rating = Math.min(5.0, rating + 0.5);
      }
    }

    return Math.round(rating * 10) / 10;
  }

  /**
   * Calculate confidence score based on data availability
   * More data sources = higher confidence
   * @private
   */
  private calculateConfidence(
    aiConfidence: number,
    hasVisionScore: boolean,
    defectCount: number
  ): number {
    let confidence = aiConfidence * 0.7; // Start with 70% of AI confidence

    if (hasVisionScore) confidence += 0.2; // +20% if we have vision analysis

    if (defectCount > 0) confidence += 0.1; // +10% if defects were detected (more data)

    // Clamp to 0.0-1.0 range, round to 2 decimals
    return Math.min(1.0, Math.round(confidence * 100) / 100);
  }

  /**
   * Assess market value based on quality and condition ratings
   * @private
   */
  private assessMarketValue(quality: number, condition: number): 'undervalued' | 'fair' | 'overpriced' {
    const avg = (quality + condition) / 2;

    if (avg >= 4.5) return 'undervalued'; // Excellent items are often undervalued in secondhand
    if (avg <= 2.5) return 'overpriced'; // Poor quality items may be overpriced
    return 'fair';
  }

  /**
   * Generate human-readable description based on overall rating
   * Supports English and Icelandic
   * @private
   */
  private generateDescription(rating: number, language: string): string {
    const descriptions: Record<string, Record<number, string>> = {
      en: {
        5.0: 'Exceptional quality with outstanding craftsmanship and materials.',
        4.5: 'Excellent quality with superior craftsmanship and premium materials.',
        4.0: 'Very good quality with solid craftsmanship and reliable materials.',
        3.5: 'Good quality with decent craftsmanship and standard materials.',
        3.0: 'Average quality with basic craftsmanship and common materials.',
        2.5: 'Below average quality with limited craftsmanship.',
        2.0: 'Poor quality with minimal craftsmanship and basic materials.',
        1.5: 'Very poor quality with significant issues.',
        1.0: 'Unacceptable quality with major defects.'
      },
      is: {
        5.0: 'Einstaklega góð gæði með framúrskarandi handverki og efni.',
        4.5: 'Frábær gæði með yfirlegu handverki og hágæða efni.',
        4.0: 'Mjög góð gæði með góðu handverki og áreiðanlegu efni.',
        3.5: 'Góð gæði með sanngjörnu handverki og venjulegu efni.',
        3.0: 'Meðalgæði með grunnhandverki og algengu efni.',
        2.5: 'Neðan meðal gæði með takmörkuðu handverki.',
        2.0: 'Lág gæði með lágmarks handverki og grunnefni.',
        1.5: 'Mjög lág gæði með verulegum vandamálum.',
        1.0: 'Óviðunandi gæði með miklum göllum.'
      }
    };

    const langDescriptions = descriptions[language as keyof typeof descriptions] || descriptions.en;

    // Find closest rating tier (round to nearest 0.5)
    const roundedRating = Math.round(rating * 2) / 2;
    const availableRatings = Object.keys(langDescriptions).map(Number);
    const closestRating = availableRatings.reduce((prev, curr) =>
      Math.abs(curr - roundedRating) < Math.abs(prev - roundedRating) ? curr : prev
    );

    return langDescriptions[closestRating];
  }
}

/**
 * Singleton instance for convenience
 */
export const ratingGenerator = new RatingGenerator();
