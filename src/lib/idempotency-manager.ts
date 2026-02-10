/**
 * Idempotency Manager - Prevents duplicate event processing
 *
 * Uses DynamoDB as a simple deduplication store with TTL-based cleanup.
 * For each unique event, we check if it's already been processed within the TTL window.
 *
 * Key Design:
 * - PK: IDEMPOTENCY#{tenantId}#{eventType}#{eventId}
 * - SK: VERSION (to support multiple versions)
 * - TTL: Auto-expires after configured duration
 * - Simple GetItem + PutItem pattern (not eventually consistent)
 */

import {
  DynamoDBClient,
  PutItemCommand,
  ConditionalCheckFailedException,
} from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

export interface IdempotencyRecord {
  PK: string;
  SK: string;
  tenantId: string;
  eventType: string;
  eventId: string;
  processedAt: string;
  ttl: number;
}

/**
 * IdempotencyManager handles event deduplication
 *
 * Usage:
 * ```typescript
 * const manager = new IdempotencyManager(dynamodbClient, tableName);
 * const isNew = await manager.checkAndSet(
 *   tenantId,
 *   'carousel.product.sold',
 *   productId,
 *   24 * 60 * 60  // 24 hours TTL
 * );
 *
 * if (!isNew) {
 *   console.log('Duplicate event - skipping');
 *   return { statusCode: 200, body: 'Duplicate' };
 * }
 * ```
 */
export class IdempotencyManager {
  private dynamodb: DynamoDBClient;
  private tableName: string;

  constructor(dynamodb: DynamoDBClient, tableName: string) {
    this.dynamodb = dynamodb;
    this.tableName = tableName;
  }

  /**
   * Check if event is new and mark as processed
   *
   * Uses PutItem-first pattern (no GetItem call) to avoid race conditions.
   * Try to write first - if it fails due to condition, it's a duplicate.
   * This eliminates the race window that existed with GetItem + PutItem.
   *
   * @param tenantId - Tenant identifier
   * @param eventType - Event type (e.g., 'carousel.product.sold')
   * @param eventId - Unique event identifier (must be globally unique, e.g., EventBridge event.id)
   * @param ttlSeconds - TTL in seconds (after which record is auto-deleted)
   * @returns true if event is new (first time seeing it), false if duplicate
   */
  async checkAndSet(
    tenantId: string,
    eventType: string,
    eventId: string,
    ttlSeconds: number
  ): Promise<boolean> {
    const PK = `IDEMPOTENCY#${tenantId}#${eventType}#${eventId}`;
    const SK = `IDEMPOTENCY#${eventId}`;
    const now = new Date().toISOString();
    const ttl = Math.floor(Date.now() / 1000) + ttlSeconds;

    try {
      // PutItem FIRST (no GetItem call) - try to write immediately
      // If it succeeds, this is a new event
      // If it fails with ConditionalCheckFailed, it's a duplicate
      await this.dynamodb.send(
        new PutItemCommand({
          TableName: this.tableName,
          Item: marshall({
            PK,
            SK,
            tenantId,
            eventType,
            eventId,
            processedAt: now,
            ttl,
          }),
          ConditionExpression: 'attribute_not_exists(PK)', // Fail if already exists
        })
      );

      console.log('[IdempotencyManager] Event marked as processed (new event)', {
        tenantId,
        eventType,
        eventId,
      });

      return true; // New event processed successfully
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        // Record already exists - this is a duplicate
        console.log('[IdempotencyManager] Duplicate event detected (conditional write failed)', {
          tenantId,
          eventType,
          eventId,
        });
        return false;
      }

      throw error;
    }
  }

}
