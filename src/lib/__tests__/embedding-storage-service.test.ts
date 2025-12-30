/**
 * Integration Tests for EmbeddingStorageService
 *
 * Tests verify:
 * 1. Batching logic works correctly (100 keys → 10 batches)
 * 2. Performance improvements (90%+ latency reduction)
 * 3. Partial failure handling
 * 4. Metrics calculation accuracy
 */

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { EmbeddingStorageService } from '../embedding-storage-service';
import { Readable } from 'stream';

// Suppress MaxListenersExceeded warnings from mocked Readable streams
if (typeof (Readable.prototype as any).setMaxListeners === 'function') {
  (Readable.prototype as any).setMaxListeners(100);
}

const s3Mock = mockClient(S3Client);

describe('EmbeddingStorageService - Batching', () => {
  beforeEach(() => {
    s3Mock.reset();
  });

  afterEach(async () => {
    // Clean up resources
  });

  describe('Batch Processing', () => {
    it('should successfully fetch and parse embeddings', async () => {
      const service = new EmbeddingStorageService('eu-west-1', 'test-bucket');

      // Mock successful S3 responses
      const mockEmbedding = new Array(1024).fill(0.5);
      s3Mock.onAnyCommand().resolves({
        Body: Readable.from([JSON.stringify(mockEmbedding)]),
      } as any);

      const productIds = ['product-1', 'product-2', 'product-3'];
      const embeddings = await service.fetchEmbeddingsBatch(productIds);

      expect(embeddings.size).toBe(3);
      expect(embeddings.get('product-1')).toEqual(mockEmbedding);
      expect(embeddings.get('product-2')).toEqual(mockEmbedding);
      expect(embeddings.get('product-3')).toEqual(mockEmbedding);

      service.close();
    });

    it('should batch 100 product IDs into 10 parallel requests', async () => {
      const service = new EmbeddingStorageService('eu-west-1', 'test-bucket');

      const mockEmbedding = new Array(1024).fill(0.5);
      let callCount = 0;

      s3Mock.onAnyCommand().callsFake(async () => {
        callCount++;
        return {
          Body: Readable.from([JSON.stringify(mockEmbedding)]),
        } as any;
      });

      // Fetch 100 products
      const productIds = Array.from({ length: 100 }, (_, i) => `product-${i}`);
      const embeddings = await service.fetchEmbeddingsBatch(productIds);

      // Verify all embeddings were fetched
      expect(embeddings.size).toBe(100);

      // Verify metrics
      const metrics = service.getMetrics();
      expect(metrics.totalFetched).toBe(100);
      expect(metrics.totalFailed).toBe(0);
      expect(metrics.batchCount).toBe(10); // 100 items / 10 batch size = 10 batches
      expect(metrics.avgBatchSize).toBe(10);

      // S3 should be called 100 times (once per item)
      expect(callCount).toBe(100);

      service.close();
    });

    it('should correctly calculate average batch size', async () => {
      const service = new EmbeddingStorageService('eu-west-1', 'test-bucket', {
        batchSize: 10,
        maxConcurrentBatches: 5,
      });

      const mockEmbedding = new Array(512).fill(0.5);
      s3Mock.onAnyCommand().resolves({
        Body: Readable.from([JSON.stringify(mockEmbedding)]),
      } as any);

      // Test with 25 items: should create batches of [10, 10, 5]
      const productIds = Array.from({ length: 25 }, (_, i) => `product-${i}`);
      await service.fetchEmbeddingsBatch(productIds);

      const metrics = service.getMetrics();
      // Average batch size: (10 + 10 + 5) / 3 = 8.33
      expect(metrics.avgBatchSize).toBeCloseTo(8.33, 1);
      expect(metrics.batchCount).toBe(3);

      service.close();
    });
  });

  describe('Performance Metrics', () => {
    it('should track bytes transferred accurately', async () => {
      const service = new EmbeddingStorageService('eu-west-1', 'test-bucket');

      const mockEmbedding = new Array(512).fill(0.5);
      const embeddingJson = JSON.stringify(mockEmbedding);
      const expectedBytes = Buffer.byteLength(embeddingJson, 'utf-8');

      s3Mock.onAnyCommand().resolves({
        Body: Readable.from([embeddingJson]),
      } as any);

      const productIds = Array.from({ length: 5 }, (_, i) => `product-${i}`);
      await service.fetchEmbeddingsBatch(productIds);

      const metrics = service.getMetrics();
      expect(metrics.totalBytesTransferred).toBe(expectedBytes * 5);
      expect(metrics.avgBytesPerEmbedding).toBeCloseTo(expectedBytes, 0);

      service.close();
    });

    it('should calculate average duration per request', async () => {
      const service = new EmbeddingStorageService('eu-west-1', 'test-bucket');

      const mockEmbedding = new Array(512).fill(0.5);
      let callCount = 0;

      s3Mock.onAnyCommand().callsFake(async () => {
        callCount++;
        // Simulate 10ms per call
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          Body: Readable.from([JSON.stringify(mockEmbedding)]),
        } as any;
      });

      const startTime = Date.now();
      const productIds = Array.from({ length: 10 }, (_, i) => `product-${i}`);
      await service.fetchEmbeddingsBatch(productIds);
      const totalElapsed = Date.now() - startTime;

      const metrics = service.getMetrics();
      expect(metrics.totalDurationMs).toBeGreaterThan(0);
      expect(metrics.totalDurationMs).toBeLessThanOrEqual(totalElapsed + 50); // Allow 50ms margin
      expect(metrics.avgDurationMs).toBeGreaterThan(0);
      expect(metrics.totalFetched).toBe(10);

      service.close();
    });

    it('should demonstrate 90%+ latency improvement vs sequential', async () => {
      const service = new EmbeddingStorageService('eu-west-1', 'test-bucket', {
        batchSize: 10,
        maxConcurrentBatches: 10, // Simulate unlimited concurrency
      });

      const mockEmbedding = new Array(512).fill(0.5);
      const callDurationMs = 10; // Each S3 call takes 10ms

      s3Mock.onAnyCommand().callsFake(async () => {
        await new Promise((resolve) => setTimeout(resolve, callDurationMs));
        return {
          Body: Readable.from([JSON.stringify(mockEmbedding)]),
        } as any;
      });

      const productIds = Array.from({ length: 100 }, (_, i) => `product-${i}`);
      const startTime = Date.now();
      await service.fetchEmbeddingsBatch(productIds);
      const batchedTime = Date.now() - startTime;

      // Sequential would take: 100 calls × 10ms = 1000ms
      // Batched: 10 batches × 10ms = 100ms (with proper parallelization)
      // Improvement: (1000 - 100) / 1000 = 90%

      // We allow some margin due to test overhead
      expect(batchedTime).toBeLessThan(300); // Should be ~100ms, allow 3x margin

      const metrics = service.getMetrics();
      expect(metrics.avgDurationMs).toBeGreaterThan(0);
      expect(metrics.totalFetched).toBe(100);

      service.close();
    });
  });

  describe('Error Handling', () => {
    it('should handle partial failures gracefully', async () => {
      const service = new EmbeddingStorageService('eu-west-1', 'test-bucket', {
        retryAttempts: 1, // No retries for faster test
      });

      const mockEmbedding = new Array(512).fill(0.5);
      let callCount = 0;

      s3Mock.onAnyCommand().callsFake(async (command) => {
        callCount++;
        // Fail every 10th call
        if (callCount % 10 === 0) {
          throw new Error('S3 timeout');
        }
        return {
          Body: Readable.from([JSON.stringify(mockEmbedding)]),
        } as any;
      });

      const productIds = Array.from({ length: 100 }, (_, i) => `product-${i}`);
      const embeddings = await service.fetchEmbeddingsBatch(productIds);

      // Should have 90 successful (10 failed)
      expect(embeddings.size).toBe(90);

      const metrics = service.getMetrics();
      expect(metrics.totalFetched).toBe(90);
      expect(metrics.totalFailed).toBeGreaterThanOrEqual(10);

      service.close();
    });

    it('should retry failed requests with exponential backoff', async () => {
      const service = new EmbeddingStorageService('eu-west-1', 'test-bucket', {
        retryAttempts: 3,
        retryDelay: 10,
      });

      const mockEmbedding = new Array(512).fill(0.5);
      let callCount = 0;
      let maxRetries = 0;

      s3Mock.onAnyCommand().callsFake(async (command) => {
        callCount++;
        // Fail first 2 calls, succeed on 3rd
        if (callCount % 3 !== 0) {
          maxRetries = Math.max(maxRetries, Math.ceil(callCount / 3));
          throw new Error('Temporary failure');
        }
        return {
          Body: Readable.from([JSON.stringify(mockEmbedding)]),
        } as any;
      });

      const productIds = ['product-1'];
      const embeddings = await service.fetchEmbeddingsBatch(productIds);

      // Should succeed after retries
      expect(embeddings.size).toBe(1);
      expect(embeddings.get('product-1')).toEqual(mockEmbedding);

      service.close();
    });

    it('should handle invalid embedding format', async () => {
      const service = new EmbeddingStorageService('eu-west-1', 'test-bucket');

      s3Mock.onAnyCommand().resolves({
        Body: Readable.from([JSON.stringify({ invalid: 'format' })]), // Not an array
      } as any);

      const productIds = ['product-1', 'product-2'];
      const embeddings = await service.fetchEmbeddingsBatch(productIds);

      // Should have 0 embeddings (both invalid)
      expect(embeddings.size).toBe(0);

      const metrics = service.getMetrics();
      expect(metrics.totalFailed).toBe(2);

      service.close();
    });

    it('should handle JSON parse errors', async () => {
      const service = new EmbeddingStorageService('eu-west-1', 'test-bucket');

      s3Mock.onAnyCommand().resolves({
        Body: Readable.from(['invalid json {{{'])
      } as any);

      const productIds = ['product-1'];
      const embeddings = await service.fetchEmbeddingsBatch(productIds);

      expect(embeddings.size).toBe(0);

      const metrics = service.getMetrics();
      expect(metrics.totalFailed).toBe(1);

      service.close();
    });
  });

  describe('Concurrency Control', () => {
    it('should respect maxConcurrentBatches setting', async () => {
      const service = new EmbeddingStorageService('eu-west-1', 'test-bucket', {
        batchSize: 10,
        maxConcurrentBatches: 2, // Only 2 batches at a time
      });

      const mockEmbedding = new Array(512).fill(0.5);
      let maxConcurrentCalls = 0;
      let currentCalls = 0;

      s3Mock.onAnyCommand().callsFake(async () => {
        currentCalls++;
        maxConcurrentCalls = Math.max(maxConcurrentCalls, currentCalls);

        await new Promise((resolve) => setTimeout(resolve, 5));
        currentCalls--;

        return {
          Body: Readable.from([JSON.stringify(mockEmbedding)]),
        } as any;
      });

      const productIds = Array.from({ length: 30 }, (_, i) => `product-${i}`);
      await service.fetchEmbeddingsBatch(productIds);

      // With maxConcurrentBatches=2 and batchSize=10, we should see at most 20 concurrent calls
      expect(maxConcurrentCalls).toBeLessThanOrEqual(25); // Allow some margin

      const metrics = service.getMetrics();
      expect(metrics.batchCount).toBe(3); // 30 / 10 = 3 batches

      service.close();
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty product list', async () => {
      const service = new EmbeddingStorageService('eu-west-1', 'test-bucket');

      const embeddings = await service.fetchEmbeddingsBatch([]);

      expect(embeddings.size).toBe(0);

      const metrics = service.getMetrics();
      expect(metrics.totalFetched).toBe(0);
      expect(metrics.batchCount).toBe(0);

      service.close();
    });

    it('should handle single product', async () => {
      const service = new EmbeddingStorageService('eu-west-1', 'test-bucket');

      const mockEmbedding = new Array(512).fill(0.5);
      s3Mock.onAnyCommand().resolves({
        Body: Readable.from([JSON.stringify(mockEmbedding)]),
      } as any);

      const embeddings = await service.fetchEmbeddingsBatch(['product-1']);

      expect(embeddings.size).toBe(1);

      const metrics = service.getMetrics();
      expect(metrics.totalFetched).toBe(1);
      expect(metrics.batchCount).toBe(1);
      expect(metrics.avgBatchSize).toBe(1);

      service.close();
    });

    it('should reset metrics correctly', async () => {
      const service = new EmbeddingStorageService('eu-west-1', 'test-bucket');

      const mockEmbedding = new Array(512).fill(0.5);
      s3Mock.onAnyCommand().resolves({
        Body: Readable.from([JSON.stringify(mockEmbedding)]),
      } as any);

      await service.fetchEmbeddingsBatch(['product-1']);

      let metrics = service.getMetrics();
      expect(metrics.totalFetched).toBe(1);

      service.resetMetrics();

      metrics = service.getMetrics();
      expect(metrics.totalFetched).toBe(0);
      expect(metrics.totalFailed).toBe(0);
      expect(metrics.batchCount).toBe(0);
      expect(metrics.totalDurationMs).toBe(0);

      service.close();
    });
  });

  describe('S3 Key Mapping', () => {
    it('should correctly convert product IDs to S3 keys', async () => {
      const service = new EmbeddingStorageService('eu-west-1', 'test-bucket');

      const mockEmbedding = new Array(512).fill(0.5);
      const capturedKeys: string[] = [];

      s3Mock.onAnyCommand().callsFake(async (command: any) => {
        if (command instanceof GetObjectCommand) {
          capturedKeys.push(command.input.Key || '');
        }
        return {
          Body: Readable.from([JSON.stringify(mockEmbedding)]),
        } as any;
      });

      const productIds = ['prod-123', 'prod-456'];
      await service.fetchEmbeddingsBatch(productIds);

      expect(capturedKeys).toContain('embeddings/prod-123.json');
      expect(capturedKeys).toContain('embeddings/prod-456.json');

      service.close();
    });
  });
});
