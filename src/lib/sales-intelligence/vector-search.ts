/**
 * Vector Search Service for Sales Intelligence
 *
 * Two-phase vector similarity search:
 * 1. Query DynamoDB GSI-2 for recent sales metadata (fast, <100ms)
 * 2. Fetch embeddings from S3 in batches (parallel, <200ms)
 * 3. Calculate cosine similarity in Lambda memory (<100ms)
 * 4. Filter and sort by similarity threshold
 *
 * Total latency target: <500ms p95
 *
 * The key insight is that full vector scan is inefficient, so we:
 * - Use DynamoDB GSI-2 to get recent sales candidates
 * - Fetch embeddings in parallel from S3
 * - Calculate similarity locally (1024-dim cosine is very fast)
 * - Return top N matches
 *
 * @module lib/sales-intelligence/vector-search
 */

import { Logger } from '@aws-lambda-powertools/logger';
import { SalesRepository, QueryResult } from './sales-repository';
import type { SalesRecord } from '../sales-intelligence-types';
import { EmbeddingStorageService } from './embedding-storage';

/**
 * Vector search options
 */
export interface VectorSearchOptions {
  /** Maximum results to return */
  limit: number;
  /** Minimum cosine similarity threshold (0-1) */
  minSimilarity: number;
  /** Number of days back to search (default: 90) */
  daysBack?: number;
  /** Optional: filter by category */
  category?: string;
}

/**
 * Result of vector similarity search
 */
export interface SimilarProduct extends SalesRecord {
  /** Cosine similarity score (0-1) */
  similarity: number;
  /** Embedding vector (only included if requested) */
  embedding?: number[];
}

/**
 * Performance metrics for vector search
 */
export interface VectorSearchMetrics {
  /** Phase 1: DynamoDB query time (ms) */
  dynamoDbMs: number;
  /** Phase 2: S3 embedding fetch time (ms) */
  s3FetchMs: number;
  /** Phase 3: Similarity calculation time (ms) */
  similarityMs: number;
  /** Total query time (ms) */
  totalMs: number;
  /** Number of candidates evaluated */
  candidates: number;
  /** Number of results returned */
  results: number;
}

/**
 * VectorSearchService - Two-phase similarity search
 *
 * Provides efficient cosine similarity search across sales history using
 * a two-phase approach to avoid full-table scans.
 *
 * Example usage:
 * ```typescript
 * const service = new VectorSearchService({
 *   tenantId: 'carousel-labs',
 *   stage: 'dev',
 *   embeddingsBucket: 'my-bucket',
 *   logger: new Logger({ serviceName: 'VectorSearch' })
 * });
 *
 * const results = await service.findSimilar(
 *   new Array(1024).fill(0.5), // Query embedding
 *   {
 *     limit: 20,
 *     minSimilarity: 0.75,
 *     daysBack: 90,
 *     category: 'dress'
 *   }
 * );
 *
 * console.log(results);
 * console.log(service.getMetrics());
 * ```
 */
export class VectorSearchService {
  private salesRepository: SalesRepository;
  private embeddingStorage: EmbeddingStorageService;
  private logger: Logger;
  private metrics: VectorSearchMetrics = {
    dynamoDbMs: 0,
    s3FetchMs: 0,
    similarityMs: 0,
    totalMs: 0,
    candidates: 0,
    results: 0,
  };

  constructor(options: {
    tenantId: string;
    stage: string;
    embeddingsBucket: string;
    tableName?: string;
    region?: string;
    logger?: Logger;
  }) {
    const {
      tenantId,
      stage,
      embeddingsBucket,
      tableName,
      region = 'eu-west-1',
      logger,
    } = options;

    this.logger = logger || new Logger({ serviceName: 'VectorSearch' });

    // Initialize repository and storage
    this.salesRepository = new SalesRepository({
      tableName:
        tableName || `bg-remover-${stage}-sales-intelligence`,
      region,
      logger: this.logger,
    });

    this.embeddingStorage = new EmbeddingStorageService(
      embeddingsBucket,
      { region, logger: this.logger }
    );

    this.logger.info('VectorSearchService initialized', {
      tenant: tenantId,
      stage,
      bucket: embeddingsBucket,
    });
  }

  /**
   * Find similar products using two-phase vector search
   *
   * Phase 1 (DynamoDB): Query GSI-2 for recent sales metadata
   * Phase 2 (S3): Fetch embeddings in parallel batches
   * Phase 3 (Local): Calculate cosine similarity for each candidate
   * Phase 4 (Memory): Sort by similarity and return top N
   *
   * @param queryEmbedding - 1024-dimensional query embedding
   * @param options - Search options
   * @returns Array of similar products sorted by similarity (descending)
   */
  async findSimilar(
    queryEmbedding: number[],
    options: VectorSearchOptions = {
      limit: 20,
      minSimilarity: 0.70,
      daysBack: 90,
    }
  ): Promise<SimilarProduct[]> {
    if (queryEmbedding.length !== 1024) {
      throw new Error(
        `Invalid query embedding dimension: ${queryEmbedding.length}, expected 1024`
      );
    }

    const startTime = Date.now();

    try {
      // Phase 1: Query DynamoDB for sales metadata
      const phase1Start = Date.now();
      const salesMetadata = await this.querySalesMetadata(
        options.daysBack || 90,
        options.category,
        options.limit * 5 // Fetch more candidates to filter by similarity
      );
      const phase1Ms = Date.now() - phase1Start;
      this.metrics.dynamoDbMs = phase1Ms;
      this.metrics.candidates = salesMetadata.length;

      this.logger.info('Phase 1: DynamoDB query complete', {
        duration: phase1Ms,
        candidates: salesMetadata.length,
      });

      if (salesMetadata.length === 0) {
        this.logger.info('No sales metadata found', {
          daysBack: options.daysBack,
          category: options.category,
        });
        this.metrics.totalMs = Date.now() - startTime;
        return [];
      }

      // Phase 2: Fetch embeddings from S3 in parallel batches
      const phase2Start = Date.now();
      const embeddingIds = salesMetadata.map((s) => s.embeddingId);
      const embeddings = await this.embeddingStorage.fetchEmbeddingsBatch(
        embeddingIds
      );
      const phase2Ms = Date.now() - phase2Start;
      this.metrics.s3FetchMs = phase2Ms;

      this.logger.info('Phase 2: S3 embedding fetch complete', {
        duration: phase2Ms,
        fetched: embeddings.size,
        failed: embeddingIds.length - embeddings.size,
      });

      // Phase 3: Calculate cosine similarity
      const phase3Start = Date.now();
      const similarProducts: SimilarProduct[] = [];

      for (const sale of salesMetadata) {
        const embedding = embeddings.get(sale.embeddingId);

        if (!embedding) {
          this.logger.debug('Missing embedding', { embeddingId: sale.embeddingId });
          continue;
        }

        const similarity = this.cosineSimilarity(queryEmbedding, embedding);

        if (similarity >= options.minSimilarity) {
          similarProducts.push({
            ...sale,
            similarity,
          });
        }
      }

      const phase3Ms = Date.now() - phase3Start;
      this.metrics.similarityMs = phase3Ms;

      this.logger.info('Phase 3: Similarity calculation complete', {
        duration: phase3Ms,
        matches: similarProducts.length,
      });

      // Phase 4: Sort by similarity and return top N
      const results = similarProducts
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, options.limit);

      this.metrics.totalMs = Date.now() - startTime;
      this.metrics.results = results.length;

      this.logger.info('Vector search complete', {
        total: this.metrics.totalMs,
        phase1: this.metrics.dynamoDbMs,
        phase2: this.metrics.s3FetchMs,
        phase3: this.metrics.similarityMs,
        results: results.length,
      });

      return results;
    } catch (error) {
      this.logger.error('Vector search failed', { error });
      throw error;
    }
  }

  /**
   * Query recent sales metadata from DynamoDB
   *
   * Uses GSI-2 to efficiently find sales from the last N days.
   *
   * @param daysBack - Number of days back to search
   * @param category - Optional category filter
   * @param limit - Maximum results to return
   * @returns Array of sales metadata records
   */
  private async querySalesMetadata(
    daysBack: number,
    category?: string,
    limit: number = 100
  ): Promise<SalesRecord[]> {
    try {
      // For now, we'll use a generic query approach
      // In production, this would use GSI-2 with date filtering
      // GSI2PK = TENANT#{tenantId}#EMBEDDING_ACTIVE
      // GSI2SK = DATE#{saleDate}

      const cutoffDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
      const cutoffDateStr = cutoffDate.toISOString().split('T')[0]; // YYYY-MM-DD

      // Note: This is a simplified implementation
      // In production, you'd use queryCategorySeason or create a specialized query method
      const results = await this.salesRepository.queryCategorySeason(
        '', // tenant would come from context
        category || 'all',
        undefined,
        cutoffDateStr
      );

      return results.slice(0, limit);
    } catch (error) {
      this.logger.error('Failed to query sales metadata', { error });
      throw error;
    }
  }

  /**
   * Calculate cosine similarity between two 1024-dimensional vectors
   *
   * Uses efficient dot product calculation with proper normalization.
   * Clamps result to [0, 1] to handle floating-point precision issues.
   *
   * Formula: similarity = (a · b) / (||a|| * ||b||)
   *
   * @param a - First embedding vector
   * @param b - Second embedding vector
   * @returns Cosine similarity score (0-1)
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error(
        `Embedding dimension mismatch: ${a.length} vs ${b.length}`
      );
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    // Single pass through vectors for efficiency
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    // Handle zero vectors
    if (normA === 0 || normB === 0) {
      return 0;
    }

    const similarity = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));

    // Clamp to [0, 1] to handle floating-point errors
    return Math.max(0, Math.min(1, similarity));
  }

  /**
   * Get performance metrics from last search
   */
  getMetrics(): VectorSearchMetrics {
    return { ...this.metrics };
  }

  /**
   * Reset metrics
   */
  resetMetrics(): void {
    this.metrics = {
      dynamoDbMs: 0,
      s3FetchMs: 0,
      similarityMs: 0,
      totalMs: 0,
      candidates: 0,
      results: 0,
    };
  }
}
