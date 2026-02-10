import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getJobsByTenant } from '../lib/job-store';
import { successResponse, errorResponse } from '../lib/http-helpers';
import { isAdmin, isStaff, parseAuthContext } from '@carousellabs/rbac-access-kit';
import { corsHeaders } from '../lib/constants';

/**
 * Handler for GET /carousel/bg-remover/jobs
 * Returns paginated list of bg-remover jobs for the tenant
 */
export async function getJobsHandler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const authContext = parseAuthContext(event);
    if (!authContext) {
      return errorResponse(401, 'Unauthorized: Missing authentication context', undefined, corsHeaders);
    }

    const { roles, tenant, userId } = authContext;

    // Only admins and staff can view all jobs
    if (!isAdmin(roles) && !isStaff(roles)) {
      return errorResponse(403, 'Forbidden: Admin or staff role required to view jobs', undefined, corsHeaders);
    }

    // Parse query parameters
    const limit = event.queryStringParameters?.limit ? parseInt(event.queryStringParameters.limit) : 50;
    const status = event.queryStringParameters?.status || undefined;

    // Validate limit
    if (isNaN(limit) || limit < 1 || limit > 1000) {
      return errorResponse(400, 'Invalid limit parameter: must be between 1 and 1000', undefined, corsHeaders);
    }

    // Get jobs for tenant
    const jobs = await getJobsByTenant(tenant, { limit, status });

    return successResponse({
      jobs,
      count: jobs.length,
      limit,
      status: status || 'all',
      tenant
    }, corsHeaders);

  } catch (error) {
    console.error('Failed to get jobs:', error);
    return errorResponse(500, 'Internal server error', undefined, corsHeaders);
  }
}
