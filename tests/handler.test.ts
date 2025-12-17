import { health, process } from '../src/handler';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';

// Mock EventBridge
const mockEventBridgeSend = jest.fn();
jest.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: jest.fn().mockImplementation(() => ({
    send: mockEventBridgeSend,
  })),
  PutEventsCommand: jest.fn(),
}));

describe('Handler Functions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEventBridgeSend.mockResolvedValue({});
  });

  describe('health', () => {
    it('should return healthy status for valid health endpoint', async () => {
      const event = {
        requestContext: {
          http: {
            path: '/bg-remover/health',
          },
        },
      };

      const result = await health(event);

      expect(result).toEqual({
        statusCode: 200,
        body: expect.stringContaining('"status":"healthy"'),
      });
    });

    it('should return 404 for invalid health endpoint path', async () => {
      const event = {
        requestContext: {
          http: {
            path: '/invalid/path',
          },
        },
      };

      const result = await health(event);

      expect(result).toEqual({
        statusCode: 404,
        body: JSON.stringify({ message: 'Not Found' }),
      });
    });
  });

  describe('process', () => {
    const mockFetch = global.fetch as jest.MockedFunction<typeof fetch>;

    beforeEach(() => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          outputBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==',
          metadata: {
            width: 100,
            height: 100,
            format: 'png',
            originalSize: 1024,
            processedSize: 512,
          },
        }),
      } as any);
    });

    it('should handle OPTIONS requests', async () => {
      const event = {
        httpMethod: 'OPTIONS',
      };

      const result = await process(event);

      expect(result).toEqual({
        statusCode: 200,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Tenant-Id',
        },
        body: '',
      });
    });

    it('should return 405 for unsupported methods', async () => {
      const event = {
        httpMethod: 'GET',
      };

      const result = await process(event);

      expect(result).toEqual({
        statusCode: 405,
        body: JSON.stringify({ message: 'Method Not Allowed' }),
      });
    });

    it('should process image from base64 successfully', async () => {
      const event = {
        httpMethod: 'POST',
        body: JSON.stringify({
          imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
          outputFormat: 'png',
          quality: 80,
        }),
        requestContext: {
          http: {
            method: 'POST',
          },
        },
      };

      const result = await process(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.success).toBe(true);
      expect(body.jobId).toBe('test-uuid-123');
      expect(body.outputUrl).toContain('data:image/png;base64,');
      expect(body.processingTimeMs).toBeGreaterThan(0);
      expect(body.metadata).toEqual({
        width: 100,
        height: 100,
        format: 'png',
        originalSize: 1024,
        processedSize: 512,
      });
    });

    it('should return 400 when no image provided', async () => {
      const event = {
        httpMethod: 'POST',
        body: JSON.stringify({
          outputFormat: 'png',
        }),
        requestContext: {
          http: {
            method: 'POST',
          },
        },
      };

      const result = await process(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.success).toBe(false);
      expect(body.error).toBe('No image provided');
    });

    it('should handle validation errors', async () => {
      const event = {
        httpMethod: 'POST',
        body: JSON.stringify({
          invalidField: 'invalid',
        }),
        requestContext: {
          http: {
            method: 'POST',
          },
        },
      };

      const result = await process(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Validation error');
    });

    it('should handle image processing errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Image processing failed',
      } as any);

      const event = {
        httpMethod: 'POST',
        body: JSON.stringify({
          imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
          outputFormat: 'png',
        }),
        requestContext: {
          http: {
            method: 'POST',
          },
        },
      };

      const result = await process(event);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Image Optimizer API failed');
    });

    it('should emit CarouselImageProcessed event', async () => {
      const event = {
        httpMethod: 'POST',
        body: JSON.stringify({
          imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
          outputFormat: 'png',
          productId: 'test-product-123',
        }),
        requestContext: {
          http: {
            method: 'POST',
          },
        },
      };

      await process(event);

      expect(mockEventBridgeSend).toHaveBeenCalledWith(
        expect.objectContaining({
          Entries: [
            expect.objectContaining({
              Source: 'carousel.bg-remover',
              DetailType: 'CarouselImageProcessed',
              Detail: expect.stringContaining('"file_hash":"test-uuid-123"'),
            }),
          ],
        })
      );
    });
  });
});