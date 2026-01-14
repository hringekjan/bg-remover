/**
 * Multi-Tenant Config Loader Integration Tests
 *
 * Tests complete config loading flow including:
 * - Tenant extraction from request headers/host
 * - SSM config loading with cache
 * - Tenant isolation (no cross-tenant access)
 * - Cache TTL behavior
 * - Error handling and retry logic
 *
 * CRITICAL SECURITY TESTS:
 * - Tenant isolation enforced
 * - No cross-tenant data leakage
 * - Config validation against expected tenant
 * - Cache prevents SSM parameter tampering between requests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  loadAppConfig,
  loadServiceConfig,
  loadConfigs,
  extractTenantFromEvent,
  extractAppFromEvent,
  clearConfigCache,
  validateAppConfig,
  ConfigLoader,
  EcommerceConfig,
  AppSecrets,
} from '@carousellabs/backend-kit';
import { SSMClient, GetParametersCommand } from '@aws-sdk/client-ssm';

// Mock AWS SDK
vi.mock('@aws-sdk/client-ssm', () => {
  const actualModule = vi.importActual('@aws-sdk/client-ssm');
  return {
    ...actualModule,
    SSMClient: vi.fn(() => ({
      send: vi.fn(),
    })),
  };
});

describe('Multi-Tenant Config Loader Integration Tests', () => {
  let mockSSMSend: any;

  beforeEach(() => {
    vi.clearAllMocks();
    clearConfigCache();

    // Get mock SSM send function
    const SSMClientMock = SSMClient as any;
    const instance = new SSMClientMock();
    mockSSMSend = instance.send;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearConfigCache();
  });

  describe('Tenant Extraction from Request Headers', () => {
    it('should extract tenant from x-tenant-id header', () => {
      const event = {
        headers: {
          'x-tenant-id': 'carousel-labs',
        },
      };

      const tenant = extractTenantFromEvent(event);
      expect(tenant).toBe('carousel-labs');
    });

    it('should extract tenant from authorizer context', () => {
      const event = {
        requestContext: {
          authorizer: {
            tenantId: 'hringekjan',
          },
        },
      };

      const tenant = extractTenantFromEvent(event);
      expect(tenant).toBe('hringekjan');
    });

    it('should prioritize header over authorizer context', () => {
      const event = {
        headers: {
          'x-tenant-id': 'carousel-labs',
        },
        requestContext: {
          authorizer: {
            tenantId: 'other-tenant',
          },
        },
      };

      const tenant = extractTenantFromEvent(event);
      expect(tenant).toBe('carousel-labs');
    });

    it('should fall back to environment variable', () => {
      process.env.TENANT = 'default-tenant';

      const event = {};
      const tenant = extractTenantFromEvent(event);

      expect(tenant).toBe('default-tenant');

      delete process.env.TENANT;
    });

    it('should use provided fallback', () => {
      const event = {};
      const tenant = extractTenantFromEvent(event, 'fallback-tenant');

      expect(tenant).toBe('fallback-tenant');
    });

    it('should normalize tenant to lowercase', () => {
      const event = {
        headers: {
          'x-tenant-id': 'CAROUSEL-LABS',
        },
      };

      const tenant = extractTenantFromEvent(event);
      expect(tenant).toBe('carousel-labs');
    });
  });

  describe('App Extraction from EventBridge Events', () => {
    it('should extract app from detail.app field', () => {
      const event = {
        detail: {
          app: 'hrh',
        },
      };

      const app = extractAppFromEvent(event);
      expect(app).toBe('hrh');
    });

    it('should extract app from EventBridge source pattern', () => {
      const event = {
        source: 'carousel.hrh.shopify',
      };

      const app = extractAppFromEvent(event);
      expect(app).toBe('hrh');
    });

    it('should extract app from AWS partner source pattern', () => {
      const event = {
        source: 'aws.partner/shopify.com/carousel.www.shopify',
      };

      const app = extractAppFromEvent(event);
      expect(app).toBe('www');
    });

    it('should extract app from detail fields (publication)', () => {
      const event = {
        detail: {
          publication: 'www',
        },
      };

      const app = extractAppFromEvent(event);
      expect(app).toBe('www');
    });

    it('should throw error if app cannot be extracted', () => {
      const event = {
        detail: {},
      };

      expect(() => extractAppFromEvent(event)).toThrow('Unable to extract app from event');
    });

    it('should normalize app to lowercase', () => {
      const event = {
        detail: {
          app: 'HRH',
        },
      };

      const app = extractAppFromEvent(event);
      expect(app).toBe('hrh');
    });
  });

  describe('SSM Config Loading with Cache', () => {
    it('should load app config from SSM', async () => {
      const mockConfig: EcommerceConfig = {
        site: {
          tenantId: 'carousel-labs',
          app: 'hrh',
          domain: 'hrh.dev.carousellabs.co',
          bucketName: 'hrh-dev-bucket',
        },
        sanity: {
          projectId: 'test-project',
          dataset: 'production',
        },
        shopify: {
          storeDomain: 'test.myshopify.com',
          storefrontAccessToken: 'test-token',
        },
        klaviyo: {
          publicKey: 'test-key',
        },
        analytics: {},
      };

      const mockSecrets: AppSecrets = {
        shopifyAdminToken: 'secret-token',
      };

      mockSSMSend.mockResolvedValue({
        Parameters: [
          {
            Name: '/tf/dev/carousel-labs/services/hrh/config',
            Value: JSON.stringify(mockConfig),
          },
          {
            Name: '/tf/dev/carousel-labs/services/hrh/secrets',
            Value: JSON.stringify(mockSecrets),
          },
        ],
      });

      const result = await loadAppConfig('carousel-labs', 'hrh', 'dev');

      expect(result.config).toEqual(mockConfig);
      expect(result.secrets).toEqual(mockSecrets);
    });

    it('should cache config and reuse on subsequent calls', async () => {
      const mockConfig: EcommerceConfig = {
        site: {
          tenantId: 'carousel-labs',
          app: 'hrh',
          domain: 'hrh.dev.carousellabs.co',
          bucketName: 'hrh-dev-bucket',
        },
        sanity: { projectId: 'test', dataset: 'production' },
        shopify: { storeDomain: 'test.myshopify.com', storefrontAccessToken: 'token' },
        klaviyo: { publicKey: 'key' },
        analytics: {},
      };

      mockSSMSend.mockResolvedValue({
        Parameters: [
          {
            Name: '/tf/dev/carousel-labs/services/hrh/config',
            Value: JSON.stringify(mockConfig),
          },
          {
            Name: '/tf/dev/carousel-labs/services/hrh/secrets',
            Value: JSON.stringify({}),
          },
        ],
      });

      // First call - loads from SSM
      await loadAppConfig('carousel-labs', 'hrh', 'dev');
      expect(mockSSMSend).toHaveBeenCalledTimes(1);

      // Second call - uses cache
      await loadAppConfig('carousel-labs', 'hrh', 'dev');
      expect(mockSSMSend).toHaveBeenCalledTimes(1); // No additional SSM call
    });

    it('should reload config after cache TTL expires', async () => {
      const mockConfig: EcommerceConfig = {
        site: {
          tenantId: 'carousel-labs',
          app: 'hrh',
          domain: 'hrh.dev.carousellabs.co',
          bucketName: 'hrh-dev-bucket',
        },
        sanity: { projectId: 'test', dataset: 'production' },
        shopify: { storeDomain: 'test.myshopify.com', storefrontAccessToken: 'token' },
        klaviyo: { publicKey: 'key' },
        analytics: {},
      };

      mockSSMSend.mockResolvedValue({
        Parameters: [
          {
            Name: '/tf/dev/carousel-labs/services/hrh/config',
            Value: JSON.stringify(mockConfig),
          },
          {
            Name: '/tf/dev/carousel-labs/services/hrh/secrets',
            Value: JSON.stringify({}),
          },
        ],
      });

      // Mock short cache TTL
      process.env.CONFIG_CACHE_TTL = '100'; // 100ms

      // First call
      await loadAppConfig('carousel-labs', 'hrh', 'dev');
      expect(mockSSMSend).toHaveBeenCalledTimes(1);

      // Wait for cache to expire
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Second call - should reload from SSM
      await loadAppConfig('carousel-labs', 'hrh', 'dev');
      expect(mockSSMSend).toHaveBeenCalledTimes(2);

      delete process.env.CONFIG_CACHE_TTL;
    });

    it('should handle malformed JSON in SSM parameters', async () => {
      mockSSMSend.mockResolvedValue({
        Parameters: [
          {
            Name: '/tf/dev/carousel-labs/services/hrh/config',
            Value: 'invalid-json{',
          },
          {
            Name: '/tf/dev/carousel-labs/services/hrh/secrets',
            Value: '{}',
          },
        ],
      });

      const result = await loadAppConfig('carousel-labs', 'hrh', 'dev');

      // Should return empty config on parse error
      expect(result.config).toEqual({});
    });
  });

  describe('Tenant Isolation', () => {
    it('should prevent cross-tenant config access via separate cache keys', async () => {
      const tenant1Config: EcommerceConfig = {
        site: {
          tenantId: 'carousel-labs',
          app: 'hrh',
          domain: 'hrh.dev.carousellabs.co',
          bucketName: 'carousel-labs-bucket',
        },
        sanity: { projectId: 'carousel-project', dataset: 'production' },
        shopify: { storeDomain: 'carousel.myshopify.com', storefrontAccessToken: 'token1' },
        klaviyo: { publicKey: 'key1' },
        analytics: {},
      };

      const tenant2Config: EcommerceConfig = {
        site: {
          tenantId: 'hringekjan',
          app: 'hrh',
          domain: 'hrh.dev.hringekjan.is',
          bucketName: 'hringekjan-bucket',
        },
        sanity: { projectId: 'hringekjan-project', dataset: 'production' },
        shopify: { storeDomain: 'hringekjan.myshopify.com', storefrontAccessToken: 'token2' },
        klaviyo: { publicKey: 'key2' },
        analytics: {},
      };

      // Mock SSM to return different configs based on path
      mockSSMSend.mockImplementation((command: GetParametersCommand) => {
        const paths = command.input.Names || [];
        const configPath = paths[0];

        if (configPath.includes('carousel-labs')) {
          return Promise.resolve({
            Parameters: [
              {
                Name: '/tf/dev/carousel-labs/services/hrh/config',
                Value: JSON.stringify(tenant1Config),
              },
              {
                Name: '/tf/dev/carousel-labs/services/hrh/secrets',
                Value: JSON.stringify({}),
              },
            ],
          });
        } else if (configPath.includes('hringekjan')) {
          return Promise.resolve({
            Parameters: [
              {
                Name: '/tf/dev/hringekjan/services/hrh/config',
                Value: JSON.stringify(tenant2Config),
              },
              {
                Name: '/tf/dev/hringekjan/services/hrh/secrets',
                Value: JSON.stringify({}),
              },
            ],
          });
        }

        return Promise.resolve({ Parameters: [] });
      });

      // Load config for tenant1
      const result1 = await loadAppConfig('carousel-labs', 'hrh', 'dev');
      expect(result1.config.site.tenantId).toBe('carousel-labs');
      expect(result1.config.site.bucketName).toBe('carousel-labs-bucket');

      // Load config for tenant2
      const result2 = await loadAppConfig('hringekjan', 'hrh', 'dev');
      expect(result2.config.site.tenantId).toBe('hringekjan');
      expect(result2.config.site.bucketName).toBe('hringekjan-bucket');

      // Verify configs are isolated
      expect(result1.config.site.bucketName).not.toBe(result2.config.site.bucketName);
    });

    it('should validate config matches expected tenant', () => {
      const config: EcommerceConfig = {
        site: {
          tenantId: 'carousel-labs',
          app: 'hrh',
          domain: 'hrh.dev.carousellabs.co',
          bucketName: 'bucket',
        },
        sanity: { projectId: 'test', dataset: 'production' },
        shopify: { storeDomain: 'test.myshopify.com', storefrontAccessToken: 'token' },
        klaviyo: { publicKey: 'key' },
        analytics: {},
      };

      // Should pass with matching tenant
      expect(() => validateAppConfig(config, 'carousel-labs', 'hrh')).not.toThrow();

      // Should fail with mismatched tenant
      expect(() => validateAppConfig(config, 'hringekjan', 'hrh')).toThrow(
        /does not match expected tenant/
      );
    });

    it('should validate config matches expected app', () => {
      const config: EcommerceConfig = {
        site: {
          tenantId: 'carousel-labs',
          app: 'hrh',
          domain: 'hrh.dev.carousellabs.co',
          bucketName: 'bucket',
        },
        sanity: { projectId: 'test', dataset: 'production' },
        shopify: { storeDomain: 'test.myshopify.com', storefrontAccessToken: 'token' },
        klaviyo: { publicKey: 'key' },
        analytics: {},
      };

      // Should pass with matching app
      expect(() => validateAppConfig(config, 'carousel-labs', 'hrh')).not.toThrow();

      // Should fail with mismatched app
      expect(() => validateAppConfig(config, 'carousel-labs', 'www')).toThrow(
        /does not match expected app/
      );
    });

    it('should reject config without required site fields', () => {
      const invalidConfig: any = {
        sanity: { projectId: 'test', dataset: 'production' },
      };

      expect(() => validateAppConfig(invalidConfig, 'carousel-labs', 'hrh')).toThrow(
        /config.site is required/
      );
    });
  });

  describe('Service Config Loading', () => {
    it('should load service-level config', async () => {
      const serviceConfig = {
        name: 'bg-remover',
        allowedApps: ['hrh', 'www'],
        maxImageSize: 10485760,
      };

      mockSSMSend.mockResolvedValue({
        Parameters: [
          {
            Name: '/tf/dev/carousel-labs/services/bg-remover/config',
            Value: JSON.stringify(serviceConfig),
          },
          {
            Name: '/tf/dev/carousel-labs/services/bg-remover/secrets',
            Value: JSON.stringify({}),
          },
        ],
      });

      const result = await loadServiceConfig('carousel-labs', 'bg-remover', 'dev');

      expect(result.config).toEqual(serviceConfig);
    });

    it('should load both service and app configs', async () => {
      const serviceConfig = {
        name: 'bg-remover',
        allowedApps: ['hrh'],
      };

      const appConfig: EcommerceConfig = {
        site: {
          tenantId: 'carousel-labs',
          app: 'hrh',
          domain: 'hrh.dev.carousellabs.co',
          bucketName: 'bucket',
        },
        sanity: { projectId: 'test', dataset: 'production' },
        shopify: { storeDomain: 'test.myshopify.com', storefrontAccessToken: 'token' },
        klaviyo: { publicKey: 'key' },
        analytics: {},
      };

      mockSSMSend.mockImplementation((command: GetParametersCommand) => {
        const paths = command.input.Names || [];
        const firstPath = paths[0];

        if (firstPath.includes('bg-remover')) {
          return Promise.resolve({
            Parameters: [
              {
                Name: '/tf/dev/carousel-labs/services/bg-remover/config',
                Value: JSON.stringify(serviceConfig),
              },
              {
                Name: '/tf/dev/carousel-labs/services/bg-remover/secrets',
                Value: JSON.stringify({}),
              },
            ],
          });
        } else {
          return Promise.resolve({
            Parameters: [
              {
                Name: '/tf/dev/carousel-labs/services/hrh/config',
                Value: JSON.stringify(appConfig),
              },
              {
                Name: '/tf/dev/carousel-labs/services/hrh/secrets',
                Value: JSON.stringify({}),
              },
            ],
          });
        }
      });

      const result = await loadConfigs('carousel-labs', 'bg-remover', 'hrh', 'dev');

      expect(result.serviceConfig).toEqual(serviceConfig);
      expect(result.appConfig).toEqual(appConfig);
    });
  });

  describe('ConfigLoader Class', () => {
    it('should support custom options', async () => {
      const loader = new ConfigLoader({
        cacheTTL: 1000, // 1 second
        debug: true,
        maxCacheEntries: 5,
      });

      const mockConfig: EcommerceConfig = {
        site: {
          tenantId: 'carousel-labs',
          app: 'hrh',
          domain: 'hrh.dev.carousellabs.co',
          bucketName: 'bucket',
        },
        sanity: { projectId: 'test', dataset: 'production' },
        shopify: { storeDomain: 'test.myshopify.com', storefrontAccessToken: 'token' },
        klaviyo: { publicKey: 'key' },
        analytics: {},
      };

      mockSSMSend.mockResolvedValue({
        Parameters: [
          {
            Name: '/tf/dev/carousel-labs/services/hrh/config',
            Value: JSON.stringify(mockConfig),
          },
          {
            Name: '/tf/dev/carousel-labs/services/hrh/secrets',
            Value: JSON.stringify({}),
          },
        ],
      });

      const result = await loader.loadAppConfig('carousel-labs', 'hrh', 'dev');
      expect(result.config).toEqual(mockConfig);
    });

    it('should retry on SSM errors', async () => {
      const loader = new ConfigLoader({
        maxRetries: 3,
        retryDelay: 10,
      });

      const mockConfig: EcommerceConfig = {
        site: {
          tenantId: 'carousel-labs',
          app: 'hrh',
          domain: 'hrh.dev.carousellabs.co',
          bucketName: 'bucket',
        },
        sanity: { projectId: 'test', dataset: 'production' },
        shopify: { storeDomain: 'test.myshopify.com', storefrontAccessToken: 'token' },
        klaviyo: { publicKey: 'key' },
        analytics: {},
      };

      // Fail twice, then succeed
      let callCount = 0;
      mockSSMSend.mockImplementation(() => {
        callCount++;
        if (callCount < 3) {
          return Promise.reject(new Error('SSM timeout'));
        }
        return Promise.resolve({
          Parameters: [
            {
              Name: '/tf/dev/carousel-labs/services/hrh/config',
              Value: JSON.stringify(mockConfig),
            },
            {
              Name: '/tf/dev/carousel-labs/services/hrh/secrets',
              Value: JSON.stringify({}),
            },
          ],
        });
      });

      const result = await loader.loadAppConfig('carousel-labs', 'hrh', 'dev');
      expect(result.config).toEqual(mockConfig);
      expect(callCount).toBe(3); // 2 retries + 1 success
    });

    it('should clear cache for specific tenant/app', async () => {
      const loader = new ConfigLoader();

      const mockConfig: EcommerceConfig = {
        site: {
          tenantId: 'carousel-labs',
          app: 'hrh',
          domain: 'hrh.dev.carousellabs.co',
          bucketName: 'bucket',
        },
        sanity: { projectId: 'test', dataset: 'production' },
        shopify: { storeDomain: 'test.myshopify.com', storefrontAccessToken: 'token' },
        klaviyo: { publicKey: 'key' },
        analytics: {},
      };

      mockSSMSend.mockResolvedValue({
        Parameters: [
          {
            Name: '/tf/dev/carousel-labs/services/hrh/config',
            Value: JSON.stringify(mockConfig),
          },
          {
            Name: '/tf/dev/carousel-labs/services/hrh/secrets',
            Value: JSON.stringify({}),
          },
        ],
      });

      // Load config
      await loader.loadAppConfig('carousel-labs', 'hrh', 'dev');
      expect(mockSSMSend).toHaveBeenCalledTimes(1);

      // Clear cache
      loader.clearCache('carousel-labs', 'hrh', 'dev');

      // Reload - should fetch from SSM again
      await loader.loadAppConfig('carousel-labs', 'hrh', 'dev');
      expect(mockSSMSend).toHaveBeenCalledTimes(2);
    });
  });
});
