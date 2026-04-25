import { APIGatewayProxyEventV2 } from 'aws-lambda';

export interface AuthContext {
  userId: string;
  role: string;
  permissions: string[];
  tenantId: string;
  applicationId?: string;
  sessionId?: string;
}

/**
 * Extract authentication context from API Gateway event
 */
export function extractAuthContext(event: APIGatewayProxyEventV2): AuthContext | null {
  // Get tenant ID from headers
  const tenantId = event.headers?.['x-tenant-id'] || event.multiValueHeaders?.['x-tenant-id']?.[0];
  
  if (!tenantId) {
    return null;
  }

  // Extract user info from context headers
  const userHeader = event.headers?.['x-context-user'] || event.multiValueHeaders?.['x-context-user']?.[0];
  const appHeader = event.headers?.['x-context-app'] || event.multiValueHeaders?.['x-context-app']?.[0];
  
  let userId = '';
  let role = '';
  let permissions: string[] = [];

  if (userHeader) {
    try {
      const user = JSON.parse(userHeader);
      userId = user.id || '';
      role = user.role || '';
      permissions = Array.isArray(user.permissions) ? user.permissions : [];
    } catch (e) {
      console.error('Failed to parse user header:', e);
    }
  }

  return {
    userId,
    role,
    permissions,
    tenantId,
    applicationId: appHeader ? getAppName(appHeader) : undefined,
    sessionId: event.headers?.['x-context-extra'] ? getSessionId(event.headers['x-context-extra']) : undefined
  };
}

/**
 * Check if user has admin role
 */
export function isAdmin(context: AuthContext): boolean {
  return context.role === 'admin' || context.role === 'super_admin' || context.permissions.includes('admin');
}

/**
 * Check if user has staff role
 */
export function isStaff(context: AuthContext): boolean {
  return context.role === 'staff' || context.permissions.includes('staff') || isAdmin(context);
}

/**
 * Check if user has super admin role
 */
export function isSuperAdmin(context: AuthContext): boolean {
  return context.role === 'super_admin' || context.permissions.includes('super_admin');
}

/**
 * Helper function to extract app name from context header
 */
function getAppName(appHeader: string): string | undefined {
  try {
    const app = JSON.parse(appHeader);
    return app.name;
  } catch (e) {
    return undefined;
  }
}

/**
 * Helper function to extract session ID from context extra
 */
function getSessionId(extraHeader: string): string | undefined {
  try {
    const extra = JSON.parse(extraHeader);
    return extra.jobId;
  } catch (e) {
    return undefined;
  }
}