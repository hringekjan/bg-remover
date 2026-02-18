/**
 * Vision Analysis Service Tests
 */

import { VisionAnalysisService, VisionAnalysisConfig } from './vision-analysis';
import { Logger } from '@aws-lambda-powertools/logger';

// Mock BedrockRuntimeClient
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({
    send: jest.fn(),
  })),
  InvokeModelCommand: jest.fn().mockImplementation((args) => args),
}));

describe('VisionAnalysisService', () => {
  let service: VisionAnalysisService;
  let mockBedrockSend: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Reset environment variables
    delete process.env.AWS_REGION;
    delete process.env.BEDROCK_REGION;
    delete process.env.VISION_TIMEOUT_MS;
    delete process.env.VISION_SIMPLE_CATEGORIES;
    delete process.env.VISION_COMPLEX_CATEGORIES;
    
    service = new VisionAnalysisService({
      logger: new Logger({ serviceName: 'test-vision' }),
    });

    // Get mock send function
    const { BedrockRuntimeClient } = require('@aws-sdk/client-bedrock-runtime');
    const mockClient = new BedrockRuntimeClient();
    mockBedrockSend = mockClient.send as jest.Mock;
    
    // Replace the bedrock client
    (service as any).bedrock = mockClient;
  });

  describe('selectBedrockModel', () => {
    it.each([
      { category: 'electronics', expected: 'amazon.nova-micro-v1:0' },
      { category: 'iPhone 15', expected: 'amazon.nova-micro-v1:0' },
      { category: 'laptop computer', expected: 'amazon.nova-micro-v1:0' },
      { category: 'Bluetooth headphones', expected: 'amazon.nova-micro-v1:0' },
      { category: 'office chair', expected: 'amazon.nova-micro-v1:0' },
      { category: 'USB cable', expected: 'amazon.nova-micro-v1:0' },
      { category: 'video game console', expected: 'amazon.nova-micro-v1:0' },
    ])('routes "$category" to Nova Micro', ({ category, expected }) => {
      const result = (service as any).selectBedrockModel({ category });
      expect(result).toBe(expected);
    });

    it.each([
      { category: 'leather jacket', expected: 'us.amazon.nova-lite-v1:0' },
      { category: 'vintage furniture', expected: 'us.amazon.nova-lite-v1:0' },
      { category: 'diamond ring', expected: 'us.amazon.nova-lite-v1:0' },
      { category: 'antique painting', expected: 'us.amazon.nova-lite-v1:0' },
      { category: 'running shoes', expected: 'us.amazon.nova-lite-v1:0' },
      { category: 'home decor vase', expected: 'us.amazon.nova-lite-v1:0' },
      { category: 'collectible stamps', expected: 'us.amazon.nova-lite-v1:0' },
    ])('routes "$category" to Nova Lite', ({ category, expected }) => {
      const result = (service as any).selectBedrockModel({ category });
      expect(result).toBe(expected);
    });

    it('defaults to Nova Lite for unknown categories', () => {
      const result = (service as any).selectBedrockModel({ category: 'random item' });
      expect(result).toBe('us.amazon.nova-lite-v1:0');
    });

    it('uses Nova Lite when no category provided', () => {
      const result = (service as any).selectBedrockModel({});
      expect(result).toBe('us.amazon.nova-lite-v1:0');
    });

    it('handles case-insensitive category matching', () => {
      const result = (service as any).selectBedrockModel({ category: 'ELECTRONICS' });
      expect(result).toBe('amazon.nova-micro-v1:0');
    });
  });

  describe('getDefaultAssessment', () => {
    it('returns neutral assessment with multiplier 1.0', () => {
      const assessment = (service as any).getDefaultAssessment();
      
      expect(assessment).toEqual({
        conditionScore: 5,
        photoQualityScore: 5,
        visibleDefects: [],
        overallAssessment: 'good',
        pricingImpact: 'neutral',
        reasoning: 'Vision analysis unavailable, using neutral assessment',
        multiplier: 1.0,
      });
    });
  });

  describe('assessmentToMultiplier', () => {
    it.each([
      { assessment: { overallAssessment: 'excellent', photoQualityScore: 10 }, expected: 1.15 },
      { assessment: { overallAssessment: 'good', photoQualityScore: 8 }, expected: 1.0 },
      { assessment: { overallAssessment: 'fair', photoQualityScore: 6 }, expected: 0.9 },
      { assessment: { overallAssessment: 'poor', photoQualityScore: 4 }, expected: 0.75 },
    ])('calculates correct multiplier for $assessment.overallAssessment', ({ assessment, expected }) => {
      const result = (service as any).assessmentToMultiplier(assessment);
      expect(result).toBe(expected);
    });

    it('applies 0.95 adjustment for poor photo quality', () => {
      const assessment = { overallAssessment: 'good' as const, photoQualityScore: 4 };
      const result = (service as any).assessmentToMultiplier(assessment);
      expect(result).toBe(0.95); // 1.0 * 0.95
    });

    it('does not adjust for acceptable photo quality', () => {
      const assessment = { overallAssessment: 'good' as const, photoQualityScore: 6 };
      const result = (service as any).assessmentToMultiplier(assessment);
      expect(result).toBe(1.0);
    });
  });

  describe('buildPrompt', () => {
    it('includes category and brand in prompt when provided', () => {
      const context = {
        category: 'electronics',
        brand: 'Apple',
        claimedCondition: 'like_new',
      };
      const prompt = (service as any).buildPrompt(context);
      
      expect(prompt).toContain('Category: electronics');
      expect(prompt).toContain('Brand: Apple');
      expect(prompt).toContain('Claimed condition: like_new');
    });

    it('uses placeholders when context is minimal', () => {
      const prompt = (service as any).buildPrompt({});
      
      expect(prompt).toContain('Category: Unknown');
      expect(prompt).toContain('Brand: Unknown');
      expect(prompt).toContain('Claimed condition: Not specified');
    });

    it('handles undefined context', () => {
      const prompt = (service as any).buildPrompt(undefined);
      
      expect(prompt).toContain('Category: Unknown');
    });
  });

  describe('assessVisualQuality', () => {
    const mockSuccessfulResponse = {
      body: {
        async text() {
          return JSON.stringify({
            output: {
              message: {
                content: [
                  { text: JSON.stringify({
                    conditionScore: 8,
                    photoQualityScore: 9,
                    visibleDefects: ['scratch on corner'],
                    overallAssessment: 'good',
                    pricingImpact: 'neutral',
                    reasoning: 'Minor cosmetic damage, overall good condition',
                  })},
                ],
              },
            },
          });
        },
      },
    };

    it('returns assessment on successful Bedrock call', async () => {
      mockBedrockSend.mockResolvedValueOnce(mockSuccessfulResponse);

      // Use a mock base64 image (JPEG magic bytes)
      const imageInput = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAKAAoDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBEQCEAxEPwAB//9k=';

      const result = await service.assessVisualQuality(imageInput, { category: 'electronics' });

      expect(result.conditionScore).toBe(8);
      expect(result.photoQualityScore).toBe(9);
      expect(result.visibleDefects).toContain('scratch on corner');
      expect(result.overallAssessment).toBe('good');
      expect(result.multiplier).toBe(1.0);
    });

    it('returns default assessment on error', async () => {
      mockBedrockSend.mockRejectedValueOnce(new Error('Service unavailable'));

      const imageInput = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAKAAoDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBEQCEAxEPwAB//9k=';

      const result = await service.assessVisualQuality(imageInput);

      expect(result).toEqual((service as any).getDefaultAssessment());
    });

    it('uses Nova Micro for electronics category', async () => {
      mockBedrockSend.mockResolvedValueOnce(mockSuccessfulResponse);

      const imageInput = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAKAAoDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBEQCEAxEPwAB//9k=';

      await service.assessVisualQuality(imageInput, { category: 'phones' });

      expect(mockBedrockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          modelId: 'amazon.nova-micro-v1:0',
        })
      );
    });
  });

  describe('generateEmbedding', () => {
    it('returns 1024-dimensional embedding', async () => {
      const embedding = Array(1024).fill(0.1);
      mockBedrockSend.mockResolvedValueOnce({
        body: {
          async text() {
            return JSON.stringify({ embedding });
          },
        },
      });

      const imageInput = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAKAAoDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBEQCEAxEPwAB//9k=';

      const result = await service.generateEmbedding(imageInput);

      expect(result).toHaveLength(1024);
    });

    it('throws error for invalid embedding dimensions', async () => {
      mockBedrockSend.mockResolvedValueOnce({
        body: {
          async text() {
            return JSON.stringify({ embedding: Array(512).fill(0.1) });
          },
        },
      });

      const imageInput = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAKAAoDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBEQCEAxEPwAB//9k=';

      await expect(service.generateEmbedding(imageInput)).rejects.toThrow('Invalid embedding dimensions');
    });
  });

  describe('assessMultipleImages', () => {
    it('takes worst-case assessment from multiple images', async () => {
      const mockResponse = (score: number) => ({
        body: {
          async text() {
            return JSON.stringify({
              output: {
                message: {
                  content: [
                    { text: JSON.stringify({
                      conditionScore: score,
                      photoQualityScore: 8,
                      visibleDefects: [],
                      overallAssessment: 'good',
                      pricingImpact: 'neutral',
                      reasoning: `Score: ${score}`,
                    })},
                  ],
                },
              },
            });
          },
        },
      });

      mockBedrockSend
        .mockResolvedValueOnce(mockResponse(9))
        .mockResolvedValueOnce(mockResponse(5))
        .mockResolvedValueOnce(mockResponse(7));

      const imageInput = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAKAAoDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBEQCEAxEPwAB//9k=';

      const result = await service.assessMultipleImages([
        imageInput,
        imageInput,
        imageInput,
      ]);

      // Should take the worst (lowest) score
      expect(result.conditionScore).toBe(5);
      expect(result.reasoning).toContain('Score: 5');
    });

    it('returns default for empty array', async () => {
      const result = await service.assessMultipleImages([]);
      expect(result).toEqual((service as any).getDefaultAssessment());
    });
  });

  describe('generateBatchEmbeddings', () => {
    it('returns results for all images', async () => {
      const embedding = Array(1024).fill(0.1);
      mockBedrockSend.mockResolvedValue({
        body: {
          async text() {
            return JSON.stringify({ embedding });
          },
        },
      });

      const imageInput = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAKAAoDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBEQCEAxEPwAB//9k=';

      const results = await service.generateBatchEmbeddings([
        imageInput,
        imageInput,
      ]);

      expect(results).toHaveLength(2);
      expect(results[0].embedding).toHaveLength(1024);
      expect(results[1].embedding).toHaveLength(1024);
    });

    it('captures errors for failed embeddings', async () => {
      mockBedrockSend.mockRejectedValue(new Error('Failed'));

      const imageInput = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAKAAoDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBEQCEAxEPwAB//9k=';

      const results = await service.generateBatchEmbeddings([imageInput]);

      expect(results[0].error).toBe('Failed');
      expect(results[0].embedding).toBeUndefined();
    });
  });

  describe('configuration', () => {
    it('loads configuration from environment variables', () => {
      process.env.AWS_REGION = 'eu-west-1';
      process.env.VISION_TIMEOUT_MS = '20000';
      process.env.VISION_SIMPLE_CATEGORIES = 'electronics,computers';
      process.env.VISION_COMPLEX_CATEGORIES = 'clothing,furniture';

      const customService = new VisionAnalysisService();

      expect((customService as any).config.region).toBe('eu-west-1');
      expect((customService as any).config.timeout).toBe(20000);
      expect((customService as any).config.simpleCategories).toEqual(['electronics', 'computers']);
      expect((customService as any).config.complexCategories).toEqual(['clothing', 'furniture']);
    });

    it('uses defaults when environment variables not set', () => {
      delete process.env.AWS_REGION;
      delete process.env.VISION_TIMEOUT_MS;

      const defaultService = new VisionAnalysisService();

      expect((defaultService as any).config.region).toBe('us-east-1');
      expect((defaultService as any).config.timeout).toBe(10000);
    });
  });

  describe('circuit breaker', () => {
    it('tracks circuit breaker state', () => {
      expect(service.getCircuitBreakerState()).toBe('CLOSED');
    });
  });
});

describe('Configuration Constants', () => {
  it('has correct default models defined', () => {
    expect(VisionAnalysisConfig.prototype).toBeDefined();
  });
});
