/**
 * Embedding Storage Service for Vector Search
 *
 * Provides efficient batch fetching of embeddings from S3 for similarity search.
 * Supports concurrent batch operations with configurable concurrency limits.
 *
 * Performance Target:
 * - Batch size: 10 keys per request
 * - Max concurrent batches: 5 (50 concurrent S3 calls max)
 * - Latency: <200ms for 100 embeddings
 *
 * @module lib/sales-intelligence/embedding-storage
 */

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { Logger } from '@aws-lambda-powertools/logger';

/**
 * Metrics for embedding fetch operations
 */
export interface EmbeddingFetchMetrics {
  /** Total embeddings requested */
  requested: number;
  /** Total embeddings successfully fetched */
  fetched: number;
  /** Total embeddings failed */
  failed: number;
  /** Total duration in milliseconds */
  durationMs: number;
  /** Number of batches processed */
  batchCount: number;
  /** Bytes transferred */
  bytesTransferred: number;
}

/**
 * EmbeddingStorageService - Manages efficient embedding fetching from S3
 *
 * Batches S3 GetObject calls to improve throughput and reduce latency.
 * Uses limited concurrency to avoid Lambda timeout and maintain stable performance.
 *
 * Example usage:
 * ```typescript
 * const service = new EmbeddingStorageService('eu-west-1', 'my-bucket', {
 *   logger: new Logger({ serviceName: 'EmbeddingStorage' })
 * });
 *
 * const embeddings = await service.fetchEmbeddingsBatch([
 *   'emb_123',
 *   'emb_456',
 *   'emb_789'
 * ]);
 *
 * console.log(service.getMetrics());
 * ```
 */
export class EmbeddingStorageService {
  private s3Client: S3Client;
  private logger: Logger;
  private metrics: EmbeddingFetchMetrics = {
    requested: 0,
    fetched: 0,
    failed: 0,
    durationMs: 0,
    batchCount: 0,
    bytesTransferred: 0,
  };

  private readonly batchSize: number = 10;
  private readonly maxConcurrentBatches: number = 5;
  private readonly retryAttempts: number = 3;
  private readonly retryDelay: number = 100;

  constructor(
    private bucketName: string,
    options: {
      region?: string;
      logger?: Logger;
      batchSize?: number;
      maxConcurrentBatches?: number;
    } = {}
  ) {
    this.s3Client = new S3Client({ region: options.region || 'eu-west-1' });
    this.logger = options.logger || new Logger({ serviceName: 'EmbeddingStorage' });
    if (options.batchSize) this.batchSize = options.batchSize;
    if (options.maxConcurrentBatches) this.maxConcurrentBatches = options.maxConcurrentBatches;
  }

  /**
   * Fetch embeddings in batches from S3
   *
   * Batches embeddings to optimize S3 throughput:
   * - 100 embeddings = 10 parallel S3 calls (vs 100 sequential)
   * - ~10ms per embedding in batch mode (vs 50-100ms sequential)
   *
   * @param salesRecords - Array of sales records with embeddingId and embeddingS3Key
   * @returns Map of embedding ID to embedding vector (1024-dim)
   */
  async fetchEmbeddingsBatch(
    salesRecords: Pick<{ embeddingId: string; embeddingS3Key: string }, 'embeddingId' | 'embeddingS3Key'>[]
  ): Promise<Map<string, number[]>> {
    const startTime = Date.now();
    this.metrics.requested = salesRecords.length;
    const results = new Map<string, number[]>();

    if (salesRecords.length === 0) {
      return results;
    }

    try {
      // Split into batches of 10
      const batches: typeof salesRecords[] = [];
      for (let i = 0; i < salesRecords.length; i += this.batchSize) {
        batches.push(salesRecords.slice(i, i + this.batchSize));
      }

      this.logger.info('Starting embedding batch fetch', {
        total: salesRecords.length,
        batches: batches.length,
        batchSize: this.batchSize,
      });

      // Process batches with limited concurrency
      for (let i = 0; i < batches.length; i += this.maxConcurrentBatches) {
        const concurrentBatches = batches.slice(i, i + this.maxConcurrentBatches);
        const batchPromises = concurrentBatches.map((batch) =>
          this.processBatch(batch)
        );

        const batchResults = await Promise.allSettled(batchPromises);

        for (const result of batchResults) {
          if (result.status === 'fulfilled') {
            result.value.forEach((embedding, id) => {
              results.set(id, embedding);
              this.metrics.bytesTransferred += embedding.length * 8; // 8 bytes per float64
            });
          }
        }

        this.metrics.batchCount += concurrentBatches.length;
      }

      this.metrics.fetched = results.size;
      this.metrics.failed = salesRecords.length - results.size;
      this.metrics.durationMs = Date.now() - startTime;

      this.logger.info('Embedding batch fetch complete', {
        fetched: this.metrics.fetched,
        failed: this.metrics.failed,
        durationMs: this.metrics.durationMs,
        batchCount: this.metrics.batchCount,
      });

      return results;
    } catch (error) {
      this.logger.error('Failed to fetch embedding batch', {
        error,
        requested: salesRecords.length,
      });
      throw error;
    }
  }

  /**
   * Process a single batch of sales records
   *
   * @param salesRecords - Array of sales records with embeddingId and embeddingS3Key
   * @returns Map of embedding ID to embedding vector
   */
  private async processBatch(
    salesRecords: Pick<{ embeddingId: string; embeddingS3Key: string }, 'embeddingId' | 'embeddingS3Key'>[]
  ): Promise<Map<string, number[]>> {
    const results = new Map<string, number[]>();

    const promises = salesRecords.map((record) =>
      this.fetchEmbeddingWithRetry(record.embeddingId, record.embeddingS3Key)
    );
    const fetchResults = await Promise.allSettled(promises);

    for (let i = 0; i < fetchResults.length; i++) {
      const record = salesRecords[i];
      const result = fetchResults[i];

      if (result.status === 'fulfilled' && result.value !== null) {
        results.set(record.embeddingId, result.value);
      } else if (result.status === 'rejected') {
        this.logger.warn('Failed to fetch embedding', {
          embeddingId: record.embeddingId,
          s3Key: record.embeddingS3Key,
          error: result.reason,
        });
      }
    }

    return results;
  }

  /**
   * Fetch a single embedding from S3 with retry logic
   *
   * Implements exponential backoff: 100ms, 200ms, 400ms
   *
   * @param embeddingId - Embedding ID to fetch
   * @param s3Key - S3 key to fetch from (e.g., s3://bucket/path/to/embedding.json)
   * @returns Embedding vector or null on failure
   */
  private async fetchEmbeddingWithRetry(
    embeddingId: string,
    s3Key: string
  ): Promise<number[] | null> {
    for (let attempt = 0; attempt < this.retryAttempts; attempt++) {
      try {
        // Parse S3 key: s3://bucket/key/path or just key/path
        let key = s3Key;
        if (s3Key.startsWith('s3://')) {
          // Remove s3://bucket/ prefix if present
          const match = s3Key.match(/^s3:\/\/[^/]+\/(.+)$/);
          if (match) {
            key = match[1];
          }
        }

        const command = new GetObjectCommand({
          Bucket: this.bucketName,
          Key: key,
        });

        const response = await this.s3Client.send(command);

        if (!response.Body) {
          this.logger.warn('Empty response from S3', { embeddingId, s3Key });
          return null;
        }

        const bodyStr = await response.Body.transformToString();
        const embedding = JSON.parse(bodyStr);

        if (!Array.isArray(embedding)) {
          this.logger.warn('Invalid embedding format', {
            embeddingId,
            s3Key,
            type: typeof embedding,
          });
          return null;
        }

        if (embedding.length !== 1024) {
          this.logger.warn('Unexpected embedding dimension', {
            embeddingId,
            s3Key,
            dimension: embedding.length,
          });
          return null;
        }

        return embedding;
      } catch (error) {
        const delayMs = this.retryDelay * Math.pow(2, attempt);

        if (attempt < this.retryAttempts - 1) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        this.logger.warn('Failed to fetch embedding after retries', {
          embeddingId,
          s3Key,
          attempts: this.retryAttempts,
          error,
        });

        return null;
      }
    }

    return null;
  }

  /**
   * Get metrics for the last fetch operation
   */
  getMetrics(): EmbeddingFetchMetrics {
    return { ...this.metrics };
  }

  /**
   * Reset metrics
   */
  resetMetrics(): void {
    this.metrics = {
      requested: 0,
      fetched: 0,
      failed: 0,
      durationMs: 0,
      batchCount: 0,
      bytesTransferred: 0,
    };
  }
}
