/**
 * Unit tests for Parallel Clustering
 *
 * Tests Quick Win #3: Parallel Clustering Processing
 * Validates concurrency control, performance, and correctness
 */

import { jest } from '@jest/globals';
import {
  processParallel,
  extractFeaturesParallel,
  calculateSimilaritiesParallel,
  clusterImagesParallel,
  batchItems,
} from '../parallel-clustering';

describe('Parallel Clustering', () => {
  /**
   * Test 1: Basic parallel processing
   */
  describe('processParallel', () => {
    it('should process items in parallel', async () => {
      const items = [1, 2, 3, 4, 5];
      const processor = async (item: number) => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return item * 2;
      };

      const result = await processParallel(items, processor, { maxConcurrency: 2 });

      expect(result.success).toEqual([2, 4, 6, 8, 10]);
      expect(result.failures).toHaveLength(0);
      expect(result.totalTime).toBeGreaterThan(0);
    });

    it('should respect concurrency limits', async () => {
      const items = Array(10).fill(0).map((_, i) => i);
      const concurrentCount = { current: 0, max: 0 };

      const processor = async (item: number) => {
        concurrentCount.current++;
        concurrentCount.max = Math.max(concurrentCount.max, concurrentCount.current);

        await new Promise(resolve => setTimeout(resolve, 50));

        concurrentCount.current--;
        return item;
      };

      await processParallel(items, processor, { maxConcurrency: 3 });

      // Should never exceed concurrency limit
      expect(concurrentCount.max).toBeLessThanOrEqual(3);
      expect(concurrentCount.max).toBeGreaterThan(1); // Should actually use parallelism
    });

    it('should handle failures gracefully', async () => {
      const items = [1, 2, 3, 4, 5];
      const processor = async (item: number) => {
        if (item === 3) {
          throw new Error('Item 3 failed');
        }
        return item * 2;
      };

      const result = await processParallel(items, processor);

      expect(result.success).toHaveLength(4);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].error).toContain('Item 3 failed');
    });

    it('should handle timeout', async () => {
      const items = [1, 2, 3];
      const processor = async (item: number) => {
        if (item === 2) {
          // This will timeout
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        return item;
      };

      const result = await processParallel(items, processor, { timeout: 100 });

      expect(result.success).toHaveLength(2); // Items 1 and 3
      expect(result.failures).toHaveLength(1); // Item 2 timeout
      expect(result.failures[0].error).toContain('timeout');
    });

    it('should calculate average time correctly', async () => {
      const items = [1, 2, 3];
      const processor = async (item: number) => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return item;
      };

      const result = await processParallel(items, processor);

      expect(result.avgTimePerItem).toBeGreaterThan(0);
      expect(result.totalTime).toBeGreaterThan(0);
    });
  });

  /**
   * Test 2: Feature extraction
   */
  describe('extractFeaturesParallel', () => {
    it('should extract features from images in parallel', async () => {
      const images = [
        { buffer: Buffer.from('image1'), imageId: 'img1' },
        { buffer: Buffer.from('image2'), imageId: 'img2' },
        { buffer: Buffer.from('image3'), imageId: 'img3' },
      ];

      const extractFn = jest.fn(async (buffer: Buffer) => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return { hash: buffer.toString('hex'), size: buffer.length };
      });

      const results = await extractFeaturesParallel(images, extractFn, { maxConcurrency: 2 });

      expect(results).toHaveLength(3);
      expect(results[0].imageId).toBe('img1');
      expect(results[0].features).toHaveProperty('hash');
      expect(results[0].features).toHaveProperty('size');
      expect(extractFn).toHaveBeenCalledTimes(3);
    });

    it('should handle extraction failures', async () => {
      const images = [
        { buffer: Buffer.from('image1'), imageId: 'img1' },
        { buffer: Buffer.from('image2'), imageId: 'img2' },
        { buffer: Buffer.from('image3'), imageId: 'img3' },
      ];

      const extractFn = async (buffer: Buffer) => {
        if (buffer.toString() === 'image2') {
          throw new Error('Extraction failed');
        }
        return { hash: 'test' };
      };

      const results = await extractFeaturesParallel(images, extractFn);

      expect(results).toHaveLength(2); // Only img1 and img3 succeed
    });
  });

  /**
   * Test 3: Similarity calculation
   */
  describe('calculateSimilaritiesParallel', () => {
    it('should calculate similarities in parallel', async () => {
      const pairs = [
        { id1: 'img1', id2: 'img2', data1: [1, 0], data2: [1, 0] },
        { id1: 'img1', id2: 'img3', data1: [1, 0], data2: [0, 1] },
        { id1: 'img2', id2: 'img3', data1: [1, 0], data2: [0, 1] },
      ];

      const similarityFn = async (data1: number[], data2: number[]) => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return data1[0] === data2[0] && data1[1] === data2[1] ? 1.0 : 0.0;
      };

      const results = await calculateSimilaritiesParallel(pairs, similarityFn);

      expect(results).toHaveLength(3);
      expect(results[0].similarity).toBe(1.0); // img1 and img2 identical
      expect(results[1].similarity).toBe(0.0); // img1 and img3 different
    });
  });

  /**
   * Test 4: Image clustering
   */
  describe('clusterImagesParallel', () => {
    it('should cluster similar images together', async () => {
      const images = [
        { id: 'img1', embedding: [1.0, 0.0, 0.0] },
        { id: 'img2', embedding: [0.99, 0.01, 0.0] }, // Similar to img1
        { id: 'img3', embedding: [0.0, 1.0, 0.0] }, // Different
        { id: 'img4', embedding: [0.0, 0.99, 0.01] }, // Similar to img3
      ];

      const clusters = await clusterImagesParallel(images, 0.9, { maxConcurrency: 2 });

      expect(clusters).toHaveLength(2);

      // Find cluster containing img1
      const cluster1 = clusters.find(c => c.includes('img1'));
      expect(cluster1).toContain('img1');
      expect(cluster1).toContain('img2');

      // Find cluster containing img3
      const cluster2 = clusters.find(c => c.includes('img3'));
      expect(cluster2).toContain('img3');
      expect(cluster2).toContain('img4');
    });

    it('should create singleton clusters for dissimilar images', async () => {
      const images = [
        { id: 'img1', embedding: [1.0, 0.0, 0.0] },
        { id: 'img2', embedding: [0.0, 1.0, 0.0] },
        { id: 'img3', embedding: [0.0, 0.0, 1.0] },
      ];

      const clusters = await clusterImagesParallel(images, 0.9);

      expect(clusters).toHaveLength(3);
      expect(clusters[0]).toHaveLength(1);
      expect(clusters[1]).toHaveLength(1);
      expect(clusters[2]).toHaveLength(1);
    });

    it('should handle single image', async () => {
      const images = [{ id: 'img1', embedding: [1.0, 0.0, 0.0] }];

      const clusters = await clusterImagesParallel(images, 0.9);

      expect(clusters).toHaveLength(1);
      expect(clusters[0]).toEqual(['img1']);
    });

    it('should handle empty array', async () => {
      const images: Array<{ id: string; embedding: number[] }> = [];

      const clusters = await clusterImagesParallel(images, 0.9);

      expect(clusters).toHaveLength(0);
    });

    it('should respect threshold', async () => {
      const images = [
        { id: 'img1', embedding: [1.0, 0.0] },
        { id: 'img2', embedding: [0.8, 0.2] }, // 0.8 similarity
        { id: 'img3', embedding: [0.6, 0.4] }, // 0.6 similarity
      ];

      // With high threshold, should create separate clusters
      const strictClusters = await clusterImagesParallel(images, 0.9);
      expect(strictClusters.length).toBeGreaterThan(1);

      // With low threshold, should group more images
      const looseClusters = await clusterImagesParallel(images, 0.5);
      expect(looseClusters.length).toBeLessThanOrEqual(strictClusters.length);
    });
  });

  /**
   * Test 5: Utility functions
   */
  describe('batchItems', () => {
    it('should batch items correctly', () => {
      const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const batches = batchItems(items, 3);

      expect(batches).toHaveLength(4);
      expect(batches[0]).toEqual([1, 2, 3]);
      expect(batches[1]).toEqual([4, 5, 6]);
      expect(batches[2]).toEqual([7, 8, 9]);
      expect(batches[3]).toEqual([10]); // Last batch partial
    });

    it('should handle empty array', () => {
      const batches = batchItems([], 5);
      expect(batches).toHaveLength(0);
    });

    it('should handle single batch', () => {
      const items = [1, 2, 3];
      const batches = batchItems(items, 10);

      expect(batches).toHaveLength(1);
      expect(batches[0]).toEqual([1, 2, 3]);
    });
  });

  /**
   * Test 6: Performance characteristics
   */
  describe('Performance', () => {
    it('should be faster with higher concurrency', async () => {
      const items = Array(20).fill(0).map((_, i) => i);
      const slowProcessor = async (item: number) => {
        await new Promise(resolve => setTimeout(resolve, 50));
        return item;
      };

      // Sequential (concurrency 1)
      const sequential = await processParallel(items, slowProcessor, { maxConcurrency: 1 });

      // Parallel (concurrency 4)
      const parallel = await processParallel(items, slowProcessor, { maxConcurrency: 4 });

      // Parallel should be significantly faster
      expect(parallel.totalTime).toBeLessThan(sequential.totalTime * 0.8);
    });

    it('should track processing metrics', async () => {
      const items = [1, 2, 3, 4, 5];
      const processor = async (item: number) => {
        await new Promise(resolve => setTimeout(resolve, 20));
        return item;
      };

      const result = await processParallel(items, processor);

      expect(result.totalTime).toBeGreaterThan(0);
      expect(result.avgTimePerItem).toBeGreaterThan(0);
      expect(result.avgTimePerItem).toBeLessThan(result.totalTime);
    });
  });
});
