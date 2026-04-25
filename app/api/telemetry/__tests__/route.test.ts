import { GET } from '../route';
import { NextRequest } from 'next/server';

// Mock auth utilities
jest.mock('@/src/utils/auth', () => ({
  extractAuthContext: jest.fn(),
  isAdmin: jest.fn(),
  isSuperAdmin: jest.fn()
}));

describe('Telemetry API Route', () => {
  const mockExtractAuthContext = jest.requireMock('@/src/utils/auth').extractAuthContext;
  const mockIsAdmin = jest.requireMock('@/src/utils/auth').isAdmin;
  const mockIsSuperAdmin = jest.requireMock('@/src/utils/auth').isSuperAdmin;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 403 for unauthorized access', async () => {
    mockExtractAuthContext.mockReturnValue(null);
    
    const request = new NextRequest('http://localhost/api/telemetry');
    const response = await GET(request);
    
    expect(response.status).toBe(403);
  });

  it('should return 403 for non-admin users', async () => {
    mockExtractAuthContext.mockReturnValue({
      userId: 'test-user',
      role: 'user',
      permissions: [],
      tenantId: 'test-tenant'
    });
    mockIsAdmin.mockReturnValue(false);
    mockIsSuperAdmin.mockReturnValue(false);
    
    const request = new NextRequest('http://localhost/api/telemetry');
    const response = await GET(request);
    
    expect(response.status).toBe(403);
  });

  it('should return telemetry data for admin users', async () => {
    mockExtractAuthContext.mockReturnValue({
      userId: 'test-user',
      role: 'admin',
      permissions: [],
      tenantId: 'test-tenant'
    });
    mockIsAdmin.mockReturnValue(true);
    mockIsSuperAdmin.mockReturnValue(false);
    
    const request = new NextRequest('http://localhost/api/telemetry');
    const response = await GET(request);
    
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.data).toBeDefined();
    expect(data.total).toBeGreaterThan(0);
  });

  it('should filter telemetry data by tenant', async () => {
    mockExtractAuthContext.mockReturnValue({
      userId: 'test-user',
      role: 'admin',
      permissions: [],
      tenantId: 'test-tenant'
    });
    mockIsAdmin.mockReturnValue(true);
    mockIsSuperAdmin.mockReturnValue(false);
    
    const request = new NextRequest('http://localhost/api/telemetry?tenantId=test-tenant');
    const response = await GET(request);
    
    expect(response.status).toBe(200);
  });

  it('should limit results', async () => {
    mockExtractAuthContext.mockReturnValue({
      userId: 'test-user',
      role: 'admin',
      permissions: [],
      tenantId: 'test-tenant'
    });
    mockIsAdmin.mockReturnValue(true);
    mockIsSuperAdmin.mockReturnValue(false);
    
    const request = new NextRequest('http://localhost/api/telemetry?limit=2');
    const response = await GET(request);
    
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.data.length).toBeLessThanOrEqual(2);
  });
});