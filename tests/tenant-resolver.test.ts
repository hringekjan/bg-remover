import { resolveTenantFromRequest, loadTenantConfig } from '../src/lib/tenant/resolver';

// Mock SSM client
const mockSSMSend = jest.fn();
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn().mockImplementation(() => ({
    send: mockSSMSend,
  })),
  GetParameterCommand: jest.fn(),
}));

describe('Tenant Resolver', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSSMSend.mockResolvedValue({
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

    it('should resolve tenant from domain', async () => {
      const event = {
        requestContext: {
          domainName: 'test-tenant.dev.carousellabs.co',
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

      expect(mockSSMSend).toHaveBeenCalledWith(
        expect.objectContaining({
          input: {
            Name: `/tf/dev/test-tenant/services/bg-remover/config`,
          },
        })
      );

      expect(config).toEqual({
        bedrock: { region: 'us-east-1' },
        s3: { bucket: 'test-bucket' },
      });
    });

    it('should handle SSM parameter not found', async () => {
      mockSSMSend.mockRejectedValueOnce(new Error('Parameter not found'));

      const tenant = 'test-tenant';
      const stage = 'dev';

      const config = await loadTenantConfig(tenant, stage);

      expect(config).toEqual({}); // Should return empty config
    });

    it('should handle malformed JSON in SSM', async () => {
      mockSSMSend.mockResolvedValueOnce({
        Parameter: {
          Value: 'invalid-json',
        },
      });

      const tenant = 'test-tenant';
      const stage = 'dev';

      const config = await loadTenantConfig(tenant, stage);

      expect(config).toEqual({}); // Should return empty config
    });
  });
});