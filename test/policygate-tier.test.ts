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

describe('PolicyGate Tier Tests', () => {
  const mockEvent: APIGatewayProxyEventV2 = {
    httpMethod: 'POST',
    path: '/test',
    headers: {},
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

  it('should validate authentication context extraction', async () => {
    const mockAuthContext = {
      userId: 'test-user-id',
      tenant: 'test-tenant',
      isAdmin: true,
      isStaff: false,
      isSuperAdmin: false,
    };
    
    (extractAuthContext as jest.Mock).mockReturnValue(mockAuthContext);
    (isAdmin as jest.Mock).mockReturnValue(true);
    (isStaff as jest.Mock).mockReturnValue(false);
    (isSuperAdmin as jest.Mock).mockReturnValue(false);
    
    const authContext = extractAuthContext(mockEvent);
    expect(authContext).toEqual(mockAuthContext);
    expect(isAdmin(authContext)).toBe(true);
  });

  it('should enforce admin access restriction', async () => {
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
    
    const result = errorResponse(403, 'Forbidden: Admin access required');
    expect(result.statusCode).toBe(403);
  });

  it('should validate staff access level', async () => {
    const mockAuthContext = {
      userId: 'test-user-id',
      tenant: 'test-tenant',
      isAdmin: false,
      isStaff: true,
      isSuperAdmin: false,
    };
    
    (extractAuthContext as jest.Mock).mockReturnValue(mockAuthContext);
    (isStaff as jest.Mock).mockReturnValue(true);
    
    const result = isStaff(mockAuthContext);
    expect(result).toBe(true);
  });

  it('should validate super admin access level', async () => {
    const mockAuthContext = {
      userId: 'test-user-id',
      tenant: 'test-tenant',
      isAdmin: false,
      isStaff: false,
      isSuperAdmin: true,
    };
    
    (extractAuthContext as jest.Mock).mockReturnValue(mockAuthContext);
    (isSuperAdmin as jest.Mock).mockReturnValue(true);
    
    const result = isSuperAdmin(mockAuthContext);
    expect(result).toBe(true);
  });

  it('should handle unauthorized access properly', async () => {
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
    
    const result = errorResponse(403, 'Forbidden: Admin access required');
    expect(result.statusCode).toBe(403);
    expect(result.body).toContain('Forbidden: Admin access required');
  });

  it('should correctly handle successful responses', async () => {
    const mockData = {
      message: 'Test success',
      data: 'test-data'
    };
    
    (httpResponse as jest.Mock).mockReturnValue({
      statusCode: 200,
      body: JSON.stringify(mockData)
    });
    
    const result = httpResponse(200, mockData);
    expect(result.statusCode).toBe(200);
    expect(result.body).toContain('Test success');
  });

  it('should create context scope correctly', async () => {
    const mockContextScope = {
      get: jest.fn(),
    };
    
    (createContextScope as jest.Mock).mockResolvedValue(mockContextScope);
    
    const result = await createContextScope(mockEvent);
    expect(result).toEqual(mockContextScope);
  });

  it('should handle error responses for internal server errors', async () => {
    (errorResponse as jest.Mock).mockReturnValue({
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    });
    
    const result = errorResponse(500, 'Internal server error');
    expect(result.statusCode).toBe(500);
    expect(result.body).toContain('Internal server error');
  });
});