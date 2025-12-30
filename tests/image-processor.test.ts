// Mock AWS SDK before imports
const mockSSMSend = jest.fn();
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({
    send: mockSSMSend,
  })),
  GetParametersCommand: jest.fn((input: unknown) => ({ input })),
}));

// Mock fetch globally
const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
global.fetch = mockFetch;

import { processImageFromUrl, processImageFromBase64 } from '../src/lib/bedrock/image-processor';

describe('Image Processor', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Set environment variables for tenant/stage resolution
    process.env.STAGE = 'dev';
    process.env.TENANT = 'test-tenant';

    // Mock SSM to return valid config with serviceApiKey (required by image-processor)
    mockSSMSend.mockResolvedValue({
      Parameters: [
        {
          Name: '/tf/dev/test-tenant/services/bg-remover/config',
          Value: JSON.stringify({
            apiBaseUrl: 'https://api.image-optimizer.example.com',
          }),
        },
        {
          Name: '/tf/dev/test-tenant/services/bg-remover/secrets',
          Value: JSON.stringify({
            serviceApiKey: 'test-api-key-123',
          }),
        },
      ],
    });

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

  describe('processImageFromUrl', () => {
    it('should process image from URL successfully', async () => {
      const imageUrl = 'https://example.com/image.jpg';
      const options = {
        format: 'png',
        quality: 80,
        autoTrim: false,
        centerSubject: false,
        enhanceColors: false,
      };
      const tenant = 'test-tenant';

      const result = await processImageFromUrl(imageUrl, options, tenant);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/optimize'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'X-Tenant-Id': tenant,
          }),
          body: JSON.stringify({
            imageUrl,
            outputFormat: 'png',
            quality: 80,
            targetSize: undefined,
          }),
        })
      );

      expect(result).toEqual({
        outputBuffer: expect.any(Buffer),
        metadata: {
          width: 100,
          height: 100,
          format: 'png',
          originalSize: 1024,
          processedSize: 512,
        },
      });
    });

    it('should handle processing errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      } as any);

      const imageUrl = 'https://example.com/image.jpg';
      const options = { format: 'png', quality: 80 };
      const tenant = 'test-tenant';

      await expect(processImageFromUrl(imageUrl, options, tenant)).rejects.toThrow(
        'Image Optimizer API failed: 500 - Internal Server Error'
      );
    });

    it('should handle network errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const imageUrl = 'https://example.com/image.jpg';
      const options = { format: 'png', quality: 80 };
      const tenant = 'test-tenant';

      await expect(processImageFromUrl(imageUrl, options, tenant)).rejects.toThrow('Network error');
    });
  });

  describe('processImageFromBase64', () => {
    it('should process image from base64 successfully', async () => {
      const base64Image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=';
      const contentType = 'image/png';
      const options = {
        format: 'png',
        quality: 80,
        autoTrim: false,
        centerSubject: false,
        enhanceColors: false,
      };
      const tenant = 'test-tenant';

      const result = await processImageFromBase64(base64Image, contentType, options, tenant);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/optimize'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'X-Tenant-Id': tenant,
          }),
          body: JSON.stringify({
            imageBase64: base64Image,
            outputFormat: 'png',
            quality: 80,
            targetSize: undefined,
          }),
        })
      );

      expect(result).toEqual({
        outputBuffer: expect.any(Buffer),
        metadata: {
          width: 100,
          height: 100,
          format: 'png',
          originalSize: 1024,
          processedSize: 512,
        },
      });
    });

    it('should handle target size options', async () => {
      const base64Image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=';
      const contentType = 'image/png';
      const options = {
        format: 'png',
        quality: 80,
        targetSize: { width: 200, height: 200 },
      };
      const tenant = 'test-tenant';

      await processImageFromBase64(base64Image, contentType, options, tenant);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: JSON.stringify({
            imageBase64: base64Image,
            outputFormat: 'png',
            quality: 80,
            targetSize: { width: 200, height: 200 },
          }),
        })
      );
    });
  });
});