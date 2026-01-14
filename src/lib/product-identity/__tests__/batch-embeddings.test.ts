/**
 * Unit tests for Batch Embedding Generation
 *
 * Tests Quick Win #1: Batch Embedding Generation
 * Validates batch processing, error handling, and performance characteristics
 */

import { jest } from '@jest/globals';
import {
  generateBatchImageEmbeddings,
  generateSingleImageEmbedding,
  type ImageInput,
  type BatchEmbeddingResult,
} from '../batch-embeddings';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

// Mock AWS SDK
jest.mock('@aws-sdk/client-bedrock-runtime');
jest.mock('../../bedrock/model-registry', () => ({
  getModelForTask: jest.fn(() => ({ id: 'amazon.titan-embed-image-v1' })),
}));

describe('Batch Embedding Generation', () => {
  const mockBedrockSend = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    (BedrockRuntimeClient as jest.MockedClass<typeof BedrockRuntimeClient>).prototype.send =
      mockBedrockSend;
  });

  /**
   * Test 1: Basic batch processing
   */
  describe('generateBatchImageEmbeddings', () => {
    it('should process a single batch of images successfully', async () => {
      const testImages: ImageInput[] = [
        { imageId: 'img1', buffer: Buffer.from('test-image-1') },
        { imageId: 'img2', buffer: Buffer.from('test-image-2') },
        { imageId: 'img3', buffer: Buffer.from('test-image-3') },
      ];

      // Mock successful Bedrock response
      const mockEmbedding = Array(1024).fill(0.5);
      mockBedrockSend.mockResolvedValueOnce({
        body: new TextEncoder().encode(
          JSON.stringify({
            embeddings: [mockEmbedding, mockEmbedding, mockEmbedding],
          })
        ),
      });

      const result = await generateBatchImageEmbeddings(testImages);

      expect(result.successCount).toBe(3);
      expect(result.failureCount).toBe(0);
      expect(result.embeddings.size).toBe(3);
      expect(result.batchCount).toBe(1);
      expect(result.errors).toHaveLength(0);

      // Verify embeddings stored correctly
      const embedding1 = result.embeddings.get('img1');
      expect(embedding1).toBeDefined();
      expect(embedding1?.embedding).toHaveLength(1024);
      expect(embedding1?.model).toBe('amazon.titan-embed-image-v1');
      expect(embedding1?.imageId).toBe('img1');
      expect(typeof embedding1?.timestamp).toBe('number');
    });

    it('should split large batches into multiple API calls', async () => {
      // Create 30 test images (should create 2 batches: 25 + 5)
      const testImages: ImageInput[] = Array(30)
        .fill(null)
        .map((_, i) => ({
          imageId: `img${i}`,
          buffer: Buffer.from(`test-image-${i}`),
        }));

      const mockEmbedding = Array(1024).fill(0.5);

      // Mock two batch responses
      mockBedrockSend
        .mockResolvedValueOnce({
          body: new TextEncoder().encode(
            JSON.stringify({
              embeddings: Array(25).fill(mockEmbedding),
            })
          ),
        })
        .mockResolvedValueOnce({
          body: new TextEncoder().encode(
            JSON.stringify({
              embeddings: Array(5).fill(mockEmbedding),
            })
          ),
        });

      const result = await generateBatchImageEmbeddings(testImages);

      expect(result.successCount).toBe(30);
      expect(result.batchCount).toBe(2);
      expect(mockBedrockSend).toHaveBeenCalledTimes(2);
      expect(result.embeddings.size).toBe(30);
    });

    it('should handle empty image array gracefully', async () => {
      const result = await generateBatchImageEmbeddings([]);

      expect(result.successCount).toBe(0);
      expect(result.failureCount).toBe(0);
      expect(result.batchCount).toBe(0);
      expect(result.embeddings.size).toBe(0);
      expect(mockBedrockSend).not.toHaveBeenCalled();
    });

    it('should use custom batch size when provided', async () => {
      const testImages: ImageInput[] = Array(15)
        .fill(null)
        .map((_, i) => ({
          imageId: `img${i}`,
          buffer: Buffer.from(`test-image-${i}`),
        }));

      const mockEmbedding = Array(1024).fill(0.5);

      // With batch size 5, should create 3 batches
      mockBedrockSend
        .mockResolvedValueOnce({
          body: new TextEncoder().encode(
            JSON.stringify({ embeddings: Array(5).fill(mockEmbedding) })
          ),
        })
        .mockResolvedValueOnce({
          body: new TextEncoder().encode(
            JSON.stringify({ embeddings: Array(5).fill(mockEmbedding) })
          ),
        })
        .mockResolvedValueOnce({
          body: new TextEncoder().encode(
            JSON.stringify({ embeddings: Array(5).fill(mockEmbedding) })
          ),
        });

      const result = await generateBatchImageEmbeddings(testImages, { batchSize: 5 });

      expect(result.batchCount).toBe(3);
      expect(result.successCount).toBe(15);
      expect(mockBedrockSend).toHaveBeenCalledTimes(3);
    });
  });

  /**
   * Test 2: Error handling
   */
  describe('Error Handling', () => {
    it('should handle Bedrock API failures gracefully', async () => {
      const testImages: ImageInput[] = [
        { imageId: 'img1', buffer: Buffer.from('test-image-1') },
        { imageId: 'img2', buffer: Buffer.from('test-image-2') },
      ];

      mockBedrockSend.mockRejectedValueOnce(new Error('Bedrock service unavailable'));

      const result = await generateBatchImageEmbeddings(testImages);

      expect(result.successCount).toBe(0);
      expect(result.failureCount).toBe(2);
      expect(result.errors).toHaveLength(2);
      expect(result.errors[0].error).toContain('Batch processing failed');
      expect(result.embeddings.size).toBe(0);
    });

    it('should continue processing other batches if one fails', async () => {
      // Create 30 images (2 batches)
      const testImages: ImageInput[] = Array(30)
        .fill(null)
        .map((_, i) => ({
          imageId: `img${i}`,
          buffer: Buffer.from(`test-image-${i}`),
        }));

      const mockEmbedding = Array(1024).fill(0.5);

      // First batch fails, second succeeds
      mockBedrockSend
        .mockRejectedValueOnce(new Error('Batch 1 failed'))
        .mockResolvedValueOnce({
          body: new TextEncoder().encode(
            JSON.stringify({ embeddings: Array(5).fill(mockEmbedding) })
          ),
        });

      const result = await generateBatchImageEmbeddings(testImages);

      expect(result.successCount).toBe(5);
      expect(result.failureCount).toBe(25);
      expect(result.errors).toHaveLength(25);
    });

    it('should validate invalid Bedrock response structure', async () => {
      const testImages: ImageInput[] = [{ imageId: 'img1', buffer: Buffer.from('test') }];

      // Mock invalid response (missing embeddings field)
      mockBedrockSend.mockResolvedValueOnce({
        body: new TextEncoder().encode(JSON.stringify({ invalid: 'response' })),
      });

      const result = await generateBatchImageEmbeddings(testImages);

      expect(result.failureCount).toBe(1);
      expect(result.errors[0].error).toContain('Invalid Bedrock batch response');
    });

    it('should validate embedding array length mismatch', async () => {
      const testImages: ImageInput[] = [
        { imageId: 'img1', buffer: Buffer.from('test-1') },
        { imageId: 'img2', buffer: Buffer.from('test-2') },
      ];

      const mockEmbedding = Array(1024).fill(0.5);

      // Return only 1 embedding for 2 images
      mockBedrockSend.mockResolvedValueOnce({
        body: new TextEncoder().encode(
          JSON.stringify({ embeddings: [mockEmbedding] })
        ),
      });

      const result = await generateBatchImageEmbeddings(testImages);

      expect(result.failureCount).toBe(2);
      expect(result.errors[0].error).toContain('returned 1 embeddings for 2 images');
    });

    it('should validate empty image buffer', async () => {
      const testImages: ImageInput[] = [
        { imageId: 'img1', buffer: Buffer.alloc(0) }, // Empty buffer
      ];

      const result = await generateBatchImageEmbeddings(testImages);

      expect(result.failureCount).toBe(1);
      expect(result.errors[0].error).toContain('Image buffer is empty');
    });

    it('should validate oversized image buffer', async () => {
      const largeBuffer = Buffer.alloc(21 * 1024 * 1024); // 21MB (over 20MB limit)
      const testImages: ImageInput[] = [{ imageId: 'img1', buffer: largeBuffer }];

      const result = await generateBatchImageEmbeddings(testImages);

      expect(result.failureCount).toBe(1);
      expect(result.errors[0].error).toContain('too large');
    });
  });

  /**
   * Test 3: Performance characteristics
   */
  describe('Performance Characteristics', () => {
    it('should include timing metadata in results', async () => {
      const testImages: ImageInput[] = [{ imageId: 'img1', buffer: Buffer.from('test') }];

      const mockEmbedding = Array(1024).fill(0.5);
      mockBedrockSend.mockResolvedValueOnce({
        body: new TextEncoder().encode(
          JSON.stringify({ embeddings: [mockEmbedding] })
        ),
      });

      const result = await generateBatchImageEmbeddings(testImages);

      expect(result.totalTimeMs).toBeGreaterThan(0);
      expect(typeof result.totalTimeMs).toBe('number');

      const embedding = result.embeddings.get('img1');
      expect(embedding?.generationTimeMs).toBeDefined();
      expect(typeof embedding?.generationTimeMs).toBe('number');
    });

    it('should process batches with controlled concurrency', async () => {
      // Create 100 images (4 batches of 25)
      const testImages: ImageInput[] = Array(100)
        .fill(null)
        .map((_, i) => ({
          imageId: `img${i}`,
          buffer: Buffer.from(`test-${i}`),
        }));

      const mockEmbedding = Array(1024).fill(0.5);
      mockBedrockSend.mockResolvedValue({
        body: new TextEncoder().encode(
          JSON.stringify({ embeddings: Array(25).fill(mockEmbedding) })
        ),
      });

      const startTime = Date.now();
      const result = await generateBatchImageEmbeddings(testImages, { maxConcurrency: 2 });
      const endTime = Date.now();

      expect(result.successCount).toBe(100);
      expect(result.batchCount).toBe(4);
      expect(endTime - startTime).toBeLessThan(5000); // Should complete quickly
    });
  });

  /**
   * Test 4: Single image API compatibility
   */
  describe('generateSingleImageEmbedding', () => {
    it('should process single image and return embedding', async () => {
      const mockEmbedding = Array(1024).fill(0.5);
      mockBedrockSend.mockResolvedValueOnce({
        body: new TextEncoder().encode(
          JSON.stringify({ embeddings: [mockEmbedding] })
        ),
      });

      const embedding = await generateSingleImageEmbedding(
        'img1',
        Buffer.from('test-image')
      );

      expect(embedding.imageId).toBe('img1');
      expect(embedding.embedding).toHaveLength(1024);
      expect(embedding.model).toBe('amazon.titan-embed-image-v1');
    });

    it('should throw error if embedding generation fails', async () => {
      mockBedrockSend.mockRejectedValueOnce(new Error('Bedrock error'));

      await expect(
        generateSingleImageEmbedding('img1', Buffer.from('test'))
      ).rejects.toThrow('Batch processing failed');
    });
  });

  /**
   * Test 5: Integration with existing product-identity-service
   */
  describe('Integration Compatibility', () => {
    it('should return embeddings in Map format for O(1) lookup', async () => {
      const testImages: ImageInput[] = [
        { imageId: 'img1', buffer: Buffer.from('test-1') },
        { imageId: 'img2', buffer: Buffer.from('test-2') },
      ];

      const mockEmbedding = Array(1024).fill(0.5);
      mockBedrockSend.mockResolvedValueOnce({
        body: new TextEncoder().encode(
          JSON.stringify({ embeddings: [mockEmbedding, mockEmbedding] })
        ),
      });

      const result = await generateBatchImageEmbeddings(testImages);

      // Should be Map, not array
      expect(result.embeddings instanceof Map).toBe(true);

      // O(1) lookup
      const embedding1 = result.embeddings.get('img1');
      const embedding2 = result.embeddings.get('img2');

      expect(embedding1).toBeDefined();
      expect(embedding2).toBeDefined();
      expect(result.embeddings.get('nonexistent')).toBeUndefined();
    });

    it('should maintain embedding vector length compatibility (1024 dimensions)', async () => {
      const testImages: ImageInput[] = [{ imageId: 'img1', buffer: Buffer.from('test') }];

      const mockEmbedding = Array(1024).fill(0.123);
      mockBedrockSend.mockResolvedValueOnce({
        body: new TextEncoder().encode(
          JSON.stringify({ embeddings: [mockEmbedding] })
        ),
      });

      const result = await generateBatchImageEmbeddings(testImages);
      const embedding = result.embeddings.get('img1');

      expect(embedding?.embedding).toHaveLength(1024);
      expect(embedding?.embedding[0]).toBe(0.123);
    });

    it('should include model ID for tracking', async () => {
      const testImages: ImageInput[] = [{ imageId: 'img1', buffer: Buffer.from('test') }];

      const mockEmbedding = Array(1024).fill(0.5);
      mockBedrockSend.mockResolvedValueOnce({
        body: new TextEncoder().encode(
          JSON.stringify({ embeddings: [mockEmbedding] })
        ),
      });

      const result = await generateBatchImageEmbeddings(testImages, {
        model: 'custom-model-id',
      });

      const embedding = result.embeddings.get('img1');
      expect(embedding?.model).toBe('custom-model-id');
    });
  });
});
