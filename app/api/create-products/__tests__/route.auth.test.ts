/**
 * Unit Tests for JWT Authentication & Tenant Authorization
 *
 * Tests authentication and authorization logic in create-products endpoint
 * Lines 340-414 in route.ts
 */

import { NextRequest } from 'next/server';
import { POST } from '../route';
import { validateJWTFromEvent } from '@/src/lib/auth/jwt-validator';
import type { JWTValidationResult } from '@/src/lib/auth/jwt-validator';

// Mock dependencies
jest.mock('@/src/lib/auth/jwt-validator');
jest.mock('@/src/lib/tenant/resolver');
jest.mock('@/src/lib/credits/client');
jest.mock('@/lib/carousel-api/client');

const mockValidateJWT = validateJWTFromEvent as jest.MockedFunction<typeof validateJWTFromEvent>;

// Helper function to create mock NextRequest
function createMockRequest(options: {
  authorization?: string;
  tenantId?: string;
  body?: any;
}): NextRequest {
  const url = 'https://api.dev.carousellabs.co/bg-remover/create-products';
  const headers = new Headers();

  if (options.authorization) {
    headers.set('authorization', options.authorization);
  }
  if (options.tenantId) {
    headers.set('x-tenant-id', options.tenantId);
  }
  headers.set('content-type', 'application/json');

  return new NextRequest(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(options.body || { productGroups: [] }),
  });
}

// Helper function to create mock JWT validation result
function createMockAuthResult(overrides: Partial<JWTValidationResult>): JWTValidationResult {
  return {
    isValid: true,
    userId: 'test-user-123',
    email: 'test@carousellabs.co',
    payload: {},
    groups: [],
    ...overrides,
  };
}

describe('JWT Authentication', () => {
  let originalStage: string | undefined;
  let originalRequireAuth: string | undefined;

  beforeEach(() => {
    // Save original environment variables
    originalStage = process.env.STAGE;
    originalRequireAuth = process.env.REQUIRE_AUTH;

    // Clear all mocks
    jest.clearAllMocks();
  });

  afterEach(() => {
    // Restore original environment variables
    if (originalStage !== undefined) {
      process.env.STAGE = originalStage;
    } else {
      delete process.env.STAGE;
    }
    if (originalRequireAuth !== undefined) {
      process.env.REQUIRE_AUTH = originalRequireAuth;
    } else {
      delete process.env.REQUIRE_AUTH;
    }
  });

  it('should allow processing with valid JWT in production', async () => {
    // Set production environment
    process.env.STAGE = 'prod';
    process.env.REQUIRE_AUTH = 'true';

    // Mock valid JWT with userId
    mockValidateJWT.mockResolvedValueOnce(createMockAuthResult({
      isValid: true,
      userId: 'user-123',
      email: 'user@carousellabs.co',
      payload: { sub: 'user-123', email: 'user@carousellabs.co' },
    }));

    const request = createMockRequest({
      authorization: 'Bearer valid-jwt-token',
      tenantId: 'carousel-labs',
      body: { productGroups: [] },
    });

    const response = await POST(request);

    // Should not return 401 - authentication should succeed
    expect(response.status).not.toBe(401);
    expect(mockValidateJWT).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: { authorization: 'Bearer valid-jwt-token' },
      }),
      undefined,
      { required: true }
    );
  });

  it('should reject invalid JWT in production', async () => {
    // Set production environment
    process.env.STAGE = 'prod';
    process.env.REQUIRE_AUTH = 'true';

    // Mock invalid JWT
    mockValidateJWT.mockResolvedValueOnce({
      isValid: false,
      error: 'Token signature verification failed',
    });

    const request = createMockRequest({
      authorization: 'Bearer invalid-jwt-token',
      tenantId: 'carousel-labs',
      body: { productGroups: [] },
    });

    const response = await POST(request);
    const responseData = await response.json();

    // Expect 401 Unauthorized
    expect(response.status).toBe(401);
    expect(responseData.error).toBe('Unauthorized');
    expect(responseData.message).toBe('Valid JWT token required');

    // Check WWW-Authenticate header
    expect(response.headers.get('WWW-Authenticate')).toBe(
      'Bearer realm="bg-remover", error="invalid_token"'
    );
  });

  it('should reject missing JWT in production', async () => {
    // Set production environment
    process.env.STAGE = 'prod';
    process.env.REQUIRE_AUTH = 'true';

    // Mock missing JWT
    mockValidateJWT.mockResolvedValueOnce({
      isValid: false,
      error: 'Missing Authorization header with Bearer token',
    });

    const request = createMockRequest({
      // No authorization header
      tenantId: 'carousel-labs',
      body: { productGroups: [] },
    });

    const response = await POST(request);
    const responseData = await response.json();

    // Expect 401 Unauthorized
    expect(response.status).toBe(401);
    expect(responseData.error).toBe('Unauthorized');
    expect(responseData.message).toBe('Valid JWT token required');
  });

  it('should allow missing JWT in dev when REQUIRE_AUTH=false', async () => {
    // Set dev environment without auth requirement
    process.env.STAGE = 'dev';
    delete process.env.REQUIRE_AUTH;

    // Mock no JWT (dev mode)
    mockValidateJWT.mockResolvedValueOnce({
      isValid: true,
      error: 'No token provided (dev mode)',
    });

    const request = createMockRequest({
      // No authorization header
      tenantId: 'carousel-labs',
      body: { productGroups: [] },
    });

    const response = await POST(request);

    // Should not return 401 - dev mode allows missing auth
    expect(response.status).not.toBe(401);
    expect(mockValidateJWT).toHaveBeenCalledWith(
      expect.any(Object),
      undefined,
      { required: false }
    );
  });

  it('should reject expired JWT', async () => {
    // Set production environment
    process.env.STAGE = 'prod';
    process.env.REQUIRE_AUTH = 'true';

    // Mock expired JWT
    mockValidateJWT.mockResolvedValueOnce({
      isValid: false,
      error: 'Token expired',
    });

    const request = createMockRequest({
      authorization: 'Bearer expired-jwt-token',
      tenantId: 'carousel-labs',
      body: { productGroups: [] },
    });

    const response = await POST(request);
    const responseData = await response.json();

    // Expect 401 Unauthorized
    expect(response.status).toBe(401);
    expect(responseData.error).toBe('Unauthorized');
    expect(responseData.message).toBe('Valid JWT token required');
  });
});

describe('Tenant Authorization', () => {
  let originalStage: string | undefined;

  beforeEach(() => {
    // Save original environment
    originalStage = process.env.STAGE;

    // Set to production for tenant authorization tests
    process.env.STAGE = 'prod';
    process.env.REQUIRE_AUTH = 'true';

    // Clear all mocks
    jest.clearAllMocks();
  });

  afterEach(() => {
    // Restore original environment
    if (originalStage !== undefined) {
      process.env.STAGE = originalStage;
    } else {
      delete process.env.STAGE;
    }
  });

  it('should allow when JWT tenant matches requested tenant', async () => {
    // Mock valid JWT with matching tenant
    mockValidateJWT.mockResolvedValueOnce(createMockAuthResult({
      isValid: true,
      userId: 'user-123',
      email: 'user@carousellabs.co',
      payload: {
        sub: 'user-123',
        email: 'user@carousellabs.co',
        'custom:tenant': 'carousel-labs',
      },
      groups: [],
    }));

    const request = createMockRequest({
      authorization: 'Bearer valid-jwt-token',
      tenantId: 'carousel-labs',
      body: { productGroups: [] },
    });

    const response = await POST(request);

    // Should not return 403 - tenant authorization should succeed
    expect(response.status).not.toBe(403);
  });

  it('should block cross-tenant access with 403 Forbidden', async () => {
    // Spy on console.error to verify security logging
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

    // Mock valid JWT with different tenant
    mockValidateJWT.mockResolvedValueOnce(createMockAuthResult({
      isValid: true,
      userId: 'user-from-tenant-a',
      email: 'user@tenant-a.com',
      payload: {
        sub: 'user-from-tenant-a',
        email: 'user@tenant-a.com',
        'custom:tenant': 'tenant-a',
      },
      groups: [],
    }));

    const request = createMockRequest({
      authorization: 'Bearer valid-jwt-token',
      tenantId: 'tenant-b',
      body: { productGroups: [] },
    });

    const response = await POST(request);
    const responseData = await response.json();

    // Expect 403 Forbidden
    expect(response.status).toBe(403);
    expect(responseData.error).toBe('Forbidden');
    expect(responseData.message).toBe(
      'Access denied: You do not have permission to create products for this tenant'
    );

    // Verify CRITICAL security log was created
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'SECURITY: Tenant authorization failed - cross-tenant access attempt blocked',
      expect.objectContaining({
        userTenantId: 'tenant-a',
        requestedTenant: 'tenant-b',
        userId: 'user-from-tenant-a',
        authorizationResult: 'DENIED',
        severity: 'CRITICAL',
      })
    );

    consoleErrorSpy.mockRestore();
  });

  it('should allow when JWT has no tenant claim (backward compatibility)', async () => {
    // Spy on console.log to verify authorization logging
    const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();

    // Mock valid JWT without tenant claim
    mockValidateJWT.mockResolvedValueOnce(createMockAuthResult({
      isValid: true,
      userId: 'legacy-user-123',
      email: 'legacy@carousellabs.co',
      payload: {
        sub: 'legacy-user-123',
        email: 'legacy@carousellabs.co',
        // No custom:tenant or cognito:groups
      },
      groups: [],
    }));

    const request = createMockRequest({
      authorization: 'Bearer valid-jwt-token',
      tenantId: 'carousel-labs',
      body: { productGroups: [] },
    });

    const response = await POST(request);

    // Should not return 403 - backward compatibility allows no tenant claim
    expect(response.status).not.toBe(403);

    // Verify authorization log shows 'not-in-jwt'
    expect(consoleLogSpy).toHaveBeenCalledWith(
      'Authorization successful - tenant access granted',
      expect.objectContaining({
        userId: 'legacy-user-123',
        userTenantId: 'not-in-jwt',
        requestedTenant: 'carousel-labs',
        authorizationResult: 'ALLOWED',
      })
    );

    consoleLogSpy.mockRestore();
  });

  it('should extract tenant from custom:tenant claim', async () => {
    // Spy on console.log
    const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();

    // Mock valid JWT with custom:tenant claim
    mockValidateJWT.mockResolvedValueOnce(createMockAuthResult({
      isValid: true,
      userId: 'user-hringekjan',
      email: 'user@hringekjan.is',
      payload: {
        sub: 'user-hringekjan',
        email: 'user@hringekjan.is',
        'custom:tenant': 'hringekjan',
      },
      groups: [],
    }));

    const request = createMockRequest({
      authorization: 'Bearer valid-jwt-token',
      tenantId: 'hringekjan',
      body: { productGroups: [] },
    });

    const response = await POST(request);

    // Should not return 403
    expect(response.status).not.toBe(403);

    // Verify tenant was extracted correctly
    expect(consoleLogSpy).toHaveBeenCalledWith(
      'Authorization successful - tenant access granted',
      expect.objectContaining({
        userId: 'user-hringekjan',
        userTenantId: 'hringekjan',
        requestedTenant: 'hringekjan',
        authorizationResult: 'ALLOWED',
      })
    );

    consoleLogSpy.mockRestore();
  });

  it('should extract tenant from cognito:groups with tenant: prefix', async () => {
    // Spy on console.log
    const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();

    // Mock valid JWT with cognito:groups containing tenant
    mockValidateJWT.mockResolvedValueOnce(createMockAuthResult({
      isValid: true,
      userId: 'user-with-groups',
      email: 'user@carousellabs.co',
      payload: {
        sub: 'user-with-groups',
        email: 'user@carousellabs.co',
        // No custom:tenant, but has cognito:groups
      },
      groups: ['tenant:carousel-labs', 'admin', 'user'],
    }));

    const request = createMockRequest({
      authorization: 'Bearer valid-jwt-token',
      tenantId: 'carousel-labs',
      body: { productGroups: [] },
    });

    const response = await POST(request);

    // Should not return 403
    expect(response.status).not.toBe(403);

    // Verify tenant was extracted from cognito:groups
    expect(consoleLogSpy).toHaveBeenCalledWith(
      'Authorization successful - tenant access granted',
      expect.objectContaining({
        userId: 'user-with-groups',
        userTenantId: 'carousel-labs',
        requestedTenant: 'carousel-labs',
        authorizationResult: 'ALLOWED',
      })
    );

    consoleLogSpy.mockRestore();
  });
});
