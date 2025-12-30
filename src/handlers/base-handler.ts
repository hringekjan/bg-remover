import { getCacheManager } from '../lib/cache/cache-manager';

export interface HandlerContext {
  cacheManager: ReturnType<typeof getCacheManager>;
  stage: string;
  region: string;
}

export class BaseHandler {
  protected context: HandlerContext;

  constructor() {
    // Initialize cache manager with tenant and cache-service config
    const tenantId = process.env.TENANT || 'carousel-labs';
    const cacheServiceUrl = process.env.CACHE_SERVICE_URL;

    this.context = {
      cacheManager: getCacheManager({
        tenantId,
        cacheServiceUrl,
        enableCacheService: !!cacheServiceUrl && !!tenantId,
        enableMemoryCache: true,
      }),
      stage: process.env.STAGE || 'dev',
      region: process.env.AWS_REGION || 'eu-west-1',
    };
  }

  protected async getCachedResponse<T>(
    key: string,
    fetcher: () => Promise<T>,
    ttl: number = 300
  ): Promise<T> {
    // Try cache first
    const cached = await this.context.cacheManager.get<T>(key);
    if (cached !== null) {
      return cached;
    }

    // Fetch fresh data
    const data = await fetcher();

    // Cache the result
    await this.context.cacheManager.set(key, data, { memoryTtl: ttl });

    return data;
  }

  protected createCorsHeaders(additionalHeaders: Record<string, string> = {}): Record<string, string> {
    return {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Tenant-Id, Cache-Control, Pragma, Expires',
      ...additionalHeaders,
    };
  }

  protected createJsonResponse(
    body: any,
    statusCode: number = 200,
    additionalHeaders: Record<string, string> = {}
  ): any {
    return {
      statusCode,
      headers: {
        ...this.createCorsHeaders(),
        'Content-Type': 'application/json',
        ...additionalHeaders,
      },
      body: JSON.stringify(body),
    };
  }

  protected createErrorResponse(
    message: string,
    statusCode: number = 500,
    details?: any
  ): any {
    const errorBody = {
      error: message,
      ...(details && { details }),
      timestamp: new Date().toISOString(),
    };

    return this.createJsonResponse(errorBody, statusCode);
  }

  protected validateTenant(tenant: string): boolean {
    // Basic tenant validation - can be extended
    return Boolean(tenant && tenant.length > 0 && tenant.length <= 50);
  }

  protected extractTenantFromEvent(event: any): string {
    // Extract tenant from various sources
    return event.headers?.['x-tenant-id'] ||
           event.headers?.['X-Tenant-Id'] ||
           process.env.TENANT ||
           'carousel-labs';
  }
}