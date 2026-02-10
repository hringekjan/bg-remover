/**
 * Sales Intelligence Type Definitions
 *
 * Complete TypeScript interface definitions for the proposed pricing intelligence
 * DynamoDB table schema. These types are ready for immediate implementation.
 *
 * Table: bg-remover-{stage}-sales-intelligence
 * Purpose: Store sales records with embeddings for pricing analytics
 */

/**
 * Core Sales Record - What gets stored in DynamoDB
 *
 * Primary Key: TENANT#{tenant}#PRODUCT#{productId}
 * Sort Key:    SALE#{saleDate}#{saleId}
 *
 * GSI1: Category-Season Trends (10 shards)
 *   PK: TENANT#{tenant}#CATEGORY#{category}#SHARD#{shard}
 *   SK: DATE#{saleDate}#PRICE#{salePrice}
 *
 * GSI2: Embedding Lookup (5 shards)
 *   PK: TENANT#{tenant}#EMBTYPE#PRODUCT#SHARD#{shard}
 *   SK: DATE#{saleDate}
 *
 * GSI3: Brand Pricing (Sparse)
 *   PK: TENANT#{tenant}#BRAND#{brand}
 *   SK: DATE#{saleDate}#PRICE#{salePrice}
 */
export interface SalesRecord {
  // ============================================================================
  // DynamoDB Keys
  // ============================================================================

  /** Primary Partition Key: TENANT#{tenant}#PRODUCT#{productId} */
  PK: string;

  /** Primary Sort Key: SALE#{saleDate}#{saleId} */
  SK: string;

  // ============================================================================
  // Core Sale Data (Required)
  // ============================================================================

  /** Unique sale identifier within product */
  saleId: string;

  /** Product identifier (UUID format: prod_xxxxxxxx) */
  productId: string;

  /** Sale date in ISO format (YYYY-MM-DD) */
  saleDate: string;

  /** Price at which product was sold (in USD) */
  salePrice: number;

  /** Original/list price before discount */
  originalPrice: number;

  /** Tenant identifier for multi-tenant isolation */
  tenant: string;

  // ============================================================================
  // Dimensions (For Analytics)
  // ============================================================================

  /** Product category (dress, shoe, jacket, etc.) */
  category: string;

  /** Brand name (required for GSI3, but can be sparse) */
  brand?: string;

  /** Season (spring | summer | fall | winter) */
  season?: string;

  /** Days from listing to sale (for seasonality analysis) */
  daysToSell?: number;

  // ============================================================================
  // Embedding Reference (S3-backed)
  // ============================================================================

  /** Unique embedding identifier */
  embeddingId: string;

  /** S3 path to embedding vector: s3://bucket/{tenant}/products/{productId}/sales/{saleId}.json */
  embeddingS3Key: string;

  // ============================================================================
  // Timestamps
  // ============================================================================

  /** When record was created (ISO 8601) */
  createdAt: string;

  /** When record was last updated (ISO 8601) */
  updatedAt: string;

  /** TTL timestamp (seconds since epoch) - DynamoDB will auto-delete after */
  ttl: number;

  // ============================================================================
  // GSI Attributes (Projections)
  // ============================================================================

  /** GSI1 Partition Key: TENANT#{tenant}#CATEGORY#{category}#SHARD#{0-9} */
  GSI1PK?: string;

  /** GSI1 Sort Key: DATE#{saleDate}#PRICE#{paddedPrice} */
  GSI1SK?: string;

  /** GSI2 Partition Key: TENANT#{tenant}#EMBTYPE#PRODUCT#SHARD#{0-4} */
  GSI2PK?: string;

  /** GSI2 Sort Key: DATE#{saleDate} */
  GSI2SK?: string;

  /** GSI3 Partition Key: TENANT#{tenant}#BRAND#{brand} */
  GSI3PK?: string;

  /** GSI3 Sort Key: DATE#{saleDate}#PRICE#{paddedPrice} */
  GSI3SK?: string;

  // ============================================================================
  // Utility Fields
  // ============================================================================

  /** Discount percentage (calculated field for analytics) */
  discountPercent?: number;

  /** Whether this is a sale (price < originalPrice) */
  isOnSale?: boolean;

  /** Metadata tags for filtering/segmentation */
  tags?: string[];

  /** Custom attributes by tenant */
  customAttributes?: Record<string, unknown>;
}

/**
 * Embedding Vector + Metadata stored in S3
 *
 * File: s3://bucket/{tenant}/products/{productId}/sales/{saleId}.json
 * Size: ~4KB per item
 * Format: JSON
 */
export interface EmbeddingVector {
  /** 1024-dimensional Titan Multimodal embedding */
  embedding: number[];

  /** Associated metadata */
  metadata: {
    /** Original image URL (for verification) */
    imageUrl: string;

    /** Time taken to generate embedding (milliseconds) */
    processingTime: number;

    /** Model identifier (e.g., "titan-multimodal-embeddings-v2") */
    model: string;

    /** Dimensions of original image */
    dimensions?: {
      width: number;
      height: number;
    };

    /** Custom metadata by tenant */
    custom?: Record<string, unknown>;
  };
}

/**
 * Request parameters for finding similar products
 */
export interface FindSimilarProductsRequest {
  /** Tenant identifier */
  tenant: string;

  /** 1024-dimensional embedding to compare against */
  embedding: number[];

  /** How many days back to search (e.g., 90 for Q1) */
  daysBack: number;

  /** Maximum results to return */
  topN: number;

  /** Minimum similarity threshold (0-1) */
  minSimilarity: number;

  /** Optional: Only search specific categories */
  categories?: string[];

  /** Optional: Exclude specific brands */
  excludeBrands?: string[];
}

/**
 * Response from similarity search
 */
export interface SimilarProductResult {
  /** The matching sales record */
  record: SalesRecord;

  /** Cosine similarity score (0-1) */
  similarity: number;

  /** Classification of match type */
  matchType: 'SAME_PRODUCT' | 'LIKELY_SAME' | 'POSSIBLY_SAME' | 'DIFFERENT';

  /** Reason for match (for debugging) */
  reason?: string;
}

/**
 * Request for seasonal trend analysis
 */
export interface SeasonalTrendRequest {
  /** Tenant identifier */
  tenant: string;

  /** Product category to analyze */
  category: string;

  /** Start date (YYYY-MM-DD) */
  startDate: string;

  /** End date (YYYY-MM-DD) */
  endDate: string;

  /** Optional: Specific brands to include */
  brands?: string[];

  /** Optional: Limit results */
  limit?: number;
}

/**
 * Response with trend statistics
 */
export interface SeasonalTrendResponse {
  /** Category analyzed */
  category: string;

  /** Date range analyzed */
  period: {
    start: string;
    end: string;
  };

  /** Price statistics */
  stats: {
    average: number;
    median: number;
    minimum: number;
    maximum: number;
    stdDev: number;
  };

  /** Count of sales */
  saleCount: number;

  /** Detailed records (if requested) */
  records?: SalesRecord[];

  /** Trend direction (up, down, stable) */
  trend: 'UP' | 'DOWN' | 'STABLE';
}

/**
 * Request for brand pricing analysis
 */
export interface BrandPricingRequest {
  /** Tenant identifier */
  tenant: string;

  /** Brand name */
  brand: string;

  /** Start date (YYYY-MM-DD) */
  startDate: string;

  /** End date (YYYY-MM-DD) */
  endDate: string;

  /** Optional: Specific categories */
  categories?: string[];
}

/**
 * Response with brand pricing data
 */
export interface BrandPricingResponse {
  /** Brand analyzed */
  brand: string;

  /** Date range */
  period: {
    start: string;
    end: string;
  };

  /** Pricing stats by category */
  byCategory: {
    [category: string]: {
      count: number;
      avgPrice: number;
      minPrice: number;
      maxPrice: number;
    };
  };

  /** Overall stats */
  overall: {
    totalSales: number;
    avgPrice: number;
    minPrice: number;
    maxPrice: number;
  };
}

/**
 * Utility type for DynamoDB operations
 */
export interface DynamoDBItem {
  PK: string;
  SK: string;
  [key: string]: unknown;
}

/**
 * Configuration for sharding
 */
export interface ShardingConfig {
  /** Number of shards for category-season GSI (recommended: 10) */
  categoryShards: number;

  /** Number of shards for embedding lookup GSI (recommended: 5) */
  embeddingShards: number;

  /** Hash function to use (optional, defaults to built-in) */
  hashFunction?: (key: string) => number;
}

/**
 * Query statistics for monitoring
 */
export interface QueryStats {
  /** Number of items returned */
  itemCount: number;

  /** Number of RCU consumed */
  consumedRCU: number;

  /** Query latency in milliseconds */
  latencyMs: number;

  /** Any additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Type guards for runtime validation
 */

export function isSalesRecord(obj: unknown): obj is SalesRecord {
  if (typeof obj !== 'object' || obj === null) return false;
  const item = obj as Record<string, unknown>;
  return (
    typeof item.PK === 'string' &&
    typeof item.SK === 'string' &&
    typeof item.saleId === 'string' &&
    typeof item.productId === 'string' &&
    typeof item.saleDate === 'string' &&
    typeof item.salePrice === 'number' &&
    typeof item.originalPrice === 'number' &&
    typeof item.tenant === 'string' &&
    typeof item.category === 'string' &&
    typeof item.embeddingId === 'string' &&
    typeof item.embeddingS3Key === 'string' &&
    typeof item.ttl === 'number'
  );
}

export function isEmbeddingVector(obj: unknown): obj is EmbeddingVector {
  if (typeof obj !== 'object' || obj === null) return false;
  const item = obj as Record<string, unknown>;
  return (
    Array.isArray(item.embedding) &&
    item.embedding.every(x => typeof x === 'number') &&
    typeof item.metadata === 'object' &&
    typeof (item.metadata as Record<string, unknown>).imageUrl === 'string' &&
    typeof (item.metadata as Record<string, unknown>).processingTime === 'number'
  );
}

/**
 * Validation functions
 */

export function validateSalesRecord(record: Partial<SalesRecord>): string[] {
  const errors: string[] = [];

  if (!record.PK || !record.PK.startsWith('TENANT#')) {
    errors.push('PK must start with TENANT#');
  }

  if (!record.SK || !record.SK.startsWith('SALE#')) {
    errors.push('SK must start with SALE#');
  }

  if (!record.saleId || record.saleId.length === 0) {
    errors.push('saleId is required');
  }

  if (!record.productId || record.productId.length === 0) {
    errors.push('productId is required');
  }

  if (!record.saleDate || !/^\d{4}-\d{2}-\d{2}$/.test(record.saleDate)) {
    errors.push('saleDate must be in YYYY-MM-DD format');
  }

  if (typeof record.salePrice !== 'number' || record.salePrice < 0) {
    errors.push('salePrice must be a non-negative number');
  }

  if (typeof record.originalPrice !== 'number' || record.originalPrice < 0) {
    errors.push('originalPrice must be a non-negative number');
  }

  if (record.salePrice !== undefined && record.originalPrice !== undefined && record.salePrice > record.originalPrice) {
    errors.push('salePrice cannot exceed originalPrice');
  }

  if (!record.tenant || record.tenant.length === 0) {
    errors.push('tenant is required');
  }

  if (!record.category || record.category.length === 0) {
    errors.push('category is required');
  }

  if (!record.embeddingId || record.embeddingId.length === 0) {
    errors.push('embeddingId is required');
  }

  if (!record.embeddingS3Key || !record.embeddingS3Key.startsWith('s3://')) {
    errors.push('embeddingS3Key must be a valid S3 path');
  }

  if (typeof record.ttl !== 'number' || record.ttl < Date.now() / 1000) {
    errors.push('ttl must be a future timestamp (seconds since epoch)');
  }

  return errors;
}

export function validateEmbedding(embedding: Partial<EmbeddingVector>): string[] {
  const errors: string[] = [];

  if (!Array.isArray(embedding.embedding)) {
    errors.push('embedding must be an array');
  } else if (embedding.embedding.length !== 1024) {
    errors.push('embedding must have exactly 1024 dimensions');
  } else if (!embedding.embedding.every(x => typeof x === 'number')) {
    errors.push('embedding must contain only numbers');
  } else if (embedding.embedding.some(x => !Number.isFinite(x))) {
    errors.push('embedding cannot contain NaN or Infinity values');
  }

  if (!embedding.metadata) {
    errors.push('metadata is required');
  } else {
    if (!embedding.metadata.imageUrl || embedding.metadata.imageUrl.length === 0) {
      errors.push('metadata.imageUrl is required');
    }
    if (typeof embedding.metadata.processingTime !== 'number' || embedding.metadata.processingTime < 0) {
      errors.push('metadata.processingTime must be a non-negative number');
    }
    if (!embedding.metadata.model || embedding.metadata.model.length === 0) {
      errors.push('metadata.model is required');
    }
  }

  return errors;
}

/**
 * Factory functions for creating instances
 */

export function createSalesRecord(
  data: Omit<SalesRecord, 'PK' | 'SK' | 'createdAt' | 'updatedAt' | 'ttl'>
): SalesRecord {
  const now = new Date().toISOString();
  const ttl = Math.floor(Date.now() / 1000) + (2 * 365.25 * 24 * 60 * 60);

  return {
    PK: `TENANT#${data.tenant}#PRODUCT#${data.productId}`,
    SK: `SALE#${data.saleDate}#${data.saleId}`,
    createdAt: now,
    updatedAt: now,
    ttl,
    ...data,
  };
}

export function createEmbeddingVector(
  embedding: number[],
  imageUrl: string,
  processingTime: number,
  model: string = 'titan-multimodal-embeddings-v2'
): EmbeddingVector {
  return {
    embedding,
    metadata: {
      imageUrl,
      processingTime,
      model,
    },
  };
}
