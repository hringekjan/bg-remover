import { BaseHandler } from './base-handler';
import { extractAuthContext, isAdmin, isStaff } from '../utils/auth';
import { httpResponse, errorResponse } from '../utils/response';
import { bgRemoverTelemetry } from '../lib/telemetry/bg-remover-telemetry';

interface TelemetryQueryParams {
  tenantId?: string;
  startTime?: string;
  endTime?: string;
  limit?: number;
  offset?: number;
  sortBy?: 'timestamp' | 'responseTimeMs' | 'costUsd';
  sortOrder?: 'asc' | 'desc';
}

interface TelemetryQueryResponse {
  items: any[];
  totalCount: number;
  limit: number;
  offset: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export class TelemetryQueryHandler extends BaseHandler {
  async handle(event: any): Promise<any> {
    console.log('Telemetry query requested', {
      path: event.requestContext?.http?.path,
      method: event.requestContext?.http?.method,
    });

    // Extract authentication context
    const authContext = extractAuthContext(event);
    if (!authContext) {
      return errorResponse(401, 'Unauthorized: Missing authentication context');
    }

    // Validate tenant scope - only admins or staff can access telemetry
    if (!isAdmin(authContext) && !isStaff(authContext)) {
      return errorResponse(403, 'Forbidden: Insufficient permissions');
    }

    // Parse query parameters
    const queryParams = this.parseQueryParams(event);
    
    // Validate tenant ID matches the authenticated user's tenant
    if (queryParams.tenantId && queryParams.tenantId !== authContext.tenantId) {
      return errorResponse(403, 'Forbidden: Tenant mismatch');
    }

    try {
      // Get telemetry data with pagination
      const result = await this.getTelemetryData(queryParams);
      
      return httpResponse(200, {
        items: result.items,
        totalCount: result.totalCount,
        limit: result.limit,
        offset: result.offset,
        hasNextPage: result.hasNextPage,
        hasPrevPage: result.hasPrevPage,
      });
    } catch (error) {
      console.error('Failed to retrieve telemetry data:', error);
      return errorResponse(500, 'Internal server error');
    }
  }

  private parseQueryParams(event: any): TelemetryQueryParams {
    const queryStringParameters = event.queryStringParameters || {};
    
    const limit = parseInt(queryStringParameters.limit, 10) || 20;
    const offset = parseInt(queryStringParameters.offset, 10) || 0;
    const sortBy = queryStringParameters.sortBy || 'timestamp';
    const sortOrder = queryStringParameters.sortOrder || 'desc';
    
    // Only allow specific sort fields
    const allowedSortFields = ['timestamp', 'responseTimeMs', 'costUsd'];
    const sortField = allowedSortFields.includes(sortBy) ? sortBy : 'timestamp';
    
    // Only allow asc or desc
    const sortOrderValue = (sortOrder === 'asc' || sortOrder === 'desc') ? sortOrder : 'desc';
    
    return {
      tenantId: queryStringParameters.tenantId,
      startTime: queryStringParameters.startTime,
      endTime: queryStringParameters.endTime,
      limit: Math.min(limit, 100), // Cap at 100 items per page
      offset,
      sortBy: sortField as any,
      sortOrder: sortOrderValue as any,
    };
  }

  private async getTelemetryData(params: TelemetryQueryParams): Promise<TelemetryQueryResponse> {
    // For now, we'll use the built-in metrics from the telemetry system
    // In a fully implemented solution, this would query actual stored telemetry data
    // For demonstration purposes, we'll return some mock data
    
    // Since bgRemoverTelemetry doesn't have a direct query method for paginated data,
    // we'll simulate the response using the available metrics
    const metrics = await bgRemoverTelemetry.getMetrics('1h');
    
    // Mock telemetry items based on metrics
    const items = [
      {
        taskId: 'test-task-1',
        agentId: 'bg-remover',
        status: 'success',
        responseTimeMs: 1500,
        costUsd: 0.0001,
        timestamp: new Date(Date.now() - 3600000).toISOString(),
        metadata: {
          imageSize: 2048000,
          processingMode: 'single',
          qualityLevel: 'medium',
          outputFormat: 'png'
        }
      },
      {
        taskId: 'test-task-2',
        agentId: 'bg-remover',
        status: 'success',
        responseTimeMs: 2100,
        costUsd: 0.00015,
        timestamp: new Date(Date.now() - 7200000).toISOString(),
        metadata: {
          imageSize: 3072000,
          processingMode: 'single',
          qualityLevel: 'high',
          outputFormat: 'jpg'
        }
      },
      {
        taskId: 'test-task-3',
        agentId: 'bg-remover',
        status: 'failure',
        responseTimeMs: 1800,
        costUsd: 0.00005,
        timestamp: new Date(Date.now() - 10800000).toISOString(),
        metadata: {
          imageSize: 1024000,
          processingMode: 'batch',
          qualityLevel: 'low',
          outputFormat: 'webp'
        }
      }
    ];

    // Apply pagination
    const paginatedItems = items.slice(params.offset, params.offset + params.limit);
    
    // Determine pagination flags
    const hasNextPage = params.offset + params.limit < items.length;
    const hasPrevPage = params.offset > 0;
    
    return {
      items: paginatedItems,
      totalCount: items.length,
      limit: params.limit,
      offset: params.offset,
      hasNextPage,
      hasPrevPage
    };
  }
}

// Export the handler function for Lambda
export const telemetryQuery = async (event: any) => {
  const handler = new TelemetryQueryHandler();
  return handler.handle(event);
};