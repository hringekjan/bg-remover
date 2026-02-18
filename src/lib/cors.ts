// Tenant-aware CORS configuration for bg-remover
import type { APIGatewayProxyEvent, APIGatewayProxyEventV2 } from 'aws-lambda';

export interface CorsHeaders {
  'Access-Control-Allow-Origin': string;
  'Access-Control-Allow-Methods': string;
  'Access-Control-Allow-Headers': string;
  'Access-Control-Allow-Credentials': string;
  'Access-Control-Max-Age': string;
  'Vary': string;
}

const TENANT_ALLOWED_ORIGINS: Record<string, string[]> = {
  'carousel-labs': [
    'https://carousel.dev.carousellabs.co',
    'https://carousel.carousellabs.co',
  ],
  'hringekjan': [
    'https://carousel.dev.hringekjan.is',
    'https://carousel.hringekjan.is',
  ],
};

const LOCALHOST_ORIGINS = new Set([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
]);

/**
 * Extract origin from either event type
 */
function extractOrigin(event: APIGatewayProxyEvent | APIGatewayProxyEventV2): string | undefined {
  // For V2 events (standard Lambda@Edge)
  if ('headers' in event && event.headers) {
    return (event.headers as Record<string, string>).origin || (event.headers as Record<string, string>).Origin;
  }
  // For V1 events (standard API Gateway)
  if ('origin' in event && event.origin) {
    return event.origin;
  }
  return undefined;
}

/**
 * Validate origin against tenant allowlist (pattern-based)
 * @param origin - Origin header from request
 * @param tenant - Tenant identifier
 * @returns Validated origin or null if not allowed
 */
export function validateOrigin(origin: string | undefined, tenant: string): string | null {
  if (!origin) {
    console.warn('[CORS] No origin header provided');
    return null;
  }

  if (!tenant || !TENANT_ALLOWED_ORIGINS[tenant]) {
    console.warn('[CORS] Unknown tenant', { tenant });
    return null;
  }

  const allowedOrigins = TENANT_ALLOWED_ORIGINS[tenant];
  if (allowedOrigins.includes(origin)) {
    console.log('[CORS] Origin allowed', { origin, tenant });
    return origin;
  }

  if (process.env.STAGE === 'dev' && LOCALHOST_ORIGINS.has(origin)) {
    console.log('[CORS] Origin allowed (localhost)', { origin, tenant });
    return origin;
  }

  console.warn('[CORS] Origin blocked - not in tenant allowlist', {
    origin,
    tenant,
    allowedOrigins,
  });
  return null;
}

/**
 * Create tenant-aware CORS headers
 * Supports both APIGatewayProxyEvent (V1) and APIGatewayProxyEventV2 (V2)
 * 
 * @param event - Lambda event with origin header
 * @param tenant - Resolved tenant ID
 * @returns CORS headers object
 */
export function createTenantCorsHeaders(
  event: APIGatewayProxyEvent | APIGatewayProxyEventV2,
  tenant: string
): CorsHeaders {
  const origin = extractOrigin(event);
  const allowedOrigin = validateOrigin(origin, tenant);

  return {
    'Access-Control-Allow-Origin': allowedOrigin || 'null', // Secure: specific origin or 'null'
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Tenant-Id, X-CSRF-Token, X-Job-Token, X-Trace-Id, X-User-Id, X-User-Role, Cache-Control',
    'Access-Control-Allow-Credentials': 'true', // Required for cookies/auth
    'Access-Control-Max-Age': '86400', // Cache preflight for 24 hours
    'Vary': 'Origin', // CRITICAL: Prevent cache poisoning
  };
}

/**
 * Create basic CORS headers without tenant validation
 * Used for errors before tenant resolution
 */
export function createBasicCorsHeaders(): CorsHeaders {
  return {
    'Access-Control-Allow-Origin': 'null',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Tenant-Id',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
