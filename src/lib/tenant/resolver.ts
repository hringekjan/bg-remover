// src/lib/tenant/resolver.ts
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { getCacheManager } from '../cache/cache-manager';
import { buildCacheKey, CacheTTL } from '../cache/constants';

const ssmClient = new SSMClient({});

/**
 * Whitelisted tenant domains for hostname validation
 * R002 - CRITICAL: Prevents tenant-spoofing attacks via Host header manipulation
 */
const ALLOWED_TENANT_DOMAINS = ['carousellabs.co', 'hringekjan.is'] as const;

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
 * 3. Default tenant fallback
 */
export const resolveTenantFromRequest = async (event: any, stage: string): Promise<string> => {
  const headers = event.headers || {};
  console.log('[TenantResolver] Incoming Headers:', {
    host: headers['host'] || headers['Host'],
    origin: headers['origin'] || headers['Origin'],
    'x-tenant-id': headers['x-tenant-id'] || headers['X-Tenant-ID'] || headers['X-Tenant-Id'],
  });


  const tenantHeader = headers['x-tenant-id'] || headers['X-Tenant-ID'] || headers['X-Tenant-Id'];
  if (tenantHeader && typeof tenantHeader === 'string' && tenantHeader.trim()) {
    const resolvedTenant = tenantHeader.trim().toLowerCase();
    console.log('Tenant resolved from X-Tenant-ID header:', resolvedTenant);
    return resolvedTenant;
  }

  // Strategy 2: Domain-based resolution from Host header
  const host = headers['host'] || headers['Host'] || '';
  if (host) {
    const tenant = extractTenantFromHost(host);
    if (tenant) {
      console.log('Tenant resolved from host header:', host, '->', tenant);
      return tenant;
    }
  }

  // Strategy 2b: Domain-based resolution from Origin header (useful for API subdomains)
  const origin = headers['origin'] || headers['Origin'] || '';
  if (origin) {
    try {
      const originHost = new URL(origin).host;
      const tenant = extractTenantFromHost(originHost);
      if (tenant) {
        console.log('Tenant resolved from origin header:', originHost, '->', tenant);
        return tenant;
      }
    } catch (error) {
      console.warn('Failed to parse origin header for tenant resolution', {
        origin,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Strategy 3: Check path parameters (for API Gateway path-based routing)
  const pathParams = event.pathParameters || {};
  if (pathParams.tenant) {
    const resolvedTenant = pathParams.tenant.toLowerCase();
    console.log('Tenant resolved from path parameters:', resolvedTenant);
    return resolvedTenant;
  }

  // Strategy 4: Environment variable default
  const envTenant = process.env.TENANT || process.env.DEFAULT_TENANT;
  if (envTenant) {
    const resolvedTenant = envTenant.toLowerCase();
    console.log('Tenant resolved from environment:', resolvedTenant);
    return resolvedTenant;
  }

  // Fallback to carousel-labs (primary tenant)
  console.log('Using default tenant: carousel-labs');
  return 'carousel-labs';
};

/**
 * Extract tenant from hostname
 * R002 - CRITICAL: Validates hostname against ALLOWED_TENANT_DOMAINS whitelist
 * Supports patterns:
 * - {tenant}.carousellabs.co
 * - {tenant}.{stage}.carousellabs.co
 * - carousel.{tenant}.is (Icelandic domains)
 * - api.{stage}.carousellabs.co (shared API)
 */
function extractTenantFromHost(host: string): string | null {
  if (!host) {
    console.warn('Missing Host header while resolving tenant');
    return null;
  }

  const hostname = host.split(':')[0].trim().toLowerCase();
  console.log('[TenantResolver] Extracting tenant from hostname:', hostname);

  // R002 - CRITICAL: Validate hostname against whitelist before processing
  const isAllowedDomain = ALLOWED_TENANT_DOMAINS.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
  );

  if (!isAllowedDomain) {
    console.warn('Tenant host not allowed (not in whitelist)', { host: hostname });
    return null;
  }

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



  // Special case: direct hringekjan domain
  if (hostname === 'hringekjan.is' || hostname.endsWith('.hringekjan.is')) {
    console.log('[TenantResolver] Resolved hringekjan tenant from hostname:', hostname);
    return 'hringekjan';
  }

  return null;
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
