/**
 * Embedding Storage Service Tests
 *
 * Test coverage for S3 batch embedding fetching:
 * - Single embedding fetch
 * - Batch fetch with parallelization
 * - Error handling and retries
 * - Performance metrics
 *
 * @test
 */

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { EmbeddingStorageService } from '../embedding-storage';

const s3Mock = mockClient(S3Client);

describe('EmbeddingStorageService', () => {
  let service: EmbeddingStorageService;

  beforeEach(() => {
    s3Mock.reset();
    service = new EmbeddingStorageService('test-bucket', {
      region: 'eu-west-1',
      batchSize: 10,
      maxConcurrentBatches: 5,
    });
  });

  describe('fetchEmbeddingsBatch', () => {
    it('should fetch embeddings successfully', async () => {
      const embeddingIds = ['emb1', 'emb2', 'emb3'];
      const mockEmbedding = new Array(1024).fill(0.5);

      // Mock S3 GetObjectCommand
      s3Mock.on(GetObjectCommand).resolves({
        Body: {
          transformToString: async () => JSON.stringify(mockEmbedding),
        } as any,
      });

      const results = await service.fetchEmbeddingsBatch(embeddingIds);

      expect(results.size).toBe(3);
      expect(results.get('emb1')).toEqual(mockEmbedding);
      expect(results.get('emb2')).toEqual(mockEmbedding);
      expect(results.get('emb3')).toEqual(mockEmbedding);
    });

    it('should return empty map for empty input', async () => {
      const results = await service.fetchEmbeddingsBatch([]);

      expect(results.size).toBe(0);
    });

    it('should handle S3 errors gracefully', async () => {
      const embeddingIds = ['emb1', 'emb2'];

      // Mock S3 to fail
      s3Mock.on(GetObjectCommand).rejects(new Error('S3 fetch failed'));

      const results = await service.fetchEmbeddingsBatch(embeddingIds);

      // Should return empty map when all fail
      expect(results.size).toBe(0);
    });

    it('should handle partial failures', async () => {
      const embeddingIds = ['emb1', 'emb2', 'emb3'];
      const mockEmbedding = new Array(1024).fill(0.5);

      let callCount = 0;
      s3Mock.on(GetObjectCommand).callsFake((input) => {
        callCount++;
        // Fail on emb2
        if (input.Key?.includes('emb2')) {
          throw new Error('S3 error');
        }

        return Promise.resolve({
          Body: {
            transformToString: async () => JSON.stringify(mockEmbedding),
          } as any,
        });
      });

      const results = await service.fetchEmbeddingsBatch(embeddingIds);

      // Should return 2 embeddings (emb1 and emb3)
      expect(results.size).toBe(2);
      expect(results.has('emb1')).toBe(true);
      expect(results.has('emb2')).toBe(false);
      expect(results.has('emb3')).toBe(true);
    });

    it('should handle invalid embedding format', async () => {
      const embeddingIds = ['emb1', 'emb2'];

      let callCount = 0;
      s3Mock.on(GetObjectCommand).callsFake(async (input) => {
        callCount++;
        // Return non-array for first call
        const invalidResponse =
          callCount === 1
            ? JSON.stringify({ not: 'an array' })
            : JSON.stringify(new Array(1024).fill(0.5));

        return {
          Body: {
            transformToString: async () => invalidResponse,
          } as any,
        };
      });

      const results = await service.fetchEmbeddingsBatch(embeddingIds);

      // Should only return valid embedding
      expect(results.size).toBe(1);
      expect(results.has('emb2')).toBe(true);
    });

    it('should handle wrong embedding dimension', async () => {
      const embeddingIds = ['emb1', 'emb2'];

      let callCount = 0;
      s3Mock.on(GetObjectCommand).callsFake(async (input) => {
        callCount++;
        // Return wrong dimension for first call
        const embedding =
          callCount === 1
            ? new Array(512).fill(0.5) // Wrong size
            : new Array(1024).fill(0.5);

        return {
          Body: {
            transformToString: async () => JSON.stringify(embedding),
          } as any,
        };
      });

      const results = await service.fetchEmbeddingsBatch(embeddingIds);

      // Should only return valid embedding
      expect(results.size).toBe(1);
      expect(results.has('emb2')).toBe(true);
    });

    it('should batch requests efficiently', async () => {
      const embeddingIds = Array.from(
        { length: 25 },
        (_, i) => `emb${i}`
      );
      const mockEmbedding = new Array(1024).fill(0.5);

      let s3CallCount = 0;
      s3Mock.on(GetObjectCommand).callsFake(async () => {
        s3CallCount++;
        return {
          Body: {
            transformToString: async () => JSON.stringify(mockEmbedding),
          } as any,
        };
      });

      const results = await service.fetchEmbeddingsBatch(embeddingIds);

      expect(results.size).toBe(25);
      // 25 embeddings / 10 per batch = 3 batches (rounded up), so 25 S3 calls
      expect(s3CallCount).toBe(25);
    });

    it('should track metrics', async () => {
      const embeddingIds = ['emb1', 'emb2'];
      const mockEmbedding = new Array(1024).fill(0.5);

      s3Mock.on(GetObjectCommand).resolves({
        Body: {
          transformToString: async () => JSON.stringify(mockEmbedding),
        } as any,
      });

      await service.fetchEmbeddingsBatch(embeddingIds);

      const metrics = service.getMetrics();

      expect(metrics.requested).toBe(2);
      expect(metrics.fetched).toBe(2);
      expect(metrics.failed).toBe(0);
      expect(metrics.durationMs).toBeGreaterThan(0);
      expect(metrics.batchCount).toBeGreaterThan(0);
      expect(metrics.bytesTransferred).toBeGreaterThan(0);
    });

    it('should handle empty S3 response', async () => {
      const embeddingIds = ['emb1'];

      s3Mock.on(GetObjectCommand).resolves({
        Body: undefined,
      } as any);

      const results = await service.fetchEmbeddingsBatch(embeddingIds);

      expect(results.size).toBe(0);
    });

    it('should reset metrics', async () => {
      const embeddingIds = ['emb1'];
      const mockEmbedding = new Array(1024).fill(0.5);

      s3Mock.on(GetObjectCommand).resolves({
        Body: {
          transformToString: async () => JSON.stringify(mockEmbedding),
        } as any,
      });

      await service.fetchEmbeddingsBatch(embeddingIds);

      service.resetMetrics();
      const metrics = service.getMetrics();

      expect(metrics.requested).toBe(0);
      expect(metrics.fetched).toBe(0);
      expect(metrics.failed).toBe(0);
      expect(metrics.durationMs).toBe(0);
      expect(metrics.batchCount).toBe(0);
    });

    it('should handle large batch efficiently', async () => {
      const embeddingIds = Array.from(
        { length: 100 },
        (_, i) => `emb${i}`
      );
      const mockEmbedding = new Array(1024).fill(0.5);

      let s3CallCount = 0;
      s3Mock.on(GetObjectCommand).callsFake(async () => {
        s3CallCount++;
        return {
          Body: {
            transformToString: async () => JSON.stringify(mockEmbedding),
          } as any,
        };
      });

      const startTime = Date.now();
      const results = await service.fetchEmbeddingsBatch(embeddingIds);
      const duration = Date.now() - startTime;

      expect(results.size).toBe(100);
      // Should complete reasonably quickly even with 100 embeddings
      expect(duration).toBeLessThan(5000);

      const metrics = service.getMetrics();
      expect(metrics.durationMs).toBeLessThan(5000);
    });
  });

  describe('error handling', () => {
    it('should retry on transient failures', async () => {
      const embeddingIds = ['emb1'];
      const mockEmbedding = new Array(1024).fill(0.5);

      let attemptCount = 0;
      s3Mock.on(GetObjectCommand).callsFake(async () => {
        attemptCount++;
        if (attemptCount < 2) {
          throw new Error('Transient error');
        }

        return {
          Body: {
            transformToString: async () => JSON.stringify(mockEmbedding),
          } as any,
        };
      });

      const results = await service.fetchEmbeddingsBatch(embeddingIds);

      // Should succeed after retry
      expect(results.size).toBe(1);
      expect(attemptCount).toBeGreaterThanOrEqual(2);
    });

    it('should fail after max retries', async () => {
      const embeddingIds = ['emb1'];

      s3Mock.on(GetObjectCommand).rejects(new Error('Persistent error'));

      const results = await service.fetchEmbeddingsBatch(embeddingIds);

      // Should fail after exhausting retries
      expect(results.size).toBe(0);
    });
  });

  describe('performance', () => {
    it('should fetch multiple embeddings quickly', async () => {
      const embeddingIds = Array.from(
        { length: 50 },
        (_, i) => `emb${i}`
      );
      const mockEmbedding = new Array(1024).fill(0.5);

      s3Mock.on(GetObjectCommand).resolves({
        Body: {
          transformToString: async () => JSON.stringify(mockEmbedding),
        } as any,
      });

      const startTime = Date.now();
      const results = await service.fetchEmbeddingsBatch(embeddingIds);
      const duration = Date.now() - startTime;

      expect(results.size).toBe(50);
      // 50 embeddings should complete in reasonable time
      expect(duration).toBeLessThan(3000);

      const metrics = service.getMetrics();
      expect(metrics.durationMs).toBeLessThan(3000);
      expect(metrics.bytesTransferred).toBe(50 * 1024 * 8); // 50 embeddings * 1024 floats * 8 bytes
    });
  });
});
