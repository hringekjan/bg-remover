/**
 * Cache Service Client Unit Tests
 *
 * Comprehensive test suite covering:
 * - Tenant ID validation (security-critical)
 * - Header injection prevention
 * - Tenant isolation enforcement
 * - Cache operations with validated tenants
 * - Circuit breaker integration
 */

import { CacheServiceClient } from './cache-service-client';

describe('CacheServiceClient - Tenant Validation Security', () => {
  let client: CacheServiceClient;

  beforeEach(() => {
    client = new CacheServiceClient({
      circuitBreakerConfig: {
        failureThreshold: 3,
        successThreshold: 2,
        timeout: 1000,
      },
    });

    // Mock fetch
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ value: { data: 'test' } }),
    });
  });

  describe('validateTenantId - Valid Tenant IDs', () => {
    it('should accept valid tenant ID: hringekjan', async () => {
      const result = await client.get('hringekjan', 'test-key');
      // Should pass validation and attempt fetch
      expect(result.success || !result.error?.includes('Invalid tenantId')).toBe(true);
    });

    it('should accept valid tenant ID: carousel-labs', async () => {
      const result = await client.get('carousel-labs', 'test-key');
      expect(result.success || !result.error?.includes('Invalid tenantId')).toBe(true);
    });

    it('should accept valid tenant ID with multiple hyphens: my-tenant-id-123', async () => {
      const result = await client.get('my-tenant-id-123', 'test-key');
      expect(result.success || !result.error?.includes('Invalid tenantId')).toBe(true);
    });

    it('should accept single character tenant ID: a', async () => {
      const result = await client.get('a', 'test-key');
      expect(result.success || !result.error?.includes('Invalid tenantId')).toBe(true);
    });

    it('should accept numeric tenant ID: 12345', async () => {
      const result = await client.get('12345', 'test-key');
      expect(result.success || !result.error?.includes('Invalid tenantId')).toBe(true);
    });

    it('should accept max length tenant ID (63 chars)', async () => {
      const maxLengthId = 'a'.repeat(63);
      const result = await client.get(maxLengthId, 'test-key');
      expect(result.success || !result.error?.includes('Invalid tenantId')).toBe(true);
    });

    it('should accept tenant ID with numbers and hyphens: tenant-123-abc', async () => {
      const result = await client.get('tenant-123-abc', 'test-key');
      expect(result.success || !result.error?.includes('Invalid tenantId')).toBe(true);
    });
  });

  describe('validateTenantId - Invalid Format Rejections', () => {
    it('should reject tenant ID with uppercase letters: ABC', async () => {
      const result = await client.get('ABC', 'test-key');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      // Error includes the invalid pattern message
      expect(result.error).toContain('Invalid tenantId');
    });

    it('should reject tenant ID with underscores: tenant_123', async () => {
      const result = await client.get('tenant_123', 'test-key');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('Invalid tenantId');
    });

    it('should reject tenant ID with dots: tenant.com', async () => {
      const result = await client.get('tenant.com', 'test-key');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('Invalid tenantId');
    });

    it('should reject tenant ID with spaces: tenant abc', async () => {
      const result = await client.get('tenant abc', 'test-key');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('Invalid tenantId');
    });

    it('should reject tenant ID with special chars: tenant@123', async () => {
      const result = await client.get('tenant@123', 'test-key');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('Invalid tenantId');
    });

    it('should reject tenant ID with path traversal: ../etc/passwd', async () => {
      const result = await client.get('../etc/passwd', 'test-key');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('Invalid tenantId');
    });

    it('should reject tenant ID with path traversal attempt: ../../admin', async () => {
      const result = await client.get('../../admin', 'test-key');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('Invalid tenantId');
    });

    it('should reject tenant ID with backslashes: tenant\\admin', async () => {
      const result = await client.get('tenant\\admin', 'test-key');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('Invalid tenantId');
    });
  });

  describe('validateTenantId - Length Bounds', () => {
    it('should reject empty string', async () => {
      const result = await client.get('', 'test-key');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('Invalid tenantId');
    });

    it('should reject tenant ID exceeding 63 chars', async () => {
      const oversizedId = 'a'.repeat(64);
      const result = await client.get(oversizedId, 'test-key');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('Invalid tenantId length');
    });

    it('should reject tenant ID of 65 chars', async () => {
      const oversizedId = 'a'.repeat(65);
      const result = await client.get(oversizedId, 'test-key');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('Invalid tenantId length');
    });

    it('should accept tenant ID of exactly 63 chars', async () => {
      const maxId = 'a'.repeat(63);
      const result = await client.get(maxId, 'test-key');
      expect(result.success || !result.error?.includes('Invalid tenantId')).toBe(true);
    });

    it('should accept tenant ID of 1 char', async () => {
      const result = await client.get('a', 'test-key');
      expect(result.success || !result.error?.includes('Invalid tenantId')).toBe(true);
    });
  });

  describe('validateTenantId - Leading/Trailing Hyphens', () => {
    it('should reject tenant ID starting with hyphen: -tenant', async () => {
      const result = await client.get('-tenant', 'test-key');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('cannot start or end with hyphen');
    });

    it('should reject tenant ID ending with hyphen: tenant-', async () => {
      const result = await client.get('tenant-', 'test-key');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('cannot start or end with hyphen');
    });

    it('should reject tenant ID with both leading and trailing hyphens: -tenant-', async () => {
      const result = await client.get('-tenant-', 'test-key');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('cannot start or end with hyphen');
    });

    it('should accept tenant ID with hyphens in middle: ten-ant', async () => {
      const result = await client.get('ten-ant', 'test-key');
      expect(result.success || !result.error?.includes('Invalid tenantId')).toBe(true);
    });
  });

  describe('validateTenantId - Header Injection Prevention', () => {
    it('should reject header injection attempt with CRLF: tenant\\r\\nX-Custom-Header: value', async () => {
      const result = await client.get('tenant\r\nX-Custom-Header: value', 'test-key');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('Invalid tenantId');
    });

    it('should reject header injection with newline: tenant\\nAuthorization: Bearer token', async () => {
      const result = await client.get('tenant\nAuthorization: Bearer token', 'test-key');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('Invalid tenantId');
    });

    it('should reject header injection with carriage return: tenant\\rX-Admin: true', async () => {
      const result = await client.get('tenant\rX-Admin: true', 'test-key');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('Invalid tenantId');
    });

    it('should reject header injection with vertical tab: tenant\\x0bAdmin: true', async () => {
      const result = await client.get('tenant\x0bAdmin: true', 'test-key');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('Invalid tenantId');
    });

    it('should reject header injection with null byte: tenant\\x00admin', async () => {
      const result = await client.get('tenant\x00admin', 'test-key');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('Invalid tenantId');
    });
  });

  describe('validateTenantId - Error Messages', () => {
    it('should provide descriptive error for non-empty validation', async () => {
      const result = await client.get('', 'test-key');
      expect(result.error).toBeDefined();
      expect(result.error).toContain('non-empty string');
    });

    it('should provide descriptive error for format validation', async () => {
      const result = await client.get('Invalid@Tenant', 'test-key');
      expect(result.error).toBeDefined();
      expect(result.error).toContain('Invalid tenantId format');
    });

    it('should provide descriptive error for length validation', async () => {
      const result = await client.get('a'.repeat(64), 'test-key');
      expect(result.error).toBeDefined();
      expect(result.error).toContain('Invalid tenantId length');
    });

    it('should provide descriptive error for hyphen validation', async () => {
      const result = await client.get('-tenant', 'test-key');
      expect(result.error).toBeDefined();
      expect(result.error).toContain('cannot start or end with hyphen');
    });
  });

  describe('get() - Tenant Validation Integration', () => {
    it('should validate tenantId before making GET request', async () => {
      jest.clearAllMocks();
      await client.get('valid-tenant', 'test-key');

      // Verify fetch was called with correct tenant ID header
      expect(global.fetch).toHaveBeenCalled();
      const callArgs = (global.fetch as jest.Mock).mock.calls[0];
      expect(callArgs[0]).toBe('https://api.dev.carousellabs.co/cache/test-key');
      expect(callArgs[1].method).toBe('GET');
      expect(callArgs[1].headers['X-Tenant-Id']).toBe('valid-tenant');
    });

    it('should reject GET with invalid tenantId before making request', async () => {
      jest.clearAllMocks();
      const result = await client.get('Invalid@Tenant', 'test-key');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('Invalid tenantId');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should reject GET with header injection attempt', async () => {
      jest.clearAllMocks();
      const result = await client.get('tenant\r\nX-Admin: true', 'test-key');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should reject GET with empty tenantId', async () => {
      jest.clearAllMocks();
      const result = await client.get('', 'test-key');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('set() - Tenant Validation Integration', () => {
    it('should validate tenantId before making SET request', async () => {
      jest.clearAllMocks();
      await client.set('valid-tenant', 'test-key', { data: 'value' }, 3600);

      // Verify fetch was called with correct tenant ID header
      expect(global.fetch).toHaveBeenCalled();
      const callArgs = (global.fetch as jest.Mock).mock.calls[0];
      expect(callArgs[0]).toBe('https://api.dev.carousellabs.co/cache/test-key');
      expect(callArgs[1].method).toBe('POST');
      expect(callArgs[1].headers['X-Tenant-Id']).toBe('valid-tenant');
    });

    it('should reject SET with invalid tenantId before making request', async () => {
      jest.clearAllMocks();
      const result = await client.set('tenant_invalid', 'test-key', { data: 'value' }, 3600);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('Invalid tenantId');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should reject SET with tenant isolation bypass attempt', async () => {
      jest.clearAllMocks();
      const result = await client.set('../other-tenant', 'test-key', { data: 'value' }, 3600);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should reject SET with oversized tenantId', async () => {
      jest.clearAllMocks();
      const oversized = 'a'.repeat(64);
      const result = await client.set(oversized, 'test-key', { data: 'value' }, 3600);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('Invalid tenantId length');
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('delete() - Tenant Validation Integration', () => {
    it('should validate tenantId before making DELETE request', async () => {
      jest.clearAllMocks();
      await client.delete('valid-tenant', 'test-key');

      // Verify fetch was called with correct tenant ID header
      expect(global.fetch).toHaveBeenCalled();
      const callArgs = (global.fetch as jest.Mock).mock.calls[0];
      expect(callArgs[0]).toBe('https://api.dev.carousellabs.co/cache/test-key');
      expect(callArgs[1].method).toBe('DELETE');
      expect(callArgs[1].headers['X-Tenant-Id']).toBe('valid-tenant');
    });

    it('should reject DELETE with invalid tenantId before making request', async () => {
      jest.clearAllMocks();
      const result = await client.delete('invalid.tenant.com', 'test-key');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('Invalid tenantId');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should reject DELETE with SQL injection-like attempt in tenantId', async () => {
      jest.clearAllMocks();
      const result = await client.delete("tenant'; DROP TABLE users--", 'test-key');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should reject DELETE with shell command injection attempt', async () => {
      jest.clearAllMocks();
      const result = await client.delete('tenant; rm -rf /', 'test-key');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('Tenant Isolation - Multi-tenant Security', () => {
    it('should use correct tenant ID in request headers for GET', async () => {
      await client.get('tenant-a', 'test-key');
      const firstCall = (global.fetch as jest.Mock).mock.calls[0];
      expect(firstCall[1].headers['X-Tenant-Id']).toBe('tenant-a');

      jest.clearAllMocks();
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ value: { data: 'test' } }),
      });

      await client.get('tenant-b', 'test-key');
      const secondCall = (global.fetch as jest.Mock).mock.calls[0];
      expect(secondCall[1].headers['X-Tenant-Id']).toBe('tenant-b');
    });

    it('should use correct tenant ID in request headers for SET', async () => {
      await client.set('tenant-x', 'test-key', { data: 'value' }, 3600);
      const firstCall = (global.fetch as jest.Mock).mock.calls[0];
      expect(firstCall[1].headers['X-Tenant-Id']).toBe('tenant-x');

      jest.clearAllMocks();
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ success: true }),
      });

      await client.set('tenant-y', 'test-key', { data: 'value' }, 3600);
      const secondCall = (global.fetch as jest.Mock).mock.calls[0];
      expect(secondCall[1].headers['X-Tenant-Id']).toBe('tenant-y');
    });

    it('should use correct tenant ID in request headers for DELETE', async () => {
      await client.delete('tenant-1', 'test-key');
      const firstCall = (global.fetch as jest.Mock).mock.calls[0];
      expect(firstCall[1].headers['X-Tenant-Id']).toBe('tenant-1');

      jest.clearAllMocks();
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ success: true }),
      });

      await client.delete('tenant-2', 'test-key');
      const secondCall = (global.fetch as jest.Mock).mock.calls[0];
      expect(secondCall[1].headers['X-Tenant-Id']).toBe('tenant-2');
    });
  });

  describe('Edge Cases and Boundary Conditions', () => {
    it('should handle tenant ID with consecutive hyphens: ten--ant', async () => {
      const result = await client.get('ten--ant', 'test-key');
      expect(result.success || !result.error?.includes('Invalid tenantId')).toBe(true);
    });

    it('should handle tenant ID with all numbers: 123456', async () => {
      const result = await client.get('123456', 'test-key');
      expect(result.success || !result.error?.includes('Invalid tenantId')).toBe(true);
    });

    it('should reject tenant ID with all hyphens: --- (fails hyphen check)', async () => {
      const result = await client.get('---', 'test-key');
      // All hyphens fails the leading/trailing hyphen check
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should reject tenant ID that starts with hyphen and is valid otherwise: -a', async () => {
      const result = await client.get('-a', 'test-key');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('cannot start or end with hyphen');
    });

    it('should reject tenant ID that ends with hyphen and is valid otherwise: a-', async () => {
      const result = await client.get('a-', 'test-key');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('cannot start or end with hyphen');
    });
  });

  describe('Circuit Breaker Integration', () => {
    it('should have circuit breaker in CLOSED state initially', () => {
      const stats = (client as any).circuitBreaker.getStats();
      expect(stats.state).toBe('closed');
    });

    it('should return error when circuit is OPEN', async () => {
      // Force circuit open by recording failures
      for (let i = 0; i < 3; i++) {
        (client as any).circuitBreaker.recordFailure();
      }

      const result = await client.get('valid-tenant', 'test-key');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Circuit breaker open');
    });

    it('should track circuit breaker state', () => {
      const breaker = (client as any).circuitBreaker;

      expect(breaker.getState()).toBe('closed');
      expect(breaker.isAvailable()).toBe(true);
    });
  });
});
