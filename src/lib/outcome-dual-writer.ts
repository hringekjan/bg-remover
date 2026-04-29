/**
 * OutcomeDualWriter — Dual-write pattern for bg-remover outcomes
 *
 * Writes outcomes to both Mem0 (HTTP) and DynamoDB (SDK) independently.
 * Each write target has independent retry logic with exponential backoff.
 * Divergence metrics are emitted to CloudWatch for monitoring.
 *
 * Pattern: Promise.allSettled() — both writes proceed in parallel,
 * success is defined as "at least one succeeds", divergence is tracked.
 */

import { DynamoDBClient, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { createCloudWatchMetrics, MetricType } from './cloudwatch-metrics';

/**
 * Outcome structure — union of all outcome types
 * Written to both Mem0 and DynamoDB
 */
export interface Outcome {
  id: string;
  tenantId: string;
  outcomeType: string; // 'sale' | 'override' | 'vendor_approval_*'
  classification: string; // 'restricted' | 'internal'
  createdAt: string; // ISO 8601
  updatedAt: string;
  [key: string]: any; // flexible metadata
}

/**
 * Configuration for dual-write retry behavior
 */
export interface DualWriteConfig {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

const DEFAULT_CONFIG: Required<DualWriteConfig> = {
  maxRetries: 3,
  initialDelayMs: 100,
  maxDelayMs: 5000,
};

/**
 * Result of a single write attempt
 */
interface WriteResult {
  target: 'mem0' | 'ddb';
  success: boolean;
  error?: Error;
  attemptCount: number;
  durationMs: number;
}

/**
 * Overall dual-write result
 */
export interface DualWriteResult {
  outcomId: string;
  mem0Result: WriteResult;
  ddbResult: WriteResult;
  overallSuccess: boolean; // true if at least one succeeded
  diverged: boolean; // true if one succeeded and one failed
}

/**
 * OutcomeDualWriter class — manages dual-write to Mem0 and DynamoDB
 */
export class OutcomeDualWriter {
  private mem0BaseUrl: string;
  private mem0ApiKey: string;
  private ddbClient: DynamoDBClient;
  private ddbTableName: string;
  private config: Required<DualWriteConfig>;
  private cloudwatch: ReturnType<typeof createCloudWatchMetrics>;

  /**
   * Initialize the dual writer
   * @param mem0BaseUrl — Mem0 API base URL (e.g., https://api.mem0.ai)
   * @param mem0ApiKey — Mem0 API key (from env)
   * @param ddbClient — DynamoDB SDK client
   * @param ddbTableName — DynamoDB table name (e.g., lcp-outcomes-dev)
   * @param config — Optional retry configuration
   */
  constructor(
    mem0BaseUrl: string,
    mem0ApiKey: string,
    ddbClient: DynamoDBClient,
    ddbTableName: string,
    config?: DualWriteConfig
  ) {
    this.mem0BaseUrl = mem0BaseUrl;
    this.mem0ApiKey = mem0ApiKey;
    this.ddbClient = ddbClient;
    this.ddbTableName = ddbTableName;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.cloudwatch = createCloudWatchMetrics('bg-remover');
  }

  /**
   * Write outcome to both Mem0 and DynamoDB
   * Both writes happen in parallel with independent retry logic
   */
  async writeOutcome(outcome: Outcome): Promise<DualWriteResult> {
    const startTime = Date.now();

    // Run both writes in parallel
    const [mem0Result, ddbResult] = await Promise.allSettled([
      this.writeToMem0(outcome),
      this.writeToDDB(outcome),
    ]);

    const mem0Resolved = this.resolveResult(mem0Result, 'mem0');
    const ddbResolved = this.resolveResult(ddbResult, 'ddb');

    const overallSuccess = mem0Resolved.success || ddbResolved.success;
    const diverged = mem0Resolved.success !== ddbResolved.success;

    const result: DualWriteResult = {
      outcomId: outcome.id,
      mem0Result: mem0Resolved,
      ddbResult: ddbResolved,
      overallSuccess,
      diverged,
    };

    // Emit metrics
    await this.emitMetrics(result, Date.now() - startTime);

    // Log divergence
    if (diverged) {
      console.warn('DIVERGENCE DETECTED', {
        outcomeId: outcome.id,
        mem0Success: mem0Resolved.success,
        ddbSuccess: ddbResolved.success,
        mem0Error: mem0Resolved.error?.message,
        ddbError: ddbResolved.error?.message,
      });
    }

    return result;
  }

  /**
   * Write outcome to Mem0 with exponential backoff retry
   */
  private async writeToMem0(outcome: Outcome): Promise<void> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        const response = await fetch(`${this.mem0BaseUrl}/api/memories`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.mem0ApiKey}`,
            'X-Outcome-ID': outcome.id,
            'X-Tenant-ID': outcome.tenantId,
          },
          body: JSON.stringify({
            metadata: {
              outcomeType: outcome.outcomeType,
              classification: outcome.classification,
              createdAt: outcome.createdAt,
              updatedAt: outcome.updatedAt,
            },
            data: outcome,
          }),
        });

        if (!response.ok) {
          throw new Error(`Mem0 API error: ${response.status} ${response.statusText}`);
        }

        return; // Success
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < this.config.maxRetries) {
          const delay = Math.min(
            this.config.initialDelayMs * Math.pow(2, attempt - 1),
            this.config.maxDelayMs
          );
          await this.sleep(delay);
        }
      }
    }

    throw lastError || new Error('Mem0 write failed after max retries');
  }

  /**
   * Write outcome to DynamoDB with exponential backoff retry
   */
  private async writeToDDB(outcome: Outcome): Promise<void> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        // Build DynamoDB item
        const item = {
          PK: `OUTCOME#${outcome.tenantId}#${outcome.id}`,
          SK: `${outcome.createdAt}#${outcome.outcomeType}`,
          outcomeId: outcome.id,
          tenantId: outcome.tenantId,
          outcomeType: outcome.outcomeType,
          classification: outcome.classification,
          createdAt: outcome.createdAt,
          updatedAt: outcome.updatedAt,
          ...outcome,
        };

        // Use PutItemCommand for atomicity
        const command = new PutItemCommand({
          TableName: this.ddbTableName,
          Item: marshall(item),
          ReturnConsumedCapacity: 'TOTAL',
        });

        await this.ddbClient.send(command);
        return; // Success
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < this.config.maxRetries) {
          const delay = Math.min(
            this.config.initialDelayMs * Math.pow(2, attempt - 1),
            this.config.maxDelayMs
          );
          await this.sleep(delay);
        }
      }
    }

    throw lastError || new Error('DynamoDB write failed after max retries');
  }

  /**
   * Resolve a Promise.allSettled result into a WriteResult
   */
  private resolveResult(
    result: PromiseSettledResult<void>,
    target: 'mem0' | 'ddb'
  ): WriteResult {
    if (result.status === 'fulfilled') {
      return {
        target,
        success: true,
        attemptCount: 1, // Single attempt if fulfilled
        durationMs: 0, // Approximated
      };
    } else {
      return {
        target,
        success: false,
        error: result.reason instanceof Error ? result.reason : new Error(String(result.reason)),
        attemptCount: this.config.maxRetries,
        durationMs: 0, // Approximated
      };
    }
  }

  /**
   * Emit CloudWatch metrics for dual-write operation
   */
  private async emitMetrics(result: DualWriteResult, durationMs: number): Promise<void> {
    try {
      // Overall success/failure
      await this.cloudwatch.putMetric(
        result.overallSuccess ? MetricType.DualWriteSuccess : MetricType.DualWriteFailure,
        1,
        {
          outcomeType: 'dual-write',
          outcomeId: result.outcomId,
        }
      );

      // Per-target success
      if (result.mem0Result.success) {
        await this.cloudwatch.putMetric(MetricType.Mem0WriteSuccess, 1);
      } else {
        await this.cloudwatch.putMetric(MetricType.Mem0WriteFailure, 1);
      }

      if (result.ddbResult.success) {
        await this.cloudwatch.putMetric(MetricType.DDBWriteSuccess, 1);
      } else {
        await this.cloudwatch.putMetric(MetricType.DDBWriteFailure, 1);
      }

      // Divergence
      if (result.diverged) {
        await this.cloudwatch.putMetric(MetricType.DivergenceDetected, 1, {
          mem0Success: String(result.mem0Result.success),
          ddbSuccess: String(result.ddbResult.success),
        });
      }

      // Duration
      await this.cloudwatch.putMetric(MetricType.DualWriteDuration, durationMs);
    } catch (error) {
      console.error('Failed to emit metrics', error);
      // Don't throw — metric emission failure should not block the write
    }
  }

  /**
   * Sleep helper for exponential backoff
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
