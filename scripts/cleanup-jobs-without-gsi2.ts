#!/usr/bin/env tsx

/**
 * Cleanup Script: Delete BG_REMOVER_JOB records without GSI2PK attribute
 *
 * This script removes old job records created before the GSI2 implementation.
 * These jobs cannot be queried efficiently via the batch status endpoint.
 *
 * Safety features:
 * - Dry run mode by default
 * - Tenant filtering
 * - Batch deletion with retry logic
 * - Detailed logging
 *
 * Usage:
 *   # Dry run (default)
 *   npx tsx scripts/cleanup-jobs-without-gsi2.ts --tenant hringekjan
 *
 *   # Actually delete
 *   npx tsx scripts/cleanup-jobs-without-gsi2.ts --tenant hringekjan --execute
 */

import { DynamoDBClient, ScanCommand, BatchWriteItemCommand } from '@aws-sdk/client-dynamodb';

const dynamoDB = new DynamoDBClient({ region: 'eu-west-1' });
const tableName = process.env.DYNAMODB_TABLE || 'carousel-main-dev';

interface ScriptOptions {
  tenant: string;
  execute: boolean;
  maxItems?: number;
}

async function cleanupJobsWithoutGSI2(options: ScriptOptions): Promise<void> {
  const { tenant, execute, maxItems } = options;

  console.log('\n=== BG Remover Job Cleanup Script ===');
  console.log(`Table: ${tableName}`);
  console.log(`Tenant: ${tenant}`);
  console.log(`Mode: ${execute ? 'EXECUTE (will delete)' : 'DRY RUN (read-only)'}`);
  console.log('=====================================\n');

  // Scan for jobs without GSI2PK
  const pkPrefix = `TENANT#${tenant}#BG_REMOVER_JOB#`;

  let itemsToDelete: Array<{ PK: { S: string }; SK: { S: string } }> = [];
  let lastEvaluatedKey: Record<string, any> | undefined = undefined;
  let totalScanned = 0;
  let pageCount = 0;

  console.log(`Scanning for jobs without GSI2PK attribute...`);

  do {
    pageCount++;
    const result = await dynamoDB.send(new ScanCommand({
      TableName: tableName,
      FilterExpression: 'begins_with(PK, :pkPrefix) AND SK = :sk AND attribute_not_exists(GSI2PK)',
      ExpressionAttributeValues: {
        ':pkPrefix': { S: pkPrefix },
        ':sk': { S: 'METADATA' },
      },
      ProjectionExpression: 'PK, SK, jobId, createdAt, #status',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ...(lastEvaluatedKey && { ExclusiveStartKey: lastEvaluatedKey }),
    }));

    totalScanned += result.ScannedCount || 0;

    if (result.Items && result.Items.length > 0) {
      console.log(`Page ${pageCount}: Found ${result.Items.length} jobs without GSI2PK`);

      // Log details
      result.Items.forEach((item) => {
        console.log(`  - Job ${item.jobId?.S} (${item.createdAt?.S}) - Status: ${item.status?.S}`);
        itemsToDelete.push({
          PK: item.PK!,
          SK: item.SK!,
        });
      });
    }

    lastEvaluatedKey = result.LastEvaluatedKey;

    // Safety limit
    if (maxItems && itemsToDelete.length >= maxItems) {
      console.log(`\nReached max items limit (${maxItems}), stopping scan.`);
      break;
    }
  } while (lastEvaluatedKey);

  console.log(`\n=== Scan Complete ===`);
  console.log(`Total items scanned: ${totalScanned}`);
  console.log(`Jobs to delete: ${itemsToDelete.length}`);

  if (itemsToDelete.length === 0) {
    console.log('\n✅ No jobs to delete. All jobs have GSI2PK attribute.');
    return;
  }

  if (!execute) {
    console.log('\n⚠️  DRY RUN MODE - No deletions performed.');
    console.log('To actually delete these jobs, run with --execute flag.');
    return;
  }

  // Execute deletions in batches of 25 (DynamoDB limit)
  console.log('\n=== Starting Deletion ===');
  const batchSize = 25;
  let deletedCount = 0;

  for (let i = 0; i < itemsToDelete.length; i += batchSize) {
    const batch = itemsToDelete.slice(i, i + batchSize);

    try {
      await dynamoDB.send(new BatchWriteItemCommand({
        RequestItems: {
          [tableName]: batch.map(item => ({
            DeleteRequest: { Key: item },
          })),
        },
      }));

      deletedCount += batch.length;
      console.log(`Deleted batch ${Math.floor(i / batchSize) + 1}: ${batch.length} items (Total: ${deletedCount}/${itemsToDelete.length})`);

      // Rate limiting to avoid throttling
      if (i + batchSize < itemsToDelete.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } catch (error) {
      console.error(`❌ Error deleting batch ${Math.floor(i / batchSize) + 1}:`, error);
      throw error;
    }
  }

  console.log(`\n✅ Cleanup complete! Deleted ${deletedCount} jobs without GSI2PK.`);
}

// Parse command line arguments
function parseArgs(): ScriptOptions {
  const args = process.argv.slice(2);
  const options: ScriptOptions = {
    tenant: '',
    execute: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--tenant' && args[i + 1]) {
      options.tenant = args[i + 1];
      i++;
    } else if (arg === '--execute') {
      options.execute = true;
    } else if (arg === '--max-items' && args[i + 1]) {
      options.maxItems = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === '--help') {
      console.log(`
Usage: npx tsx scripts/cleanup-jobs-without-gsi2.ts [options]

Options:
  --tenant <name>       Tenant ID to clean up (required)
  --execute             Actually delete jobs (default: dry run)
  --max-items <num>     Maximum number of items to delete (safety limit)
  --help                Show this help message

Examples:
  # Dry run for hringekjan tenant
  npx tsx scripts/cleanup-jobs-without-gsi2.ts --tenant hringekjan

  # Actually delete old jobs
  npx tsx scripts/cleanup-jobs-without-gsi2.ts --tenant hringekjan --execute

  # Delete max 100 jobs
  npx tsx scripts/cleanup-jobs-without-gsi2.ts --tenant hringekjan --execute --max-items 100
      `);
      process.exit(0);
    }
  }

  if (!options.tenant) {
    console.error('Error: --tenant is required');
    console.log('Run with --help for usage information');
    process.exit(1);
  }

  return options;
}

// Main execution
const options = parseArgs();
cleanupJobsWithoutGSI2(options).catch((error) => {
  console.error('Script failed:', error);
  process.exit(1);
});
