/**
 * TTL Backfill Script for Sales Intelligence Table
 *
 * One-time migration script to populate TTL attribute on existing records.
 * Run this after enabling TTL on the DynamoDB table to ensure old records
 * are properly cleaned up after 2 years.
 *
 * Usage:
 * ```bash
 * # Dry run (list items that would be updated)
 * npx ts-node src/lib/sales-intelligence/backfill-ttl.ts \
 *   --table bg-remover-dev-sales-intelligence \
 *   --dry-run \
 *   --region eu-west-1
 *
 * # Actual run (update database)
 * npx ts-node src/lib/sales-intelligence/backfill-ttl.ts \
 *   --table bg-remover-dev-sales-intelligence \
 *   --region eu-west-1
 * ```
 *
 * @module lib/sales-intelligence/backfill-ttl
 */

import {
  DynamoDBClient,
  ScanCommand,
  UpdateItemCommand,
  type ScanCommandInput,
  type UpdateItemCommandInput,
} from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

/**
 * BackfillTTLOptions configuration
 */
export interface BackfillTTLOptions {
  /** DynamoDB table name */
  tableName: string;

  /** AWS region */
  region?: string;

  /** Dry run (don't actually update) */
  dryRun?: boolean;

  /** TTL offset in years (default: 2) */
  ttlYears?: number;

  /** Batch size for scan (default: 100, max: 1000) */
  batchSize?: number;

  /** Callback for progress updates */
  onProgress?: (progress: BackfillProgress) => void;
}

/**
 * Progress information for backfill operation
 */
export interface BackfillProgress {
  /** Total items processed so far */
  processed: number;

  /** Items that were updated */
  updated: number;

  /** Items that already had TTL */
  skipped: number;

  /** Items that failed to update */
  failed: number;

  /** Estimated total items in table */
  estimatedTotal: number;

  /** Current rate (items/second) */
  rate: number;

  /** Estimated time remaining (seconds) */
  estimatedRemaining: number;
}

/**
 * Backfill TTL attribute for existing sales records
 *
 * Scans the entire table and updates records that don't have TTL set.
 * This is a one-time operation needed after deploying the table with TTL enabled.
 *
 * Important notes:
 * - This operation reads the entire table (may consume RCUs)
 * - For large tables (>1M items), use VPC endpoint for cost optimization
 * - Dry run is recommended before actual execution
 * - Progress callbacks are useful for monitoring long-running operations
 *
 * @param options - Backfill configuration
 * @returns Backfill result summary
 */
export async function backfillTTL(options: BackfillTTLOptions): Promise<{
  totalProcessed: number;
  totalUpdated: number;
  totalSkipped: number;
  totalFailed: number;
  dryRun: boolean;
  duration: number;
}> {
  const {
    tableName,
    region = 'eu-west-1',
    dryRun = true,
    ttlYears = 2,
    batchSize = 100,
    onProgress,
  } = options;

  // Validate inputs
  if (!tableName) throw new Error('tableName is required');
  if (batchSize < 1 || batchSize > 1000) {
    throw new Error('batchSize must be between 1 and 1000');
  }

  const client = new DynamoDBClient({ region });
  const startTime = Date.now();
  let processed = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  let lastEvaluatedKey: Record<string, any> | undefined;

  console.log(
    `[${new Date().toISOString()}] Starting TTL backfill for table: ${tableName}`
  );
  console.log(`[${new Date().toISOString()}] Dry run: ${dryRun}`);
  console.log(`[${new Date().toISOString()}] TTL years: ${ttlYears}`);

  do {
    // Scan batch
    const scanInput: ScanCommandInput = {
      TableName: tableName,
      Limit: batchSize,
      ProjectionExpression: 'PK, SK, saleDate, #ttl',
      ExpressionAttributeNames: { '#ttl': 'ttl' },
      ExclusiveStartKey: lastEvaluatedKey,
    };

    const scanCommand = new ScanCommand(scanInput);
    const scanResponse = await client.send(scanCommand);

    // Process items in this batch
    for (const item of scanResponse.Items || []) {
      processed++;

      // Skip if TTL already set
      if (item.ttl?.N) {
        skipped++;
        continue;
      }

      // Extract saleDate
      const saleDateValue = item.saleDate?.S;
      if (!saleDateValue) {
        console.warn(`[${new Date().toISOString()}] Skipping item without saleDate: PK=${item.PK?.S}`);
        skipped++;
        continue;
      }

      // Calculate TTL
      const ttl = calculateTTL(saleDateValue, ttlYears);

      // Update item if not dry run
      if (!dryRun) {
        try {
          const updateInput: UpdateItemCommandInput = {
            TableName: tableName,
            Key: marshall({
              PK: item.PK?.S,
              SK: item.SK?.S,
            }),
            UpdateExpression: 'SET #ttl = :ttl',
            ExpressionAttributeNames: { '#ttl': 'ttl' },
            ExpressionAttributeValues: marshall({
              ':ttl': ttl,
            }),
          };

          const updateCommand = new UpdateItemCommand(updateInput);
          await client.send(updateCommand);
          updated++;
        } catch (error) {
          failed++;
          console.error(
            `[${new Date().toISOString()}] Failed to update item: PK=${item.PK?.S}, error=${(error as Error).message}`
          );
        }
      } else {
        // In dry-run, just count what would be updated
        updated++;
      }

      // Report progress every 100 items
      if (processed % 100 === 0) {
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = processed / elapsed;
        const estimated = scanResponse.ScannedCount || processed;
        const remaining = Math.max(0, (estimated - processed) / rate);

        onProgress?.({
          processed,
          updated,
          skipped,
          failed,
          estimatedTotal: estimated,
          rate,
          estimatedRemaining: remaining,
        });

        console.log(
          `[${new Date().toISOString()}] Progress: ${processed} processed, ${updated} updated, ${skipped} skipped, ${failed} failed`
        );
      }
    }

    // Continue with next batch
    lastEvaluatedKey = scanResponse.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  const duration = (Date.now() - startTime) / 1000;

  // Print final summary
  console.log(`[${new Date().toISOString()}] ========== BACKFILL SUMMARY ==========`);
  console.log(`[${new Date().toISOString()}] Total processed: ${processed}`);
  console.log(`[${new Date().toISOString()}] Total updated: ${updated}`);
  console.log(`[${new Date().toISOString()}] Total skipped (already have TTL): ${skipped}`);
  console.log(`[${new Date().toISOString()}] Total failed: ${failed}`);
  console.log(`[${new Date().toISOString()}] Duration: ${duration.toFixed(2)} seconds`);
  console.log(`[${new Date().toISOString()}] Rate: ${(processed / duration).toFixed(2)} items/second`);

  return {
    totalProcessed: processed,
    totalUpdated: updated,
    totalSkipped: skipped,
    totalFailed: failed,
    dryRun,
    duration,
  };
}

/**
 * Calculate TTL timestamp
 *
 * @param saleDate - Sale date in YYYY-MM-DD format
 * @param ttlYears - Number of years until expiration
 * @returns TTL timestamp in seconds since epoch
 */
function calculateTTL(saleDate: string, ttlYears: number): number {
  const date = new Date(saleDate);

  // Validate date format
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid date format: ${saleDate}, expected YYYY-MM-DD`);
  }

  // Add TTL years
  date.setFullYear(date.getFullYear() + ttlYears);

  // Return as epoch seconds
  return Math.floor(date.getTime() / 1000);
}

/**
 * CLI Interface for backfill script
 *
 * Allows running backfill from command line:
 * npx ts-node backfill-ttl.ts --table table-name --region eu-west-1 --dry-run
 */
if (require.main === module) {
  // Parse command-line arguments
  const args = process.argv.slice(2);
  const params: Record<string, string | boolean> = {};

  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, '');
    const value = args[i + 1];

    if (value === undefined || value.startsWith('--')) {
      params[key] = true;
    } else {
      params[key] = value;
    }
  }

  // Validate required parameters
  if (!params.table) {
    console.error('Usage: npx ts-node backfill-ttl.ts --table TABLE_NAME [--region REGION] [--dry-run] [--ttl-years YEARS]');
    process.exit(1);
  }

  // Run backfill
  backfillTTL({
    tableName: params.table as string,
    region: (params.region as string) || 'eu-west-1',
    dryRun: params['dry-run'] !== false,
    ttlYears: params['ttl-years'] ? parseInt(params['ttl-years'] as string) : 2,
    onProgress: (progress) => {
      const eta = progress.estimatedRemaining > 0
        ? `${Math.floor(progress.estimatedRemaining)}s remaining`
        : 'complete';
      console.log(
        `[Progress] Processed: ${progress.processed} | Updated: ${progress.updated} | Rate: ${progress.rate.toFixed(2)} items/s | ETA: ${eta}`
      );
    },
  })
    .then((result) => {
      process.exit(result.totalFailed > 0 ? 1 : 0);
    })
    .catch((error) => {
      console.error('Backfill failed:', error);
      process.exit(1);
    });
}

export default backfillTTL;
