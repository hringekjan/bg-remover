/**
 * Brand Registry
 *
 * Persists detected brand names to DynamoDB so the system learns new brands
 * over time without requiring code deploys.
 *
 * Single-table design (carousel-main-<stage>):
 *   PK: BRAND_REGISTRY#<tenant>
 *   SK: BRAND#<brand_lowercase>
 *
 * On each successful brand detection, `registerBrand()` upserts the record.
 * On Lambda cold start, `loadRegisteredBrands()` loads all known brands for
 * the tenant so `ai-extractor` can include them in KNOWN_BRANDS lookups.
 *
 * The registry is fire-and-forget — detection failures are logged but never
 * block the main processing pipeline.
 */

import {
  DynamoDBClient,
  PutItemCommand,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';

// ============================================================================
// Types
// ============================================================================

export interface BrandRegistryRecord {
  PK: string;               // BRAND_REGISTRY#<tenant>
  SK: string;               // BRAND#<brand_lowercase>
  tenant: string;
  brandLower: string;       // canonical lowercase key
  displayName: string;      // canonical display form (e.g. "H&M")
  firstSeenAt: string;      // ISO-8601
  lastSeenAt: string;       // ISO-8601
  detectionCount: number;   // number of times detected
}

// ============================================================================
// Registry class
// ============================================================================

export class BrandRegistry {
  private client: DynamoDBClient;
  private tableName: string;
  private tenant: string;

  constructor(client: DynamoDBClient, tableName: string, tenant: string) {
    this.client = client;
    this.tableName = tableName;
    this.tenant = tenant;
  }

  /**
   * Upsert a detected brand into the registry.
   * Fire-and-forget — never throws (logs errors only).
   */
  async registerBrand(displayName: string): Promise<void> {
    const brandLower = displayName.toLowerCase().trim();
    if (!brandLower) return;

    const now = new Date().toISOString();

    try {
      await this.client.send(
        new PutItemCommand({
          TableName: this.tableName,
          Item: marshall({
            PK: `BRAND_REGISTRY#${this.tenant}`,
            SK: `BRAND#${brandLower}`,
            tenant: this.tenant,
            brandLower,
            displayName,
            firstSeenAt: now,
            lastSeenAt: now,
            detectionCount: 1,
          }),
          // Increment detectionCount and update lastSeenAt on conflicts,
          // but never overwrite firstSeenAt or displayName once set.
          ConditionExpression: 'attribute_not_exists(SK)',
        }),
      );
    } catch (err: unknown) {
      // ConditionalCheckFailedException means the record already exists — update it
      if (
        err instanceof Error &&
        err.name === 'ConditionalCheckFailedException'
      ) {
        try {
          const { UpdateItemCommand } = await import('@aws-sdk/client-dynamodb');
          await this.client.send(
            new UpdateItemCommand({
              TableName: this.tableName,
              Key: marshall({
                PK: `BRAND_REGISTRY#${this.tenant}`,
                SK: `BRAND#${brandLower}`,
              }),
              UpdateExpression:
                'SET lastSeenAt = :now ADD detectionCount :one',
              ExpressionAttributeValues: marshall({
                ':now': now,
                ':one': 1,
              }),
            }),
          );
        } catch (updateErr) {
          console.warn('[BrandRegistry] Failed to update brand count:', updateErr);
        }
      } else {
        console.warn('[BrandRegistry] Failed to register brand:', err);
      }
    }
  }

  /**
   * Load all brands for this tenant from the registry.
   * Returns a map of brandLower → displayName.
   * On error, returns empty map (graceful degradation).
   */
  async loadRegisteredBrands(): Promise<Map<string, string>> {
    const brands = new Map<string, string>();

    try {
      let lastKey: Record<string, unknown> | undefined;

      do {
        const result = await this.client.send(
          new QueryCommand({
            TableName: this.tableName,
            KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
            ExpressionAttributeValues: marshall({
              ':pk': `BRAND_REGISTRY#${this.tenant}`,
              ':prefix': 'BRAND#',
            }),
            ProjectionExpression: 'brandLower, displayName',
            ExclusiveStartKey: lastKey
              ? marshall(lastKey)
              : undefined,
          }),
        );

        for (const raw of result.Items ?? []) {
          const item = unmarshall(raw) as Pick<BrandRegistryRecord, 'brandLower' | 'displayName'>;
          if (item.brandLower && item.displayName) {
            brands.set(item.brandLower, item.displayName);
          }
        }

        lastKey = result.LastEvaluatedKey
          ? (unmarshall(result.LastEvaluatedKey) as Record<string, unknown>)
          : undefined;
      } while (lastKey);
    } catch (err) {
      console.warn('[BrandRegistry] Failed to load brands — using defaults only:', err);
    }

    return brands;
  }
}

// ============================================================================
// Singleton (one per Lambda execution environment)
// ============================================================================

let _registry: BrandRegistry | null = null;

export function getBrandRegistry(
  client: DynamoDBClient,
  tableName: string,
  tenant: string,
): BrandRegistry {
  if (!_registry) {
    _registry = new BrandRegistry(client, tableName, tenant);
  }
  return _registry;
}
