import { getCacheManager } from '../lib/cache/cache-manager';
// Temporarily disabled due to build issues - not critical for core functionality
// import { bgRemoverAgentState } from '../lib/agent-state';

export interface HandlerContext {
  cacheManager: ReturnType<typeof getCacheManager>;
  stage: string;
  region: string;
  // agentState: typeof bgRemoverAgentState;
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
      // agentState: bgRemoverAgentState,
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

  /**
   * @deprecated Use createTenantCorsHeaders from lib/cors.ts instead
   * This method uses wildcard CORS which is insecure for production.
   */
  protected createCorsHeaders(additionalHeaders: Record<string, string> = {}): Record<string, string> {
    return {
      'Access-Control-Allow-Origin': 'null',  // Secure: no wildcard
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Tenant-Id, Cache-Control, Pragma, Expires',
      'Vary': 'Origin',  // CRITICAL: Prevent cache poisoning
      ...additionalHeaders,
    };
  }

  protected createJsonResponse(
    body: any,
    statusCode: number = 200,
    additionalHeaders: Record<string, string> = {}
  ): any {
    // Generate ETag for cache validation
    const bodyString = JSON.stringify(body);
    const etag = this.generateETag(bodyString);

    return {
      statusCode,
      headers: {
        ...this.createCorsHeaders(),
        'Content-Type': 'application/json',
        // CloudFront cache headers - 5 minute TTL
        'Cache-Control': 'public, max-age=300, must-revalidate',
        'ETag': etag,
        'Vary': 'Authorization, X-Tenant-Id',
        ...additionalHeaders,
      },
      body: bodyString,
    };
  }

  /**
   * Generate ETag for cache validation
   * Uses simple hash of response body for cache validation
   */
  protected generateETag(content: string): string {
    const crypto = require('crypto');
    const hash = crypto.createHash('md5').update(content).digest('hex');
    return `"${hash}"`;
  }

  protected createErrorResponse(
    message: string,
    statusCode: number = 500,
    headersOrDetails?: Record<string, string> | any,
    details?: any
  ): any {
    // Support backward compatibility: third param can be headers or details
    let additionalHeaders: Record<string, string> = {};
    let errorDetails: any = undefined;

    if (headersOrDetails) {
      // If third param looks like HTTP headers (has common header keys), treat as headers
      const headerKeys = [
        'WWW-Authenticate',
        'Content-Type',
        'Cache-Control',
        'Location',
        'Access-Control-Allow-Origin',
        'Access-Control-Allow-Methods',
        'Access-Control-Allow-Headers',
        'Access-Control-Allow-Credentials',
        'Access-Control-Max-Age',
        'Vary',
      ];
      const isHeaders = typeof headersOrDetails === 'object' &&
        Object.keys(headersOrDetails).some(key => headerKeys.includes(key));

      if (isHeaders) {
        additionalHeaders = headersOrDetails;
        errorDetails = details;
      } else {
        // Third param is details (old signature)
        errorDetails = headersOrDetails;
      }
    }

    const errorBody = {
      error: message,
      ...(errorDetails && { details: errorDetails }),
      timestamp: new Date().toISOString(),
    };

    // Error responses should not be cached
    return this.createJsonResponse(errorBody, statusCode, {
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      'Pragma': 'no-cache',
      'Expires': '0',
      ...additionalHeaders,
    });
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
