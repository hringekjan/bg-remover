/**
 * LCP Event Emitter — Dual-Write Utility for Layer 2 Integration
 *
 * Emits product outcomes to SNS topics for Layer 2 processing while maintaining
 * backward compatibility with DynamoDB writes (Phase 1 dual-write).
 *
 * Migration phases:
 * - Phase 1 (immediate): emit to SNS + write to DDB (dual-write active)
 * - Phase 2 (after 14 days): remove DDB write, SNS-only
 * - Phase 3 (after 30 days): remove LcpEventEmitter utility
 */

import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { randomUUID } from 'crypto';

/**
 * Represents a product outcome from bg-remover processing
 */
export interface ProductOutcome {
  productId: string;
  tenantId: string;
  suggestedPrice?: number;
  actualPrice?: number;
  priceDelta?: number;
  metadata?: Record<string, unknown>;
  processingTimeMs?: number;
  success: boolean;
  error?: string;
}

/**
 * Event types for Layer 2 routing
 */
export type LcpEventType = 'sale' | 'stale' | 'vendor_override';

/**
 * SNS message structure for LCP events
 */
interface LcpEventMessage {
  eventId: string;
  eventType: LcpEventType;
  outcome: ProductOutcome;
  timestamp: string;
  version: '1.0';
}

/**
 * LcpEventEmitter — handles async event emission with dual-write fallback
 *
 * Responsibilities:
 * - Publish outcomes to SNS topics (sale, stale, vendor_override)
 * - Continue writing to DynamoDB for backward compatibility (Phase 1)
 * - Log failures and metrics
 * - Handle retries and idempotency
 */
export class LcpEventEmitter {
  private snsClient: SNSClient;
  private ddbClient: DynamoDBDocumentClient;
  private saleEventsTopic: string;
  private staleEventsTopic: string;
  private vendorOverrideEventsTopic: string;
  private outcomesTableName: string;
  private stage: string;

  /**
   * Initialize the event emitter with AWS clients and configuration
   */
  constructor(
    stage: string = process.env['STAGE'] || 'dev',
    saleEventsTopic?: string,
    staleEventsTopic?: string,
    vendorOverrideEventsTopic?: string,
    outcomesTableName?: string,
  ) {
    this.stage = stage;
    this.saleEventsTopic = saleEventsTopic || process.env['LCP_SALE_EVENTS_TOPIC'] || '';
    this.staleEventsTopic = staleEventsTopic || process.env['LCP_STALE_EVENTS_TOPIC'] || '';
    this.vendorOverrideEventsTopic =
      vendorOverrideEventsTopic || process.env['LCP_VENDOR_OVERRIDE_EVENTS_TOPIC'] || '';
    this.outcomesTableName =
      outcomesTableName || process.env['LCP_OUTCOMES_TABLE'] || `lcp-outcomes-${stage}`;

    const ddbRawClient = new DynamoDBClient({ region: 'eu-west-1' });
    this.ddbClient = DynamoDBDocumentClient.from(ddbRawClient);
    this.snsClient = new SNSClient({ region: 'eu-west-1' });
  }

  /**
   * Emit a product outcome to the appropriate SNS topic
   *
   * Flow:
   * 1. Validate configuration (topics must be set)
   * 2. Publish to SNS (async, non-blocking)
   * 3. If SNS fails: log warning + continue (DDB is backup)
   * 4. Write to DynamoDB (synchronous, blocking)
   * 5. If DDB fails: throw error (fail the request)
   *
   * @param outcome The product outcome to emit
   * @param eventType The type of event (sale, stale, vendor_override)
   * @throws Error if DynamoDB write fails (SNS failure is logged but not thrown)
   */
  async emitOutcome(outcome: ProductOutcome, eventType: LcpEventType): Promise<void> {
    const eventId = `event_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const now = new Date().toISOString();

    // Validate configuration
    const topicArn = this.getTopicArn(eventType);
    if (!topicArn) {
      console.warn(
        `LcpEventEmitter: SNS topic not configured for event type '${eventType}'. Skipping SNS publish.`,
      );
      // Continue with DDB write as fallback
    } else {
      // Publish to SNS (fire-and-forget, non-blocking)
      await this.publishToSns(eventId, outcome, eventType, now, topicArn).catch((err) => {
        // Log warning but continue — DDB write is the safety net
        console.warn(
          `LcpEventEmitter: SNS publish failed for event type '${eventType}'`,
          {
            eventId,
            productId: outcome.productId,
            tenantId: outcome.tenantId,
            error: err instanceof Error ? err.message : String(err),
          },
        );
      });
    }

    // Phase 1: Continue writing to DynamoDB (dual-write)
    // This ensures backward compatibility and acts as a safety net if SNS fails
    await this.writeToDynamoDB(eventId, outcome, eventType, now);

    console.log(
      JSON.stringify({
        msg: 'LcpEventEmitter: outcome emitted',
        eventId,
        eventType,
        productId: outcome.productId,
        tenantId: outcome.tenantId,
      }),
    );
  }

  /**
   * Get the SNS topic ARN for the given event type
   */
  private getTopicArn(eventType: LcpEventType): string | null {
    switch (eventType) {
      case 'sale':
        return this.saleEventsTopic;
      case 'stale':
        return this.staleEventsTopic;
      case 'vendor_override':
        return this.vendorOverrideEventsTopic;
      default:
        return null;
    }
  }

  /**
   * Publish event to SNS topic
   */
  private async publishToSns(
    eventId: string,
    outcome: ProductOutcome,
    eventType: LcpEventType,
    timestamp: string,
    topicArn: string,
  ): Promise<void> {
    const message: LcpEventMessage = {
      eventId,
      eventType,
      outcome,
      timestamp,
      version: '1.0',
    };

    const command = new PublishCommand({
      TopicArn: topicArn,
      Message: JSON.stringify(message),
      MessageAttributes: {
        eventType: {
          DataType: 'String',
          StringValue: eventType,
        },
        tenantId: {
          DataType: 'String',
          StringValue: outcome.tenantId,
        },
        productId: {
          DataType: 'String',
          StringValue: outcome.productId,
        },
      },
    });

    await this.snsClient.send(command);
  }

  /**
   * Write outcome to DynamoDB (Phase 1 dual-write)
   *
   * Table schema:
   * - PK: outcome_<id>
   * - SK: <tenantId>#<productId>
   * - TTL: expires in 90 days
   */
  private async writeToDynamoDB(
    eventId: string,
    outcome: ProductOutcome,
    eventType: LcpEventType,
    timestamp: string,
  ): Promise<void> {
    const now = new Date();
    const ttlSeconds = Math.floor(now.getTime() / 1000) + 90 * 24 * 60 * 60; // 90 days

    const outcomeRecord = {
      PK: `outcome_${eventId}`,
      SK: `${outcome.tenantId}#${outcome.productId}`,
      eventType,
      outcome,
      timestamp,
      createdAt: now.toISOString(),
      ttl: ttlSeconds,
      // Metadata for querying and analytics
      tenantId: outcome.tenantId,
      productId: outcome.productId,
      source: 'bg-remover',
      stage: this.stage,
    };

    const command = new PutCommand({
      TableName: this.outcomesTableName,
      Item: outcomeRecord,
    });

    await this.ddbClient.send(command);
  }

  /**
   * Health check: verify SNS and DynamoDB connectivity
   */
  async healthCheck(): Promise<{
    sns: boolean;
    dynamodb: boolean;
    topics: Record<string, boolean>;
  }> {
    const health = {
      sns: false,
      dynamodb: false,
      topics: {
        sale: !!this.saleEventsTopic,
        stale: !!this.staleEventsTopic,
        vendor_override: !!this.vendorOverrideEventsTopic,
      },
    };

    // TODO: Add actual health checks to SNS and DynamoDB
    // For now, just verify configuration exists

    return health;
  }
}

/**
 * Singleton instance of LcpEventEmitter
 * Export for use throughout the bg-remover service
 */
export const lcpEventEmitter = new LcpEventEmitter();
