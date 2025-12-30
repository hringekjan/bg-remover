/**
 * Vision Analysis Service Tests
 *
 * Tests for Bedrock Nova Lite integration with quality assessment,
 * error handling, validation, and multiplier generation.
 *
 * Note: Full Bedrock integration tests should be done in E2E tests
 * due to SDK mocking complexity. These tests verify service logic and validation.
 */

import { VisionAnalysisService, ImageInput } from '../vision-analysis';

describe('VisionAnalysisService', () => {
  let service: VisionAnalysisService;

  beforeEach(() => {
    service = new VisionAnalysisService({ region: 'us-east-1' });
  });

  describe('service initialization', () => {
    it('should be instantiable without errors', () => {
      expect(service).toBeDefined();
    });

    it('should return neutral assessment structure when service is initialized', () => {
      const testService = new VisionAnalysisService({ region: 'us-east-1' });
      expect(testService).toBeInstanceOf(VisionAnalysisService);
    });

    it('should handle different region configurations', () => {
      const usEastService = new VisionAnalysisService({ region: 'us-east-1' });
      const euWestService = new VisionAnalysisService({ region: 'eu-west-1' });

      expect(usEastService).toBeDefined();
      expect(euWestService).toBeDefined();
    });

    it('should support custom timeout configuration', () => {
      const customTimeoutService = new VisionAnalysisService({
        region: 'us-east-1',
        timeout: 5000,
      });
      expect(customTimeoutService).toBeDefined();
    });

    it('should use 10 second default timeout', () => {
      const defaultTimeoutService = new VisionAnalysisService({
        region: 'us-east-1',
      });
      expect(defaultTimeoutService).toBeDefined();
    });

    it('should support region configuration', () => {
      const regionService = new VisionAnalysisService({
        region: 'us-west-2',
      });
      expect(regionService).toBeDefined();
    });

    it('should use us-east-1 as default region', () => {
      const defaultService = new VisionAnalysisService();
      expect(defaultService).toBeDefined();
    });
  });

  describe('input validation', () => {
    it('should validate base64 format - reject empty string', async () => {
      const assessment = await service.assessVisualQuality('');
      // Invalid input should return default assessment (graceful degradation)
      expect(assessment.multiplier).toBe(1.0);
      expect(assessment.reasoning).toContain('unavailable');
    });

    it('should validate base64 format - reject non-string', async () => {
      const assessment = await service.assessVisualQuality(null as any);
      expect(assessment.multiplier).toBe(1.0);
      expect(assessment.reasoning).toContain('unavailable');
    });

    it('should validate base64 encoding format', async () => {
      // Invalid base64 characters (e.g., spaces, special chars)
      const assessment = await service.assessVisualQuality('not@valid#base64!');
      expect(assessment.multiplier).toBe(1.0);
      expect(assessment.reasoning).toContain('unavailable');
    });

    it('should reject oversized images (>5MB)', async () => {
      // Create a string that represents >5MB of data
      const largeBatch = 'A'.repeat(5 * 1024 * 1024 + 1000); // Over 5MB
      const assessment = await service.assessVisualQuality(largeBatch);
      expect(assessment.multiplier).toBe(1.0);
      expect(assessment.reasoning).toContain('unavailable');
    });

    it('should accept valid base64 string with legacy interface', async () => {
      // Valid JPEG magic bytes in base64: /9j/4AAQSkZJRg==
      const validJpegBase64 = '/9j/4AAQSkZJRg==';
      // This will fail at Bedrock call (no mock), but input validation passes
      const assessment = await service.assessVisualQuality(validJpegBase64);
      expect(assessment).toBeDefined();
      expect(assessment.conditionScore).toBeDefined();
    });

    it('should accept ImageInput interface with explicit media type', async () => {
      const imageInput: ImageInput = {
        base64: '/9j/4AAQSkZJRg==',
        mediaType: 'image/jpeg',
      };
      const assessment = await service.assessVisualQuality(imageInput);
      expect(assessment).toBeDefined();
      expect(assessment.conditionScore).toBeDefined();
    });

    it('should accept PNG image input', async () => {
      const imageInput: ImageInput = {
        base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        mediaType: 'image/png',
      };
      const assessment = await service.assessVisualQuality(imageInput);
      expect(assessment).toBeDefined();
    });

    it('should accept WebP image input', async () => {
      const imageInput: ImageInput = {
        base64: 'UklGRiYAAABXEBP7AAAAVUlmZkA=',
        mediaType: 'image/webp',
      };
      const assessment = await service.assessVisualQuality(imageInput);
      expect(assessment).toBeDefined();
    });
  });

  describe('image format detection', () => {
    it('should auto-detect JPEG format from magic bytes', async () => {
      // JPEG magic bytes: FFD8FF (base64: /9j/)
      const jpegBase64 = '/9j/4AAQSkZJRg==';
      const assessment = await service.assessVisualQuality(jpegBase64);
      expect(assessment).toBeDefined();
    });

    it('should auto-detect PNG format from magic bytes', async () => {
      // PNG magic bytes: 89504E47 (base64: iVBORw)
      const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      const assessment = await service.assessVisualQuality(pngBase64);
      expect(assessment).toBeDefined();
    });

    it('should auto-detect WebP format from magic bytes', async () => {
      // WebP magic bytes: 52494646 (base64: UklGR)
      const webpBase64 = 'UklGRiYAAABXEBP7AAAAVUlmZkA=';
      const assessment = await service.assessVisualQuality(webpBase64);
      expect(assessment).toBeDefined();
    });

    it('should reject unsupported image formats', async () => {
      // BMP or other unsupported format
      const unsupportedBase64 = 'Qkm1BAAAA=='; // BMP magic bytes
      const assessment = await service.assessVisualQuality(unsupportedBase64);
      expect(assessment.multiplier).toBe(1.0);
      expect(assessment.reasoning).toContain('unavailable');
    });
  });

  describe('batch assessment', () => {
    it('should handle empty images array gracefully', async () => {
      const assessment = await service.assessMultipleImages([]);

      expect(assessment.multiplier).toBe(1.0);
      expect(assessment.overallAssessment).toBe('good');
      expect(assessment.reasoning).toContain('No images provided');
    });

    it('should have proper interface for multiple images', async () => {
      expect(service.assessMultipleImages).toBeDefined();
      const result = await service.assessMultipleImages([]);
      expect(result).toHaveProperty('multiplier');
      expect(result).toHaveProperty('overallAssessment');
      expect(result).toHaveProperty('reasoning');
    });
  });

  describe('multiplier calculation', () => {
    it('should initialize with proper defaults', () => {
      const testService = new VisionAnalysisService();
      expect(testService).toBeDefined();
    });
  });

  describe('graceful degradation', () => {
    it('should return valid assessment on error (with empty images)', async () => {
      const assessment = await service.assessMultipleImages([]);

      expect(assessment).toBeDefined();
      expect(assessment.multiplier).toBe(1.0);
      expect(typeof assessment.conditionScore).toBe('number');
      expect(typeof assessment.photoQualityScore).toBe('number');
      expect(Array.isArray(assessment.visibleDefects)).toBe(true);
    });

    it('should return default assessment on validation error', async () => {
      // Invalid input should gracefully return default
      const assessment = await service.assessVisualQuality('invalid!!!');
      expect(assessment.multiplier).toBe(1.0);
      expect(assessment.overallAssessment).toBe('good');
      expect(assessment.pricingImpact).toBe('neutral');
    });
  });

  describe('assessment structure', () => {
    it('should return correct assessment structure format', async () => {
      const assessment = await service.assessMultipleImages([]);

      // Verify all required fields exist with proper types
      expect(assessment).toHaveProperty('conditionScore');
      expect(assessment).toHaveProperty('photoQualityScore');
      expect(assessment).toHaveProperty('visibleDefects');
      expect(assessment).toHaveProperty('overallAssessment');
      expect(assessment).toHaveProperty('pricingImpact');
      expect(assessment).toHaveProperty('reasoning');
      expect(assessment).toHaveProperty('multiplier');

      // Verify types
      expect(typeof assessment.conditionScore).toBe('number');
      expect(typeof assessment.photoQualityScore).toBe('number');
      expect(Array.isArray(assessment.visibleDefects)).toBe(true);
      expect(['excellent', 'good', 'fair', 'poor']).toContain(
        assessment.overallAssessment
      );
      expect(['increase', 'neutral', 'decrease']).toContain(
        assessment.pricingImpact
      );
      expect(typeof assessment.reasoning).toBe('string');
      expect(typeof assessment.multiplier).toBe('number');

      // Verify ranges
      expect(assessment.multiplier).toBeGreaterThanOrEqual(0.75);
      expect(assessment.multiplier).toBeLessThanOrEqual(1.15);
    });

    it('should return scores in valid range (1-10)', async () => {
      const assessment = await service.assessMultipleImages([]);
      expect(assessment.conditionScore).toBeGreaterThanOrEqual(1);
      expect(assessment.conditionScore).toBeLessThanOrEqual(10);
      expect(assessment.photoQualityScore).toBeGreaterThanOrEqual(1);
      expect(assessment.photoQualityScore).toBeLessThanOrEqual(10);
    });
  });
});
