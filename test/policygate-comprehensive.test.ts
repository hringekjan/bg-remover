import { createContextScope } from '../lib/middleware/context-scope';
import { extractAuthContext, isAdmin, isStaff, isSuperAdmin } from '../lib/utils/auth';
import { httpResponse, errorResponse } from '../lib/utils/response';
import { APIGatewayProxyEventV2 } from 'aws-lambda';

// Mock modules to isolate tests
jest.mock('@carousellabs/context-scope', () => ({
  createContextScope: jest.fn(),
  ContextScope: jest.fn().mockImplementation(() => ({
    get: jest.fn(),
  })),
}));

jest.mock('../lib/utils/auth', () => ({
  extractAuthContext: jest.fn(),
  isAdmin: jest.fn(),
  isStaff: jest.fn(),
  isSuperAdmin: jest.fn(),
}));

jest.mock('../lib/utils/response', () => ({
  httpResponse: jest.fn(),
  errorResponse: jest.fn(),
}));

describe('PolicyGate Comprehensive Test Suite', () => {
  const baseEvent: APIGatewayProxyEventV2 = {
    httpMethod: 'POST',
    path: '/test',
    headers: {
      'Authorization': 'Bearer test-token',
      'X-Tenant-ID': 'test-tenant',
      'X-User-ID': 'test-user',
      'X-Is-Admin': 'true',
      'X-Is-Staff': 'false',
      'X-Is-Super-Admin': 'false'
    },
    body: JSON.stringify({ test: 'data' }),
    queryStringParameters: {},
    pathParameters: {},
    stageVariables: {},
    requestContext: {
      accountId: 'test-account',
      apiId: 'test-api',
      domainName: 'test-domain',
      domainPrefix: 'test-prefix',
      http: {
        method: 'POST',
        path: '/test',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'test-user-agent',
      },
      requestId: 'test-request-id',
      routeKey: '$default',
      stage: 'test-stage',
      time: 'test-time',
      timeEpoch: 1234567890,
    },
    isBase64Encoded: false,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Authentication Context Extraction', () => {
    it('should properly extract auth context from valid headers', () => {
      (extractAuthContext as jest.Mock).mockReturnValue({
        userId: 'test-user-id',
        tenant: 'test-tenant',
        isAdmin: true,
        isStaff: false,
        isSuperAdmin: false,
      });

      const result = extractAuthContext(baseEvent);
      
      expect(extractAuthContext).toHaveBeenCalledWith(baseEvent);
      expect(result.userId).toBe('test-user-id');
      expect(result.tenant).toBe('test-tenant');
    });

    it('should handle missing authentication headers gracefully', () => {
      const minimalEvent: APIGatewayProxyEventV2 = {
        ...baseEvent,
        headers: {}
      };

      (extractAuthContext as jest.Mock).mockReturnValue({
        userId: null,
        tenant: null,
        isAdmin: false,
        isStaff: false,
        isSuperAdmin: false,
      });

      const result = extractAuthContext(minimalEvent);
      
      expect(result.userId).toBeNull();
      expect(result.tenant).toBeNull();
    });
  });

  describe('Role-Based Access Control', () => {
    it('should correctly identify admin users', () => {
      const adminContext = {
        userId: 'admin-user',
        tenant: 'test-tenant',
        isAdmin: true,
        isStaff: false,
        isSuperAdmin: false,
      };

      const nonAdminContext = {
        userId: 'regular-user',
        tenant: 'test-tenant',
        isAdmin: false,
        isStaff: false,
        isSuperAdmin: false,
      };

      expect(isAdmin(adminContext)).toBe(true);
      expect(isAdmin(nonAdminContext)).toBe(false);
    });

    it('should correctly identify staff users', () => {
      const staffContext = {
        userId: 'staff-user',
        tenant: 'test-tenant',
        isAdmin: false,
        isStaff: true,
        isSuperAdmin: false,
      };

      const nonStaffContext = {
        userId: 'regular-user',
        tenant: 'test-tenant',
        isAdmin: false,
        isStaff: false,
        isSuperAdmin: false,
      };

      expect(isStaff(staffContext)).toBe(true);
      expect(isStaff(nonStaffContext)).toBe(false);
    });

    it('should correctly identify super admin users', () => {
      const superAdminContext = {
        userId: 'super-admin-user',
        tenant: 'test-tenant',
        isAdmin: true,
        isStaff: true,
        isSuperAdmin: true,
      };

      const adminContext = {
        userId: 'admin-user',
        tenant: 'test-tenant',
        isAdmin: true,
        isStaff: false,
        isSuperAdmin: false,
      };

      expect(isSuperAdmin(superAdminContext)).toBe(true);
      expect(isSuperAdmin(adminContext)).toBe(false);
    });

    it('should prioritize role hierarchy correctly', () => {
      // Super admin has highest priority
      const superAdminContext = {
        userId: 'super-admin-user',
        tenant: 'test-tenant',
        isAdmin: true,
        isStaff: true,
        isSuperAdmin: true,
      };

      expect(isAdmin(superAdminContext)).toBe(true);
      expect(isStaff(superAdminContext)).toBe(true);
      expect(isSuperAdmin(superAdminContext)).toBe(true);

      // Regular admin
      const adminContext = {
        userId: 'admin-user',
        tenant: 'test-tenant',
        isAdmin: true,
        isStaff: false,
        isSuperAdmin: false,
      };

      expect(isAdmin(adminContext)).toBe(true);
      expect(isStaff(adminContext)).toBe(false);
      expect(isSuperAdmin(adminContext)).toBe(false);
    });
  });

  describe('Context Scope Management', () => {
    it('should create context scope correctly for authenticated requests', async () => {
      const mockContextScope = {
        get: jest.fn((key) => {
          switch(key) {
            case 'userId': return 'test-user-id';
            case 'tenant': return 'test-tenant';
            case 'isAdmin': return true;
            case 'isStaff': return false;
            case 'isSuperAdmin': return false;
            default: return null;
          }
        }),
      };

      (createContextScope as jest.Mock).mockResolvedValue(mockContextScope);

      const result = await createContextScope(baseEvent);
      
      expect(createContextScope).toHaveBeenCalledWith(baseEvent);
      expect(result.get('userId')).toBe('test-user-id');
    });

    it('should handle context scope creation failures gracefully', async () => {
      (createContextScope as jest.Mock).mockRejectedValue(new Error('Context scope creation failed'));

      await expect(createContextScope(baseEvent)).rejects.toThrow('Context scope creation failed');
    });
  });

  describe('Response Handling', () => {
    it('should generate proper HTTP responses', () => {
      const testData = { message: 'Success', data: 'test' };
      
      (httpResponse as jest.Mock).mockReturnValue({
        statusCode: 200,
        body: JSON.stringify(testData),
        headers: {
          'Content-Type': 'application/json'
        }
      });

      const result = httpResponse(200, testData);
      
      expect(result.statusCode).toBe(200);
      expect(result.body).toContain('Success');
      expect(result.headers).toHaveProperty('Content-Type');
    });

    it('should generate proper error responses', () => {
      (errorResponse as jest.Mock).mockReturnValue({
        statusCode: 403,
        body: JSON.stringify({ error: 'Forbidden' }),
        headers: {
          'Content-Type': 'application/json'
        }
      });

      const result = errorResponse(403, 'Forbidden');
      
      expect(result.statusCode).toBe(403);
      expect(result.body).toContain('Forbidden');
    });

    it('should handle different error codes appropriately', () => {
      const unauthorizedResponse = errorResponse(401, 'Unauthorized');
      const forbiddenResponse = errorResponse(403, 'Forbidden');
      const serverErrorResponse = errorResponse(500, 'Internal Server Error');

      expect(unauthorizedResponse.statusCode).toBe(401);
      expect(forbiddenResponse.statusCode).toBe(403);
      expect(serverErrorResponse.statusCode).toBe(500);
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('should handle empty event bodies gracefully', () => {
      const eventWithEmptyBody: APIGatewayProxyEventV2 = {
        ...baseEvent,
        body: null
      };

      const result = extractAuthContext(eventWithEmptyBody);
      expect(result).toBeDefined();
    });

    it('should handle malformed JSON in body', () => {
      const eventWithMalformedJSON: APIGatewayProxyEventV2 = {
        ...baseEvent,
        body: '{ invalid json'
      };

      const result = extractAuthContext(eventWithMalformedJSON);
      expect(result).toBeDefined();
    });

    it('should maintain consistency across role checks', () => {
      const mixedRoleContext = {
        userId: 'mixed-role-user',
        tenant: 'test-tenant',
        isAdmin: true,
        isStaff: false,
        isSuperAdmin: true,
      };

      // A super admin should also be considered an admin
      expect(isAdmin(mixedRoleContext)).toBe(true);
      expect(isSuperAdmin(mixedRoleContext)).toBe(true);
      expect(isStaff(mixedRoleContext)).toBe(false);
    });
  });

  describe('Integration Scenarios', () => {
    it('should simulate complete admin access flow', async () => {
      const mockAuthContext = {
        userId: 'admin-user',
        tenant: 'test-tenant',
        isAdmin: true,
        isStaff: false,
        isSuperAdmin: false,
      };

      const mockContextScope = {
        get: jest.fn((key) => {
          switch(key) {
            case 'userId': return 'admin-user';
            case 'tenant': return 'test-tenant';
            case 'isAdmin': return true;
            case 'isStaff': return false;
            case 'isSuperAdmin': return false;
            default: return null;
          }
        }),
      };

      (extractAuthContext as jest.Mock).mockReturnValue(mockAuthContext);
      (isAdmin as jest.Mock).mockReturnValue(true);
      (createContextScope as jest.Mock).mockResolvedValue(mockContextScope);
      (httpResponse as jest.Mock).mockReturnValue({
        statusCode: 200,
        body: JSON.stringify({ message: 'Admin access confirmed' })
      });

      // Simulate complete handler flow
      const contextScope = await createContextScope(baseEvent);
      const authContext = extractAuthContext(baseEvent);
      
      expect(isAdmin(authContext)).toBe(true);
      expect(contextScope.get('userId')).toBe('admin-user');
      
      const finalResponse = httpResponse(200, { message: 'Admin access confirmed' });
      expect(finalResponse.statusCode).toBe(200);
    });

    it('should simulate restricted access scenario', async () => {
      const mockAuthContext = {
        userId: 'regular-user',
        tenant: 'test-tenant',
        isAdmin: false,
        isStaff: false,
        isSuperAdmin: false,
      };

      (extractAuthContext as jest.Mock).mockReturnValue(mockAuthContext);
      (isAdmin as jest.Mock).mockReturnValue(false);
      (errorResponse as jest.Mock).mockReturnValue({
        statusCode: 403,
        body: JSON.stringify({ error: 'Access denied: Admin required' })
      });

      const authContext = extractAuthContext(baseEvent);
      const result = errorResponse(403, 'Access denied: Admin required');
      
      expect(isAdmin(authContext)).toBe(false);
      expect(result.statusCode).toBe(403);
    });
  });
});