/**
 * Sales Intelligence Module
 *
 * Complete DynamoDB implementation for pricing intelligence and sales analytics.
 * Provides type-safe access to sales records with multi-tenant isolation,
 * automatic TTL-based cleanup, and optimized access patterns via sharded indexes.
 *
 * @module lib/sales-intelligence
 *
 * @example
 * ```typescript
 * import {
 *   SalesRepository,
 *   createSalesRecord,
 *   getCategoryShard,
 *   backfillTTL,
 * } from '@/lib/sales-intelligence';
 *
 * // Initialize repository
 * const repo = new SalesRepository({
 *   tableName: 'bg-remover-dev-sales-intelligence',
 *   region: 'eu-west-1',
 * });
 *
 * // Create and store a sale record
 * const record = createSalesRecord({
 *   tenant: 'carousel-labs',
 *   productId: 'prod_123',
 *   saleId: 'sale_abc',
 *   saleDate: '2025-12-29',
 *   salePrice: 99.99,
 *   originalPrice: 199.99,
 *   category: 'dress',
 *   brand: 'Nike',
 *   embeddingId: 'emb_xyz',
 *   embeddingS3Key: 's3://bucket/carousel-labs/products/prod_123/sales/sale_abc.json',
 * });
 *
 * await repo.putSale(record);
 *
 * // Query category trends across all shards
 * const trends = await repo.queryCategorySeason(
 *   'carousel-labs',
 *   'dress',
 *   'SPRING',
 *   '2025-01-01',
 *   '2025-03-31'
 * );
 *
 * // Query product embeddings
 * const embeddings = await repo.queryProductEmbeddings(
 *   'carousel-labs',
 *   'prod_123'
 * );
 *
 * // Analyze brand pricing
 * const brandSales = await repo.queryBrandPricing(
 *   'carousel-labs',
 *   'Nike'
 * );
 *
 * // Batch write multiple records
 * const written = await repo.batchWriteSales(records);
 *
 * // Backfill TTL for existing records (one-time operation)
 * await backfillTTL({
 *   tableName: 'bg-remover-dev-sales-intelligence',
 *   region: 'eu-west-1',
 *   ttlYears: 2,
 * });
 * ```
 */

// Repository
export { SalesRepository } from './sales-repository';
export type { SalesRepositoryConfig, QueryResult } from './sales-repository';

// Types & Interfaces
export type {
  SalesRecord,
  EmbeddingVector,
  FindSimilarProductsRequest,
  SimilarProductResult,
  SeasonalTrendRequest,
  SeasonalTrendResponse,
  BrandPricingRequest,
  BrandPricingResponse,
  DynamoDBItem,
  ShardingConfig,
  QueryStats,
} from '../sales-intelligence-types';

export {
  isSalesRecord,
  isEmbeddingVector,
  validateSalesRecord,
  validateEmbedding,
  createSalesRecord,
  createEmbeddingVector,
} from '../sales-intelligence-types';

// Sharding Utilities
export {
  getCategoryShard,
  getEmbeddingShard,
  getBrandShard,
  verifyShardDistribution,
  buildGSI1PK,
  buildGSI1SK,
  buildGSI2PK,
  buildGSI2SK,
  buildGSI3PK,
  buildGSI3SK,
} from './shard-calculator';

// TTL Backfill
export { backfillTTL } from './backfill-ttl';
export type { BackfillTTLOptions, BackfillProgress } from './backfill-ttl';

// Vector Search (Phase 4.2)
export { VectorSearchService } from './vector-search';
export { EmbeddingStorageService } from './embedding-storage';
export { VectorSearchIntegration, createVectorSearchIntegration } from './vector-search-integration';

export type {
  VectorSearchOptions,
  SimilarProduct,
  VectorSearchMetrics,
} from './vector-search';

export type { EmbeddingFetchMetrics } from './embedding-storage';
