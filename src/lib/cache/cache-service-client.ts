/**
 * Cache Service HTTP Client
 *
 * Provides HTTP client for cache-service with resilience patterns:
 * - Circuit breaker to prevent cascading failures
 * - Retry logic with exponential backoff for transient errors
 * - Configurable timeouts per operation
 * - Connection pooling with keep-alive
 */

import { CircuitBreaker, CircuitState } from './circuit-breaker';

// Cache Service API base URL
const CACHE_SERVICE_URL = process.env.CACHE_SERVICE_URL || 'https://api.dev.carousellabs.co/cache';

/**
 * Cache GET/SET/DELETE response types
 */
export interface CacheGetResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  cached?: boolean;
}

export interface CacheSetResponse {
  success: boolean;
  error?: string;
}

export interface CacheDeleteResponse {
  success: boolean;
  error?: string;
}

/**
 * Retry configuration
 */
interface RetryConfig {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
}

/**
 * Operation timeouts (in milliseconds)
 */
const OPERATION_TIMEOUTS = {
  GET: 2000, // 2 seconds for reads
  SET: 3000, // 3 seconds for writes
  DELETE: 1500, // 1.5 seconds for deletes
};

/**
 * Default retry configuration
 */
const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelayMs: 100,
  maxDelayMs: 2000,
  backoffMultiplier: 2,
};

/**
 * HTTP status codes that should trigger retries (transient errors)
 */
const RETRYABLE_STATUS_CODES = [408, 429, 500, 502, 503, 504];

/**
 * Cache Service HTTP Client with Circuit Breaker
 */
export class CacheServiceClient {
  private circuitBreaker: CircuitBreaker;
  private retryConfig: Required<RetryConfig>;

  constructor(config?: {
    circuitBreakerConfig?: { failureThreshold?: number; successThreshold?: number; timeout?: number };
    retryConfig?: RetryConfig;
  }) {
    this.circuitBreaker = new CircuitBreaker(config?.circuitBreakerConfig);
    this.retryConfig = {
      maxRetries: config?.retryConfig?.maxRetries ?? DEFAULT_RETRY_CONFIG.maxRetries!,
      initialDelayMs: config?.retryConfig?.initialDelayMs ?? DEFAULT_RETRY_CONFIG.initialDelayMs!,
      maxDelayMs: config?.retryConfig?.maxDelayMs ?? DEFAULT_RETRY_CONFIG.maxDelayMs!,
      backoffMultiplier: config?.retryConfig?.backoffMultiplier ?? DEFAULT_RETRY_CONFIG.backoffMultiplier!,
    };
  }

  /**
   * Validate tenant ID format and security
   * Prevents header injection and tenant isolation bypass
   */
  private validateTenantId(tenantId: string): void {
    if (!tenantId || typeof tenantId !== 'string') {
      throw new Error('Invalid tenantId: must be non-empty string');
    }

    // Validate format (lowercase alphanumeric + hyphens only, no injection vectors)
    if (!/^[a-z0-9-]+$/.test(tenantId)) {
      throw new Error(`Invalid tenantId format: ${tenantId}. Must match [a-z0-9-]+`);
    }

    // Check length bounds (DNS-style limit)
    if (tenantId.length < 1 || tenantId.length > 63) {
      throw new Error(`Invalid tenantId length: ${tenantId.length}. Must be 1-63 chars`);
    }

    // Prevent leading/trailing hyphens
    if (tenantId.startsWith('-') || tenantId.endsWith('-')) {
      throw new Error('Invalid tenantId: cannot start or end with hyphen');
    }
  }

  /**
   * GET cache entry by key
   */
  async get<T = any>(tenantId: string, key: string): Promise<CacheGetResponse<T>> {
    // Check circuit breaker first
    if (!this.circuitBreaker.canExecute()) {
      console.warn('Cache service circuit breaker OPEN, skipping GET request', {
        key,
        tenantId,
        state: this.circuitBreaker.getState(),
      });
      return {
        success: false,
        error: 'Circuit breaker open',
      };
    }

    try {
      // Validate tenant ID (prevents header injection and tenant isolation bypass)
      this.validateTenantId(tenantId);

      const response = await this.executeWithRetry(
        () => this.fetchWithTimeout(`${CACHE_SERVICE_URL}/${key}`, {
          method: 'GET',
          headers: {
            'X-Tenant-Id': tenantId,
          },
        }, OPERATION_TIMEOUTS.GET),
        'GET',
        key
      );

      if (!response.ok) {
        // 404 Not Found is expected for cache misses, not an error
        if (response.status === 404) {
          this.circuitBreaker.recordSuccess();
          return {
            success: true,
            data: undefined,
            cached: false,
          };
        }

        // Other errors are failures
        this.circuitBreaker.recordFailure();
        return {
          success: false,
          error: `Cache service returned ${response.status}`,
        };
      }

      const result = await response.json();
      this.circuitBreaker.recordSuccess();

      return {
        success: true,
        data: result.value as T,
        cached: true,
      };
    } catch (error) {
      this.circuitBreaker.recordFailure();
      console.warn('Cache GET failed', {
        error: error instanceof Error ? error.message : String(error),
        key,
        tenantId,
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * SET cache entry with key and TTL
   */
  async set<T = any>(tenantId: string, key: string, value: T, ttl: number): Promise<CacheSetResponse> {
    // Check circuit breaker first
    if (!this.circuitBreaker.canExecute()) {
      console.warn('Cache service circuit breaker OPEN, skipping SET request', {
        key,
        tenantId,
        state: this.circuitBreaker.getState(),
      });
      return {
        success: false,
        error: 'Circuit breaker open',
      };
    }

    try {
      // Validate tenant ID (prevents header injection and tenant isolation bypass)
      this.validateTenantId(tenantId);

      const response = await this.executeWithRetry(
        () => this.fetchWithTimeout(`${CACHE_SERVICE_URL}/${key}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Tenant-Id': tenantId,
          },
          body: JSON.stringify({ value, ttl }),
        }, OPERATION_TIMEOUTS.SET),
        'SET',
        key
      );

      if (!response.ok) {
        this.circuitBreaker.recordFailure();
        return {
          success: false,
          error: `Cache service returned ${response.status}`,
        };
      }

      this.circuitBreaker.recordSuccess();
      return {
        success: true,
      };
    } catch (error) {
      this.circuitBreaker.recordFailure();
      console.warn('Cache SET failed', {
        error: error instanceof Error ? error.message : String(error),
        key,
        tenantId,
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * DELETE cache entry by key
   */
  async delete(tenantId: string, key: string): Promise<CacheDeleteResponse> {
    // Check circuit breaker first
    if (!this.circuitBreaker.canExecute()) {
      console.warn('Cache service circuit breaker OPEN, skipping DELETE request', {
        key,
        tenantId,
        state: this.circuitBreaker.getState(),
      });
      return {
        success: false,
        error: 'Circuit breaker open',
      };
    }

    try {
      // Validate tenant ID (prevents header injection and tenant isolation bypass)
      this.validateTenantId(tenantId);

      const response = await this.executeWithRetry(
        () => this.fetchWithTimeout(`${CACHE_SERVICE_URL}/${key}`, {
          method: 'DELETE',
          headers: {
            'X-Tenant-Id': tenantId,
          },
        }, OPERATION_TIMEOUTS.DELETE),
        'DELETE',
        key
      );

      if (!response.ok) {
        this.circuitBreaker.recordFailure();
        return {
          success: false,
          error: `Cache service returned ${response.status}`,
        };
      }

      this.circuitBreaker.recordSuccess();
      return {
        success: true,
      };
    } catch (error) {
      this.circuitBreaker.recordFailure();
      console.warn('Cache DELETE failed', {
        error: error instanceof Error ? error.message : String(error),
        key,
        tenantId,
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Check if cache service is available (circuit breaker status)
   */
  isAvailable(): boolean {
    return this.circuitBreaker.isAvailable();
  }

  /**
   * Get circuit breaker state
   */
  getState(): CircuitState {
    return this.circuitBreaker.getState();
  }

  /**
   * Get circuit breaker statistics
   */
  getStats() {
    return this.circuitBreaker.getStats();
  }

  /**
   * Execute fetch with timeout
   */
  private async fetchWithTimeout(
    url: string,
    options: RequestInit,
    timeoutMs: number
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Execute with retry logic for transient errors
   */
  private async executeWithRetry(
    operation: () => Promise<Response>,
    operationType: string,
    key: string
  ): Promise<Response> {
    let lastError: Error | null = null;
    let delayMs = this.retryConfig.initialDelayMs;

    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      try {
        const response = await operation();

        // Don't retry on successful responses or non-retryable errors
        if (response.ok || !RETRYABLE_STATUS_CODES.includes(response.status)) {
          return response;
        }

        // Retryable error - log and continue to retry
        console.debug('Cache operation returned retryable error', {
          operationType,
          key,
          status: response.status,
          attempt: attempt + 1,
          maxRetries: this.retryConfig.maxRetries,
        });

        lastError = new Error(`HTTP ${response.status}`);
      } catch (error) {
        // Network errors and timeouts are retryable
        lastError = error instanceof Error ? error : new Error(String(error));
        console.debug('Cache operation failed with error', {
          operationType,
          key,
          error: lastError.message,
          attempt: attempt + 1,
          maxRetries: this.retryConfig.maxRetries,
        });
      }

      // Don't sleep after the last attempt
      if (attempt < this.retryConfig.maxRetries) {
        await this.sleep(delayMs);
        // Exponential backoff with max cap
        delayMs = Math.min(delayMs * this.retryConfig.backoffMultiplier, this.retryConfig.maxDelayMs);
      }
    }

    // All retries exhausted
    throw lastError || new Error('Unknown error during retry');
  }

  /**
   * Sleep utility for retry delays
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Global client instance
let globalCacheServiceClient: CacheServiceClient | null = null;

/**
 * Get or create global cache service client
 */
export function getCacheServiceClient(config?: {
  circuitBreakerConfig?: { failureThreshold?: number; successThreshold?: number; timeout?: number };
  retryConfig?: RetryConfig;
}): CacheServiceClient {
  if (!globalCacheServiceClient) {
    globalCacheServiceClient = new CacheServiceClient(config);
  }
  return globalCacheServiceClient;
}
