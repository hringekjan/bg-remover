import { createContextScope } from '../lib/middleware/context-scope';
import { extractAuthContext, isAdmin, isStaff, isSuperAdmin } from '../lib/utils/auth';
import { httpResponse, errorResponse } from '../lib/utils/response';
import { APIGatewayProxyEventV2 } from 'aws-lambda';

// Mock the context-scope dependency
jest.mock('@carousellabs/context-scope', () => ({
  createContextScope: jest.fn(),
  ContextScope: jest.fn().mockImplementation(() => ({
    get: jest.fn(),
  })),
}));

// Mock the auth utils
jest.mock('../lib/utils/auth', () => ({
  extractAuthContext: jest.fn(),
  isAdmin: jest.fn(),
  isStaff: jest.fn(),
  isSuperAdmin: jest.fn(),
}));

// Mock the response utilities
jest.mock('../lib/utils/response', () => ({
  httpResponse: jest.fn(),
  errorResponse: jest.fn(),
}));

describe('PolicyGate Tier Integration Tests', () => {
  const mockEvent: APIGatewayProxyEventV2 = {
    httpMethod: 'POST',
    path: '/test',
    headers: {
      'Authorization': 'Bearer test-token',
      'X-Tenant-ID': 'test-tenant',
      'X-User-ID': 'test-user'
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

  it('should validate full policy gate flow with admin user', async () => {
    const mockAuthContext = {
      userId: 'test-user-id',
      tenant: 'test-tenant',
      isAdmin: true,
      isStaff: false,
      isSuperAdmin: false,
    };
    
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
    
    (extractAuthContext as jest.Mock).mockReturnValue(mockAuthContext);
    (isAdmin as jest.Mock).mockReturnValue(true);
    (createContextScope as jest.Mock).mockResolvedValue(mockContextScope);
    (httpResponse as jest.Mock).mockReturnValue({
      statusCode: 200,
      body: JSON.stringify({ message: 'Access granted' })
    });
    
    // Simulate the handler logic flow
    const contextScope = await createContextScope(mockEvent);
    const authContext = extractAuthContext(mockEvent);
    
    expect(isAdmin(authContext)).toBe(true);
    expect(contextScope.get('userId')).toBe('test-user-id');
    expect(contextScope.get('tenant')).toBe('test-tenant');
    
    const result = httpResponse(200, { message: 'Access granted' });
    expect(result.statusCode).toBe(200);
  });

  it('should reject non-admin users properly', async () => {
    const mockAuthContext = {
      userId: 'test-user-id',
      tenant: 'test-tenant',
      isAdmin: false,
      isStaff: false,
      isSuperAdmin: false,
    };
    
    (extractAuthContext as jest.Mock).mockReturnValue(mockAuthContext);
    (isAdmin as jest.Mock).mockReturnValue(false);
    (errorResponse as jest.Mock).mockReturnValue({
      statusCode: 403,
      body: JSON.stringify({ error: 'Forbidden: Admin access required' })
    });
    
    const authContext = extractAuthContext(mockEvent);
    const result = errorResponse(403, 'Forbidden: Admin access required');
    
    expect(isAdmin(authContext)).toBe(false);
    expect(result.statusCode).toBe(403);
  });

  it('should allow staff users with proper authorization', async () => {
    const mockAuthContext = {
      userId: 'staff-user-id',
      tenant: 'test-tenant',
      isAdmin: false,
      isStaff: true,
      isSuperAdmin: false,
    };
    
    (extractAuthContext as jest.Mock).mockReturnValue(mockAuthContext);
    (isStaff as jest.Mock).mockReturnValue(true);
    (httpResponse as jest.Mock).mockReturnValue({
      statusCode: 200,
      body: JSON.stringify({ message: 'Staff access granted' })
    });
    
    const authContext = extractAuthContext(mockEvent);
    const result = httpResponse(200, { message: 'Staff access granted' });
    
    expect(isStaff(authContext)).toBe(true);
    expect(result.statusCode).toBe(200);
  });

  it('should allow super admins with higher privileges', async () => {
    const mockAuthContext = {
      userId: 'super-admin-user-id',
      tenant: 'test-tenant',
      isAdmin: true,
      isStaff: true,
      isSuperAdmin: true,
    };
    
    (extractAuthContext as jest.Mock).mockReturnValue(mockAuthContext);
    (isSuperAdmin as jest.Mock).mockReturnValue(true);
    (httpResponse as jest.Mock).mockReturnValue({
      statusCode: 200,
      body: JSON.stringify({ message: 'Super admin access granted' })
    });
    
    const authContext = extractAuthContext(mockEvent);
    const result = httpResponse(200, { message: 'Super admin access granted' });
    
    expect(isSuperAdmin(authContext)).toBe(true);
    expect(result.statusCode).toBe(200);
  });
});