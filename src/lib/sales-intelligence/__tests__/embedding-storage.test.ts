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
      const salesRecords = [
        { embeddingId: 'emb1', embeddingS3Key: 's3://test-bucket/embeddings/emb1.json' },
        { embeddingId: 'emb2', embeddingS3Key: 's3://test-bucket/embeddings/emb2.json' },
        { embeddingId: 'emb3', embeddingS3Key: 's3://test-bucket/embeddings/emb3.json' },
      ];
      const mockEmbedding = new Array(1024).fill(0.5);

      // Mock S3 GetObjectCommand
      s3Mock.on(GetObjectCommand).resolves({
        Body: {
          transformToString: async () => JSON.stringify(mockEmbedding),
        } as any,
      });

      const results = await service.fetchEmbeddingsBatch(salesRecords);

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
      const salesRecords = [
        { embeddingId: 'emb1', embeddingS3Key: 's3://test-bucket/embeddings/emb1.json' },
        { embeddingId: 'emb2', embeddingS3Key: 's3://test-bucket/embeddings/emb2.json' },
      ];

      // Mock S3 to fail
      s3Mock.on(GetObjectCommand).rejects(new Error('S3 fetch failed'));

      const results = await service.fetchEmbeddingsBatch(salesRecords);

      // Should return empty map when all fail
      expect(results.size).toBe(0);
    });

    it('should handle partial failures', async () => {
      const salesRecords = [
        { embeddingId: 'emb1', embeddingS3Key: 's3://test-bucket/embeddings/emb1.json' },
        { embeddingId: 'emb2', embeddingS3Key: 's3://test-bucket/embeddings/emb2.json' },
        { embeddingId: 'emb3', embeddingS3Key: 's3://test-bucket/embeddings/emb3.json' },
      ];
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

      const results = await service.fetchEmbeddingsBatch(salesRecords);

      // Should return 2 embeddings (emb1 and emb3)
      expect(results.size).toBe(2);
      expect(results.has('emb1')).toBe(true);
      expect(results.has('emb2')).toBe(false);
      expect(results.has('emb3')).toBe(true);
    });

    it('should handle invalid embedding format', async () => {
      const salesRecords = [
        { embeddingId: 'emb1', embeddingS3Key: 's3://test-bucket/embeddings/emb1.json' },
        { embeddingId: 'emb2', embeddingS3Key: 's3://test-bucket/embeddings/emb2.json' },
      ];

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

      const results = await service.fetchEmbeddingsBatch(salesRecords);

      // Should only return valid embedding
      expect(results.size).toBe(1);
      expect(results.has('emb2')).toBe(true);
    });

    it('should handle wrong embedding dimension', async () => {
      const salesRecords = [
        { embeddingId: 'emb1', embeddingS3Key: 's3://test-bucket/embeddings/emb1.json' },
        { embeddingId: 'emb2', embeddingS3Key: 's3://test-bucket/embeddings/emb2.json' },
      ];

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

      const results = await service.fetchEmbeddingsBatch(salesRecords);

      // Should only return valid embedding
      expect(results.size).toBe(1);
      expect(results.has('emb2')).toBe(true);
    });

    it('should batch requests efficiently', async () => {
      const salesRecords = Array.from(
        { length: 25 },
        (_, i) => ({
          embeddingId: `emb${i}`,
          embeddingS3Key: `s3://test-bucket/embeddings/emb${i}.json`,
        })
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

      const results = await service.fetchEmbeddingsBatch(salesRecords);

      expect(results.size).toBe(25);
      // 25 embeddings / 10 per batch = 3 batches (rounded up), so 25 S3 calls
      expect(s3CallCount).toBe(25);
    });

    it('should track metrics', async () => {
      const salesRecords = [
        { embeddingId: 'emb1', embeddingS3Key: 's3://test-bucket/embeddings/emb1.json' },
        { embeddingId: 'emb2', embeddingS3Key: 's3://test-bucket/embeddings/emb2.json' },
      ];
      const mockEmbedding = new Array(1024).fill(0.5);

      s3Mock.on(GetObjectCommand).resolves({
        Body: {
          transformToString: async () => JSON.stringify(mockEmbedding),
        } as any,
      });

      await service.fetchEmbeddingsBatch(salesRecords);

      const metrics = service.getMetrics();

      expect(metrics.requested).toBe(2);
      expect(metrics.fetched).toBe(2);
      expect(metrics.failed).toBe(0);
      expect(metrics.durationMs).toBeGreaterThanOrEqual(0);  // Mocks may be very fast
      expect(metrics.batchCount).toBeGreaterThanOrEqual(1);
      expect(metrics.bytesTransferred).toBeGreaterThan(0);
    });

    it('should handle empty S3 response', async () => {
      const salesRecords = [
        { embeddingId: 'emb1', embeddingS3Key: 's3://test-bucket/embeddings/emb1.json' },
      ];

      s3Mock.on(GetObjectCommand).resolves({
        Body: undefined,
      } as any);

      const results = await service.fetchEmbeddingsBatch(salesRecords);

      expect(results.size).toBe(0);
    });

    it('should reset metrics', async () => {
      const salesRecords = [
        { embeddingId: 'emb1', embeddingS3Key: 's3://test-bucket/embeddings/emb1.json' },
      ];
      const mockEmbedding = new Array(1024).fill(0.5);

      s3Mock.on(GetObjectCommand).resolves({
        Body: {
          transformToString: async () => JSON.stringify(mockEmbedding),
        } as any,
      });

      await service.fetchEmbeddingsBatch(salesRecords);

      service.resetMetrics();
      const metrics = service.getMetrics();

      expect(metrics.requested).toBe(0);
      expect(metrics.fetched).toBe(0);
      expect(metrics.failed).toBe(0);
      expect(metrics.durationMs).toBe(0);
      expect(metrics.batchCount).toBe(0);
    });

    it('should handle large batch efficiently', async () => {
      const salesRecords = Array.from(
        { length: 100 },
        (_, i) => ({
          embeddingId: `emb${i}`,
          embeddingS3Key: `s3://test-bucket/embeddings/emb${i}.json`,
        })
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
      const results = await service.fetchEmbeddingsBatch(salesRecords);
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
      const salesRecords = [
        { embeddingId: 'emb1', embeddingS3Key: 's3://test-bucket/embeddings/emb1.json' },
      ];
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

      const results = await service.fetchEmbeddingsBatch(salesRecords);

      // Should succeed after retry
      expect(results.size).toBe(1);
      expect(attemptCount).toBeGreaterThanOrEqual(2);
    });

    it('should fail after max retries', async () => {
      const salesRecords = [
        { embeddingId: 'emb1', embeddingS3Key: 's3://test-bucket/embeddings/emb1.json' },
      ];

      s3Mock.on(GetObjectCommand).rejects(new Error('Persistent error'));

      const results = await service.fetchEmbeddingsBatch(salesRecords);

      // Should fail after exhausting retries
      expect(results.size).toBe(0);
    });
  });

  describe('performance', () => {
    it('should fetch multiple embeddings quickly', async () => {
      const salesRecords = Array.from(
        { length: 50 },
        (_, i) => ({
          embeddingId: `emb${i}`,
          embeddingS3Key: `s3://test-bucket/embeddings/emb${i}.json`,
        })
      );
      const mockEmbedding = new Array(1024).fill(0.5);

      s3Mock.on(GetObjectCommand).resolves({
        Body: {
          transformToString: async () => JSON.stringify(mockEmbedding),
        } as any,
      });

      const startTime = Date.now();
      const results = await service.fetchEmbeddingsBatch(salesRecords);
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
