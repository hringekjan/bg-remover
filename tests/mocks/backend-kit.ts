type CacheEntry = {
  value: number[];
  createdAt: number;
  lastAccess: number;
  sizeBytes: number;
};

export class EmbeddingCache {
  private maxSizeBytes: number;
  private ttlMs: number;
  private cache = new Map<string, CacheEntry>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private sizeBytes = 0;

  constructor(opts?: { maxSizeBytes?: number; ttlMs?: number }) {
    this.maxSizeBytes = opts?.maxSizeBytes ?? 100 * 1024 * 1024;
    this.ttlMs = opts?.ttlMs ?? 5 * 60 * 1000;
  }

  private estimateSize(embedding: number[], key: string): number {
    return embedding.length * 8 + key.length;
  }

  private evictIfNeeded(): void {
    if (this.sizeBytes <= this.maxSizeBytes) return;
    const entries = Array.from(this.cache.entries()).sort(
      (a, b) => a[1].lastAccess - b[1].lastAccess
    );
    for (const [key, entry] of entries) {
      if (this.sizeBytes <= this.maxSizeBytes) break;
      this.cache.delete(key);
      this.sizeBytes -= entry.sizeBytes;
      this.evictions += 1;
    }
  }

  async get(key: string): Promise<number[] | null> {
    const entry = this.cache.get(key);
    if (!entry) {
      this.misses += 1;
      return null;
    }
    const now = Date.now();
    if (this.ttlMs > 0 && now - entry.createdAt > this.ttlMs) {
      this.cache.delete(key);
      this.sizeBytes -= entry.sizeBytes;
      this.misses += 1;
      return null;
    }
    entry.lastAccess = now;
    this.hits += 1;
    return entry.value;
  }

  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;
    if (this.ttlMs > 0 && Date.now() - entry.createdAt > this.ttlMs) {
      this.cache.delete(key);
      this.sizeBytes -= entry.sizeBytes;
      return false;
    }
    return true;
  }

  async set(key: string, value: number[]): Promise<void> {
    const now = Date.now();
    const size = this.estimateSize(value, key);
    const existing = this.cache.get(key);
    if (existing) {
      this.sizeBytes -= existing.sizeBytes;
    }
    this.cache.set(key, { value, createdAt: now, lastAccess: now, sizeBytes: size });
    this.sizeBytes += size;
    this.evictIfNeeded();
  }

  clear(): void {
    this.cache.clear();
    this.sizeBytes = 0;
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  getEntrySize(key: string): number | null {
    const entry = this.cache.get(key);
    return entry ? entry.sizeBytes : null;
  }

  getCacheStats(): {
    hits: number;
    misses: number;
    totalRequests: number;
    hitRate: number;
    evictions: number;
    sizeBytes: number;
    sizePercent: number;
    entryCount: number;
  } {
    const totalRequests = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      totalRequests,
      hitRate: totalRequests ? this.hits / totalRequests : 0,
      evictions: this.evictions,
      sizeBytes: this.sizeBytes,
      sizePercent: this.maxSizeBytes ? (this.sizeBytes / this.maxSizeBytes) * 100 : 0,
      entryCount: this.cache.size,
    };
  }
}
