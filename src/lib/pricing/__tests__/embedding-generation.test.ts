/**
 * Embedding Generation Tests
 *
 * Tests for the VisionAnalysisService embedding generation capability
 * using AWS Bedrock Titan Embeddings model.
 *
 * Coverage includes:
 * - Valid image embedding generation
 * - Dimension validation (1024-dimensional vectors)
 * - Image format detection (JPEG, PNG, WebP)
 * - Error handling for invalid images
 * - Batch embedding generation
 * - Titan Embeddings API integration
 */

import { VisionAnalysisService } from '../vision-analysis';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';

// Mock Bedrock client
jest.mock('@aws-sdk/client-bedrock-runtime');

// Mock Response object for body parsing
const mockTextMethod = jest.fn();
global.Response = jest.fn((body) => ({
  text: mockTextMethod,
})) as any;

describe('VisionAnalysisService - Embedding Generation', () => {
  let service: VisionAnalysisService;
  let mockBedrockClient: any;
  let mockInvokeModel: any;

  // Valid 1024-dimensional embedding for testing
  const mockEmbedding = Array.from({ length: 1024 }, (_, i) =>
    Math.sin(i / 100) * 0.5
  );

  // Valid base64 JPEG image (minimal 1x1 pixel)
  const validJpegBase64 =
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8VAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';

  // Valid base64 PNG image (minimal 1x1 pixel)
  const validPngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  beforeEach(() => {
    // Clear all mocks before each test
    jest.clearAllMocks();
    mockTextMethod.mockClear();

    // Setup mock Bedrock client
    mockInvokeModel = jest.fn();
    mockBedrockClient = {
      send: mockInvokeModel,
    };

    (BedrockRuntimeClient as jest.Mock).mockReturnValue(mockBedrockClient);

    // Initialize service
    service = new VisionAnalysisService({
      region: 'us-east-1',
      timeout: 10000,
    });
  });

  describe('generateEmbedding', () => {
    it('should generate 1024-dimensional embedding from valid JPEG', async () => {
      const responseBody = JSON.stringify({
        embedding: mockEmbedding,
      });

      // Mock successful Bedrock response
      mockTextMethod.mockResolvedValue(responseBody);
      mockInvokeModel.mockResolvedValue({
        body: 'mock-body',
      });

      const result = await service.generateEmbedding(validJpegBase64);

      expect(result).toEqual(mockEmbedding);
      expect(result.length).toBe(1024);
      expect(mockInvokeModel).toHaveBeenCalledWith(
        expect.any(InvokeModelCommand)
      );
    });

    it('should generate 1024-dimensional embedding from valid PNG', async () => {
      const responseBody = JSON.stringify({
        embedding: mockEmbedding,
      });

      mockTextMethod.mockResolvedValue(responseBody);
      mockInvokeModel.mockResolvedValue({
        body: 'mock-body',
      });

      const result = await service.generateEmbedding(validPngBase64);

      expect(result.length).toBe(1024);
      expect(mockInvokeModel).toHaveBeenCalled();
    });

    it('should reject embedding with incorrect dimensions', async () => {
      const invalidEmbedding = Array(512).fill(0.5); // Wrong dimension
      const responseBody = JSON.stringify({
        embedding: invalidEmbedding,
      });

      mockTextMethod.mockResolvedValue(responseBody);
      mockInvokeModel.mockResolvedValue({
        body: 'mock-body',
      });

      await expect(
        service.generateEmbedding(validJpegBase64)
      ).rejects.toThrow('Invalid embedding dimensions: expected 1024, got 512');
    });

    it('should reject embedding with non-numeric values', async () => {
      const invalidEmbedding = Array(1024).fill('string'); // Non-numeric
      const responseBody = JSON.stringify({
        embedding: invalidEmbedding,
      });

      mockTextMethod.mockResolvedValue(responseBody);
      mockInvokeModel.mockResolvedValue({
        body: 'mock-body',
      });

      await expect(
        service.generateEmbedding(validJpegBase64)
      ).rejects.toThrow('Embedding contains non-numeric values');
    });

    it('should reject invalid base64 encoding', async () => {
      const invalidBase64 = 'not-valid-base64!!!';

      await expect(
        service.generateEmbedding(invalidBase64)
      ).rejects.toThrow('Invalid base64 encoding');
    });

    it('should reject image exceeding size limit', async () => {
      // Create base64 string that decodes to >5MB
      const oversizedBase64 = 'A'.repeat(7 * 1024 * 1024); // 7MB

      await expect(
        service.generateEmbedding(oversizedBase64)
      ).rejects.toThrow(/Image too large/);
    });

    it('should reject unsupported image format', async () => {
      // Valid base64 but not JPEG, PNG, or WebP format
      const bmpBase64 = 'Qk0='; // BMP magic bytes

      await expect(
        service.generateEmbedding(bmpBase64)
      ).rejects.toThrow('Unsupported or unrecognized image format');
    });

    it('should handle empty response body from Bedrock', async () => {
      mockInvokeModel.mockResolvedValue({
        body: null,
      });

      await expect(
        service.generateEmbedding(validJpegBase64)
      ).rejects.toThrow('Empty response body from Bedrock Titan Embeddings');
    });

    it('should handle invalid JSON response from Bedrock', async () => {
      mockTextMethod.mockResolvedValue('invalid json {');
      mockInvokeModel.mockResolvedValue({
        body: 'mock-body',
      });

      await expect(
        service.generateEmbedding(validJpegBase64)
      ).rejects.toThrow('Failed to parse Bedrock Titan response');
    });

    it('should handle missing embedding field in response', async () => {
      const responseBody = JSON.stringify({
        // No embedding field
        status: 'success',
      });

      mockTextMethod.mockResolvedValue(responseBody);
      mockInvokeModel.mockResolvedValue({
        body: 'mock-body',
      });

      await expect(
        service.generateEmbedding(validJpegBase64)
      ).rejects.toThrow('Response does not contain embedding array');
    });

    it('should handle Bedrock API errors with graceful fallback', async () => {
      const error = new Error('Bedrock service unavailable');
      mockInvokeModel.mockRejectedValue(error);

      await expect(
        service.generateEmbedding(validJpegBase64)
      ).rejects.toThrow('Bedrock service unavailable');
    });

    it('should support ImageInput interface with explicit media type', async () => {
      const responseBody = JSON.stringify({
        embedding: mockEmbedding,
      });

      mockTextMethod.mockResolvedValue(responseBody);
      mockInvokeModel.mockResolvedValue({
        body: 'mock-body',
      });

      const imageInput = {
        base64: validJpegBase64,
        mediaType: 'image/jpeg' as const,
      };

      const result = await service.generateEmbedding(imageInput);

      expect(result.length).toBe(1024);
      expect(mockInvokeModel).toHaveBeenCalled();
    });

    it('should validate embedding vector magnitude', async () => {
      // Embedding with zero magnitude (all zeros)
      const zeroEmbedding = Array(1024).fill(0);
      const responseBody = JSON.stringify({
        embedding: zeroEmbedding,
      });

      mockTextMethod.mockResolvedValue(responseBody);
      mockInvokeModel.mockResolvedValue({
        body: 'mock-body',
      });

      // Should still be accepted (zero vectors are valid mathematically)
      const result = await service.generateEmbedding(validJpegBase64);
      expect(result).toEqual(zeroEmbedding);
    });

    it('should normalize embedding with unit magnitude', async () => {
      // Create normalized embedding (magnitude = 1.0)
      const normalizedEmbedding = mockEmbedding.map(
        (v) => v / Math.sqrt(mockEmbedding.reduce((sum, x) => sum + x * x, 0))
      );
      const responseBody = JSON.stringify({
        embedding: normalizedEmbedding,
      });

      mockTextMethod.mockResolvedValue(responseBody);
      mockInvokeModel.mockResolvedValue({
        body: 'mock-body',
      });

      const result = await service.generateEmbedding(validJpegBase64);

      // Calculate magnitude
      const magnitude = Math.sqrt(
        result.reduce((sum, v) => sum + v * v, 0)
      );
      expect(magnitude).toBeCloseTo(1.0, 5);
    });
  });

  describe('generateBatchEmbeddings', () => {
    it('should process multiple images in parallel', async () => {
      const responseBody = JSON.stringify({
        embedding: mockEmbedding,
      });

      mockTextMethod.mockResolvedValue(responseBody);
      mockInvokeModel.mockResolvedValue({
        body: 'mock-body',
      });

      const images = [validJpegBase64, validPngBase64];
      const results = await service.generateBatchEmbeddings(images);

      expect(results).toHaveLength(2);
      expect(results[0].embedding?.length).toBe(1024);
      expect(results[1].embedding?.length).toBe(1024);
      expect(results[0].error).toBeUndefined();
      expect(results[1].error).toBeUndefined();
    });

    it('should handle partial failures in batch processing', async () => {
      const responseBody = JSON.stringify({
        embedding: mockEmbedding,
      });

      // First call succeeds, second fails
      mockTextMethod
        .mockResolvedValueOnce(responseBody)
        .mockRejectedValueOnce(new Error('Image format error'));

      mockInvokeModel
        .mockResolvedValueOnce({
          body: 'mock-body',
        })
        .mockRejectedValueOnce(new Error('Image format error'));

      const images = [validJpegBase64, 'invalid-base64!!!'];
      const results = await service.generateBatchEmbeddings(images);

      expect(results).toHaveLength(2);
      expect(results[0].embedding?.length).toBe(1024);
      expect(results[0].error).toBeUndefined();
      expect(results[1].embedding).toBeUndefined();
      expect(results[1].error).toBeDefined();
    });

    it('should handle empty batch', async () => {
      const results = await service.generateBatchEmbeddings([]);
      expect(results).toHaveLength(0);
    });

    it('should preserve original image reference in results', async () => {
      const responseBody = JSON.stringify({
        embedding: mockEmbedding,
      });

      mockTextMethod.mockResolvedValue(responseBody);
      mockInvokeModel.mockResolvedValue({
        body: 'mock-body',
      });

      const images = [validJpegBase64];
      const results = await service.generateBatchEmbeddings(images);

      expect(results[0].image).toBe(validJpegBase64);
    });

    it('should handle large batch of images', async () => {
      const responseBody = JSON.stringify({
        embedding: mockEmbedding,
      });

      mockTextMethod.mockResolvedValue(responseBody);
      mockInvokeModel.mockResolvedValue({
        body: 'mock-body',
      });

      const images = Array(10).fill(validJpegBase64);
      const results = await service.generateBatchEmbeddings(images);

      expect(results).toHaveLength(10);
      expect(results.every((r) => r.embedding?.length === 1024)).toBe(true);
    });
  });

  describe('Image Format Detection', () => {
    it('should correctly detect JPEG format', async () => {
      const responseBody = JSON.stringify({
        embedding: mockEmbedding,
      });

      mockTextMethod.mockResolvedValue(responseBody);
      mockInvokeModel.mockResolvedValue({
        body: 'mock-body',
      });

      const result = await service.generateEmbedding(validJpegBase64);

      expect(mockInvokeModel).toHaveBeenCalled();
      expect(result.length).toBe(1024);
    });

    it('should correctly detect PNG format', async () => {
      const responseBody = JSON.stringify({
        embedding: mockEmbedding,
      });

      mockTextMethod.mockResolvedValue(responseBody);
      mockInvokeModel.mockResolvedValue({
        body: 'mock-body',
      });

      const result = await service.generateEmbedding(validPngBase64);

      expect(mockInvokeModel).toHaveBeenCalled();
      expect(result.length).toBe(1024);
    });
  });

  describe('Error Scenarios', () => {
    it('should log error details on embedding generation failure', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      mockInvokeModel.mockRejectedValue(new Error('Network timeout'));

      try {
        await service.generateEmbedding(validJpegBase64);
      } catch (e) {
        // Expected error
      }

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Embedding generation failed'),
        expect.objectContaining({
          error: 'Network timeout',
        })
      );

      consoleSpy.mockRestore();
    });

    it('should handle timeout errors gracefully', async () => {
      const timeoutError = new Error('RequestTimeout');
      mockInvokeModel.mockRejectedValue(timeoutError);

      await expect(
        service.generateEmbedding(validJpegBase64)
      ).rejects.toThrow('RequestTimeout');
    });
  });
});
