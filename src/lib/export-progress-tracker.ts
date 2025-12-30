/**
 * Export Progress Tracker
 *
 * Tracks SmartGo to S3 Tables exporter progress in DynamoDB for observability
 * and debugging. Enables monitoring of:
 * - Export start/completion times
 * - Success/error counts
 * - Detailed error messages for investigation
 * - Progress history for analytics
 *
 * Data Model:
 * PK: EXPORT#{date} (e.g., EXPORT#2024-12-30)
 * SK: METADATA
 *
 * TTL: 90 days (automatic cleanup)
 */

import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';

/**
 * Export progress record
 */
export interface ExportProgressRecord {
  date: string; // YYYY-MM-DD
  status: 'IN_PROGRESS' | 'COMPLETE' | 'FAILED';
  startTime: string; // ISO format
  endTime?: string; // ISO format
  successCount: number;
  errorCount: number;
  totalCount: number;
  errors?: string[]; // Last error messages
  errorMessage?: string; // For FAILED status
  ttl: number; // Unix timestamp
}

/**
 * Export progress tracker for monitoring and observability
 */
export class ExportProgressTracker {
  constructor(
    private dynamodb: DynamoDBClient,
    private tableName: string
  ) {}

  /**
   * Record export start
   *
   * Creates initial progress record with IN_PROGRESS status
   */
  async recordExportStart(date: string): Promise<void> {
    try {
      const now = new Date();
      const ttlSeconds = Math.floor(now.getTime() / 1000) + 90 * 24 * 60 * 60; // 90 day TTL

      const item = {
        PK: `EXPORT#${date}`,
        SK: 'METADATA',
        date,
        status: 'IN_PROGRESS',
        startTime: now.toISOString(),
        successCount: 0,
        errorCount: 0,
        totalCount: 0,
        ttl: ttlSeconds,
      };

      await this.dynamodb.send(
        new PutItemCommand({
          TableName: this.tableName,
          Item: marshall(item),
        })
      );

      console.log('[ExportProgressTracker] Export start recorded', {
        date,
        startTime: now.toISOString(),
      });
    } catch (error) {
      // Don't throw - progress tracking should not block export
      console.error('[ExportProgressTracker] Failed to record export start', {
        date,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Record export completion with success metrics
   *
   * Updates progress record with COMPLETE status and final counts
   */
  async recordExportComplete(
    date: string,
    successCount: number,
    errorCount: number,
    errors?: string[]
  ): Promise<void> {
    try {
      const now = new Date();
      const ttlSeconds = Math.floor(now.getTime() / 1000) + 90 * 24 * 60 * 60; // 90 day TTL

      const item: Record<string, any> = {
        PK: `EXPORT#${date}`,
        SK: 'METADATA',
        date,
        status: 'COMPLETE',
        successCount,
        errorCount,
        totalCount: successCount + errorCount,
        endTime: now.toISOString(),
        ttl: ttlSeconds,
      };

      // Include errors if provided (limit to last 10 for DynamoDB size constraints)
      if (errors && errors.length > 0) {
        item.errors = errors.slice(0, 10);
      }

      await this.dynamodb.send(
        new PutItemCommand({
          TableName: this.tableName,
          Item: marshall(item),
        })
      );

      console.log('[ExportProgressTracker] Export completion recorded', {
        date,
        successCount,
        errorCount,
        totalCount: successCount + errorCount,
        endTime: now.toISOString(),
      });
    } catch (error) {
      // Don't throw - progress tracking should not block export
      console.error('[ExportProgressTracker] Failed to record export completion', {
        date,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Record export failure
   *
   * Updates progress record with FAILED status and error details
   */
  async recordExportFailed(date: string, errorMessage: string): Promise<void> {
    try {
      const now = new Date();
      const ttlSeconds = Math.floor(now.getTime() / 1000) + 90 * 24 * 60 * 60; // 90 day TTL

      const item = {
        PK: `EXPORT#${date}`,
        SK: 'METADATA',
        date,
        status: 'FAILED',
        errorMessage,
        failedAt: now.toISOString(),
        ttl: ttlSeconds,
      };

      await this.dynamodb.send(
        new PutItemCommand({
          TableName: this.tableName,
          Item: marshall(item),
        })
      );

      console.log('[ExportProgressTracker] Export failure recorded', {
        date,
        errorMessage,
        failedAt: now.toISOString(),
      });
    } catch (error) {
      // Don't throw - progress tracking should not block export
      console.error('[ExportProgressTracker] Failed to record export failure', {
        date,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get progress for a specific export date
   *
   * @param date Export date (YYYY-MM-DD)
   * @returns Progress record or undefined if not found
   */
  async getExportProgress(date: string): Promise<ExportProgressRecord | undefined> {
    try {
      const response = await this.dynamodb.send(
        new GetItemCommand({
          TableName: this.tableName,
          Key: marshall({
            PK: `EXPORT#${date}`,
            SK: 'METADATA',
          }),
        })
      );

      if (!response.Item) {
        return undefined;
      }

      return unmarshall(response.Item) as ExportProgressRecord;
    } catch (error) {
      console.error('[ExportProgressTracker] Failed to get export progress', {
        date,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get recent export history (last N days)
   *
   * @param days Number of days to retrieve (default: 30)
   * @returns Array of progress records sorted by date (newest first)
   */
  async getRecentExportHistory(days: number = 30): Promise<ExportProgressRecord[]> {
    const records: ExportProgressRecord[] = [];

    // Query requires range key, so we need to query each date individually
    // For efficiency, just query recent dates
    const now = new Date();

    for (let i = 0; i < days; i++) {
      const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const dateString = date.toISOString().split('T')[0]; // YYYY-MM-DD

      try {
        const progress = await this.getExportProgress(dateString);
        if (progress) {
          records.push(progress);
        }
      } catch (error) {
        // Continue on error for individual dates
        console.warn('[ExportProgressTracker] Failed to get progress for date', {
          date: dateString,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return records;
  }

  /**
   * Get summary statistics for recent exports
   *
   * @param days Number of days to analyze (default: 30)
   * @returns Summary statistics
   */
  async getSummaryStatistics(days: number = 30): Promise<ExportSummary> {
    const history = await this.getRecentExportHistory(days);

    const summary: ExportSummary = {
      totalExports: history.length,
      completedExports: history.filter((r) => r.status === 'COMPLETE').length,
      failedExports: history.filter((r) => r.status === 'FAILED').length,
      inProgressExports: history.filter((r) => r.status === 'IN_PROGRESS').length,
      totalSuccessfulRecords: 0,
      totalFailedRecords: 0,
      averageSuccessRate: 0,
      lastExport: undefined,
    };

    // Calculate aggregates
    for (const record of history) {
      if (record.status === 'COMPLETE') {
        summary.totalSuccessfulRecords += record.successCount;
        summary.totalFailedRecords += record.errorCount;
      }
    }

    // Calculate average success rate
    const totalRecords = summary.totalSuccessfulRecords + summary.totalFailedRecords;
    if (totalRecords > 0) {
      summary.averageSuccessRate = (summary.totalSuccessfulRecords / totalRecords) * 100;
    }

    // Find most recent export
    if (history.length > 0) {
      summary.lastExport = history[0];
    }

    return summary;
  }
}

/**
 * Export summary statistics
 */
export interface ExportSummary {
  totalExports: number;
  completedExports: number;
  failedExports: number;
  inProgressExports: number;
  totalSuccessfulRecords: number;
  totalFailedRecords: number;
  averageSuccessRate: number; // 0-100
  lastExport?: ExportProgressRecord;
}

/**
 * Create export progress tracker instance
 *
 * Helper function for cleaner instantiation
 */
export function createExportProgressTracker(
  tableName: string = process.env.EXPORT_PROGRESS_TABLE_NAME || `smartgo-exporter-${process.env.STAGE || 'dev'}-progress`
): ExportProgressTracker {
  const dynamodb = new DynamoDBClient({
    region: process.env.AWS_REGION || 'eu-west-1',
  });

  return new ExportProgressTracker(dynamodb, tableName);
}
