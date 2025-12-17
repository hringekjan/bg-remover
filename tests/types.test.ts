import { ProcessRequestSchema, createProcessResult } from '../src/lib/types';

describe('Types and Validation', () => {
  describe('ProcessRequestSchema', () => {
    it('should validate valid process request', () => {
      const validRequest = {
        imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
        outputFormat: 'png',
        quality: 80,
        productId: 'test-product-123',
        autoTrim: true,
        centerSubject: false,
        enhanceColors: true,
        targetWidth: 200,
        targetHeight: 200,
        generateDescription: true,
        productName: 'Test Product',
      };

      const result = ProcessRequestSchema.safeParse(validRequest);
      expect(result.success).toBe(true);
      expect(result.data).toEqual(validRequest);
    });

    it('should reject invalid output format', () => {
      const invalidRequest = {
        imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
        outputFormat: 'invalid',
      };

      const result = ProcessRequestSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    it('should reject invalid quality values', () => {
      const invalidRequest = {
        imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
        outputFormat: 'png',
        quality: 150, // Should be 1-100
      };

      const result = ProcessRequestSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    it('should require either imageUrl or imageBase64', () => {
      const invalidRequest = {
        outputFormat: 'png',
      };

      const result = ProcessRequestSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    it('should accept imageUrl only', () => {
      const validRequest = {
        imageUrl: 'https://example.com/image.jpg',
        outputFormat: 'png',
      };

      const result = ProcessRequestSchema.safeParse(validRequest);
      expect(result.success).toBe(true);
    });

    it('should accept imageBase64 only', () => {
      const validRequest = {
        imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
        outputFormat: 'png',
      };

      const result = ProcessRequestSchema.safeParse(validRequest);
      expect(result.success).toBe(true);
    });

    it('should validate target dimensions', () => {
      const validRequest = {
        imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
        outputFormat: 'png',
        targetWidth: 100,
        targetHeight: 200,
      };

      const result = ProcessRequestSchema.safeParse(validRequest);
      expect(result.success).toBe(true);
      expect(result.data.targetWidth).toBe(100);
      expect(result.data.targetHeight).toBe(200);
    });

    it('should reject negative dimensions', () => {
      const invalidRequest = {
        imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
        outputFormat: 'png',
        targetWidth: -100,
      };

      const result = ProcessRequestSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });
  });

  describe('createProcessResult', () => {
    it('should create successful result', () => {
      const result = createProcessResult(
        true,
        'output-url',
        { width: 100, height: 100, originalSize: 1024, processedSize: 512 },
        undefined,
        150
      );

      expect(result).toEqual({
        success: true,
        outputUrl: 'output-url',
        metadata: { width: 100, height: 100, originalSize: 1024, processedSize: 512 },
        processingTimeMs: 150,
      });
    });

    it('should create error result', () => {
      const result = createProcessResult(
        false,
        undefined,
        undefined,
        'Processing failed',
        200
      );

      expect(result).toEqual({
        success: false,
        error: 'Processing failed',
        processingTimeMs: 200,
      });
    });
  });
});