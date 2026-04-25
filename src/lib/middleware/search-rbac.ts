/**
 * RBAC Middleware for Search Endpoints
 * Enforces tenant isolation and role-based access control for search functionality
 */

import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { AuthContext, extractAuthContext, isAdmin, isStaff, isSuperAdmin } from '../../utils/auth';
import { errorResponse } from '../../utils/response';

/**
 * RBAC check for search endpoints
 * Ensures proper tenant isolation and role validation
 */
export const withSearchRBAC = (
  handler: (event: APIGatewayProxyEventV2, authContext: AuthContext) => Promise<APIGatewayProxyResultV2>
) => {
  return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
    // Extract authentication context
    const authContext = extractAuthContext(event);
    
    if (!authContext) {
      return errorResponse(401, 'Unauthorized: Missing authentication context');
    }

    // Check if user has permission to access search functionality
    // Based on typical search permissions, we allow staff and above
    if (!isStaff(authContext)) {
      return errorResponse(403, 'Forbidden: Insufficient permissions to access search functionality');
    }

    // Validate tenant isolation - ensure search is scoped to tenant
    if (!authContext.tenantId) {
      return errorResponse(400, 'Bad Request: Tenant ID is required for search operations');
    }

    // For admin-level search access, we might want to add additional checks
    // This could include checking specific permissions or roles
    if (isAdmin(authContext) || isSuperAdmin(authContext)) {
      // Admin users have full access to search across all tenants (if needed)
      // For now, we keep it scoped to their tenant 
    }

    // Call the original handler with auth context
    return handler(event, authContext);
  };
};