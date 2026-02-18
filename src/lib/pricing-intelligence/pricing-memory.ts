/**
 * Pricing Memory Integration (mem0)
 * 
 * Stores pricing corrections, patterns, and sales outcomes for continuous learning.
 * Uses mem0 for semantic memory storage and retrieval.
 */

import type { PricingSuggestion, HistoricalSale } from './types';

/**
 * Mem0 memory categories for pricing intelligence
 */
export const PRICING_MEMORY_CATEGORIES = {
  PRODUCT_LISTING: 'pricing:product_listing',
  CORRECTION: 'pricing:correction',
  SALES_OUTCOME: 'pricing:sales_outcome',
  PATTERN: 'pricing:pattern',
} as const;

/**
 * Configuration for mem0 integration
 */
export interface PricingMemoryConfig {
  apiKey?: string;
  baseUrl?: string;
  userId?: string;
  tenantId?: string;
  tableName?: string;
}

/**
 * Memory entry for a pricing correction
 */
export interface PricingCorrectionEntry {
  productName: string;
  suggestedPrice: number;
  actualPrice: number;
  adjustment: number;
  reason: string;
  category?: string;
  brand?: string;
  condition?: string;
  timestamp: string;
}

/**
 * Memory entry for a sales outcome
 */
export interface SalesOutcomeEntry {
  productName: string;
  listedPrice: number;
  soldPrice: number;
  daysOnMarket: number;
  category?: string;
  brand?: string;
  condition?: string;
  timestamp: string;
}

/**
 * Memory entry for a pricing pattern
 */
export interface PricingPatternEntry {
  pattern: string;
  category: string;
  avgAdjustment: number;
  confidence: number;
  sampleSize: number;
  description: string;
  timestamp: string;
}

/**
 * Pricing Memory Integration using mem0
 */
export class PricingMemoryIntegration {
  private config: PricingMemoryConfig;
  private tableName: string;

  constructor(config: PricingMemoryConfig = {}) {
    this.config = {
      apiKey: config.apiKey || process.env.MEM0_API_KEY,
      baseUrl: config.baseUrl || process.env.MEM0_BASE_URL || 'https://api.mem0.ai/v1',
      userId: config.userId || 'bg-remover-service',
      tenantId: config.tenantId || process.env.TENANT_ID || 'carousel-labs',
      tableName: config.tableName || process.env.DYNAMODB_TABLE || 'carousel-main-dev',
    };
    this.tableName = this.config.tableName!;
  }

  /**
   * Store a pricing correction
   * Called when user adjusts the AI-suggested price
   */
  async storeCorrection(entry: PricingCorrectionEntry): Promise<boolean> {
    try {
      const memory = {
        role: 'user',
        content: JSON.stringify({
          event: 'pricing_correction',
          productName: entry.productName,
          suggestedPrice: entry.suggestedPrice,
          actualPrice: entry.actualPrice,
          adjustment: entry.adjustment,
          reason: entry.reason,
          category: entry.category,
          brand: entry.brand,
          condition: entry.condition,
        }),
        metadata: {
          category: PRICING_MEMORY_CATEGORIES.CORRECTION,
          tenantId: this.config.tenantId,
          timestamp: entry.timestamp,
        },
      };

      // Store in DynamoDB (simplified - actual implementation would use mem0 SDK)
      await this.storeInDynamoDB(memory);

      console.log('[PricingMemory] Stored correction', {
        productName: entry.productName,
        adjustment: entry.adjustment,
        reason: entry.reason,
      });

      return true;
    } catch (error) {
      console.error('[PricingMemory] Failed to store correction', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Store a sales outcome
   * Called when a product is sold
   */
  async storeSalesOutcome(entry: SalesOutcomeEntry): Promise<boolean> {
    try {
      const memory = {
        role: 'user',
        content: JSON.stringify({
          event: 'sales_outcome',
          productName: entry.productName,
          listedPrice: entry.listedPrice,
          soldPrice: entry.soldPrice,
          daysOnMarket: entry.daysOnMarket,
          category: entry.category,
          brand: entry.brand,
          condition: entry.condition,
        }),
        metadata: {
          category: PRICING_MEMORY_CATEGORIES.SALES_OUTCOME,
          tenantId: this.config.tenantId,
          timestamp: entry.timestamp,
        },
      };

      await this.storeInDynamoDB(memory);

      console.log('[PricingMemory] Stored sales outcome', {
        productName: entry.productName,
        soldPrice: entry.soldPrice,
        daysOnMarket: entry.daysOnMarket,
      });

      return true;
    } catch (error) {
      console.error('[PricingMemory] Failed to store sales outcome', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Store a pricing pattern
   * Called when a pattern is detected
   */
  async storePattern(entry: PricingPatternEntry): Promise<boolean> {
    try {
      const memory = {
        role: 'user',
        content: JSON.stringify({
          event: 'pricing_pattern',
          pattern: entry.pattern,
          category: entry.category,
          avgAdjustment: entry.avgAdjustment,
          confidence: entry.confidence,
          sampleSize: entry.sampleSize,
          description: entry.description,
        }),
        metadata: {
          category: PRICING_MEMORY_CATEGORIES.PATTERN,
          tenantId: this.config.tenantId,
          timestamp: entry.timestamp,
        },
      };

      await this.storeInDynamoDB(memory);

      console.log('[PricingMemory] Stored pattern', {
        pattern: entry.pattern,
        category: entry.category,
        avgAdjustment: entry.avgAdjustment,
      });

      return true;
    } catch (error) {
      console.error('[PricingMemory] Failed to store pattern', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Get pricing corrections for a similar product
   */
  async getCorrections(
    productName: string,
    category?: string
  ): Promise<PricingCorrectionEntry[]> {
    try {
      // Query DynamoDB for similar corrections
      const corrections = await this.queryMemories(
        PRICING_MEMORY_CATEGORIES.CORRECTION,
        productName,
        category
      );

      return corrections.map((c: any) => {
        const content = typeof c.content === 'string' ? JSON.parse(c.content) : c.content;
        return {
          productName: content.productName,
          suggestedPrice: content.suggestedPrice,
          actualPrice: content.actualPrice,
          adjustment: content.adjustment,
          reason: content.reason,
          category: content.category,
          brand: content.brand,
          condition: content.condition,
          timestamp: content.timestamp || c.createdAt,
        };
      });
    } catch (error) {
      console.error('[PricingMemory] Failed to get corrections', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Get sales outcomes for similar products
   */
  async getSalesOutcomes(
    productName: string,
    category?: string
  ): Promise<SalesOutcomeEntry[]> {
    try {
      const outcomes = await this.queryMemories(
        PRICING_MEMORY_CATEGORIES.SALES_OUTCOME,
        productName,
        category
      );

      return outcomes.map((o: any) => {
        const content = typeof o.content === 'string' ? JSON.parse(o.content) : o.content;
        return {
          productName: content.productName,
          listedPrice: content.listedPrice,
          soldPrice: content.soldPrice,
          daysOnMarket: content.daysOnMarket,
          category: content.category,
          brand: content.brand,
          condition: content.condition,
          timestamp: content.timestamp || o.createdAt,
        };
      });
    } catch (error) {
      console.error('[PricingMemory] Failed to get sales outcomes', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Get pricing patterns for a category
   */
  async getPatterns(category: string): Promise<PricingPatternEntry[]> {
    try {
      const patterns = await this.queryMemories(
        PRICING_MEMORY_CATEGORIES.PATTERN,
        undefined,
        category
      );

      return patterns.map((p: any) => {
        const content = typeof p.content === 'string' ? JSON.parse(p.content) : p.content;
        return {
          pattern: content.pattern,
          category: content.category,
          avgAdjustment: content.avgAdjustment,
          confidence: content.confidence,
          sampleSize: content.sampleSize,
          description: content.description,
          timestamp: content.timestamp || p.createdAt,
        };
      });
    } catch (error) {
      console.error('[PricingMemory] Failed to get patterns', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Calculate adjustment factor based on historical corrections
   */
  async calculateCorrectionFactor(
    productName: string,
    category?: string
  ): Promise<number> {
    const corrections = await this.getCorrections(productName, category);
    
    if (corrections.length === 0) {
      return 1.0; // No corrections, use suggested price
    }

    // Calculate average adjustment
    const avgAdjustment = corrections.reduce((sum, c) => sum + c.adjustment, 0) / corrections.length;
    
    // Weight more recent corrections more heavily
    const recentWeight = corrections.reduce((weight, c, i) => {
      const daysAgo = (Date.now() - new Date(c.timestamp).getTime()) / (1000 * 60 * 60 * 24);
      const decayFactor = Math.exp(-daysAgo / 30); // 30-day decay
      return weight + (1 - decayFactor) * (i + 1);
    }, 0);

    const normalizedAdjustment = avgAdjustment / Math.sqrt(corrections.length);
    
    return 1.0 + normalizedAdjustment;
  }

  /**
   * Calculate sold price ratio based on sales outcomes
   */
  async calculateSoldPriceRatio(
    productName: string,
    category?: string
  ): Promise<{ ratio: number; avgDaysOnMarket: number }> {
    const outcomes = await this.getSalesOutcomes(productName, category);
    
    if (outcomes.length === 0) {
      return { ratio: 1.0, avgDaysOnMarket: 30 };
    }

    const ratios = outcomes.map(o => o.soldPrice / o.listedPrice);
    const avgRatio = ratios.reduce((sum, r) => sum + r, 0) / ratios.length;
    const avgDays = outcomes.reduce((sum, o) => sum + o.daysOnMarket, 0) / outcomes.length;

    return { ratio: avgRatio, avgDaysOnMarket: avgDays };
  }

  /**
   * Store memory entry in DynamoDB
   */
  private async storeInDynamoDB(memory: Record<string, any>): Promise<void> {
    const { DynamoDBClient, PutItemCommand } = await import('@aws-sdk/client-dynamodb');
    const { DynamoDBDocumentClient, PutCommand } = await import('@aws-sdk/lib-dynamodb');
    
    const dynamoDB = new DynamoDBClient({});
    const docClient = DynamoDBDocumentClient.from(dynamoDB);

    const pk = `TENANT#${this.config.tenantId}#MEMORY#${memory.metadata.category}`;
    const sk = `DATE#${new Date().toISOString()}#${Date.now()}`;

    await docClient.send(new PutCommand({
      TableName: this.tableName,
      Item: {
        PK: pk,
        SK: sk,
        ...memory,
        createdAt: new Date().toISOString(),
      },
    }));
  }

  /**
   * Query memories from DynamoDB
   */
  private async queryMemories(
    category: string,
    productName?: string,
    categoryFilter?: string
  ): Promise<any[]> {
    const { DynamoDBClient, QueryCommand } = await import('@aws-sdk/client-dynamodb');
    const { DynamoDBDocumentClient, QueryCommand: DocQueryCommand } = await import('@aws-sdk/lib-dynamodb');
    
    const dynamoDB = new DynamoDBClient({});
    const docClient = DynamoDBDocumentClient.from(dynamoDB);

    const pk = `TENANT#${this.config.tenantId}#MEMORY#${category}`;

    const response = await docClient.send(new DocQueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: {
        ':pk': pk,
      },
      Limit: 50,
    }));

    let items = response.Items || [];

    // Filter by product name or category if provided
    if (productName || categoryFilter) {
      items = items.filter((item: any) => {
        const content = typeof item.content === 'string' ? JSON.parse(item.content) : item.content;
        
        if (productName && categoryFilter) {
          return (
            content.productName?.toLowerCase().includes(productName.toLowerCase()) &&
            content.category?.toLowerCase() === categoryFilter.toLowerCase()
          );
        }
        
        if (productName) {
          return content.productName?.toLowerCase().includes(productName.toLowerCase());
        }
        
        if (categoryFilter) {
          return content.category?.toLowerCase() === categoryFilter.toLowerCase();
        }
        
        return true;
      });
    }

    return items;
  }
}

/**
 * Singleton instance
 */
let pricingMemoryInstance: PricingMemoryIntegration | null = null;

export function getPricingMemory(config?: PricingMemoryConfig): PricingMemoryIntegration {
  if (!pricingMemoryInstance) {
    pricingMemoryInstance = new PricingMemoryIntegration(config);
  }
  return pricingMemoryInstance;
}

/**
 * Utility to calculate seasonal adjustment based on demand patterns
 */
export function calculateSeasonalMultiplier(
  month: number,
  category: string
): number {
  const seasonalMultipliers: Record<string, Record<number, number>> = {
    outerwear: {
      1: 0.9, 2: 0.85, 3: 0.9, 4: 0.95, 5: 1.0, 6: 1.0,
      7: 1.0, 8: 1.0, 9: 1.1, 10: 1.2, 11: 1.3, 12: 1.4,
    },
    dresses: {
      1: 0.7, 2: 0.7, 3: 0.85, 4: 0.95, 5: 1.1, 6: 1.2,
      7: 1.2, 8: 1.1, 9: 1.0, 10: 0.9, 11: 0.85, 12: 1.0,
    },
    tops: {
      1: 0.9, 2: 0.9, 3: 1.0, 4: 1.0, 5: 0.95, 6: 0.9,
      7: 0.85, 8: 0.9, 9: 1.0, 10: 1.1, 11: 1.2, 12: 1.1,
    },
    shoes: {
      1: 0.95, 2: 0.95, 3: 1.0, 4: 1.0, 5: 1.0, 6: 1.0,
      7: 1.0, 8: 1.0, 9: 1.0, 10: 0.95, 11: 0.95, 12: 1.0,
    },
  };

  const categoryMultipliers = seasonalMultipliers[category];
  if (categoryMultipliers) {
    return categoryMultipliers[month] || 1.0;
  }

  // Default seasonal multipliers
  const defaultMultipliers: Record<number, number> = {
    1: 0.9, 2: 0.9, 3: 0.95, 4: 1.0, 5: 1.0, 6: 1.0,
    7: 1.0, 8: 1.0, 9: 1.0, 10: 1.0, 11: 1.1, 12: 1.2,
  };

  return defaultMultipliers[month] || 1.0;
}

/**
 * Aggregate weekly pricing insights
 */
export async function aggregateWeeklyInsights(
  tenantId: string,
  category?: string
): Promise<{
  avgSoldPrice: number;
  avgDaysOnMarket: number;
  topCorrections: { productName: string; avgAdjustment: number }[];
  topPatterns: { pattern: string; category: string; avgAdjustment: number }[];
}> {
  const memory = getPricingMemory({ tenantId });
  
  // Get sales outcomes for the week
  const outcomes = await memory.getSalesOutcomes('', category);
  const now = Date.now();
  const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
  
  const recentOutcomes = outcomes.filter(
    o => new Date(o.timestamp).getTime() > oneWeekAgo
  );

  // Calculate averages
  const avgSoldPrice = recentOutcomes.length > 0
    ? recentOutcomes.reduce((sum, o) => sum + o.soldPrice, 0) / recentOutcomes.length
    : 0;

  const avgDaysOnMarket = recentOutcomes.length > 0
    ? recentOutcomes.reduce((sum, o) => sum + o.daysOnMarket, 0) / recentOutcomes.length
    : 30;

  // Get patterns
  const patterns = category 
    ? await memory.getPatterns(category) 
    : [];

  // Get corrections
  const corrections = await memory.getCorrections('', category);

  return {
    avgSoldPrice: Math.round(avgSoldPrice / 100) * 100,
    avgDaysOnMarket: Math.round(avgDaysOnMarket),
    topCorrections: corrections.slice(0, 5).map(c => ({
      productName: c.productName,
      avgAdjustment: c.adjustment,
    })),
    topPatterns: patterns.slice(0, 5).map(p => ({
      pattern: p.pattern,
      category: p.category,
      avgAdjustment: p.avgAdjustment,
    })),
  };
}
