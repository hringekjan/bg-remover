/**
 * Unit tests for Image Analysis Cache
 *
 * Tests Quick Win #2: Expand Embedding Cache Coverage
 * Validates caching, TTL, eviction, and performance characteristics
 */

import { jest } from '@jest/globals';
import { ImageAnalysisCache, embeddingCache, analysisCache } from '../image-analysis-cache';

describe('Image Analysis Cache', () => {
  let cache: ImageAnalysisCache;

  beforeEach(() => {
    cache = new ImageAnalysisCache({
      ttl: 60, // 1 minute for testing
      maxSize: 1, // 1MB for testing
      enableStats: true,
    });
  });

  afterEach(() => {
    cache.clear();
  });

  /**
   * Test 1: Basic caching operations
   */
  describe('Basic Operations', () => {
    it('should cache and retrieve embeddings', async () => {
      const imageBuffer = Buffer.from('test-image-data');
      const embedding = Array(1024).fill(0.5);

      await cache.cacheEmbedding(imageBuffer, embedding);
      const cached = await cache.getEmbedding(imageBuffer);

      expect(cached).toBeDefined();
      expect(cached?.embedding).toHaveLength(1024);
      expect(cached?.embedding[0]).toBe(0.5);
    });

    it('should return undefined for cache miss', async () => {
      const imageBuffer = Buffer.from('nonexistent-image');
      const cached = await cache.getEmbedding(imageBuffer);

      expect(cached).toBeUndefined();
    });

    it('should cache Bedrock analysis results', async () => {
      const imageBuffer = Buffer.from('test-image');
      const prompt = 'Describe this image';
      const model = 'claude-3-sonnet';
      const result = { description: 'A beautiful landscape' };

      await cache.cacheBedrockAnalysis(imageBuffer, prompt, model, result);
      const cached = await cache.getBedrockAnalysis(imageBuffer, prompt, model);

      expect(cached).toEqual(result);
    });

    it('should cache Rekognition labels', async () => {
      const imageBuffer = Buffer.from('test-image');
      const labels = [{ Name: 'Cat', Confidence: 99.5 }, { Name: 'Animal', Confidence: 99.9 }];

      await cache.cacheRekognitionLabels(imageBuffer, labels);
      const cached = await cache.getRekognitionLabels(imageBuffer);

      expect(cached).toEqual(labels);
    });

    it('should cache clustering results', async () => {
      const imageIds = ['img1', 'img2', 'img3'];
      const clusters = [['img1', 'img2'], ['img3']];

      await cache.cacheClusteringResult(imageIds, clusters);
      const cached = await cache.getClusteringResult(imageIds);

      expect(cached).toEqual(clusters);
    });
  });

  /**
   * Test 2: Cache key generation
   */
  describe('Cache Key Generation', () => {
    it('should generate same key for identical image buffers', async () => {
      const buffer1 = Buffer.from('identical-image-data');
      const buffer2 = Buffer.from('identical-image-data');
      const embedding = Array(1024).fill(0.7);

      await cache.cacheEmbedding(buffer1, embedding);
      const cached = await cache.getEmbedding(buffer2);

      expect(cached).toBeDefined();
      expect(cached?.embedding[0]).toBe(0.7);
    });

    it('should generate different keys for different image buffers', async () => {
      const buffer1 = Buffer.from('image-1');
      const buffer2 = Buffer.from('image-2');
      const embedding1 = Array(1024).fill(0.1);
      const embedding2 = Array(1024).fill(0.9);

      await cache.cacheEmbedding(buffer1, embedding1);
      await cache.cacheEmbedding(buffer2, embedding2);

      const cached1 = await cache.getEmbedding(buffer1);
      const cached2 = await cache.getEmbedding(buffer2);

      expect(cached1?.embedding[0]).toBe(0.1);
      expect(cached2?.embedding[0]).toBe(0.9);
    });

    it('should generate different keys for same image with different prompts', async () => {
      const imageBuffer = Buffer.from('test-image');
      const model = 'claude-3-sonnet';
      const result1 = { description: 'Result 1' };
      const result2 = { description: 'Result 2' };

      await cache.cacheBedrockAnalysis(imageBuffer, 'prompt1', model, result1);
      await cache.cacheBedrockAnalysis(imageBuffer, 'prompt2', model, result2);

      const cached1 = await cache.getBedrockAnalysis(imageBuffer, 'prompt1', model);
      const cached2 = await cache.getBedrockAnalysis(imageBuffer, 'prompt2', model);

      expect(cached1).toEqual(result1);
      expect(cached2).toEqual(result2);
    });
  });

  /**
   * Test 3: TTL and expiration
   */
  describe('TTL and Expiration', () => {
    it('should expire entries after TTL', async () => {
      const shortCache = new ImageAnalysisCache({
        ttl: 1, // 1 second
        enableStats: true,
      });

      const imageBuffer = Buffer.from('test-image');
      const embedding = Array(1024).fill(0.5);

      await shortCache.cacheEmbedding(imageBuffer, embedding);

      // Should be cached immediately
      let cached = await shortCache.getEmbedding(imageBuffer);
      expect(cached).toBeDefined();

      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Should be expired
      cached = await shortCache.getEmbedding(imageBuffer);
      expect(cached).toBeUndefined();
    });

    it('should support custom TTL per entry', async () => {
      const imageBuffer = Buffer.from('test-image');
      const embedding = Array(1024).fill(0.5);

      // Cache with 1 second TTL
      await cache.cacheEmbedding(imageBuffer, embedding, undefined, 1);

      // Should be cached immediately
      let cached = await cache.getEmbedding(imageBuffer);
      expect(cached).toBeDefined();

      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Should be expired
      cached = await cache.getEmbedding(imageBuffer);
      expect(cached).toBeUndefined();
    });

    it('should clean expired entries', async () => {
      const shortCache = new ImageAnalysisCache({
        ttl: 1,
        enableStats: true,
      });

      // Add multiple entries
      for (let i = 0; i < 5; i++) {
        await shortCache.cacheEmbedding(
          Buffer.from(`image-${i}`),
          Array(1024).fill(i)
        );
      }

      expect(shortCache.size()).toBe(5);

      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Trigger cleanup
      shortCache.clearExpired();

      expect(shortCache.size()).toBe(0);
    });
  });

  /**
   * Test 4: Size limits and eviction
   */
  describe('Size Limits and Eviction', () => {
    it('should track cache size', async () => {
      const imageBuffer = Buffer.from('test-image');
      const embedding = Array(1024).fill(0.5);

      expect(cache.getSizeMB()).toBe(0);

      await cache.cacheEmbedding(imageBuffer, embedding);

      expect(cache.getSizeMB()).toBeGreaterThan(0);
    });

    it('should evict LRU entries when size limit reached', async () => {
      const smallCache = new ImageAnalysisCache({
        maxSize: 0.01, // 10KB limit
        enableStats: true,
      });

      // Add entries until we exceed the limit
      const entries = 20;
      for (let i = 0; i < entries; i++) {
        await smallCache.cacheEmbedding(
          Buffer.from(`image-${i}`),
          Array(1024).fill(i)
        );
      }

      // Cache should have evicted some entries
      expect(smallCache.size()).toBeLessThan(entries);
      expect(smallCache.getSizeMB()).toBeLessThanOrEqual(0.01);
    });

    it('should evict least used entries first', async () => {
      const smallCache = new ImageAnalysisCache({
        maxSize: 0.01,
        enableStats: true,
      });

      // Add and access first entry multiple times
      const popularImage = Buffer.from('popular-image');
      await smallCache.cacheEmbedding(popularImage, Array(1024).fill(1));

      // Access it multiple times to increase hit count
      for (let i = 0; i < 10; i++) {
        await smallCache.getEmbedding(popularImage);
      }

      // Add many more entries to trigger eviction
      for (let i = 0; i < 20; i++) {
        await smallCache.cacheEmbedding(
          Buffer.from(`image-${i}`),
          Array(1024).fill(i)
        );
      }

      // Popular entry should still be cached
      const cached = await smallCache.getEmbedding(popularImage);
      expect(cached).toBeDefined();
    });
  });

  /**
   * Test 5: Statistics tracking
   */
  describe('Statistics', () => {
    it('should track cache hits and misses', async () => {
      const imageBuffer = Buffer.from('test-image');
      const embedding = Array(1024).fill(0.5);

      // Initial stats should be zero
      let stats = cache.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);

      // Cache miss
      await cache.getEmbedding(imageBuffer);
      stats = cache.getStats();
      expect(stats.misses).toBe(1);

      // Cache the embedding
      await cache.cacheEmbedding(imageBuffer, embedding);

      // Cache hit
      await cache.getEmbedding(imageBuffer);
      stats = cache.getStats();
      expect(stats.hits).toBe(1);

      // Hit rate should be 50% (1 hit, 1 miss)
      expect(stats.hitRate).toBe(0.5);
    });

    it('should calculate correct hit rate', async () => {
      const imageBuffer = Buffer.from('test-image');
      const embedding = Array(1024).fill(0.5);

      // Initial miss
      await cache.getEmbedding(imageBuffer);

      // Cache the embedding
      await cache.cacheEmbedding(imageBuffer, embedding);

      // 9 hits
      for (let i = 0; i < 9; i++) {
        await cache.getEmbedding(imageBuffer);
      }

      const stats = cache.getStats();
      expect(stats.hits).toBe(9);
      expect(stats.misses).toBe(1);
      expect(stats.hitRate).toBe(0.9); // 90% hit rate
    });

    it('should track evictions', async () => {
      const smallCache = new ImageAnalysisCache({
        maxSize: 0.01, // 10KB
        enableStats: true,
      });

      // Add many entries to trigger evictions
      for (let i = 0; i < 20; i++) {
        await smallCache.cacheEmbedding(
          Buffer.from(`image-${i}`),
          Array(1024).fill(i)
        );
      }

      const stats = smallCache.getStats();
      expect(stats.evictions).toBeGreaterThan(0);
    });

    it('should reset statistics', async () => {
      const imageBuffer = Buffer.from('test-image');
      const embedding = Array(1024).fill(0.5);

      await cache.cacheEmbedding(imageBuffer, embedding);
      await cache.getEmbedding(imageBuffer);

      let stats = cache.getStats();
      expect(stats.hits).toBeGreaterThan(0);

      cache.resetStats();

      stats = cache.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
    });
  });

  /**
   * Test 6: Clear operations
   */
  describe('Clear Operations', () => {
    it('should clear all entries', async () => {
      // Add multiple entries
      for (let i = 0; i < 5; i++) {
        await cache.cacheEmbedding(
          Buffer.from(`image-${i}`),
          Array(1024).fill(i)
        );
      }

      expect(cache.size()).toBe(5);

      cache.clear();

      expect(cache.size()).toBe(0);
      expect(cache.getSizeMB()).toBe(0);
    });
  });

  /**
   * Test 7: Integration with global cache instances
   */
  describe('Global Cache Instances', () => {
    it('should have separate embedding and analysis caches', async () => {
      const imageBuffer = Buffer.from('test-image');
      const embedding = Array(1024).fill(0.5);

      await embeddingCache.cacheEmbedding(imageBuffer, embedding);
      await analysisCache.cacheBedrockAnalysis(
        imageBuffer,
        'prompt',
        'model',
        { result: 'test' }
      );

      expect(embeddingCache.size()).toBeGreaterThan(0);
      expect(analysisCache.size()).toBeGreaterThan(0);
    });
  });

  /**
   * Test 8: Metadata support
   */
  describe('Metadata Support', () => {
    it('should store and retrieve metadata with embeddings', async () => {
      const imageBuffer = Buffer.from('test-image');
      const embedding = Array(1024).fill(0.5);
      const metadata = {
        imageId: 'img-123',
        fileName: 'test.jpg',
        dimensions: { width: 800, height: 600 },
      };

      await cache.cacheEmbedding(imageBuffer, embedding, metadata);
      const cached = await cache.getEmbedding(imageBuffer);

      expect(cached?.metadata).toEqual(metadata);
    });
  });
});
