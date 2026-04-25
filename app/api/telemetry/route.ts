import { NextRequest, NextResponse } from 'next/server';
import { extractAuthContext, isAdmin, isSuperAdmin } from '@/src/utils/auth';
import { httpResponse, errorResponse } from '@/src/utils/response';
import { ContextScope } from '@carousellabs/context-scope';

// Mock telemetry data - in a real implementation, this would come from DynamoDB or similar
const MOCK_TELEMETRY_DATA = [
  {
    id: '1',
    timestamp: '2023-05-15T10:30:00Z',
    query: 'product search',
    resultCount: 24,
    latencyMs: 142,
    status: 'success',
    tenantId: 'tenant-123',
    dataSource: 'elastic-search',
    userId: 'user-456'
  },
  {
    id: '2',
    timestamp: '2023-05-15T10:28:00Z',
    query: 'image search',
    resultCount: 12,
    latencyMs: 89,
    status: 'success',
    tenantId: 'tenant-123',
    dataSource: 'vector-db',
    userId: 'user-456'
  },
  {
    id: '3',
    timestamp: '2023-05-15T10:25:00Z',
    query: 'video search',
    resultCount: 5,
    latencyMs: 234,
    status: 'error',
    tenantId: 'tenant-456',
    dataSource: 'elastic-search',
    userId: 'user-789'
  },
  {
    id: '4',
    timestamp: '2023-05-15T10:20:00Z',
    query: 'text search',
    resultCount: 31,
    latencyMs: 67,
    status: 'success',
    tenantId: 'tenant-456',
    dataSource: 'vector-db',
    userId: 'user-789'
  }
];

/**
 * GET /api/telemetry - Retrieve recent search telemetry data
 */
export async function GET(request: NextRequest) {
  try {
    const contextScope = new ContextScope();
    
    // Extract auth context from request headers
    const authContext = extractAuthContext({
      headers: Object.fromEntries(request.headers.entries())
    } as any);
    
    // RBAC enforcement - only allow admin or super_admin users
    if (!authContext || (!isAdmin(authContext) && !isSuperAdmin(authContext))) {
      return errorResponse(403, 'Insufficient permissions for telemetry access');
    }
    
    // Get query parameters for filtering
    const { searchParams } = new URL(request.url);
    const tenantId = searchParams.get('tenantId') || '';
    const limit = parseInt(searchParams.get('limit') || '10', 10);
    
    // Filter telemetry data by tenant if specified
    let filteredData = MOCK_TELEMETRY_DATA;
    if (tenantId) {
      filteredData = filteredData.filter(item => item.tenantId === tenantId);
    }
    
    // Sort by timestamp descending (most recent first)
    filteredData.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    
    // Limit results
    const limitedData = filteredData.slice(0, limit);
    
    // Return telemetry data with metadata
    return httpResponse(200, {
      data: limitedData,
      total: filteredData.length,
      limit,
      tenantFilter: tenantId || 'all',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Telemetry API error:', error);
    return errorResponse(500, 'Failed to retrieve telemetry data');
  }
}