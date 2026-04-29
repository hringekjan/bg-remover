import { DynamoDBClient, UpdateItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { NodeHttpHandler } from '@smithy/node-http-handler';

/**
 * Result type for individual write operations
 */
export interface WriteResult {
  success: boolean;
  error?: string;
  timestamp: number;
  retries: number;
}

/**
 * Dual-write outcome result combining mem0 and DDB results
 */
export interface DualWriteResult {
  mem0: WriteResult;
  ddb: WriteResult;
  discrepancy: boolean; // true if one succeeded and one failed
}

/**
 * Outcome payload structure for dual writing
 */
export interface OutcomePayload {
  jobId: string;
  tenant: string;
  outcomeType: 'vendor_approval' | 'sale_event' | 'stale_event';
  data: Record<string, any>;
  metadata?: Record<string, any>;
}

/**
 * OutcomeDualWriter handles resilient dual-writing of outcomes to both
 * mem0 (HTTP-based Mem0 service) and DynamoDB (lcp-outcomes table).
 * 
 * Each write path is independent with its own retry logic:
 * - mem0: HTTP with exponential backoff (max 3 retries)
 * - DDB: AWS SDK with built-in retry logic (configurable)
 * 
 * Returns both results for visibility into partial failures.
 */
export class OutcomeDualWriter {
  private dynamoDBClient: DynamoDBClient;
  private cloudWatchClient: CloudWatchClient;
  private mem0BaseUrl: string;
  private mem0ApiKey: string;
  private dynamoDBTable: string;
  private stage: string;

  constructor(config: {
    mem0BaseUrl?: string;
    mem0ApiKey?: string;
    dynamoDBTable?: string;
    stage?: string;
  } = {}) {
    this.mem0BaseUrl = config.mem0BaseUrl || process.env.MEM0_BASE_URL || 'https://api.mem0.com/v1';
    this.mem0ApiKey = config.mem0ApiKey || process.env.MEM0_API_KEY || '';
    this.dynamoDBTable = config.dynamoDBTable || process.env.OUTCOMES_TABLE || 'lcp-outcomes-dev';
    this.stage = config.stage || process.env.STAGE || 'dev';

    this.dynamoDBClient = new DynamoDBClient({
      region: process.env.AWS_REGION || 'eu-west-1',
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 5000,
        requestTimeout: 10000,
      }),
    });

    this.cloudWatchClient = new CloudWatchClient({
      region: process.env.AWS_REGION || 'eu-west-1',
    });
  }

  /**
   * Write outcome to both mem0 and DDB in parallel with independent retry logic.
   * Uses Promise.allSettled for fault tolerance.
   * 
   * @param outcome The outcome payload to write
   * @returns Promise containing both mem0 and DDB results
   */
  async writeOutcome(outcome: OutcomePayload): Promise<DualWriteResult> {
    // Execute both writes in parallel
    const [mem0Result, ddbResult] = await Promise.allSettled([
      this.writeMem0(outcome),
      this.writeDynamoDB(outcome),
    ]);

    const mem0Status = this.extractResult(mem0Result);
    const ddbStatus = this.extractResult(ddbResult);

    const result: DualWriteResult = {
      mem0: mem0Status,
      ddb: ddbStatus,
      discrepancy: mem0Status.success !== ddbStatus.success,
    };

    // Emit metrics
    await this.emitMetrics(result, outcome);

    return result;
  }

  /**
   * Write outcome to mem0 with independent HTTP retry logic.
   * Exponential backoff: 100ms → 200ms → 400ms (max 3 retries)
   */
  private async writeMem0(outcome: OutcomePayload): Promise<WriteResult> {
    const maxRetries = 3;
    let lastError: string | undefined;
    let retries = 0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(`${this.mem0BaseUrl}/memories`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Token ${this.mem0ApiKey}`,
          },
          body: JSON.stringify({
            messages: [
              {
                role: 'user',
                content: this.formatOutcomeForMem0(outcome),
              },
            ],
            metadata: {
              jobId: outcome.jobId,
              tenant: outcome.tenant,
              outcomeType: outcome.outcomeType,
              timestamp: new Date().toISOString(),
            },
          }),
        });

        if (!response.ok) {
          throw new Error(`mem0 API returned ${response.status}: ${response.statusText}`);
        }

        return {
          success: true,
          timestamp: Date.now(),
          retries: attempt,
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        retries = attempt;

        if (attempt < maxRetries) {
          // Exponential backoff: 100ms * 2^attempt
          const backoffMs = 100 * Math.pow(2, attempt);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
        }
      }
    }

    return {
      success: false,
      error: lastError,
      timestamp: Date.now(),
      retries,
    };
  }

  /**
   * Write outcome to DynamoDB with SDK-level retry logic.
   * Retries are handled by the AWS SDK itself with exponential backoff.
   */
  private async writeDynamoDB(outcome: OutcomePayload): Promise<WriteResult> {
    let retries = 0;

    try {
      const pk = `OUTCOME#${outcome.jobId}#${outcome.outcomeType}`;
      const sk = `${outcome.tenant}#${new Date().toISOString()}`;
      const createdAt = Math.floor(Date.now() / 1000);

      const command = new PutItemCommand({
        TableName: this.dynamoDBTable,
        Item: marshall({
          PK: pk,
          SK: sk,
          jobId: outcome.jobId,
          tenant: outcome.tenant,
          outcomeType: outcome.outcomeType,
          data: outcome.data,
          metadata: outcome.metadata || {},
          createdAt, // Timestamp for time-series GSI
          ttl: Math.floor(Date.now() / 1000) + 7776000, // 90 days retention
        }),
      });

      await this.dynamoDBClient.send(command);

      return {
        success: true,
        timestamp: Date.now(),
        retries,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: errorMsg,
        timestamp: Date.now(),
        retries,
      };
    }
  }

  /**
   * Format outcome payload for mem0 storage
   */
  private formatOutcomeForMem0(outcome: OutcomePayload): string {
    return `
Outcome Report:
- Job ID: ${outcome.jobId}
- Tenant: ${outcome.tenant}
- Type: ${outcome.outcomeType}
- Timestamp: ${new Date().toISOString()}

Data:
${JSON.stringify(outcome.data, null, 2)}

Metadata:
${JSON.stringify(outcome.metadata || {}, null, 2)}
    `.trim();
  }

  /**
   * Extract result from PromiseSettledResult
   */
  private extractResult(
    settled: PromiseSettledResult<WriteResult>
  ): WriteResult {
    if (settled.status === 'fulfilled') {
      return settled.value;
    }
    return {
      success: false,
      error: settled.reason instanceof Error ? settled.reason.message : String(settled.reason),
      timestamp: Date.now(),
      retries: 0,
    };
  }

  /**
   * Emit CloudWatch metrics for monitoring dual-write health
   */
  private async emitMetrics(result: DualWriteResult, outcome: OutcomePayload): Promise<void> {
    try {
      const metricData = [];

      // Individual success/failure metrics
      if (result.mem0.success) {
        metricData.push({
          MetricName: 'mem0-success',
          Value: 1,
          Unit: 'Count',
        });
      } else {
        metricData.push({
          MetricName: 'mem0-failure',
          Value: 1,
          Unit: 'Count',
        });
      }

      if (result.ddb.success) {
        metricData.push({
          MetricName: 'ddb-success',
          Value: 1,
          Unit: 'Count',
        });
      } else {
        metricData.push({
          MetricName: 'ddb-failure',
          Value: 1,
          Unit: 'Count',
        });
      }

      // Discrepancy metric (1 if mismatch, 0 otherwise)
      if (result.discrepancy) {
        metricData.push({
          MetricName: 'dual-write-discrepancy',
          Value: 1,
          Unit: 'Count',
        });
      }

      await this.cloudWatchClient.send(
        new PutMetricDataCommand({
          Namespace: 'lcp-outcomes',
          MetricData: metricData.map(m => ({
            ...m,
            Timestamp: new Date(),
            Dimensions: [
              {
                Name: 'OutcomeType',
                Value: outcome.outcomeType,
              },
              {
                Name: 'Tenant',
                Value: outcome.tenant,
              },
              {
                Name: 'Stage',
                Value: this.stage,
              },
            ],
          })),
        })
      );
    } catch (error) {
      // Log but don't fail the write if metrics fail
      console.error('Failed to emit CloudWatch metrics:', error);
    }
  }
}

export default OutcomeDualWriter;
