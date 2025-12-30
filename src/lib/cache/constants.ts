/**
 * Cache Key Schemas and TTL Strategy
 *
 * Defines consistent cache key patterns and time-to-live strategies
 * for different types of cached data in bg-remover service.
 */

/**
 * Cache Key Builders
 *
 * Pattern: {service}-{type}-{identifier}
 * Note: Cache service only allows [a-zA-Z0-9_-] characters (no colons)
 * Ensures consistent, collision-free cache keys across the application
 */
export const buildCacheKey = {
  /**
   * Tenant configuration cache key
   * Pattern: config-tenant-{stage}-{tenant}
   * Example: config-tenant-dev-carousel-labs
   */
  tenantConfig: (stage: string, tenant: string): string =>
    `config-tenant-${stage}-${tenant}`,

  /**
   * JWT validation result cache key
   * Pattern: jwt-validation-{tokenHash}
   * Example: jwt-validation-a1b2c3d4e5f6...
   * Uses full 64-char HMAC-SHA256 hash for security (prevents collision attacks)
   */
  jwtValidation: (tokenHash: string): string =>
    `jwt-validation-${tokenHash}`,

  /**
   * Credits check cache key
   * Pattern: credits-check-{tenant}-{walletId}
   * Example: credits-check-carousel-labs-wallet_abc123
   */
  creditsCheck: (tenant: string, walletId: string): string =>
    `credits-check-${tenant}-${walletId}`,

  /**
   * Credits balance cache key
   * Pattern: credits-balance-{tenant}-{walletId}
   * Example: credits-balance-carousel-labs-wallet_abc123
   */
  creditsBalance: (tenant: string, walletId: string): string =>
    `credits-balance-${tenant}-${walletId}`,

  /**
   * Image processing job cache key
   * Pattern: job-{tenant}-{jobId}
   * Example: job-carousel-labs-job_xyz789
   */
  job: (tenant: string, jobId: string): string =>
    `job-${tenant}-${jobId}`,
};

/**
 * TTL Strategy (in seconds)
 *
 * Defines separate TTLs for L1 (memory) and L2 (cache-service)
 * Balances freshness requirements with performance optimization
 */
export const CacheTTL = {
  /**
   * Tenant Configuration
   * Low volatility, high access frequency
   * Memory: 5 minutes (quick refresh for config changes)
   * Service: 15 minutes (distributed cache for cross-Lambda consistency)
   */
  TENANT_CONFIG: {
    memory: 300, // 5 minutes
    service: 900, // 15 minutes
  },

  /**
   * JWT Validation
   * Tokens valid ~1 hour, but validate fresh for security
   * Memory: 1 minute (rapid cache churn for security)
   * Service: 5 minutes (balance between security and performance)
   */
  JWT_VALIDATION: {
    memory: 60, // 1 minute
    service: 300, // 5 minutes
  },

  /**
   * Credits Check
   * Balance changes on transactions, short cache tolerable
   * Memory: 30 seconds (near-real-time for UI responsiveness)
   * Service: 3 minutes (distributed cache for burst protection)
   */
  CREDITS_CHECK: {
    memory: 30, // 30 seconds
    service: 180, // 3 minutes
  },

  /**
   * Credits Balance
   * Similar to credits check, balance changes frequently
   * Memory: 30 seconds
   * Service: 3 minutes
   */
  CREDITS_BALANCE: {
    memory: 30, // 30 seconds
    service: 180, // 3 minutes
  },

  /**
   * Image Processing Job
   * Job status changes frequently during processing
   * Memory: 1 minute (quick refresh for status polling)
   * Service: 5 minutes (distributed cache for job lookup)
   */
  JOB: {
    memory: 60, // 1 minute
    service: 300, // 5 minutes
  },
} as const;

/**
 * Cache operation options type helper
 */
export interface CacheOptions {
  memoryTtl?: number;
  cacheServiceTtl?: number;
}

/**
 * Helper to get cache options from TTL strategy
 */
export function getCacheOptions(
  strategy: typeof CacheTTL[keyof typeof CacheTTL]
): CacheOptions {
  return {
    memoryTtl: strategy.memory,
    cacheServiceTtl: strategy.service,
  };
}
