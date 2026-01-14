/**
 * Health Endpoint Tests
 *
 * Tests correct HTTP status codes for different dependency health states:
 * - 200 OK: All dependencies healthy
 * - 207 Multi-Status: Some dependencies degraded but service operational
 * - 503 Service Unavailable: Critical dependencies down
 */

import { health } from '../handler';

// Mock AWS SDK clients
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(),
  DescribeTableCommand: jest.fn(),
}));

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(),
  ListBucketsCommand: jest.fn(),
}));

// Mock tenant resolver
jest.mock('../lib/tenant/resolver', () => ({
  resolveTenantFromRequest: jest.fn(() => Promise.resolve('carousel-labs')),
}));

// Mock CORS
jest.mock('../lib/cors', () => ({
  createTenantCorsHeaders: jest.fn(() => ({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  })),
}));

// Mock Cognito config
jest.mock('../lib/tenant/cognito-config', () => ({
  loadTenantCognitoConfig: jest.fn(() => Promise.resolve({
    userPoolId: 'eu-west-1_test',
    region: 'eu-west-1',
    issuer: 'https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_test',
  })),
}));

// Mock cache manager
jest.mock('../lib/cache/cache-manager', () => ({
  getCacheManager: jest.fn(() => ({
    getStats: jest.fn(() => ({
      cacheService: {
        state: 'closed',
        available: true,
      },
    })),
  })),
}));

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

describe('Health Endpoint', () => {
  const mockEvent = {
    requestContext: {
      http: {
        path: '/dev/bg-remover/health',
        method: 'GET',
      },
    },
    headers: {
      host: 'api.dev.carousellabs.co',
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.STAGE = 'dev';
    process.env.TENANT = 'carousel-labs';
    process.env.AWS_REGION = 'eu-west-1';
    process.env.DYNAMODB_TABLE = 'bg-remover-dev';
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('200 OK - All Healthy', () => {
    it('should return 200 when all dependencies are healthy', async () => {
      // Mock all dependencies healthy
      const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
      const { S3Client } = require('@aws-sdk/client-s3');

      (DynamoDBClient as any).mockImplementation(() => ({
        send: jest.fn().mockResolvedValue({}),
      }));

      (S3Client as any).mockImplementation(() => ({
        send: jest.fn().mockResolvedValue({}),
      }));

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
      });

      const result = await health(mockEvent);

      expect(result.statusCode).toBe(200);

      const body = JSON.parse(result.body);
      expect(body.status).toBe('healthy');
      expect(body.dependencies.dynamodb.status).toBe('healthy');
      expect(body.dependencies.s3.status).toBe('healthy');
      expect(body.dependencies.cognito.status).toBe('healthy');
      expect(body.dependencies.cacheService.status).toBe('healthy');
    });
  });

  describe('207 Multi-Status - Degraded', () => {
    it('should return 207 when Cognito JWKS is degraded', async () => {
      // Mock DynamoDB and S3 healthy
      const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
      const { S3Client } = require('@aws-sdk/client-s3');

      (DynamoDBClient as any).mockImplementation(() => ({
        send: jest.fn().mockResolvedValue({}),
      }));

      (S3Client as any).mockImplementation(() => ({
        send: jest.fn().mockResolvedValue({}),
      }));

      // Mock Cognito JWKS failure (degraded, not critical)
      mockFetch.mockRejectedValue(new Error('JWKS unreachable'));

      const result = await health(mockEvent);

      expect(result.statusCode).toBe(207);

      const body = JSON.parse(result.body);
      expect(body.status).toBe('degraded');
      expect(body.dependencies.dynamodb.status).toBe('healthy');
      expect(body.dependencies.s3.status).toBe('healthy');
      expect(body.dependencies.cognito.status).toBe('degraded');
      expect(body.dependencies.cognito.message).toContain('JWKS');
    });

    it('should return 207 when cache service circuit breaker is open', async () => {
      // Mock DynamoDB and S3 healthy
      const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
      const { S3Client } = require('@aws-sdk/client-s3');

      (DynamoDBClient as any).mockImplementation(() => ({
        send: jest.fn().mockResolvedValue({}),
      }));

      (S3Client as any).mockImplementation(() => ({
        send: jest.fn().mockResolvedValue({}),
      }));

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
      });

      // Mock cache service circuit breaker open
      const { getCacheManager } = require('../lib/cache/cache-manager');
      (getCacheManager as any).mockReturnValue({
        getStats: jest.fn(() => ({
          cacheService: {
            state: 'open',
            available: false,
          },
        })),
      });

      // Set cache service URL to enable check
      process.env.CACHE_SERVICE_URL = 'https://cache.dev.carousellabs.co';

      const result = await health(mockEvent);

      expect(result.statusCode).toBe(207);

      const body = JSON.parse(result.body);
      expect(body.status).toBe('degraded');
      expect(body.dependencies.cacheService.status).toBe('degraded');
      expect(body.dependencies.cacheService.message).toContain('circuit breaker');
    });
  });

  describe('503 Service Unavailable - Unhealthy', () => {
    it('should return 503 when DynamoDB is down', async () => {
      // Mock DynamoDB failure (critical)
      const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
      const { S3Client } = require('@aws-sdk/client-s3');

      (DynamoDBClient as any).mockImplementation(() => ({
        send: jest.fn().mockRejectedValue(new Error('Table not found')),
      }));

      (S3Client as any).mockImplementation(() => ({
        send: jest.fn().mockResolvedValue({}),
      }));

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
      });

      const result = await health(mockEvent);

      expect(result.statusCode).toBe(503);

      const body = JSON.parse(result.body);
      expect(body.status).toBe('unhealthy');
      expect(body.dependencies.dynamodb.status).toBe('unhealthy');
      expect(body.dependencies.dynamodb.message).toContain('Table not found');
    });

    it('should return 503 when S3 is down', async () => {
      // Mock S3 failure (critical)
      const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
      const { S3Client } = require('@aws-sdk/client-s3');

      (DynamoDBClient as any).mockImplementation(() => ({
        send: jest.fn().mockResolvedValue({}),
      }));

      (S3Client as any).mockImplementation(() => ({
        send: jest.fn().mockRejectedValue(new Error('Access denied')),
      }));

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
      });

      const result = await health(mockEvent);

      expect(result.statusCode).toBe(503);

      const body = JSON.parse(result.body);
      expect(body.status).toBe('unhealthy');
      expect(body.dependencies.s3.status).toBe('unhealthy');
      expect(body.dependencies.s3.message).toContain('Access denied');
    });

    it('should return 503 when both DynamoDB and S3 are down', async () => {
      // Mock both critical dependencies down
      const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
      const { S3Client } = require('@aws-sdk/client-s3');

      (DynamoDBClient as any).mockImplementation(() => ({
        send: jest.fn().mockRejectedValue(new Error('DynamoDB error')),
      }));

      (S3Client as any).mockImplementation(() => ({
        send: jest.fn().mockRejectedValue(new Error('S3 error')),
      }));

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
      });

      const result = await health(mockEvent);

      expect(result.statusCode).toBe(503);

      const body = JSON.parse(result.body);
      expect(body.status).toBe('unhealthy');
      expect(body.dependencies.dynamodb.status).toBe('unhealthy');
      expect(body.dependencies.s3.status).toBe('unhealthy');
    });
  });

  describe('Response Format', () => {
    it('should include latency measurements for all dependencies', async () => {
      const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
      const { S3Client } = require('@aws-sdk/client-s3');

      (DynamoDBClient as any).mockImplementation(() => ({
        send: jest.fn().mockResolvedValue({}),
      }));

      (S3Client as any).mockImplementation(() => ({
        send: jest.fn().mockResolvedValue({}),
      }));

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
      });

      const result = await health(mockEvent);
      const body = JSON.parse(result.body);

      expect(body.dependencies.dynamodb.latency).toBeGreaterThanOrEqual(0);
      expect(body.dependencies.s3.latency).toBeGreaterThanOrEqual(0);
      expect(body.dependencies.cognito.latency).toBeGreaterThanOrEqual(0);
      expect(body.dependencies.cacheService.latency).toBeGreaterThanOrEqual(0);
    });

    it('should include timestamp in response', async () => {
      const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
      const { S3Client } = require('@aws-sdk/client-s3');

      (DynamoDBClient as any).mockImplementation(() => ({
        send: jest.fn().mockResolvedValue({}),
      }));

      (S3Client as any).mockImplementation(() => ({
        send: jest.fn().mockResolvedValue({}),
      }));

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
      });

      const result = await health(mockEvent);
      const body = JSON.parse(result.body);

      expect(body.timestamp).toBeDefined();
      expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
    });

    it('should include CORS headers', async () => {
      const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
      const { S3Client } = require('@aws-sdk/client-s3');

      (DynamoDBClient as any).mockImplementation(() => ({
        send: jest.fn().mockResolvedValue({}),
      }));

      (S3Client as any).mockImplementation(() => ({
        send: jest.fn().mockResolvedValue({}),
      }));

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
      });

      const result = await health(mockEvent);

      expect(result.headers['Access-Control-Allow-Origin']).toBe('*');
      expect(result.headers['Content-Type']).toBe('application/json');
    });
  });

  describe('Edge Cases', () => {
    it('should handle cache service not configured gracefully', async () => {
      const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
      const { S3Client } = require('@aws-sdk/client-s3');

      (DynamoDBClient as any).mockImplementation(() => ({
        send: jest.fn().mockResolvedValue({}),
      }));

      (S3Client as any).mockImplementation(() => ({
        send: jest.fn().mockResolvedValue({}),
      }));

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
      });

      // No cache service URL
      delete process.env.CACHE_SERVICE_URL;

      const result = await health(mockEvent);

      expect(result.statusCode).toBe(200);

      const body = JSON.parse(result.body);
      expect(body.dependencies.cacheService.status).toBe('healthy');
      expect(body.dependencies.cacheService.message).toContain('not configured');
    });

    it('should handle invalid path gracefully', async () => {
      const invalidEvent = {
        ...mockEvent,
        requestContext: {
          http: {
            path: '/invalid/path',
            method: 'GET',
          },
        },
      };

      const result = await health(invalidEvent);

      expect(result.statusCode).toBe(404);
    });
  });
});
