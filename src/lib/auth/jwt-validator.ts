/**
 * JWT Token Validation for bg-remover service
 *
 * Validates AWS Cognito JWT tokens using JWKS (JSON Web Key Set)
 * This provides Lambda-level authentication until API Gateway-level
 * authorization is configured at the platform level.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { createHmac } from 'crypto';
import { getCacheManager } from '../cache/cache-manager';
import { buildCacheKey, CacheTTL } from '../cache/constants';

// HMAC secret for secure cache key generation
// CRITICAL: This prevents cache poisoning attacks by ensuring only authorized parties can generate valid cache keys
const CACHE_KEY_SECRET = process.env.CACHE_KEY_SECRET || (() => {
  console.warn('CACHE_KEY_SECRET not set, using default - NOT SECURE FOR PRODUCTION');
  return 'default-cache-key-secret-change-me';
})();

export interface JWTValidationResult {
  isValid: boolean;
  payload?: JWTPayload;
  error?: string;
  userId?: string;
  email?: string;
  groups?: string[];
}

export interface CognitoConfig {
  userPoolId: string;
  region: string;
  issuer: string;
  audience?: string[];  // Client IDs that are allowed
}

// Tenant-specific Cognito pools (one pool per tenant per stage)
// These should match the pools used by carousel-api authorizer
const TENANT_COGNITO_POOLS: Record<string, CognitoConfig> = {
  'carousel-labs': {
    userPoolId: 'eu-west-1_vLdYTnLGY',
    region: 'eu-west-1',
    issuer: 'https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_vLdYTnLGY',
    audience: ['7ph029to7u4edosrot896bbvru'],
  },
  'hringekjan': {
    userPoolId: 'eu-west-1_PRuF4zx1a',
    region: 'eu-west-1',
    issuer: 'https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_PRuF4zx1a',
    audience: ['7ieik03s0tcigkbpg9psc90sih'],
  },
};

// M2M (Machine-to-Machine) support - allow any client_id from tenant pools
const M2M_ALLOWED_POOLS = new Set(Object.values(TENANT_COGNITO_POOLS).map(c => c.userPoolId));

// Fallback to env vars if tenant not found (for backwards compatibility)
const DEFAULT_COGNITO_CONFIG: CognitoConfig = {
  userPoolId: process.env.COGNITO_USER_POOL_ID || 'eu-west-1_vLdYTnLGY',
  region: process.env.AWS_REGION || 'eu-west-1',
  issuer: process.env.COGNITO_ISSUER_URL || 'https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_vLdYTnLGY',
  audience: process.env.COGNITO_AUDIENCE?.split(',') || undefined,
};

/**
 * Get Cognito config for a specific tenant
 */
export function getCognitoConfigForTenant(tenantId: string): CognitoConfig {
  return TENANT_COGNITO_POOLS[tenantId] || DEFAULT_COGNITO_CONFIG;
}

// JWKS endpoint for verifying JWT signatures
const getJWKSEndpoint = (config: CognitoConfig): string => {
  return `${config.issuer}/.well-known/jwks.json`;
};

// Cache JWKS clients per user pool to support multi-tenant architecture
// Key format: "{userPoolId}"
const jwksClients = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/**
 * Get or create JWKS client for JWT verification
 * Creates separate JWKS clients per Cognito User Pool for multi-tenant support
 */
function getJWKSClient(config: CognitoConfig = DEFAULT_COGNITO_CONFIG): ReturnType<typeof createRemoteJWKSet> {
  const cacheKey = config.userPoolId;

  if (!jwksClients.has(cacheKey)) {
    const jwksUrl = new URL(getJWKSEndpoint(config));
    const client = createRemoteJWKSet(jwksUrl, {
      cacheMaxAge: 600000, // Cache JWKS for 10 minutes
      cooldownDuration: 30000, // Wait 30 seconds before refetching on error
    });
    jwksClients.set(cacheKey, client);
    console.log('Created new JWKS client for user pool', {
      userPoolId: config.userPoolId,
      jwksUrl: jwksUrl.toString(),
    });
  }
  return jwksClients.get(cacheKey)!;
}

/**
 * Extract JWT token from Authorization header
 */
export function extractTokenFromHeader(authHeader: string | undefined): string | null {
  if (!authHeader) {
    return null;
  }

  // Handle "Bearer <token>" format
  const bearerPrefix = 'Bearer ';
  if (authHeader.startsWith(bearerPrefix)) {
    return authHeader.substring(bearerPrefix.length).trim();
  }

  // Handle raw token
  return authHeader.trim();
}

/**
 * Validate JWT token from AWS Cognito
 * Uses hybrid L1 (memory) + L2 (cache-service) caching for validation results
 *
 * @param token - JWT token string
 * @param config - Cognito configuration (defaults to platform config)
 * @returns Validation result with user info if valid
 */
export async function validateJWT(
  token: string,
  config: CognitoConfig = DEFAULT_COGNITO_CONFIG
): Promise<JWTValidationResult> {
  // Generate cache key from HMAC of token (prevents cache poisoning attacks)
  const tokenHash = createHmac('sha256', CACHE_KEY_SECRET)
    .update(token)
    .digest('hex');
  const cacheKey = buildCacheKey.jwtValidation(tokenHash);
  const cacheManager = getCacheManager();

  // Try cache first (L1 memory + L2 cache-service)
  const cached = await cacheManager.get<JWTValidationResult>(cacheKey);
  if (cached) {
    console.debug('JWT validation cache hit', {
      userId: cached.userId
      // Note: tokenHash deliberately omitted for security
    });
    return cached;
  }

  try {
    // Decode token without verification first to check token_use
    const tokenParts = token.split('.');
    const payloadBase64 = tokenParts[1];
    const decodedPayload = JSON.parse(Buffer.from(payloadBase64, 'base64url').toString());
    const tokenUse = decodedPayload.token_use as string;
    const tokenIssuer = decodedPayload.iss as string;

    // Log validation context before verification
    console.log('[JWTValidator] Validating token:', {
      configUserPoolId: config.userPoolId,
      configIssuer: config.issuer,
      tokenIssuer,
      tokenUse,
      hasAudience: !!config.audience,
      timestamp: new Date().toISOString(),
    });

    // Validate token_use claim (must be 'id' or 'access')
    if (!['id', 'access'].includes(tokenUse)) {
      return {
        isValid: false,
        error: `Invalid token_use: ${tokenUse}`,
      };
    }

    const jwks = getJWKSClient(config);

    // Verify the JWT signature and claims
    // ID tokens have 'aud' claim, access tokens (M2M) have 'client_id' claim
    const verifyOptions: Parameters<typeof jwtVerify>[2] = {
      issuer: config.issuer,
      // Only require audience for ID tokens, not access tokens (M2M)
      ...(tokenUse === 'id' && config.audience && { audience: config.audience }),
    };

    const { payload } = await jwtVerify(token, jwks, verifyOptions);

    // For access tokens (M2M), validate client_id instead of aud
    if (tokenUse === 'access') {
      const clientId = payload.client_id as string;
      const isKnownClient = config.audience?.includes(clientId);
      const isM2MAllowed = M2M_ALLOWED_POOLS.has(config.userPoolId);

      if (!isKnownClient && !isM2MAllowed) {
        console.log('[JWTValidator] ❌ Invalid client_id for access token', { clientId, isM2MAllowed });
        return {
          isValid: false,
          error: `Invalid client_id: ${clientId}`,
        };
      }

      // Log M2M access for audit
      if (!isKnownClient && isM2MAllowed) {
        console.log('[JWTValidator] M2M client access', { clientId, userPoolId: config.userPoolId });
      }
    }

    // Extract user information from token claims
    const userId = (payload.sub || payload['cognito:username']) as string | undefined;
    const email = payload.email as string | undefined;
    const groups = payload['cognito:groups'] as string[] | undefined;

    console.log('[JWTValidator] ✅ Token verified successfully:', {
      userId: userId,
      issuer: payload.iss,
      audience: payload.aud,
      clientId: payload.client_id,
      tokenUse,
      expiresAt: payload.exp ? new Date((payload.exp as number) * 1000).toISOString() : 'unknown',
    });

    const result: JWTValidationResult = {
      isValid: true,
      payload,
      userId,
      email,
      groups,
    };

    // Cache only successful validations (L1 + L2)
    if (result.isValid) {
      await cacheManager.set(cacheKey, result, {
        memoryTtl: CacheTTL.JWT_VALIDATION.memory,
        cacheServiceTtl: CacheTTL.JWT_VALIDATION.service,
      });
      console.debug('JWT validation result cached', {
        userId
        // Note: tokenHash deliberately omitted for security
      });
    }

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    console.error('[JWTValidator] ❌ Token validation failed:', {
      error: errorMessage,
      errorType: error instanceof Error ? error.constructor.name : typeof error,
      configIssuer: config.issuer,
      configUserPoolId: config.userPoolId,
      timestamp: new Date().toISOString(),
    });

    return {
      isValid: false,
      error: `JWT validation failed: ${errorMessage}`,
    };
  }
}

/**
 * Validate JWT token from Lambda event
 *
 * @param event - Lambda event with Authorization header
 * @param config - Cognito configuration (optional, will derive from tenant header if not provided)
 * @param options - Validation options
 * @returns Validation result
 */
export async function validateJWTFromEvent(
  event: any,
  config?: CognitoConfig,
  options: { required?: boolean } = {}
): Promise<JWTValidationResult> {
  const authHeader = event.headers?.Authorization || event.headers?.authorization;

  // Extract token from header
  const token = extractTokenFromHeader(authHeader);

  if (!token) {
    if (options.required) {
      return {
        isValid: false,
        error: 'Missing Authorization header with Bearer token',
      };
    }

    // If not required, return valid without user info (dev mode)
    return {
      isValid: true,
      error: 'No token provided (dev mode)',
    };
  }

  // If no config provided, try to derive from tenant header or token issuer
  let effectiveConfig = config;
  if (!effectiveConfig) {
    // Try to get tenant from header
    const tenantId = event.headers?.['x-tenant-id'] || event.headers?.['X-Tenant-Id'];
    if (tenantId) {
      effectiveConfig = getCognitoConfigForTenant(tenantId);
      console.log('[JWTValidator] Using tenant-specific config:', { tenantId, poolId: effectiveConfig.userPoolId });
    } else {
      // Fall back to decoding token to get issuer
      try {
        const tokenParts = token.split('.');
        const payloadBase64 = tokenParts[1];
        const decodedPayload = JSON.parse(Buffer.from(payloadBase64, 'base64url').toString());
        const tokenIssuer = decodedPayload.iss as string;

        // Find matching tenant config by issuer
        for (const [tenant, cfg] of Object.entries(TENANT_COGNITO_POOLS)) {
          if (cfg.issuer === tokenIssuer) {
            effectiveConfig = cfg;
            console.log('[JWTValidator] Derived config from token issuer:', { tenant, poolId: cfg.userPoolId });
            break;
          }
        }
      } catch {
        // Ignore decode errors, will use default config
      }

      if (!effectiveConfig) {
        effectiveConfig = DEFAULT_COGNITO_CONFIG;
        console.log('[JWTValidator] Using default config');
      }
    }
  }

  // Validate the token
  return validateJWT(token, effectiveConfig);
}

/**
 * Check if user has required role/group
 */
export function hasRequiredRole(
  validationResult: JWTValidationResult,
  requiredRoles: string[]
): boolean {
  if (!validationResult.isValid || !validationResult.groups) {
    return false;
  }

  return requiredRoles.some((role) =>
    validationResult.groups!.includes(role)
  );
}
