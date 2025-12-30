/**
 * Sales Intelligence Repository
 *
 * Production-grade DynamoDB abstraction for sales records with:
 * - Type-safe operations
 * - Automatic TTL calculation (2-year retention)
 * - Multi-shard querying for GSI access
 * - Comprehensive error handling
 * - Logging and observability
 *
 * @module lib/sales-intelligence/sales-repository
 */

import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  QueryCommand,
  UpdateItemCommand,
  DeleteItemCommand,
  BatchWriteItemCommand,
  ScanCommand,
  type QueryCommandInput,
  type PutItemCommandInput,
  type GetItemCommandInput,
  type UpdateItemCommandInput,
  type DeleteItemCommandInput,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { Logger } from '@aws-lambda-powertools/logger';

import type { SalesRecord } from '../sales-intelligence-types';
import {
  getCategoryShard,
  getEmbeddingShard,
  buildGSI1PK,
  buildGSI1SK,
  buildGSI2PK,
  buildGSI2SK,
  buildGSI3PK,
  buildGSI3SK,
} from './shard-calculator';

/**
 * Configuration for SalesRepository
 */
export interface SalesRepositoryConfig {
  /** DynamoDB table name */
  tableName: string;
  /** AWS region */
  region?: string;
  /** Logger instance (optional) */
  logger?: Logger;
  /** TTL in years (default: 2) */
  ttlYears?: number;
}

/**
 * Query result with pagination support
 */
export interface QueryResult<T> {
  /** Items returned from query */
  items: T[];
  /** Pagination token for next batch */
  nextToken?: string;
  /** Number of items scanned (capacity consumed) */
  scannedCount: number;
  /** Number of items in result (before filters) */
  count: number;
  /** Consumed read capacity units */
  consumedCapacity?: number;
}

/**
 * SalesRepository provides type-safe access to sales intelligence data
 *
 * Example usage:
 * ```typescript
 * const repo = new SalesRepository({
 *   tableName: 'bg-remover-dev-sales-intelligence',
 *   region: 'eu-west-1'
 * });
 *
 * // Write a sale record
 * const record = createSalesRecord({
 *   tenant: 'carousel-labs',
 *   productId: 'prod_123',
 *   saleId: 'sale_abc',
 *   saleDate: '2025-12-29',
 *   salePrice: 99.99,
 *   originalPrice: 199.99,
 *   category: 'dress',
 *   embeddingId: 'emb_xyz',
 *   embeddingS3Key: 's3://bucket/tenant/products/prod_123/sales/sale_abc.json'
 * });
 * await repo.putSale(record);
 *
 * // Query by category
 * const trends = await repo.queryCategorySeason(
 *   'carousel-labs',
 *   'dress',
 *   'SPRING'
 * );
 *
 * // Query product embeddings
 * const embeddings = await repo.queryProductEmbeddings(
 *   'carousel-labs',
 *   'prod_123'
 * );
 * ```
 */
export class SalesRepository {
  private client: DynamoDBClient;
  private tableName: string;
  private logger: Logger;
  private ttlYears: number;

  constructor(config: SalesRepositoryConfig) {
    this.tableName = config.tableName;
    this.ttlYears = config.ttlYears ?? 2;
    this.logger = config.logger ?? new Logger({ serviceName: 'SalesRepository' });

    this.client = new DynamoDBClient({
      region: config.region ?? 'eu-west-1',
    });
  }

  /**
   * Store a single sale record
   *
   * Automatically calculates TTL and populates GSI keys.
   *
   * @param sale - Sales record to store
   * @throws Error if record validation fails
   */
  async putSale(sale: Omit<SalesRecord, 'GSI1PK' | 'GSI1SK' | 'GSI2PK' | 'GSI2SK' | 'GSI3PK' | 'GSI3SK'>): Promise<void> {
    try {
      const ttl = this.calculateTTL(sale.saleDate);

      // Calculate shard assignments
      const categoryShard = getCategoryShard(sale.saleId);
      const embeddingShard = getEmbeddingShard(sale.productId);

      // Build GSI keys
      const gsi1PK = buildGSI1PK(sale.tenant, sale.category, categoryShard);
      const gsi1SK = buildGSI1SK(sale.saleDate, sale.salePrice);
      const gsi2PK = buildGSI2PK(sale.tenant, embeddingShard);
      const gsi2SK = buildGSI2SK(sale.saleDate);

      // Build complete record with GSI keys
      const record: SalesRecord = {
        ...sale,
        ttl,
        GSI1PK: gsi1PK,
        GSI1SK: gsi1SK,
        GSI2PK: gsi2PK,
        GSI2SK: gsi2SK,
      };

      // Add brand GSI keys if brand exists
      if (sale.brand) {
        record.GSI3PK = buildGSI3PK(sale.tenant, sale.brand);
        record.GSI3SK = buildGSI3SK(sale.saleDate, sale.salePrice);
      }

      const command = new PutItemCommand({
        TableName: this.tableName,
        Item: marshall(record),
      } as PutItemCommandInput);

      await this.client.send(command);

      this.logger.info('Sale record stored', {
        tenant: sale.tenant,
        productId: sale.productId,
        saleId: sale.saleId,
        categoryShard,
        embeddingShard,
      });
    } catch (error) {
      this.logger.error('Failed to store sale record', {
        error,
        sale: {
          tenant: sale.tenant,
          productId: sale.productId,
        },
      });
      throw error;
    }
  }

  /**
   * Retrieve a single sale record
   *
   * @param tenant - Tenant identifier
   * @param productId - Product identifier
   * @param saleDate - Sale date (YYYY-MM-DD)
   * @param saleId - Sale identifier
   * @returns Sale record or undefined if not found
   */
  async getSale(
    tenant: string,
    productId: string,
    saleDate: string,
    saleId: string
  ): Promise<SalesRecord | undefined> {
    try {
      const PK = `TENANT#${tenant}#PRODUCT#${productId}`;
      const SK = `SALE#${saleDate}#${saleId}`;

      const command = new GetItemCommand({
        TableName: this.tableName,
        Key: marshall({ PK, SK }),
      } as GetItemCommandInput);

      const response = await this.client.send(command);

      if (!response.Item) {
        return undefined;
      }

      return unmarshall(response.Item) as SalesRecord;
    } catch (error) {
      this.logger.error('Failed to get sale record', {
        error,
        tenant,
        productId,
        saleId,
      });
      throw error;
    }
  }

  /**
   * Query sales by category and season
   *
   * Queries GSI-1 across all 10 shards in parallel.
   * Optionally filters by date range.
   *
   * @param tenant - Tenant identifier
   * @param category - Product category
   * @param season - Season (optional)
   * @param startDate - Start date for filtering (optional, YYYY-MM-DD)
   * @param endDate - End date for filtering (optional, YYYY-MM-DD)
   * @returns Array of matching sales records
   */
  async queryCategorySeason(
    tenant: string,
    category: string,
    season?: string,
    startDate?: string,
    endDate?: string
  ): Promise<SalesRecord[]> {
    try {
      // Query all 10 shards in parallel
      const shardPromises = Array.from({ length: 10 }, (_, shard) =>
        this.queryGSI1Shard(tenant, category, shard, startDate, endDate)
      );

      const shardResults = await Promise.all(shardPromises);
      let results = shardResults.flat();

      // Filter by season if provided
      if (season) {
        results = results.filter((record) => record.season === season);
      }

      this.logger.info('Queried category trends', {
        tenant,
        category,
        season,
        count: results.length,
      });

      return results;
    } catch (error) {
      this.logger.error('Failed to query category season', {
        error,
        tenant,
        category,
      });
      throw error;
    }
  }

  /**
   * Query sales for a specific product's embeddings
   *
   * Queries GSI-2 across relevant shards to find embedding references.
   *
   * @param tenant - Tenant identifier
   * @param productId - Product identifier
   * @param startDate - Start date for filtering (optional)
   * @param endDate - End date for filtering (optional)
   * @returns Array of sales records with embedding info
   */
  async queryProductEmbeddings(
    tenant: string,
    productId: string,
    startDate?: string,
    endDate?: string
  ): Promise<SalesRecord[]> {
    try {
      const embeddingShard = getEmbeddingShard(productId);
      const gsi2PK = buildGSI2PK(tenant, embeddingShard);

      let keyConditionExpression = 'GSI2PK = :pk';
      const expressionValues: Record<string, any> = {
        ':pk': { S: gsi2PK },
      };

      if (startDate && endDate) {
        keyConditionExpression += ' AND GSI2SK BETWEEN :start AND :end';
        expressionValues[':start'] = { S: buildGSI2SK(startDate) };
        expressionValues[':end'] = { S: buildGSI2SK(endDate) };
      }

      const command = new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI-2',
        KeyConditionExpression: keyConditionExpression,
        ExpressionAttributeValues: expressionValues,
      } as QueryCommandInput);

      const response = await this.client.send(command);
      const items = (response.Items || []).map((item) => unmarshall(item) as SalesRecord);

      // Filter by productId since GSI2 is shared across all products
      const filtered = items.filter((item) => item.productId === productId);

      this.logger.info('Queried product embeddings', {
        tenant,
        productId,
        count: filtered.length,
      });

      return filtered;
    } catch (error) {
      this.logger.error('Failed to query product embeddings', {
        error,
        tenant,
        productId,
      });
      throw error;
    }
  }

  /**
   * Query a single GSI2 shard for vector search
   *
   * Used by vector search to find recent sales across all products.
   * Queries a specific embedding shard for sales from a cutoff date forward.
   *
   * @param tenant - Tenant identifier
   * @param shard - Shard number (0-4)
   * @param startDate - Start date for filtering (YYYY-MM-DD)
   * @param limit - Maximum results to return
   * @returns Array of sales records from this shard
   */
  async queryGSI2Shard(
    tenant: string,
    shard: number,
    startDate: string,
    limit: number = 100
  ): Promise<SalesRecord[]> {
    try {
      const gsi2PK = buildGSI2PK(tenant, shard);
      const gsi2SK = buildGSI2SK(startDate);

      const command = new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI-2',
        KeyConditionExpression: 'GSI2PK = :pk AND GSI2SK >= :startDate',
        ExpressionAttributeValues: {
          ':pk': { S: gsi2PK },
          ':startDate': { S: gsi2SK },
        },
        Limit: limit,
      } as QueryCommandInput);

      const response = await this.client.send(command);
      const items = (response.Items || []).map((item) => unmarshall(item) as SalesRecord);

      this.logger.debug('Queried GSI2 shard', {
        tenant,
        shard,
        startDate,
        count: items.length,
      });

      return items;
    } catch (error) {
      this.logger.error('Failed to query GSI2 shard', {
        error,
        tenant,
        shard,
        startDate,
      });
      throw error;
    }
  }

  /**
   * Query sales by brand
   *
   * Queries GSI-3 for brand pricing analysis.
   *
   * @param tenant - Tenant identifier
   * @param brand - Brand name
   * @param startDate - Start date for filtering (optional)
   * @param endDate - End date for filtering (optional)
   * @returns Array of sales records for the brand
   */
  async queryBrandPricing(
    tenant: string,
    brand: string,
    startDate?: string,
    endDate?: string
  ): Promise<SalesRecord[]> {
    try {
      const gsi3PK = buildGSI3PK(tenant, brand);

      let keyConditionExpression = 'GSI3PK = :pk';
      const expressionValues: Record<string, any> = {
        ':pk': { S: gsi3PK },
      };

      if (startDate && endDate) {
        keyConditionExpression += ' AND GSI3SK BETWEEN :start AND :end';
        expressionValues[':start'] = { S: buildGSI3SK(startDate, 0) };
        expressionValues[':end'] = { S: buildGSI3SK(endDate, 999999) };
      }

      const command = new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI-3',
        KeyConditionExpression: keyConditionExpression,
        ExpressionAttributeValues: expressionValues,
      } as QueryCommandInput);

      const response = await this.client.send(command);
      const items = (response.Items || []).map((item) => unmarshall(item) as SalesRecord);

      this.logger.info('Queried brand pricing', {
        tenant,
        brand,
        count: items.length,
      });

      return items;
    } catch (error) {
      this.logger.error('Failed to query brand pricing', {
        error,
        tenant,
        brand,
      });
      throw error;
    }
  }

  /**
   * Update a sale record
   *
   * Partially updates an existing record. Note: Cannot update GSI key attributes.
   * Use delete + put for GSI key changes.
   *
   * @param tenant - Tenant identifier
   * @param productId - Product identifier
   * @param saleDate - Sale date
   * @param saleId - Sale identifier
   * @param updates - Partial update object
   */
  async updateSale(
    tenant: string,
    productId: string,
    saleDate: string,
    saleId: string,
    updates: Partial<Omit<SalesRecord, 'PK' | 'SK'>>
  ): Promise<void> {
    try {
      const PK = `TENANT#${tenant}#PRODUCT#${productId}`;
      const SK = `SALE#${saleDate}#${saleId}`;

      // Build update expression
      const updateExpressions: string[] = [];
      const expressionAttributeValues: Record<string, any> = {};

      Object.entries(updates).forEach(([key, value], index) => {
        // Skip GSI key updates
        if (key.startsWith('GSI')) {
          this.logger.warn(`Skipping GSI key update: ${key}`);
          return;
        }

        const placeholder = `:val${index}`;
        updateExpressions.push(`${key} = ${placeholder}`);
        expressionAttributeValues[placeholder] = value;
      });

      if (updateExpressions.length === 0) {
        this.logger.warn('No attributes to update');
        return;
      }

      // Always update updatedAt
      updateExpressions.push('updatedAt = :updatedAt');
      expressionAttributeValues[':updatedAt'] = new Date().toISOString();

      const command = new UpdateItemCommand({
        TableName: this.tableName,
        Key: marshall({ PK, SK }),
        UpdateExpression: `SET ${updateExpressions.join(', ')}`,
        ExpressionAttributeValues: marshall(expressionAttributeValues),
      } as UpdateItemCommandInput);

      await this.client.send(command);

      this.logger.info('Sale record updated', {
        tenant,
        productId,
        saleId,
      });
    } catch (error) {
      this.logger.error('Failed to update sale record', {
        error,
        tenant,
        productId,
      });
      throw error;
    }
  }

  /**
   * Delete a sale record
   *
   * @param tenant - Tenant identifier
   * @param productId - Product identifier
   * @param saleDate - Sale date
   * @param saleId - Sale identifier
   */
  async deleteSale(
    tenant: string,
    productId: string,
    saleDate: string,
    saleId: string
  ): Promise<void> {
    try {
      const PK = `TENANT#${tenant}#PRODUCT#${productId}`;
      const SK = `SALE#${saleDate}#${saleId}`;

      const command = new DeleteItemCommand({
        TableName: this.tableName,
        Key: marshall({ PK, SK }),
      } as DeleteItemCommandInput);

      await this.client.send(command);

      this.logger.info('Sale record deleted', {
        tenant,
        productId,
        saleId,
      });
    } catch (error) {
      this.logger.error('Failed to delete sale record', {
        error,
        tenant,
        productId,
      });
      throw error;
    }
  }

  /**
   * Batch write multiple sale records
   *
   * Efficient bulk insert for large datasets. Limited to 25 items per batch.
   * Implementation batches larger sets automatically.
   *
   * @param sales - Array of sales records to write
   * @returns Number of successfully written records
   */
  async batchWriteSales(
    sales: Omit<SalesRecord, 'GSI1PK' | 'GSI1SK' | 'GSI2PK' | 'GSI2SK' | 'GSI3PK' | 'GSI3SK'>[]
  ): Promise<number> {
    try {
      let written = 0;

      // Process in chunks of 25 (DynamoDB batch limit)
      for (let i = 0; i < sales.length; i += 25) {
        const chunk = sales.slice(i, Math.min(i + 25, sales.length));

        const requestItems = chunk.map((sale) => {
          const ttl = this.calculateTTL(sale.saleDate);
          const categoryShard = getCategoryShard(sale.saleId);
          const embeddingShard = getEmbeddingShard(sale.productId);

          const record: SalesRecord = {
            ...sale,
            ttl,
            GSI1PK: buildGSI1PK(sale.tenant, sale.category, categoryShard),
            GSI1SK: buildGSI1SK(sale.saleDate, sale.salePrice),
            GSI2PK: buildGSI2PK(sale.tenant, embeddingShard),
            GSI2SK: buildGSI2SK(sale.saleDate),
          };

          if (sale.brand) {
            record.GSI3PK = buildGSI3PK(sale.tenant, sale.brand);
            record.GSI3SK = buildGSI3SK(sale.saleDate, sale.salePrice);
          }

          return {
            PutRequest: {
              Item: marshall(record),
            },
          };
        });

        const command = new BatchWriteItemCommand({
          RequestItems: {
            [this.tableName]: requestItems,
          },
        });

        const response = await this.client.send(command);
        written += chunk.length - (response.UnprocessedItems?.[this.tableName]?.length ?? 0);

        // Log progress
        this.logger.info(`Batch write progress: ${written}/${sales.length}`);
      }

      return written;
    } catch (error) {
      this.logger.error('Failed to batch write sale records', { error });
      throw error;
    }
  }

  /**
   * Query a single GSI1 shard
   *
   * Internal method used by queryCategorySeason.
   *
   * @param tenant - Tenant identifier
   * @param category - Product category
   * @param shard - Shard number (0-9)
   * @param startDate - Optional start date filter
   * @param endDate - Optional end date filter
   * @returns Array of sales records from this shard
   */
  private async queryGSI1Shard(
    tenant: string,
    category: string,
    shard: number,
    startDate?: string,
    endDate?: string
  ): Promise<SalesRecord[]> {
    try {
      const gsi1PK = buildGSI1PK(tenant, category, shard);

      let keyConditionExpression = 'GSI1PK = :pk';
      const expressionValues: Record<string, any> = {
        ':pk': { S: gsi1PK },
      };

      if (startDate && endDate) {
        keyConditionExpression += ' AND GSI1SK BETWEEN :start AND :end';
        expressionValues[':start'] = { S: buildGSI1SK(startDate, 0) };
        expressionValues[':end'] = { S: buildGSI1SK(endDate, 999999) };
      }

      const command = new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI-1',
        KeyConditionExpression: keyConditionExpression,
        ExpressionAttributeValues: expressionValues,
      } as QueryCommandInput);

      const response = await this.client.send(command);
      return (response.Items || []).map((item) => unmarshall(item) as SalesRecord);
    } catch (error) {
      this.logger.error('Failed to query GSI1 shard', {
        error,
        tenant,
        category,
        shard,
      });
      throw error;
    }
  }

  /**
   * Calculate TTL timestamp
   *
   * Returns epoch seconds for a date N years in the future.
   * Used for automatic DynamoDB record expiration.
   *
   * @param saleDate - Sale date (YYYY-MM-DD format)
   * @returns TTL timestamp (seconds since epoch)
   */
  private calculateTTL(saleDate: string): number {
    const date = new Date(saleDate);
    date.setFullYear(date.getFullYear() + this.ttlYears);
    return Math.floor(date.getTime() / 1000);
  }
}
