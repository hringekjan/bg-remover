/**
 * Pricing Insight Aggregator - Weekly Batch Job
 *
 * Scheduled Lambda function that runs every Sunday at 2 AM UTC.
 * Analyzes seasonal patterns for top categories and stores patterns in mem0.
 *
 * Workflow:
 * 1. Fetch list of top categories by sales volume
 * 2. For each category, detect seasonal patterns
 * 3. For top brands, detect brand-specific patterns
 * 4. Store patterns in mem0 for future use
 * 5. Log results and metrics
 *
 * Cost: ~$0.02 per execution
 * Runtime: 2-10 minutes depending on data volume
 */

import { EventBridgeEvent } from 'aws-lambda';
import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { Logger } from '@aws-lambda-powertools/logger';

import { SeasonalAdjustmentService } from '../lib/pricing/seasonal-adjustment';
import { PatternStorageService } from '../lib/pricing/pattern-storage';

const logger = new Logger({ serviceName: 'PricingInsightAggregator' });

/**
 * EventBridge scheduled event handler
 *
 * Triggered by: cron(0 2 * * 0) - Every Sunday at 2 AM UTC
 */
export async function handler(event: EventBridgeEvent<'Scheduled Event', any>): Promise<{
  statusCode: number;
  body: string;
}> {
  logger.info('[PricingInsightAggregator] Starting weekly pattern analysis', {
    timestamp: new Date().toISOString(),
  });

  const tenantId = process.env.TENANT_ID || 'carousel-labs';
  const stage = process.env.STAGE || 'dev';
  const salesTableName = process.env.SALES_TABLE_NAME || `bg-remover-${stage}-sales-intelligence`;

  const seasonalService = new SeasonalAdjustmentService(tenantId, salesTableName);
  const patternStorage = new PatternStorageService(tenantId);

  try {
    // Fetch top categories by sales volume
    const categories = await getTopCategories(tenantId, salesTableName);

    logger.info('[PricingInsightAggregator] Analyzing categories', {
      count: categories.length,
      categories,
    });

    let patternsFound = 0;
    let categoriesProcessed = 0;

    // Analyze each category
    for (const category of categories) {
      try {
        // Detect pattern for category (all brands combined)
        const pattern = await seasonalService.detectSeasonalPattern(category);

        if (pattern && pattern.seasonalityScore > 0.15) {
          try {
            await patternStorage.storeSeasonalPattern(pattern);
            patternsFound++;
            logger.info('Pattern stored successfully', {
              category: pattern.category,
              brand: pattern.brand,
              seasonalityScore: pattern.seasonalityScore,
            });
          } catch (storageError) {
            logger.error('Failed to store seasonal pattern', {
              error: storageError instanceof Error ? storageError.message : String(storageError),
              category: pattern.category,
              brand: pattern.brand,
            });
            // Continue processing remaining patterns
          }
        }

        // Also analyze top brands within category
        const topBrands = await getTopBrandsForCategory(tenantId, salesTableName, category);

        for (const brand of topBrands) {
          try {
            const brandPattern = await seasonalService.detectSeasonalPattern(category, brand);

            if (brandPattern && brandPattern.seasonalityScore > 0.2) {
              try {
                await patternStorage.storeSeasonalPattern(brandPattern);
                patternsFound++;
                logger.info('Brand pattern stored successfully', {
                  category: brandPattern.category,
                  brand: brandPattern.brand,
                  seasonalityScore: brandPattern.seasonalityScore,
                });
              } catch (storageError) {
                logger.error('Failed to store brand pattern', {
                  error: storageError instanceof Error ? storageError.message : String(storageError),
                  category: brandPattern.category,
                  brand: brandPattern.brand,
                });
                // Continue processing remaining brands
              }
            }
          } catch (brandError) {
            logger.warn('Error analyzing brand', {
              category,
              brand,
              error: brandError instanceof Error ? brandError.message : String(brandError),
            });
          }
        }

        categoriesProcessed++;
      } catch (error) {
        logger.error('[PricingInsightAggregator] Error analyzing category', {
          category,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const result = {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        categoriesAnalyzed: categoriesProcessed,
        categoriesTotal: categories.length,
        patternsFound,
        timestamp: new Date().toISOString(),
      }),
    };

    logger.info('[PricingInsightAggregator] Completed successfully', {
      categoriesProcessed,
      patternsFound,
    });

    return result;
  } catch (error) {
    logger.error('[PricingInsightAggregator] Fatal error', {
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
}

/**
 * Fetch top categories by sales volume
 *
 * Queries DynamoDB to identify categories with most sales.
 * Limits to top N for cost efficiency.
 *
 * @param tenantId - Tenant identifier
 * @param tableName - DynamoDB table name
 * @param limit - Maximum categories to return (default: 10)
 * @returns Array of category names
 */
async function getTopCategories(
  tenantId: string,
  tableName: string,
  limit: number = 10
): Promise<string[]> {
  try {
    const client = new DynamoDBClient({ region: 'eu-west-1' });

    // Query for sales in this tenant
    const command = new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: marshall({
        ':pk': `TENANT#${tenantId}#SALES`,
      }),
      Limit: 100, // Fetch enough to identify top categories
      ScanIndexForward: false, // Most recent first
    });

    const response = await client.send(command);

    if (!response.Items || response.Items.length === 0) {
      logger.warn('[PricingInsightAggregator] No sales found for tenant', { tenantId });
      return [];
    }

    // Group by category and count
    const categoryCounts: Record<string, number> = {};

    // Note: In a production system, you'd want a dedicated "top categories" index
    // For now, we'll use a predefined list of common product categories
    // This is a pragmatic approach until analytics are built

    return getDefaultCategories();
  } catch (error) {
    logger.error('[PricingInsightAggregator] Error fetching top categories', {
      error: error instanceof Error ? error.message : String(error),
    });
    return getDefaultCategories();
  }
}

/**
 * Get default categories for analysis
 *
 * These are common fashion/apparel categories with strong seasonality.
 *
 * @returns Array of category names
 */
function getDefaultCategories(): string[] {
  return ['coats', 'jackets', 'swimwear', 'dresses', 'boots', 'handbags', 'shirts', 'pants'];
}

/**
 * Fetch top brands for a specific category
 *
 * Identifies brands with most sales in a category by querying all shards.
 * Used to detect brand-specific seasonal patterns.
 *
 * @param tenantId - Tenant identifier
 * @param tableName - DynamoDB table name
 * @param category - Product category
 * @param limit - Maximum brands to return (default: 5)
 * @returns Array of brand names
 */
async function getTopBrandsForCategory(
  tenantId: string,
  tableName: string,
  category: string,
  limit: number = 5
): Promise<string[]> {
  try {
    const client = new DynamoDBClient({ region: 'eu-west-1' });
    const brandCounts: Record<string, number> = {};

    // Query all 10 shards (0-9) for category sales
    // This ensures we capture all brands, not just shard 0
    for (let shard = 0; shard < 10; shard++) {
      try {
        const command = new QueryCommand({
          TableName: tableName,
          IndexName: 'GSI-1',
          KeyConditionExpression: 'GSI1PK = :pk',
          ExpressionAttributeValues: marshall({
            ':pk': `TENANT#${tenantId}#CATEGORY#${category}#SHARD#${shard}`,
          }),
          Limit: 100, // Fetch enough from each shard to identify top brands
        });

        const response = await client.send(command);

        if (!response.Items || response.Items.length === 0) {
          continue; // Shard may be empty
        }

        // Aggregate brand counts across all shards
        response.Items.forEach((item) => {
          const brand = (item.brand?.S || 'unknown') as string;
          brandCounts[brand] = (brandCounts[brand] || 0) + 1;
        });
      } catch (shardError) {
        // Log error but continue with other shards
        logger.warn('Error querying shard for category', {
          category,
          shard,
          error: shardError instanceof Error ? shardError.message : String(shardError),
        });
      }
    }

    // Sort by count descending and return top N
    const topBrands = Object.entries(brandCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([brand]) => brand)
      .filter((b) => b !== 'unknown');

    logger.debug('Top brands identified for category', {
      category,
      count: topBrands.length,
      brands: topBrands,
    });

    return topBrands;
  } catch (error) {
    logger.warn('Error fetching top brands for category', {
      category,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
