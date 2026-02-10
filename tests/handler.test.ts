// Mock DynamoDB health check
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({
    send: jest.fn().mockResolvedValue({}),
  })),
  DescribeTableCommand: jest.fn(),
}));

// Mock S3 health check
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({
    send: jest.fn().mockResolvedValue({}),
  })),
  ListBucketsCommand: jest.fn(),
  GetObjectCommand: jest.fn(),
}));

// Mock SSM before imports
const mockSSMSend = jest.fn();
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({
    send: mockSSMSend,
  })),
  GetParametersCommand: jest.fn((input: unknown) => ({ input })),
  GetParameterCommand: jest.fn((input: unknown) => ({ input })),
}));

// Mock fetch globally
const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
global.fetch = mockFetch;

// Mock EventBridge
const mockEventBridgeSend = jest.fn();
jest.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: jest.fn().mockImplementation(() => ({
    send: mockEventBridgeSend,
  })),
  PutEventsCommand: jest.fn((input: unknown) => {
    if (input && typeof input === 'object') {
      return { ...input as Record<string, unknown> };
    }
    return { input };
  }),
}));

// Mock JWT validation to bypass auth in tests
jest.mock('../src/lib/auth/jwt-validator', () => ({
  validateJWTFromEvent: jest.fn().mockResolvedValue({
    isValid: true,
    payload: {
      sub: 'test-user-123',
      email: 'test@carousellabs.co',
      'cognito:groups': ['admin'],
    },
    userId: 'test-user-123',
    email: 'test@carousellabs.co',
    groups: ['admin'],
  }),
  getCognitoConfigForTenantAsync: jest.fn().mockResolvedValue({
    userPoolId: 'test-pool',
    region: 'eu-west-1',
    issuer: 'https://cognito-idp.eu-west-1.amazonaws.com/test-pool',
    audience: ['test-client'],
  }),
  extractTokenFromHeader: jest.fn((header: string | undefined) =>
    header?.replace('Bearer ', '') || null
  ),
}));

// Mock Cognito for health checks (used by health endpoint)
jest.mock('../src/lib/tenant/cognito-config', () => ({
  loadTenantCognitoConfig: jest.fn().mockResolvedValue({
    userPoolId: 'test-pool',
    region: 'eu-west-1',
    issuer: 'https://cognito-idp.eu-west-1.amazonaws.com/test-pool',
  }),
}));

// Mock cache service for health checks
jest.mock('../src/lib/cache/cache-service-client', () => ({
  CacheServiceClient: jest.fn().mockImplementation(() => ({
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(true),
    health: jest.fn().mockResolvedValue({ status: 'healthy' }),
  })),
}));

// Mock cache manager to avoid background timers
jest.mock('../src/lib/cache/cache-manager', () => ({
  getCacheManager: jest.fn().mockReturnValue({
    getStats: jest.fn().mockReturnValue({
      cacheService: { state: 'closed' }
    }),
    get: jest.fn(),
    set: jest.fn(),
  })
}));

// Mock UUID
jest.mock('crypto', () => ({
  ...jest.requireActual('crypto'),
  randomUUID: jest.fn().mockReturnValue('test-uuid-123'),
}));

// Mock job-store
jest.mock('../src/lib/job-store', () => ({
  getJobStatus: jest.fn(),
  setJobStatus: jest.fn(),
  updateJobStatus: jest.fn(),
  deleteJob: jest.fn(),
  createJob: jest.fn(),
  markJobCompleted: jest.fn(),
  markJobFailed: jest.fn(),
}));

// Mock S3 client lib
jest.mock('../lib/s3/client', () => ({
  uploadProcessedImage: jest.fn().mockResolvedValue('https://bg-remover-test.s3.eu-west-1.amazonaws.com/test-uuid-123.png'),
  generateOutputKey: jest.fn().mockReturnValue('test-uuid-123.png'),
  getOutputBucket: jest.fn().mockResolvedValue('bg-remover-test'),
}));

// Mock image processing pipeline to avoid dynamic imports and network calls
jest.mock('../src/lib/bedrock/image-processor', () => ({
  processImageFromUrl: jest.fn().mockResolvedValue({
    outputBuffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==',
      'base64'
    ),
    metadata: {
      width: 100,
      height: 100,
      format: 'png',
      originalSize: 1024,
      processedSize: 512,
    },
  }),
  processImageFromBase64: jest.fn().mockResolvedValue({
    outputBuffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==',
      'base64'
    ),
    metadata: {
      width: 100,
      height: 100,
      format: 'png',
      originalSize: 1024,
      processedSize: 512,
    },
  }),
}));

import { health, process as processHandler } from '../src/handler';
import * as jobStore from '../src/lib/job-store';
import * as s3Client from '../lib/s3/client';
import * as imageProcessor from '../src/lib/bedrock/image-processor';

describe('Handler Functions', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Set environment variables for tenant/stage resolution
    process.env.STAGE = 'test';
    process.env.TENANT = 'carousel-labs';
    process.env.AWS_REGION = 'eu-west-1';
    process.env.DYNAMODB_TABLE = 'bg-remover-test';
    process.env.CACHE_SERVICE_ENABLED = 'false';  // Disable cache service for tests

    // Mock SSM to return valid config
    mockSSMSend.mockResolvedValue({
      Parameters: [
        {
          Name: '/tf/test/carousel-labs/services/bg-remover/config',
          Value: JSON.stringify({
            apiBaseUrl: 'https://api.test.carousellabs.co',
          }),
        },
        {
          Name: '/tf/test/carousel-labs/services/bg-remover/secrets',
          Value: JSON.stringify({
            serviceApiKey: 'test-api-key-123',
          }),
        },
      ],
    });

    // Mock EventBridge
    mockEventBridgeSend.mockResolvedValue({});

    // Mock fetch for Cognito health check and image processing
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
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

      expect(result.statusCode).toBe(200);
      expect(result.body).toContain('"status":"healthy"');
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

      expect(result.statusCode).toBe(404);
      const body = JSON.parse(result.body);
      expect(body.error).toBe('NOT_FOUND');
    });
  });

  describe('process', () => {
    it('should handle OPTIONS requests', async () => {
      const event = {
        httpMethod: 'OPTIONS',
        headers: {
          origin: 'https://carousel.dev.carousellabs.co',
          'x-tenant-id': 'carousel-labs',
        },
      };

      const result = await processHandler(event);

      expect(result.statusCode).toBe(200);
      expect(result.headers).toMatchObject({
        'Access-Control-Allow-Origin': 'https://carousel.dev.carousellabs.co',
        'Access-Control-Allow-Methods': expect.stringContaining('OPTIONS'),
        'Access-Control-Allow-Headers': expect.stringContaining('Content-Type'),
      });
    });

    it('should return 405 for unsupported methods', async () => {
      const event = {
        httpMethod: 'GET',
      };

      const result = await processHandler(event);

      expect(result.statusCode).toBe(405);
      const body = JSON.parse(result.body);
      expect(body.error).toBe('METHOD_NOT_ALLOWED');
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

      const result = await processHandler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.success).toBe(true);
      expect(body.jobId).toBe('test-uuid-123');
      expect(body.outputUrl).toContain('s3.eu-west-1.amazonaws.com');
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

      const result = await processHandler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toBe('VALIDATION_ERROR');
      expect(body.message).toContain('validation');
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

      const result = await processHandler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toBe('VALIDATION_ERROR');
    });

    it('should handle image processing errors', async () => {
      (imageProcessor.processImageFromBase64 as jest.Mock).mockRejectedValueOnce(
        new Error('Image processing failed')
      );

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

      const result = await processHandler(event);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.error).toBe('INTERNAL_ERROR');
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

      await processHandler(event);

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
