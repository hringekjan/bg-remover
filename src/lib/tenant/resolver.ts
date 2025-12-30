// src/lib/tenant/resolver.ts
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { getCacheManager } from '../cache/cache-manager';
import { buildCacheKey, CacheTTL } from '../cache/constants';

const ssmClient = new SSMClient({});

export interface TenantConfig {
  tenant: string;
  stage: string;
  bedrockModelId?: string;
  s3OutputBucket?: string;
  creditsEnabled?: boolean;
  maxImageSize?: number;
  allowedFormats?: string[];
}

/**
 * Resolve tenant from request using multiple strategies:
 * 1. X-Tenant-ID header (explicit)
 * 2. Domain-based resolution (host header)
 * 3. Authorization token claims
 * 4. Default tenant fallback
 */
export const resolveTenantFromRequest = async (event: any, stage: string): Promise<string> => {
  // Strategy 1: Check X-Tenant-ID header (case-insensitive)
  const headers = event.headers || {};
  const tenantHeader = headers['x-tenant-id'] || headers['X-Tenant-ID'] || headers['X-Tenant-Id'];
  if (tenantHeader && typeof tenantHeader === 'string' && tenantHeader.trim()) {
    console.log('Tenant resolved from X-Tenant-ID header:', tenantHeader);
    return tenantHeader.trim().toLowerCase();
  }

  // Strategy 2: Domain-based resolution from Host header
  const host = headers['host'] || headers['Host'] || '';
  if (host) {
    const tenant = extractTenantFromHost(host);
    if (tenant) {
      console.log('Tenant resolved from host:', host, '->', tenant);
      return tenant;
    }
  }

  // Strategy 3: Extract from JWT claims if present
  const authHeader = headers['authorization'] || headers['Authorization'];
  if (authHeader) {
    const tenant = extractTenantFromJWT(authHeader);
    if (tenant) {
      console.log('Tenant resolved from JWT claims:', tenant);
      return tenant;
    }
  }

  // Strategy 4: Check path parameters (for API Gateway path-based routing)
  const pathParams = event.pathParameters || {};
  if (pathParams.tenant) {
    console.log('Tenant resolved from path parameters:', pathParams.tenant);
    return pathParams.tenant.toLowerCase();
  }

  // Strategy 5: Environment variable default
  const envTenant = process.env.TENANT || process.env.DEFAULT_TENANT;
  if (envTenant) {
    console.log('Tenant resolved from environment:', envTenant);
    return envTenant.toLowerCase();
  }

  // Fallback to carousel-labs (primary tenant)
  console.log('Using default tenant: carousel-labs');
  return 'carousel-labs';
};

/**
 * Extract tenant from hostname
 * Supports patterns:
 * - {tenant}.carousellabs.co
 * - {tenant}.{stage}.carousellabs.co
 * - carousel.{tenant}.is (Icelandic domains)
 * - api.{stage}.carousellabs.co (shared API)
 */
function extractTenantFromHost(host: string): string | null {
  // Remove port if present
  const hostname = host.split(':')[0].toLowerCase();

  // Pattern: {tenant}.carousellabs.co or {tenant}.dev.carousellabs.co
  const carouselPattern = /^([a-z0-9-]+)\.(?:dev\.|prod\.)?carousellabs\.co$/;
  const carouselMatch = hostname.match(carouselPattern);
  if (carouselMatch) {
    const tenant = carouselMatch[1];
    // Exclude known subdomains that aren't tenants
    if (!['api', 'auth', 'www', 'app', 'admin'].includes(tenant)) {
      return tenant;
    }
  }

  // Pattern: carousel.{tenant}.is (Icelandic tenant domains)
  const icelandicPattern = /^carousel\.([a-z0-9-]+)\.is$/;
  const icelandicMatch = hostname.match(icelandicPattern);
  if (icelandicMatch) {
    return icelandicMatch[1];
  }

  // Pattern: {tenant}.hringekjan.is
  const hringekjanPattern = /^([a-z0-9-]+)\.hringekjan\.is$/;
  const hringekjanMatch = hostname.match(hringekjanPattern);
  if (hringekjanMatch) {
    const subdomain = hringekjanMatch[1];
    if (subdomain === 'carousel') {
      return 'hringekjan';
    }
  }

  // Special case: direct hringekjan domain
  if (hostname === 'hringekjan.is' || hostname.endsWith('.hringekjan.is')) {
    return 'hringekjan';
  }

  return null;
}

/**
 * Extract tenant from JWT claims
 * Looks for custom:tenant_id or tenant claim in JWT payload
 */
function extractTenantFromJWT(authHeader: string): string | null {
  try {
    // Remove "Bearer " prefix if present
    const token = authHeader.replace(/^Bearer\s+/i, '');

    // Split JWT and decode payload (middle part)
    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }

    // Decode base64url payload
    const payload = JSON.parse(
      Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    );

    // Check various claim names
    const tenant = payload['custom:tenant_id'] ||
                   payload['tenant_id'] ||
                   payload['tenant'] ||
                   payload['custom:tenant'];

    if (tenant && typeof tenant === 'string') {
      return tenant.toLowerCase();
    }

    return null;
  } catch (error) {
    console.warn('Failed to extract tenant from JWT:', error);
    return null;
  }
}

/**
 * Load tenant-specific configuration from SSM Parameter Store
 * Uses hybrid L1 (memory) + L2 (cache-service) caching
 */
export const loadTenantConfig = async (tenant: string, stage: string): Promise<TenantConfig> => {
  const cacheKey = buildCacheKey.tenantConfig(stage, tenant);
  const cacheManager = getCacheManager();

  // Try cache first (L1 memory + L2 cache-service)
  const cached = await cacheManager.get<TenantConfig>(cacheKey);
  if (cached) {
    console.log('Using cached tenant config for:', tenant);
    return cached;
  }

  const defaultConfig: TenantConfig = {
    tenant,
    stage,
    bedrockModelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
    s3OutputBucket: `carousel-processed-images-${stage}`,
    creditsEnabled: true,
    maxImageSize: 10 * 1024 * 1024, // 10MB
    allowedFormats: ['image/jpeg', 'image/png', 'image/webp'],
  };

  try {
    const parameterPath = `/tf/${stage}/${tenant}/services/bg-remover/config`;
    console.log('Loading tenant config from SSM:', parameterPath);

    const response = await ssmClient.send(new GetParameterCommand({
      Name: parameterPath,
      WithDecryption: true,
    }));

    if (response.Parameter?.Value) {
      const ssmConfig = JSON.parse(response.Parameter.Value);
      const config: TenantConfig = {
        ...defaultConfig,
        ...ssmConfig,
        tenant,
        stage,
      };

      // Cache the config (L1 + L2)
      await cacheManager.set(cacheKey, config, {
        memoryTtl: CacheTTL.TENANT_CONFIG.memory,
        cacheServiceTtl: CacheTTL.TENANT_CONFIG.service,
      });
      console.log('Loaded and cached tenant config for:', tenant);
      return config;
    }
  } catch (error) {
    console.warn('Failed to load tenant config from SSM, using defaults:', {
      tenant,
      stage,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }

  // Cache default config (L1 + L2)
  await cacheManager.set(cacheKey, defaultConfig, {
    memoryTtl: CacheTTL.TENANT_CONFIG.memory,
    cacheServiceTtl: CacheTTL.TENANT_CONFIG.service,
  });
  return defaultConfig;
};

/**
 * Clear the tenant config cache (useful for testing)
 * Clears only L1 memory cache - L2 cache-service entries expire naturally via TTL
 */
export const clearTenantConfigCache = async (tenant?: string, stage?: string): Promise<void> => {
  const cacheManager = getCacheManager();

  if (tenant && stage) {
    // Clear specific tenant config
    const cacheKey = buildCacheKey.tenantConfig(stage, tenant);
    await cacheManager.delete(cacheKey);
  } else {
    // Clear all cached configs (memory only)
    // Note: This only clears L1 memory cache, not L2 cache-service
    console.warn('Clearing all tenant configs from memory cache');
    // CacheManager doesn't have a clear-all method, so this is a no-op
    // Individual entries will expire naturally via TTL
  }
};
