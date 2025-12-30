// Container for mock - allows access after hoisting
const mocks = {
  ssmSend: jest.fn(),
};

jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({
    send: (...args: unknown[]) => mocks.ssmSend(...args),
  })),
  GetParameterCommand: jest.fn((input: unknown) => ({ input })),
}));

import { resolveTenantFromRequest, loadTenantConfig, clearTenantConfigCache } from '../src/lib/tenant/resolver';

describe('Tenant Resolver', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearTenantConfigCache(); // Clear cache between tests
    mocks.ssmSend.mockResolvedValue({
      Parameter: {
        Value: JSON.stringify({
          bedrock: { region: 'us-east-1' },
          s3: { bucket: 'test-bucket' },
        }),
      },
    });
  });

  describe('resolveTenantFromRequest', () => {
    it('should resolve tenant from X-Tenant-Id header', async () => {
      const event = {
        headers: {
          'X-Tenant-Id': 'test-tenant',
        },
      };
      const stage = 'dev';

      const tenant = await resolveTenantFromRequest(event, stage);
      expect(tenant).toBe('test-tenant');
    });

    it('should resolve tenant from host header', async () => {
      const event = {
        headers: {
          host: 'test-tenant.dev.carousellabs.co',
        },
      };
      const stage = 'dev';

      const tenant = await resolveTenantFromRequest(event, stage);
      expect(tenant).toBe('test-tenant');
    });

    it('should return default tenant when no tenant found', async () => {
      const event = {};
      const stage = 'dev';

      const tenant = await resolveTenantFromRequest(event, stage);
      expect(tenant).toBe('carousel-labs');
    });

    it('should handle malformed domain', async () => {
      const event = {
        requestContext: {
          domainName: 'invalid-domain',
        },
      };
      const stage = 'dev';

      const tenant = await resolveTenantFromRequest(event, stage);
      expect(tenant).toBe('carousel-labs');
    });
  });

  describe('loadTenantConfig', () => {
    it('should load tenant config from SSM', async () => {
      const tenant = 'test-tenant';
      const stage = 'dev';

      const config = await loadTenantConfig(tenant, stage);

      expect(mocks.ssmSend).toHaveBeenCalledWith(
        expect.objectContaining({
          input: {
            Name: `/tf/dev/test-tenant/services/bg-remover/config`,
            WithDecryption: true,
          },
        })
      );

      // Config is merged with defaults
      expect(config).toMatchObject({
        tenant: 'test-tenant',
        stage: 'dev',
        bedrock: { region: 'us-east-1' },
        s3: { bucket: 'test-bucket' },
      });
    });

    it('should return default config when SSM parameter not found', async () => {
      mocks.ssmSend.mockRejectedValueOnce(new Error('Parameter not found'));

      const tenant = 'test-tenant';
      const stage = 'dev';

      const config = await loadTenantConfig(tenant, stage);

      // Should return default config when SSM fails
      expect(config).toMatchObject({
        tenant: 'test-tenant',
        stage: 'dev',
        bedrockModelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
        creditsEnabled: true,
      });
    });

    it('should return default config for malformed JSON in SSM', async () => {
      mocks.ssmSend.mockResolvedValueOnce({
        Parameter: {
          Value: 'invalid-json',
        },
      });

      const tenant = 'test-tenant';
      const stage = 'dev';

      const config = await loadTenantConfig(tenant, stage);

      // Should return default config when JSON parsing fails
      expect(config).toMatchObject({
        tenant: 'test-tenant',
        stage: 'dev',
        bedrockModelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
      });
    });
  });
});