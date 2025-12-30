import { getCacheServiceClient, CacheServiceClient } from './cache-service-client';

export interface CacheConfig {
  cacheServiceUrl?: string; // Cache service API URL
  memoryTtl?: number; // seconds (L1 TTL)
  cacheServiceTtl?: number; // seconds (L2 TTL)
  maxMemoryEntries?: number; // Maximum entries in memory cache before LRU eviction
  enableMemoryCache?: boolean;
  enableCacheService?: boolean; // Enable L2 cache via cache-service
  tenantId?: string; // Required for cache-service operations
}

export interface CacheEntry<T = any> {
  data: T;
  timestamp: number;
  ttl: number;
  hits: number;
}

export class CacheManager {
  private cacheServiceClient: CacheServiceClient | null = null;
  private memoryCache: Map<string, CacheEntry> = new Map();
  private config: Required<CacheConfig>;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private cacheWriteFailures: number = 0; // Track L2 write failures for observability
  private cacheWriteSuccesses: number = 0; // Track L2 write successes for observability

  constructor(config: CacheConfig = {}) {
    this.config = {
      cacheServiceUrl: config.cacheServiceUrl || process.env.CACHE_SERVICE_URL || '',
      memoryTtl: config.memoryTtl || 300, // 5 minutes default
      cacheServiceTtl: config.cacheServiceTtl || 3600, // 1 hour default
      maxMemoryEntries: config.maxMemoryEntries || 1000, // Prevent unbounded growth
      enableMemoryCache: config.enableMemoryCache !== false,
      enableCacheService: config.enableCacheService !== false && !!config.tenantId,
      tenantId: config.tenantId || '',
    };

    this.initializeCacheService();
    this.startCleanupInterval();
  }

  private initializeCacheService(): void {
    if (!this.config.enableCacheService) {
      console.info('Cache service L2 disabled - using memory-only cache');
      this.cacheServiceClient = null;
      return;
    }

    if (!this.config.tenantId) {
      console.warn('Cache service enabled but no tenantId provided - using memory-only cache');
      this.cacheServiceClient = null;
      return;
    }

    try {
      this.cacheServiceClient = getCacheServiceClient();
      console.info('Cache service L2 initialized successfully', {
        tenantId: this.config.tenantId,
        cacheServiceUrl: this.config.cacheServiceUrl,
      });
    } catch (error) {
      console.warn('Failed to initialize cache service, falling back to memory-only cache', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.cacheServiceClient = null;
    }
  }

  private startCleanupInterval(): void {
    if (!this.config.enableMemoryCache) return;

    // Clean up expired entries every 5 minutes
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredEntries();
    }, 5 * 60 * 1000);
  }

  private cleanupExpiredEntries(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, entry] of this.memoryCache.entries()) {
      if (now > entry.timestamp + (entry.ttl * 1000)) {
        this.memoryCache.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.info('Cleaned up expired cache entries', { cleaned });
    }
  }

  /**
   * Evict least recently used entry when cache is full
   * Uses weighted score: older timestamp + fewer hits = evicted first
   */
  private evictLRU(): void {
    if (this.memoryCache.size === 0) return;

    let evictKey: string | null = null;
    let lowestScore = Infinity;

    for (const [key, entry] of this.memoryCache.entries()) {
      // Score = age (ms) - hit bonus (1 hit = 60 seconds of age forgiveness)
      const age = Date.now() - entry.timestamp;
      const hitBonus = entry.hits * 60000;
      const score = age - hitBonus;

      if (score < lowestScore) {
        lowestScore = score;
        evictKey = key;
      }
    }

    if (evictKey) {
      this.memoryCache.delete(evictKey);
      console.debug('Evicted LRU cache entry', {
        key: evictKey,
        cacheSize: this.memoryCache.size,
        maxSize: this.config.maxMemoryEntries,
      });
    }
  }

  /**
   * Validate cache key format
   * Cache service only allows [a-zA-Z0-9_-]
   */
  private validateCacheKey(key: string): void {
    if (!key || typeof key !== 'string') {
      throw new Error('Cache key must be non-empty string');
    }

    // Cache service only allows [a-zA-Z0-9_-]
    if (!/^[a-zA-Z0-9_-]+$/.test(key)) {
      throw new Error(`Invalid cache key format: ${key}. Must match [a-zA-Z0-9_-]+`);
    }

    if (key.length > 256) {
      throw new Error(`Cache key exceeds max length: ${key.length}/256`);
    }
  }

  /**
   * Emit CloudWatch Embedded Metric Format (EMF)
   * Works in Lambda without SDK
   */
  private emitMetric(metricName: string, value: number, dimensions: Record<string, string> = {}): void {
    // CloudWatch EMF format
    const emf = {
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [{
          Namespace: 'bg-remover/cache',
          Dimensions: [Object.keys(dimensions)],
          Metrics: [{ Name: metricName, Unit: 'Count' }],
        }],
      },
      service: 'bg-remover',
      ...dimensions,
      [metricName]: value,
    };
    console.log(JSON.stringify(emf));
  }

  /**
   * Multi-layer cache retrieval with fallback strategy
   * L1: Memory cache (fastest)
   * L2: Cache service (distributed)
   */
  async get<T = any>(key: string): Promise<T | null> {
    this.validateCacheKey(key); // Validate key format

    // L1: Memory cache lookup
    if (this.config.enableMemoryCache) {
      const memoryEntry = this.memoryCache.get(key);
      if (memoryEntry && Date.now() < memoryEntry.timestamp + (memoryEntry.ttl * 1000)) {
        memoryEntry.hits++;
        console.debug('Cache hit (memory)', { key, hits: memoryEntry.hits });
        return memoryEntry.data;
      }
    }

    // L2: Cache service lookup
    if (this.config.enableCacheService && this.cacheServiceClient && this.config.tenantId) {
      try {
        const result = await this.cacheServiceClient.get<T>(this.config.tenantId, key);

        if (result.success && result.cached && result.data !== undefined) {
          const entry: CacheEntry<T> = {
            data: result.data,
            timestamp: Date.now(),
            ttl: this.config.memoryTtl, // Use memory TTL for L1 storage
            hits: 1,
          };

          // Populate L1 cache from L2
          if (this.config.enableMemoryCache) {
            this.memoryCache.set(key, entry);
          }

          console.debug('Cache hit (cache-service)', { key });
          return entry.data;
        }

        // Cache miss or circuit breaker open
        if (!result.success) {
          console.debug('Cache service unavailable', {
            key,
            error: result.error,
          });
        }
      } catch (error) {
        console.warn('Cache service lookup failed', {
          key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    console.debug('Cache miss', { key });
    return null;
  }

  /**
   * Multi-layer cache storage
   * L1: Synchronous memory cache
   * L2: Async cache-service (fire-and-forget)
   */
  async set<T = any>(
    key: string,
    data: T,
    options: {
      memoryTtl?: number;
      cacheServiceTtl?: number;
    } = {}
  ): Promise<void> {
    this.validateCacheKey(key); // Validate key format

    const now = Date.now();
    const memoryTtl = options.memoryTtl || this.config.memoryTtl;
    const cacheServiceTtl = options.cacheServiceTtl || this.config.cacheServiceTtl;

    // L1: Memory cache storage (synchronous)
    if (this.config.enableMemoryCache) {
      // Evict LRU if at capacity
      if (this.memoryCache.size >= this.config.maxMemoryEntries) {
        this.evictLRU();
      }

      const memoryEntry: CacheEntry<T> = {
        data,
        timestamp: now,
        ttl: memoryTtl,
        hits: 0,
      };
      this.memoryCache.set(key, memoryEntry);
      console.debug('Stored in memory cache', {
        key,
        size: this.memoryCache.size,
        maxSize: this.config.maxMemoryEntries,
        ttl: memoryTtl,
      });
    }

    // L2: Cache service storage (fire-and-forget with observability)
    if (this.config.enableCacheService && this.cacheServiceClient && this.config.tenantId) {
      // Fire-and-forget: don't await, don't block
      this.cacheServiceClient
        .set(this.config.tenantId, key, data, cacheServiceTtl)
        .then(result => {
          if (result.success) {
            this.cacheWriteSuccesses++;
            console.debug('Stored in cache service', {
              key,
              ttl: cacheServiceTtl,
              totalSuccesses: this.cacheWriteSuccesses,
            });
            this.emitMetric('CacheWriteSuccess', 1, { layer: 'L2', tenant: this.config.tenantId });
          } else {
            this.cacheWriteFailures++;
            console.warn('Cache service storage failed', {
              key,
              error: result.error,
              totalFailures: this.cacheWriteFailures,
              failureRate: this.cacheWriteFailures / (this.cacheWriteSuccesses + this.cacheWriteFailures),
            });
            this.emitMetric('CacheWriteFailure', 1, { layer: 'L2', tenant: this.config.tenantId });
          }
        })
        .catch(error => {
          this.cacheWriteFailures++;
          console.error('Cache service storage exception', {
            key,
            error: error instanceof Error ? error.message : String(error),
            totalFailures: this.cacheWriteFailures,
          });
          this.emitMetric('CacheWriteException', 1, { layer: 'L2', tenant: this.config.tenantId });
        });
    }
  }

  /**
   * Delete from all cache layers
   */
  async delete(key: string): Promise<void> {
    this.validateCacheKey(key); // Validate key format

    // L1: Memory cache
    if (this.config.enableMemoryCache) {
      this.memoryCache.delete(key);
    }

    // L2: Cache service
    if (this.config.enableCacheService && this.cacheServiceClient && this.config.tenantId) {
      try {
        const result = await this.cacheServiceClient.delete(this.config.tenantId, key);
        if (!result.success) {
          console.warn('Cache service deletion failed', {
            key,
            error: result.error,
          });
        }
      } catch (error) {
        console.warn('Cache service deletion error', {
          key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    console.debug('Deleted from cache', { key });
  }


  /**
   * Clear memory cache (L1 only)
   * Note: Cache service (L2) entries expire via TTL
   */
  async clear(): Promise<void> {
    // L1: Memory cache
    if (this.config.enableMemoryCache) {
      this.memoryCache.clear();
    }

    console.info('Memory cache cleared');
  }

  /**
   * Get cache statistics
   */
  getStats(): {
    memory: { entries: number; size: number };
    cacheService: { available: boolean; state?: string; stats?: any };
  } {
    return {
      memory: {
        entries: this.memoryCache.size,
        size: JSON.stringify([...this.memoryCache.entries()]).length,
      },
      cacheService: {
        available: this.cacheServiceClient?.isAvailable() || false,
        state: this.cacheServiceClient?.getState(),
        stats: this.cacheServiceClient?.getStats(),
      },
    };
  }

  /**
   * Graceful shutdown
   */
  async close(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Cache service client uses HTTP, no persistent connection to close
    console.info('Cache manager closed');
  }
}

// Per-tenant cache managers (prevents data mixing across Lambda invocations)
const globalCacheManagers: Map<string, CacheManager> = new Map();

/**
 * Get or create cache manager for a specific tenant
 * Maintains separate cache managers per tenant to prevent data mixing
 *
 * @param config - Cache configuration including tenantId
 * @returns Cache manager instance for the specified tenant
 */
export function getCacheManager(config?: CacheConfig): CacheManager {
  const tenantId = config?.tenantId || 'default';

  if (!globalCacheManagers.has(tenantId)) {
    console.info('Creating new cache manager for tenant', { tenantId });
    globalCacheManagers.set(tenantId, new CacheManager(config));
  }

  return globalCacheManagers.get(tenantId)!;
}

/**
 * Clear all cache managers (useful for testing and graceful shutdown)
 */
export function clearCacheManagers(): void {
  console.info('Clearing all cache managers', { count: globalCacheManagers.size });

  for (const [tenantId, cache] of globalCacheManagers.entries()) {
    try {
      cache.close();
    } catch (error) {
      console.error('Error closing cache manager', {
        tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  globalCacheManagers.clear();
}

/**
 * Get statistics for all cache managers (observability)
 */
export function getAllCacheStats(): Record<string, any> {
  const stats: Record<string, any> = {};

  for (const [tenantId, cache] of globalCacheManagers.entries()) {
    stats[tenantId] = cache.getStats();
  }

  return stats;
}

// Graceful shutdown handler
process.on('SIGTERM', async () => {
  clearCacheManagers();
});

process.on('SIGINT', async () => {
  clearCacheManagers();
});