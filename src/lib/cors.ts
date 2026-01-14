// Tenant-aware CORS configuration for bg-remover
export interface CorsHeaders {
  'Access-Control-Allow-Origin': string;
  'Access-Control-Allow-Methods': string;
  'Access-Control-Allow-Headers': string;
  'Access-Control-Allow-Credentials': string;
  'Access-Control-Max-Age': string;
  'Vary': string;
}

// Dynamic tenant domain patterns (aligned with carousel-api)
const TENANT_DOMAIN_PATTERNS: RegExp[] = [
  // CarouselLabs domains (dev and prod)
  /^https:\/\/[\w.-]+\.carousellabs\.co$/,
  // Hringekjan domains (dev and prod)
  /^https:\/\/[\w.-]+\.hringekjan\.is$/,
];

// Localhost patterns (only allowed in dev)
const LOCALHOST_PATTERNS: RegExp[] = [
  /^http:\/\/localhost:\d+$/,
  /^http:\/\/127\.0\.0\.1:\d+$/,
];

function matchesTenantPattern(origin: string): boolean {
  return TENANT_DOMAIN_PATTERNS.some(pattern => pattern.test(origin));
}

function isLocalhostOrigin(origin: string): boolean {
  return LOCALHOST_PATTERNS.some(pattern => pattern.test(origin));
}

/**
 * Validate origin against tenant allowlist (pattern-based)
 * @param origin - Origin header from request
 * @returns Validated origin or null if not allowed
 */
export function validateOrigin(origin: string | undefined): string | null {
  if (!origin) {
    console.warn('[CORS] No origin header provided');
    return null;
  }

  if (matchesTenantPattern(origin)) {
    console.log('[CORS] Origin allowed', { origin });
    return origin;
  }

  if (process.env.STAGE === 'dev' && isLocalhostOrigin(origin)) {
    console.log('[CORS] Origin allowed (localhost)', { origin });
    return origin;
  }

  console.warn('[CORS] Origin blocked - not in allowlist', {
    origin,
  });
  return null;
}

/**
 * Create tenant-aware CORS headers
 * @param event - Lambda event with origin header
 * @param tenant - Resolved tenant ID
 * @returns CORS headers object
 */
export function createTenantCorsHeaders(event: any, tenant: string): CorsHeaders {
  const origin = event.headers?.origin || event.headers?.Origin;
  const allowedOrigin = validateOrigin(origin);

  return {
    'Access-Control-Allow-Origin': allowedOrigin || 'null',  // Secure: specific origin or 'null'
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Tenant-Id, X-CSRF-Token, X-Job-Token, Cache-Control',
    'Access-Control-Allow-Credentials': 'true',  // Required for cookies/auth
    'Access-Control-Max-Age': '86400',  // Cache preflight for 24 hours
    'Vary': 'Origin',  // CRITICAL: Prevent cache poisoning
  };
}
