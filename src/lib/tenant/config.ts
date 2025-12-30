/**
 * Multi-tenant API configuration utilities for bg-remover service
 * Uses tenant context from Lambda event to determine tenant-specific API URLs
 */

/**
 * Extract tenant from Lambda event context
 * Priority order:
 * 1. x-tenant-id header
 * 2. Authorizer context
 * 3. Environment variable
 * 4. Default to carousel-labs
 */
export function extractTenantFromEvent(event: any): string {
  // Check headers
  if (event.headers?.['x-tenant-id']) {
    return event.headers['x-tenant-id'];
  }

  // Check authorizer context
  if (event.requestContext?.authorizer?.tenantId) {
    return event.requestContext.authorizer.tenantId;
  }

  // Fall back to environment variable
  return process.env.TENANT || process.env.NEXT_PUBLIC_TENANT || 'carousel-labs';
}

/**
 * Determine stage from environment
 */
export function getStage(): 'dev' | 'prod' {
  const stage = process.env.STAGE || process.env.NODE_ENV;
  return stage === 'production' || stage === 'prod' ? 'prod' : 'dev';
}

/**
 * Map tenant ID to base domain
 * Examples:
 * - carousel-labs -> carousellabs.co
 * - hringekjan -> hringekjan.is
 */
export function getTenantBaseDomain(tenant: string): string {
  const tenantDomainMap: Record<string, string> = {
    'carousel-labs': 'carousellabs.co',
    'hringekjan': 'hringekjan.is',
  };

  return tenantDomainMap[tenant] || 'carousellabs.co';
}

/**
 * Get the API base URL for the current tenant
 * Priority order:
 * 1. Explicit environment variable override (IMAGE_OPTIMIZER_SERVICE_URL)
 * 2. Dynamic tenant-specific API domain based on tenant context
 *
 * Examples:
 * - tenant: carousel-labs, stage: dev -> https://api.dev.carousellabs.co/carousel-labs
 * - tenant: hringekjan, stage: dev -> https://api.dev.hringekjan.is/hringekjan
 * - tenant: carousel-labs, stage: prod -> https://api.carousellabs.co/carousel-labs
 * - tenant: hringekjan, stage: prod -> https://api.hringekjan.is/hringekjan
 */
export function getTenantApiBaseUrl(tenant?: string, service?: string): string {
  // 1. Check for explicit service URL override
  if (service === 'image-optimizer' && process.env.IMAGE_OPTIMIZER_SERVICE_URL) {
    return process.env.IMAGE_OPTIMIZER_SERVICE_URL;
  }

  // 2. Check for generic API URL override
  if (process.env.API_BASE_URL) {
    return process.env.API_BASE_URL;
  }

  // 3. Dynamically determine API URL based on tenant
  const resolvedTenant = tenant || process.env.TENANT || 'carousel-labs';
  const stage = getStage();
  const baseDomain = getTenantBaseDomain(resolvedTenant);

  // Build tenant-specific API domain
  const apiDomain = stage === 'prod'
    ? `api.${baseDomain}`       // api.hringekjan.is or api.carousellabs.co
    : `api.dev.${baseDomain}`;  // api.dev.hringekjan.is or api.dev.carousellabs.co

  return `https://${apiDomain}/${resolvedTenant}`;
}

/**
 * Get the complete API endpoint URL for a specific service
 */
export function getServiceEndpoint(serviceName: string, tenant?: string): string {
  const baseUrl = getTenantApiBaseUrl(tenant, serviceName);

  // Remove tenant path suffix if it's already in the base URL
  const cleanBaseUrl = baseUrl.replace(/\/(carousel-labs|hringekjan)$/, '');

  // Special case: image-optimizer service uses /optimize endpoint, not /image-optimizer
  if (serviceName === 'image-optimizer') {
    return `${cleanBaseUrl}/optimize`;
  }

  return `${cleanBaseUrl}/${serviceName}`;
}

/**
 * Get tenant-specific configuration from event context
 * Returns tenant ID and API base URL
 */
export function getTenantContext(event: any): {
  tenant: string;
  apiBaseUrl: string;
  stage: 'dev' | 'prod';
} {
  const tenant = extractTenantFromEvent(event);
  const stage = getStage();
  const apiBaseUrl = getTenantApiBaseUrl(tenant);

  return {
    tenant,
    apiBaseUrl,
    stage,
  };
}
