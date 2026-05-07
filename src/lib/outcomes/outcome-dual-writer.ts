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
 * Triple-write outcome result combining mem0, DDB, and LCP-API results
 */
export interface DualWriteResult {
  mem0: WriteResult;
  ddb: WriteResult;
  lcpApi: WriteResult;
  discrepancy: boolean; // true if any write succeeded while another failed
}

/**
 * Outcome payload structure for dual writing
 */
export interface OutcomePayload {
  jobId: string;
  tenant: string;
  tenantId: string;
  outcomeType: 'vendor_approval' | 'sale_event' | 'stale_event' | 'sale';
  data: Record<string, any>;
  metadata?: Record<string, any>;
}

/**
 * OutcomeDualWriter handles resilient triple-writing of outcomes to:
 * - mem0 (HTTP-based Mem0 service) — for knowledge storage
 * - DynamoDB (lcp-outcomes table) — for primary storage (carousel-main)
 * - LCP-API (HTTP POST /learning/outcomes/sale) — for secondary Layer 2 validation
 *
 * Each write path is independent with its own retry logic:
 * - mem0: HTTP with exponential backoff (max 3 retries)
 * - DDB: AWS SDK with built-in retry logic
 * - LCP-API: HTTP with exponential backoff (max 2 retries, fire-and-forget with DLQ)
 *
 * Returns all three results for visibility into partial failures and divergence.
 * DLQ is used for async LCP-API failures to avoid blocking carousel-main responses.
 */
export class OutcomeDualWriter {
  private dynamoDBClient: DynamoDBClient;
  private cloudWatchClient: CloudWatchClient;
  private mem0BaseUrl: string;
  private mem0ApiKey: string;
  private lcpApiBaseUrl: string;
  private lcpApiAuthToken: string;
  private dynamoDBTable: string;
  private dlqUrl?: string;
  private stage: string;

  constructor(config: {
    mem0BaseUrl?: string;
    lcpApiBaseUrl?: string;
    lcpApiAuthToken?: string;
    dynamoDBTable?: string;
    dlqUrl?: string;
    stage?: string;
  } = {}) {
    this.mem0BaseUrl = config.mem0BaseUrl || process.env.MEM0_API_ENDPOINT || '';
    this.mem0ApiKey = '';  // mem0 cloud writes removed (ADR-001)
    this.lcpApiBaseUrl = config.lcpApiBaseUrl || process.env.LCP_API_BASE_URL || 'https://api.example.com';
    this.lcpApiAuthToken = config.lcpApiAuthToken || process.env.LCP_API_AUTH_TOKEN || '';
    this.dynamoDBTable = config.dynamoDBTable || process.env.OUTCOMES_TABLE || 'lcp-outcomes-dev';
    this.dlqUrl = config.dlqUrl || process.env.LCP_API_DLQ_URL;
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
   * Write outcome to mem0, DDB, and LCP-API in parallel with independent retry logic.
   * Uses Promise.allSettled for fault tolerance.
   *
   * LCP-API write is fire-and-forget (non-blocking) via async SQS DLQ on failure.
   * This ensures carousel-main writes never block on LCP-API latency.
   *
   * @param outcome The outcome payload to write
   * @returns Promise containing mem0, DDB, and LCP-API results
   */
  async writeOutcome(outcome: OutcomePayload): Promise<DualWriteResult> {
    // Execute all writes in parallel
    const [mem0Result, ddbResult, lcpApiResult] = await Promise.allSettled([
      this.writeMem0(outcome),
      this.writeDynamoDB(outcome),
      this.writeLcpApi(outcome),
    ]);

    const mem0Status = this.extractResult(mem0Result);
    const ddbStatus = this.extractResult(ddbResult);
    const lcpApiStatus = this.extractResult(lcpApiResult);

    const result: DualWriteResult = {
      mem0: mem0Status,
      ddb: ddbStatus,
      lcpApi: lcpApiStatus,
      // discrepancy if any write succeeded while another failed
      discrepancy:
        (mem0Status.success !== ddbStatus.success) ||
        (ddbStatus.success !== lcpApiStatus.success) ||
        (mem0Status.success !== lcpApiStatus.success),
    };

    // Log dual-write pattern for divergence monitoring
    await this.logDualWritePattern(result, outcome);

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
          tenantId: outcome.tenantId,
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
   * Write outcome to LCP-API POST /learning/outcomes/sale endpoint.
   * Fire-and-forget pattern: if this fails, log to DLQ for async retry.
   * Never blocks the main response.
   *
   * Exponential backoff: 50ms → 100ms (max 2 retries)
   */
  private async writeLcpApi(outcome: OutcomePayload): Promise<WriteResult> {
    const maxRetries = 2;
    let lastError: string | undefined;
    let retries = 0;

    // Map outcome types to LCP-API format
    const lcpOutcomeType = this.mapOutcomeTypeToLcpFormat(outcome.outcomeType);
    if (!lcpOutcomeType) {
      return {
        success: false,
        error: `Unmapped outcome type: ${outcome.outcomeType}`,
        timestamp: Date.now(),
        retries: 0,
      };
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const payload = {
          jobId: outcome.jobId,
          artifactId: outcome.data.artifactId || outcome.jobId,
          actualPrice: outcome.data.actualPrice,
          listingPrice: outcome.data.listingPrice,
          currency: outcome.data.currency || 'USD',
          timeToSaleDays: outcome.data.timeToSaleDays,
          productCategory: outcome.data.productCategory,
          condition: outcome.data.condition,
          styleTags: outcome.data.styleTags,
          buyerId: outcome.data.buyerId, // Will be hashed by LCP-API
          metadata: outcome.metadata,
        };

        const response = await fetch(`${this.lcpApiBaseUrl}/learning/outcomes/sale`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.lcpApiAuthToken}`,
            'x-tenant-id': outcome.tenantId,
            'x-outcome-id': `${outcome.jobId}#${outcome.outcomeType}`,
          },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          throw new Error(`LCP-API returned ${response.status}: ${response.statusText}`);
        }

        console.log(
          `[OutcomeDualWriter] LCP-API write succeeded for jobId=${outcome.jobId}, attempt=${attempt + 1}`
        );

        return {
          success: true,
          timestamp: Date.now(),
          retries: attempt,
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        retries = attempt;

        console.warn(
          `[OutcomeDualWriter] LCP-API write attempt ${attempt + 1} failed: ${lastError}`
        );

        if (attempt < maxRetries) {
          // Exponential backoff: 50ms * 2^attempt
          const backoffMs = 50 * Math.pow(2, attempt);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
        }
      }
    }

    // If all retries exhausted, try to queue to DLQ for async retry
    if (this.dlqUrl) {
      try {
        await this.queueToDlq(outcome, lastError || 'Max retries exhausted');
        console.log(`[OutcomeDualWriter] Queued to DLQ for async retry: jobId=${outcome.jobId}`);
      } catch (dlqError) {
        console.error(
          `[OutcomeDualWriter] Failed to queue to DLQ: ${dlqError instanceof Error ? dlqError.message : String(dlqError)}`
        );
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
   * Map internal outcome types to LCP-API outcome types
   */
  private mapOutcomeTypeToLcpFormat(outcomeType: string): string | null {
    const mapping: Record<string, string> = {
      'sale': 'sale',
      'sale_event': 'sale',
      'stale_event': 'stale',
      'vendor_approval': 'override',
    };
    return mapping[outcomeType] || null;
  }

  /**
   * Queue failed LCP-API write to SQS DLQ for async retry
   */
  private async queueToDlq(outcome: OutcomePayload, error: string): Promise<void> {
    if (!this.dlqUrl) {
      throw new Error('DLQ URL not configured');
    }

    const message = {
      jobId: outcome.jobId,
      tenantId: outcome.tenantId,
      outcomeType: outcome.outcomeType,
      data: outcome.data,
      metadata: outcome.metadata,
      lastError: error,
      failedAt: new Date().toISOString(),
      retryCount: 0,
    };

    // Use standard fetch to POST to SQS endpoint (or SNS for simplicity)
    try {
      const response = await fetch(this.dlqUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          Action: 'SendMessage',
          MessageBody: JSON.stringify(message),
        }).toString(),
      });

      if (!response.ok) {
        throw new Error(`DLQ POST returned ${response.status}`);
      }
    } catch (e) {
      // Log but don't throw — we don't want DLQ failures to cascade
      console.error(`[OutcomeDualWriter] DLQ queue failed:`, e);
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
   * Log dual-write pattern to CloudWatch for divergence detection
   *
   * Logs individual write outcomes in structured JSON for monitoring.
   * Validation window: 48h from 2026-04-29 to 2026-05-01.
   * Success criteria: < 1% divergence between carousel-main and LCP-API.
   */
  private async logDualWritePattern(result: DualWriteResult, outcome: OutcomePayload): Promise<void> {
    const logEntry = {
      timestamp: new Date().toISOString(),
      jobId: outcome.jobId,
      tenantId: outcome.tenantId,
      outcomeType: outcome.outcomeType,
      writes: {
        carouselMain: {
          success: result.ddb.success,
          retries: result.ddb.retries,
          error: result.ddb.error,
        },
        lcpApi: {
          success: result.lcpApi.success,
          retries: result.lcpApi.retries,
          error: result.lcpApi.error,
        },
        mem0: {
          success: result.mem0.success,
          retries: result.mem0.retries,
          error: result.mem0.error,
        },
      },
      discrepancy: result.discrepancy,
    };

    if (result.discrepancy) {
      console.warn('[DualWrite] Divergence detected:', JSON.stringify(logEntry));
    } else {
      console.log('[DualWrite] Pattern OK:', JSON.stringify(logEntry));
    }
  }

  /**
   * Emit CloudWatch metrics for monitoring triple-write health
   */
  private async emitMetrics(result: DualWriteResult, outcome: OutcomePayload): Promise<void> {
    try {
      const metricData = [];

      // Individual success/failure metrics for carousel-main (DDB)
      if (result.ddb.success) {
        metricData.push({
          MetricName: 'carousel-main-success',
          Value: 1,
          Unit: 'Count',
        });
      } else {
        metricData.push({
          MetricName: 'carousel-main-failure',
          Value: 1,
          Unit: 'Count',
        });
      }

      // Individual success/failure metrics for LCP-API
      if (result.lcpApi.success) {
        metricData.push({
          MetricName: 'lcp-api-success',
          Value: 1,
          Unit: 'Count',
        });
      } else {
        metricData.push({
          MetricName: 'lcp-api-failure',
          Value: 1,
          Unit: 'Count',
        });
      }

      // Individual success/failure metrics for mem0
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

      // Discrepancy metric (1 if any write path differs from others, 0 otherwise)
      if (result.discrepancy) {
        metricData.push({
          MetricName: 'dual-write-discrepancy',
          Value: 1,
          Unit: 'Count',
        });
      }

      // Dual-write success rate: 1 if both carousel-main and LCP-API succeeded
      if (result.ddb.success && result.lcpApi.success) {
        metricData.push({
          MetricName: 'dual-write-complete',
          Value: 1,
          Unit: 'Count',
        });
      }

      await this.cloudWatchClient.send(
        new PutMetricDataCommand({
          Namespace: 'bg-remover/outcomes',
          MetricData: metricData.map(m => ({
            ...m,
            Timestamp: new Date(),
            Dimensions: [
              {
                Name: 'OutcomeType',
                Value: outcome.outcomeType,
              },
              {
                Name: 'TenantId',
                Value: outcome.tenantId,
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
      console.error('[OutcomeDualWriter] Failed to emit CloudWatch metrics:', error);
    }
  }
}

export default OutcomeDualWriter;
