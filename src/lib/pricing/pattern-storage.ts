/**
 * Pattern Storage Service - mem0 Integration
 *
 * Stores detected seasonal patterns in mem0 for persistence and future reference.
 * Enables the system to learn and improve over time without manual configuration.
 *
 * Key Features:
 * - Formats seasonal patterns as human-readable memories
 * - Stores metadata for filtering and retrieval
 * - Integrates with mem0 API for long-term learning
 * - Handles errors gracefully with logging
 */

import type { SeasonalPattern } from './seasonal-adjustment';

/**
 * PatternStorageService - Persist seasonal patterns to mem0
 */
export class PatternStorageService {
  private mem0ApiUrl: string;
  private mem0ApiKey: string;

  /**
   * Initialize pattern storage service
   *
   * @param tenantId - Tenant identifier for multi-tenant isolation
   * @param options - Configuration options
   */
  constructor(
    private tenantId: string,
    private options: {
      apiUrl?: string;
      apiKey?: string;
    } = {}
  ) {
    this.mem0ApiUrl = options.apiUrl || process.env.MEM0_API_URL || '';
    this.mem0ApiKey = options.apiKey || process.env.MEM0_API_KEY || '';

    if (!this.mem0ApiUrl) {
      console.warn('[PatternStorage] MEM0_API_URL not configured, storage disabled');
    }

    if (!this.mem0ApiKey) {
      console.warn('[PatternStorage] MEM0_API_KEY not configured, storage disabled');
    }
  }

  /**
   * Store seasonal pattern in mem0
   *
   * Creates a memory record with pattern details that can be referenced
   * in future pricing decisions.
   *
   * @param pattern - Seasonal pattern to store
   * @throws Error if API call fails
   */
  async storeSeasonalPattern(pattern: SeasonalPattern): Promise<void> {
    if (!this.mem0ApiUrl || !this.mem0ApiKey) {
      console.warn('[PatternStorage] Storage disabled, skipping pattern persistence');
      return;
    }

    try {
      const content = this.formatPatternContent(pattern);

      const payload = {
        user_id: `${this.tenantId}:seasonal-analyzer`,
        messages: [content],
        metadata: {
          category: 'pricing:seasonal_pattern',
          productCategory: pattern.category,
          brand: pattern.brand || 'all',
          peakMonths: pattern.peakMonths,
          offSeasonMonths: pattern.offSeasonMonths,
          seasonalityScore: pattern.seasonalityScore,
          sampleSize: pattern.sampleSize,
          analysisDate: pattern.analysisDate,
          monthlyStats: JSON.stringify(pattern.monthlyStats),
        },
      };

      const response = await fetch(`${this.mem0ApiUrl}/v1/memories/`, {
        method: 'POST',
        headers: {
          Authorization: `Token ${this.mem0ApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Failed to store pattern: ${response.statusText} - ${errorBody}`);
      }

      console.log('[PatternStorage] Stored seasonal pattern', {
        category: pattern.category,
        brand: pattern.brand,
        seasonalityScore: pattern.seasonalityScore.toFixed(2),
        sampleSize: pattern.sampleSize,
      });
    } catch (error) {
      console.error('[PatternStorage] Error storing pattern:', error);
      throw error;
    }
  }

  /**
   * Format seasonal pattern into human-readable memory content
   *
   * Creates a natural language description of the pattern that mem0 can understand.
   *
   * @param pattern - Seasonal pattern
   * @returns Formatted content string
   */
  private formatPatternContent(pattern: SeasonalPattern): string {
    const peakMonthNames = pattern.peakMonths.map((m) => this.getMonthName(m)).join(', ');
    const offSeasonMonthNames = pattern.offSeasonMonths.map((m) => this.getMonthName(m)).join(', ');

    const brandInfo = pattern.brand ? ` (${pattern.brand})` : '';

    const peakMultiplier = this.getAvgMultiplier(pattern, pattern.peakMonths);
    const offSeasonMultiplier = this.getAvgMultiplier(pattern, pattern.offSeasonMonths);

    return (
      `${pattern.category}${brandInfo}: ` +
      `Peak season ${peakMonthNames} (avg ${peakMultiplier}x), ` +
      `off-season ${offSeasonMonthNames} (avg ${offSeasonMultiplier}x). ` +
      `Seasonality strength: ${pattern.seasonalityScore.toFixed(2)} (0-1 scale), ` +
      `based on ${pattern.sampleSize} historical sales.`
    );
  }

  /**
   * Get average multiplier for specific months
   *
   * @param pattern - Seasonal pattern
   * @param months - Array of month numbers (1-12)
   * @returns Formatted average multiplier string
   */
  private getAvgMultiplier(pattern: SeasonalPattern, months: number[]): string {
    if (months.length === 0) return '1.0';

    const multipliers = months.map((m) => {
      const stats = pattern.monthlyStats.find((s) => s.month === m);
      return stats?.priceMultiplier || 1.0;
    });

    const avg = multipliers.reduce((sum, m) => sum + m, 0) / multipliers.length;
    return avg.toFixed(2);
  }

  /**
   * Get month name from number
   *
   * @param month - Month number (1-12)
   * @returns Three-letter month abbreviation
   */
  private getMonthName(month: number): string {
    const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return names[month - 1] || 'Unknown';
  }
}
