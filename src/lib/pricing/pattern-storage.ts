/**
 * Pattern Storage Service - DynamoDB Integration
 *
 * Stores detected seasonal patterns in DynamoDB for persistence and future reference.
 * Enables the system to learn and improve over time without manual configuration.
 *
 * Key Features:
 * - Formats seasonal patterns as human-readable summaries
 * - Stores structured key-value data in DynamoDB
 * - Deterministic key schema for consistent retrieval
 * - Handles errors gracefully with logging
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { SeasonalPattern } from './seasonal-adjustment';

/**
 * PatternStorageService - Persist seasonal patterns to DynamoDB
 */
export class PatternStorageService {
  private tableName: string;
  private docClient: DynamoDBDocumentClient;

  /**
   * Initialize pattern storage service
   *
   * @param tenantId - Tenant identifier for multi-tenant isolation
   * @param options - Configuration options
   */
  constructor(
    private tenantId: string,
    private options: { tableName?: string; stage?: string } = {}
  ) {
    this.tableName = options.tableName || process.env.PRICING_PATTERNS_TABLE || `bg-remover-${options.stage || process.env.STAGE || 'dev'}-pricing-patterns`;

    const ddbClient = new DynamoDBClient({
      region: process.env.AWS_REGION || 'eu-west-1',
    });

    this.docClient = DynamoDBDocumentClient.from(ddbClient);
  }

  /**
   * Store seasonal pattern in DynamoDB
   *
   * Creates a record with pattern details that can be referenced
   * in future pricing decisions.
   *
   * Key schema:
   * - PK: TENANT#{tenantId}#CATEGORY#{category}
   * - SK: BRAND#{brand || 'all'}#DATE#{analysisDate}
   *
   * @param pattern - Seasonal pattern to store
   * @throws Error if DynamoDB write fails
   */
  async storeSeasonalPattern(pattern: SeasonalPattern): Promise<void> {
    try {
      const summary = this.formatPatternContent(pattern);

      const item = {
        PK: `TENANT#${this.tenantId}#CATEGORY#${pattern.category}`,
        SK: `BRAND#${pattern.brand || 'all'}#DATE#${pattern.analysisDate}`,
        tenantId: this.tenantId,
        category: pattern.category,
        brand: pattern.brand || 'all',
        peakMonths: pattern.peakMonths,
        offSeasonMonths: pattern.offSeasonMonths,
        seasonalityScore: pattern.seasonalityScore,
        sampleSize: pattern.sampleSize,
        analysisDate: pattern.analysisDate,
        monthlyStats: pattern.monthlyStats,
        summary,
        createdAt: new Date().toISOString(),
      };

      const command = new PutCommand({
        TableName: this.tableName,
        Item: item,
      });

      await this.docClient.send(command);

      console.log('[PatternStorage] Stored seasonal pattern to DynamoDB', {
        category: pattern.category,
        brand: pattern.brand,
        seasonalityScore: pattern.seasonalityScore.toFixed(2),
        sampleSize: pattern.sampleSize,
        tableName: this.tableName,
      });
    } catch (error) {
      console.error('[PatternStorage] Error storing pattern to DynamoDB:', error);
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
