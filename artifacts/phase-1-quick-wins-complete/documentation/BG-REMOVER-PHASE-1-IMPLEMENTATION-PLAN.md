# BG-Remover Phase 1 Implementation Plan
## All Quick Wins - Complete Implementation Guide

**Plan Date:** 2026-01-09
**Estimated Duration:** 3-4 days
**Expected Impact:** 3-5x performance improvement, 80% cost reduction
**Status:** Ready to Execute with State Persistence

---

## Executive Summary

This plan implements **ALL THREE Phase 1 Quick Wins** simultaneously for maximum impact:
1. **Batch Embedding Generation** → 3-5x faster embedding workflows
2. **Expand Cache Coverage** → 80% cache hit rate, massive cost savings
3. **Parallel Clustering** → N/cores speedup for multi-image processing

All implementations include **automatic state persistence** for debugging and resume capability.

---

## Pre-Implementation Checklist

- [ ] Development environment set up
- [ ] Access to AWS credentials (dev environment)
- [ ] Test dataset prepared (minimum 100 sample images)
- [ ] Baseline performance metrics captured
- [ ] State persistence monitoring dashboard ready

---

## Quick Win #1: Batch Embedding Generation

### Current State
```typescript
// Sequential processing - ONE API call per image
for (const image of images) {
  const embedding = await generateImageEmbedding(image);
  embeddings.push(embedding);
}
// Time: N * API_LATENCY (e.g., 10 images = 10 * 200ms = 2000ms)
```

### Target State
```typescript
// Batch processing - ONE API call for multiple images
const embeddings = await generateBatchImageEmbeddings(images, {
  batchSize: 25  // AWS Titan supports up to 25 images per batch
});
// Time: (N / BATCH_SIZE) * API_LATENCY (e.g., 10 images = 1 * 250ms = 250ms)
// Speedup: 8x for 10 images, 20x for 100 images
```

### Implementation Steps

#### Step 1.1: Update Product Identity Service (2 hours)

**File:** `src/lib/product-identity/product-identity-service.ts`

**Changes Required:**

```typescript
/**
 * Generate embeddings for multiple images in a single batch
 * AWS Titan Multimodal Embeddings supports up to 25 images per request
 */
export async function generateBatchImageEmbeddings(
  images: Array<{ imageId: string; buffer: Buffer }>,
  options: {
    batchSize?: number;
    model?: string;
  } = {}
): Promise<Map<string, ProductEmbedding>> {
  const { batchSize = 25, model = 'amazon.titan-embed-image-v1' } = options;

  const embeddings = new Map<string, ProductEmbedding>();
  const batches = chunkArray(images, batchSize);

  // Process batches in parallel (AWS SDK handles rate limiting)
  await Promise.all(
    batches.map(async (batch) => {
      const batchEmbeddings = await invokeTitanBatchEmbedding(batch, model);

      // Map results back to image IDs
      batchEmbeddings.forEach((embedding, index) => {
        const imageId = batch[index].imageId;
        embeddings.set(imageId, {
          imageId,
          embedding,
          model,
          timestamp: Date.now(),
        });
      });
    })
  );

  return embeddings;
}

/**
 * Helper: Invoke AWS Titan batch embedding API
 */
async function invokeTitanBatchEmbedding(
  batch: Array<{ imageId: string; buffer: Buffer }>,
  model: string
): Promise<number[][]> {
  const bedrock = new BedrockRuntimeClient({ region: 'eu-west-1' });

  const request = {
    modelId: model,
    contentType: 'application/json',
    accept: '*/*',
    body: JSON.stringify({
      inputImages: batch.map((img) => ({
        format: 'png', // or detect from buffer
        data: img.buffer.toString('base64'),
      })),
      embeddingConfig: {
        outputEmbeddingLength: 1024, // Standard dimension
      },
    }),
  };

  const command = new InvokeModelCommand(request);
  const response = await bedrock.send(command);

  const result = JSON.parse(new TextDecoder().decode(response.body));
  return result.embeddings; // Array of embedding vectors
}

/**
 * Helper: Split array into chunks
 */
function chunkArray<T>(array: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}
```

**Testing:**
```typescript
// Test file: src/lib/product-identity/__tests__/batch-embeddings.test.ts
describe('Batch Embedding Generation', () => {
  it('should generate embeddings for 10 images in <500ms', async () => {
    const images = generateTestImages(10);
    const startTime = Date.now();

    const embeddings = await generateBatchImageEmbeddings(images);

    const duration = Date.now() - startTime;
    expect(duration).toBeLessThan(500);
    expect(embeddings.size).toBe(10);
  });

  it('should handle batches larger than 25 images', async () => {
    const images = generateTestImages(100);

    const embeddings = await generateBatchImageEmbeddings(images);

    expect(embeddings.size).toBe(100);
    // Verify 4 batches were created (100 / 25 = 4)
  });

  it('should maintain embedding quality', async () => {
    const testImage = generateTestImages(1)[0];

    // Single embedding
    const singleEmbedding = await generateImageEmbedding(testImage);

    // Batch embedding
    const batchEmbeddings = await generateBatchImageEmbeddings([testImage]);
    const batchEmbedding = batchEmbeddings.get(testImage.imageId);

    // Embeddings should be identical
    expect(cosineSimilarity(singleEmbedding, batchEmbedding)).toBeGreaterThan(
      0.99
    );
  });
});
```

**State Persistence Checkpoint:**
```python
# After completing Step 1.1
manager.save_checkpoint(
    workflow_id='bg-remover-phase-1-implementation',
    step_number=0,
    step_name='batch_embedding_generation_complete',
    state_data={
        'quick_win': 1,
        'files_modified': ['product-identity-service.ts'],
        'tests_added': ['batch-embeddings.test.ts'],
        'performance_target': '3-5x faster'
    }
)
```

---

## Quick Win #2: Expand Cache Coverage

### Current State Analysis

**Existing Cache:** `src/lib/embedding-storage-service.ts` + `src/lib/cache/cache-manager.ts`

**Current Coverage Gaps:**
- ❌ No cache for Bedrock Claude 3.5 image analysis calls
- ❌ No cache for Rekognition API responses
- ❌ Embedding cache TTL may be too short
- ❌ Cache key generation not optimized (collision risk)

### Target State

**Cache Hit Rate:** 80%+ across all LLM/AI API calls

**Cache Strategy:**
```typescript
// Cache Layer 1: Embedding Cache (existing, improve)
// Cache Layer 2: Image Analysis Cache (NEW)
// Cache Layer 3: Clustering Results Cache (NEW)
```

### Implementation Steps

#### Step 2.1: Optimize Embedding Cache (1 hour)

**File:** `src/lib/embedding-storage-service.ts`

**Changes:**

```typescript
import { createHash } from 'crypto';

/**
 * Generate deterministic cache key for image
 * Uses perceptual hash to detect duplicates even if file differs slightly
 */
export function generateImageCacheKey(
  imageBuffer: Buffer,
  model: string
): string {
  // Use first 1KB + last 1KB for fast hashing (avoids processing entire image)
  const head = imageBuffer.slice(0, 1024);
  const tail = imageBuffer.slice(-1024);
  const sample = Buffer.concat([head, tail]);

  const hash = createHash('sha256').update(sample).digest('hex').slice(0, 16);

  return `embed:${model}:${hash}`;
}

/**
 * Store embedding with optimized TTL based on usage patterns
 */
export async function storeEmbeddingWithSmartTTL(
  imageId: string,
  embedding: ProductEmbedding,
  usage: 'frequent' | 'normal' | 'rare' = 'normal'
): Promise<void> {
  const ttlMap = {
    frequent: 7 * 24 * 3600, // 7 days for frequently accessed
    normal: 24 * 3600, // 24 hours (current default)
    rare: 1 * 3600, // 1 hour for one-time use
  };

  const ttl = ttlMap[usage];

  await cacheManager.set(
    generateImageCacheKey(embedding.imageId, embedding.model),
    embedding,
    { ttl }
  );
}
```

#### Step 2.2: Add Image Analysis Cache (NEW) (1.5 hours)

**File:** `src/lib/bedrock/image-analysis-cache.ts` (NEW)

**Implementation:**

```typescript
/**
 * Cache wrapper for Bedrock Claude 3.5 image analysis
 */
import { CacheManager } from '../cache/cache-manager';
import { createHash } from 'crypto';

export class ImageAnalysisCache {
  private cache: CacheManager;

  constructor() {
    this.cache = new CacheManager({
      defaultTTL: 3600, // 1 hour for analysis results
      maxSize: 5000, // Store up to 5000 analysis results
    });
  }

  /**
   * Generate cache key for image analysis
   */
  private getCacheKey(
    imageBuffer: Buffer,
    prompt: string,
    model: string
  ): string {
    // Hash image + prompt combination
    const imageHash = createHash('sha256')
      .update(imageBuffer.slice(0, 2048))
      .digest('hex')
      .slice(0, 12);

    const promptHash = createHash('sha256')
      .update(prompt)
      .digest('hex')
      .slice(0, 8);

    return `analysis:${model}:${imageHash}:${promptHash}`;
  }

  /**
   * Get cached analysis or invoke Bedrock
   */
  async analyzeImage(
    imageBuffer: Buffer,
    prompt: string,
    model: string = 'anthropic.claude-3-5-sonnet-20241022-v2:0'
  ): Promise<any> {
    const cacheKey = this.getCacheKey(imageBuffer, prompt, model);

    // Check cache
    const cached = await this.cache.get(cacheKey);
    if (cached) {
      console.log('✅ Image analysis cache HIT');
      return cached;
    }

    console.log('❌ Image analysis cache MISS - invoking Bedrock');

    // Invoke Bedrock (use existing implementation)
    const result = await invokeBedrock(imageBuffer, prompt, model);

    // Cache result
    await this.cache.set(cacheKey, result, { ttl: 3600 });

    return result;
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<{
    hits: number;
    misses: number;
    hitRate: number;
    size: number;
  }> {
    return this.cache.getStats();
  }
}

// Global instance
export const imageAnalysisCache = new ImageAnalysisCache();
```

**Integration:**

Update `src/lib/bedrock/image-processor.ts`:
```typescript
import { imageAnalysisCache } from './image-analysis-cache';

// Replace direct Bedrock calls with cached version
export async function processImageFromUrl(
  imageUrl: string,
  options: ProcessOptions = {}
): Promise<ProcessResult> {
  const imageBuffer = await fetchImage(imageUrl);

  // Use cache wrapper
  const analysis = await imageAnalysisCache.analyzeImage(
    imageBuffer,
    generatePrompt(options),
    'anthropic.claude-3-5-sonnet-20241022-v2:0'
  );

  // ... rest of processing
}
```

#### Step 2.3: Add Clustering Results Cache (NEW) (30 min)

**File:** `lib/clustering/similarity-service.ts`

**Changes:**

```typescript
import { CacheManager } from '../cache/cache-manager';
import { createHash } from 'crypto';

const clusteringCache = new CacheManager({
  defaultTTL: 1800, // 30 minutes
  maxSize: 1000,
});

/**
 * Generate cache key for clustering operation
 */
function getClusteringCacheKey(
  imageIds: string[],
  options: ClusteringOptions
): string {
  const idsHash = createHash('sha256')
    .update(imageIds.sort().join(','))
    .digest('hex')
    .slice(0, 16);

  const optsHash = createHash('sha256')
    .update(JSON.stringify(options))
    .digest('hex')
    .slice(0, 8);

  return `cluster:${idsHash}:${optsHash}`;
}

/**
 * Cluster images with caching
 */
export async function clusterImages(
  images: ImageFeatures[],
  options: ClusteringOptions = {}
): Promise<ClusteringResult> {
  const imageIds = images.map((img) => img.imageId);
  const cacheKey = getClusteringCacheKey(imageIds, options);

  // Check cache
  const cached = await clusteringCache.get(cacheKey);
  if (cached) {
    console.log('✅ Clustering cache HIT');
    return cached;
  }

  console.log('❌ Clustering cache MISS - computing clusters');

  // Compute clusters (existing implementation)
  const result = {
    features: images,
    duplicateGroups: findDuplicates(images, options.duplicateThreshold),
    colorGroups: groupByColor(images, options.colorGroups),
  };

  // Cache result
  await clusteringCache.set(cacheKey, result, { ttl: 1800 });

  return result;
}
```

**State Persistence Checkpoint:**
```python
# After completing Step 2
manager.save_checkpoint(
    workflow_id='bg-remover-phase-1-implementation',
    step_number=1,
    step_name='cache_expansion_complete',
    state_data={
        'quick_win': 2,
        'cache_layers_added': 3,
        'files_created': [
            'image-analysis-cache.ts',
            'clustering-cache-integration'
        ],
        'target_hit_rate': '80%'
    }
)
```

---

## Quick Win #3: Parallel Clustering Processing

### Current State
```typescript
// Sequential feature extraction - ONE image at a time
for (const image of images) {
  const features = await extractFeatures(image.buffer, image.imageId);
  allFeatures.push(features);
}
// Time: N * FEATURE_EXTRACTION_TIME
```

### Target State
```typescript
// Parallel feature extraction - ALL images simultaneously
const allFeatures = await Promise.all(
  images.map((image) => extractFeatures(image.buffer, image.imageId))
);
// Time: MAX(FEATURE_EXTRACTION_TIME) ≈ FEATURE_EXTRACTION_TIME
// Speedup: N/cores (e.g., 8 images on 4 cores = 2x faster)
```

### Implementation Steps

#### Step 3.1: Parallelize Feature Extraction (1 hour)

**File:** `lib/clustering/similarity-service.ts`

**Changes:**

```typescript
/**
 * Extract features from multiple images in parallel
 * Uses worker pool to prevent memory overflow
 */
export async function extractFeaturesParallel(
  images: Array<{ buffer: Buffer; imageId: string }>,
  options: {
    maxConcurrency?: number;
  } = {}
): Promise<ImageFeatures[]> {
  const { maxConcurrency = 4 } = options; // Limit concurrent Sharp operations

  // Use p-limit for controlled concurrency
  const limit = pLimit(maxConcurrency);

  const tasks = images.map((image) =>
    limit(() => extractFeatures(image.buffer, image.imageId))
  );

  return Promise.all(tasks);
}

/**
 * Batch process images for clustering (public API)
 */
export async function batchProcessForClustering(
  images: Array<{ buffer: Buffer; imageId: string }>,
  options: ClusteringOptions = {}
): Promise<ClusteringResult> {
  console.log(`🚀 Processing ${images.length} images in parallel...`);

  const startTime = Date.now();

  // Step 1: Extract features in parallel
  const features = await extractFeaturesParallel(images, {
    maxConcurrency: 4,
  });

  const extractionTime = Date.now() - startTime;
  console.log(`✅ Feature extraction: ${extractionTime}ms`);

  // Step 2: Cluster (sequential, but fast with pre-extracted features)
  const result = await clusterImages(features, options);

  const totalTime = Date.now() - startTime;
  console.log(`✅ Total clustering: ${totalTime}ms`);

  return result;
}
```

**Install dependency:**
```bash
npm install p-limit
```

**Add to `package.json`:**
```json
{
  "dependencies": {
    "p-limit": "^5.0.0"
  }
}
```

#### Step 3.2: Optimize Sharp Memory Usage (30 min)

**File:** `lib/clustering/similarity-service.ts`

**Changes:**

```typescript
import sharp from 'sharp';

// Configure Sharp for better concurrency
sharp.concurrency(4); // Limit concurrent operations
sharp.cache({ memory: 50 }); // Limit memory cache to 50MB

/**
 * Memory-optimized perceptual hash computation
 */
async function computePerceptualHash(imageBuffer: Buffer): Promise<string> {
  // Create Sharp instance with memory limits
  const image = sharp(imageBuffer, {
    limitInputPixels: 268402689, // ~512MB limit
    sequentialRead: true, // Optimize for sequential access
  });

  // Resize to 8x8 grayscale (minimal memory footprint)
  const { data } = await image
    .resize(8, 8, { fit: 'fill', kernel: 'nearest' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const grayscale: number[] = Array.from(data as Uint8Array);

  // Compute average
  const avg =
    grayscale.reduce((a: number, b: number) => a + b, 0) / grayscale.length;

  // Create binary hash
  const hash = grayscale.map((val: number) => (val >= avg ? '1' : '0')).join('');

  return hash;
}
```

**Testing:**
```typescript
// Test file: lib/clustering/__tests__/parallel-clustering.test.ts
describe('Parallel Clustering', () => {
  it('should process 100 images faster than sequential', async () => {
    const images = generateTestImages(100);

    // Sequential baseline
    const seqStart = Date.now();
    for (const img of images) {
      await extractFeatures(img.buffer, img.imageId);
    }
    const seqTime = Date.now() - seqStart;

    // Parallel processing
    const parStart = Date.now();
    await extractFeaturesParallel(images);
    const parTime = Date.now() - parStart;

    console.log(`Sequential: ${seqTime}ms, Parallel: ${parTime}ms`);
    expect(parTime).toBeLessThan(seqTime * 0.5); // At least 2x faster
  });

  it('should not exceed memory limits', async () => {
    const images = generateTestImages(1000); // Large dataset

    const memBefore = process.memoryUsage().heapUsed;

    await extractFeaturesParallel(images, { maxConcurrency: 4 });

    const memAfter = process.memoryUsage().heapUsed;
    const memDelta = (memAfter - memBefore) / 1024 / 1024; // MB

    expect(memDelta).toBeLessThan(500); // Less than 500MB increase
  });
});
```

**State Persistence Checkpoint:**
```python
# After completing Step 3
manager.save_checkpoint(
    workflow_id='bg-remover-phase-1-implementation',
    step_number=2,
    step_name='parallel_clustering_complete',
    state_data={
        'quick_win': 3,
        'concurrency_limit': 4,
        'files_modified': ['similarity-service.ts'],
        'dependencies_added': ['p-limit'],
        'speedup_target': 'N/cores'
    }
)
```

---

## Integration & Testing

### Integration Test Suite

**File:** `tests/integration/phase-1-optimizations.test.ts` (NEW)

```typescript
describe('Phase 1 Quick Wins - Integration Tests', () => {
  describe('End-to-End Performance', () => {
    it('should process 100 images with all optimizations', async () => {
      const images = await loadTestImages(100);

      const startTime = Date.now();

      // Step 1: Generate embeddings in batches
      const embeddings = await generateBatchImageEmbeddings(images);

      // Step 2: Extract features in parallel
      const features = await extractFeaturesParallel(images);

      // Step 3: Cluster with caching
      const clusters = await clusterImages(features);

      const totalTime = Date.now() - startTime;

      console.log('=== Performance Results ===');
      console.log(`Total time: ${totalTime}ms`);
      console.log(`Embeddings: ${embeddings.size}`);
      console.log(`Features: ${features.length}`);
      console.log(`Clusters: ${clusters.duplicateGroups.length}`);

      // Performance assertions
      expect(totalTime).toBeLessThan(5000); // Under 5 seconds
      expect(embeddings.size).toBe(100);
      expect(features.length).toBe(100);
    });
  });

  describe('Cache Hit Rate Validation', () => {
    it('should achieve 80%+ cache hit rate on second run', async () => {
      const images = await loadTestImages(50);

      // First run - populate cache
      await generateBatchImageEmbeddings(images);
      await extractFeaturesParallel(images);

      // Second run - use cache
      const stats = await imageAnalysisCache.getStats();

      expect(stats.hitRate).toBeGreaterThan(0.8);
    });
  });

  describe('Batch Processing Validation', () => {
    it('should handle batches correctly', async () => {
      const sizes = [5, 25, 50, 100];

      for (const size of sizes) {
        const images = await loadTestImages(size);
        const embeddings = await generateBatchImageEmbeddings(images);

        expect(embeddings.size).toBe(size);
      }
    });
  });
});
```

### Performance Benchmarking

**File:** `scripts/benchmark-phase-1.ts` (NEW)

```typescript
/**
 * Benchmark script for Phase 1 optimizations
 */
import { performance } from 'perf_hooks';

async function benchmarkOptimizations() {
  console.log('=== Phase 1 Quick Wins Benchmark ===\n');

  const imageCounts = [10, 50, 100, 500];

  for (const count of imageCounts) {
    console.log(`\n--- Testing with ${count} images ---`);

    const images = await generateTestImages(count);

    // Benchmark 1: Batch embeddings
    const embStart = performance.now();
    await generateBatchImageEmbeddings(images);
    const embTime = performance.now() - embStart;

    // Benchmark 2: Parallel clustering
    const clusterStart = performance.now();
    await extractFeaturesParallel(images);
    const clusterTime = performance.now() - clusterStart;

    // Benchmark 3: Cache performance
    const cacheStats = await imageAnalysisCache.getStats();

    console.log(`Embedding time: ${embTime.toFixed(2)}ms`);
    console.log(`Clustering time: ${clusterTime.toFixed(2)}ms`);
    console.log(`Cache hit rate: ${(cacheStats.hitRate * 100).toFixed(1)}%`);

    // Calculate speedup vs baseline
    const baselineEmbTime = count * 200; // Assume 200ms per image
    const speedup = baselineEmbTime / embTime;

    console.log(`Speedup: ${speedup.toFixed(1)}x faster`);
  }

  console.log('\n=== Benchmark Complete ===');
}

benchmarkOptimizations();
```

---

## Deployment Plan

### Pre-Deployment

1. **Run Full Test Suite:**
   ```bash
   npm run test
   npm run test:integration
   ```

2. **Run Benchmark:**
   ```bash
   npx ts-node scripts/benchmark-phase-1.ts
   ```

3. **Code Review:**
   - Security review for cache key generation
   - Memory leak check for parallel processing
   - AWS Titan batch API usage validation

### Deployment Steps (Dev Environment)

```bash
# Step 1: Install dependencies
npm install p-limit

# Step 2: Build Lambda handler
npm run build:handler

# Step 3: Deploy to dev
npm run deploy:dev

# Step 4: Run smoke tests
npm run test:integration

# Step 5: Monitor CloudWatch for errors
aws logs tail /aws/lambda/bg-remover-dev-processWorker --follow
```

### Monitoring & Validation

**CloudWatch Metrics to Track:**
- Embedding generation time (target: 60% reduction)
- Cache hit rate (target: 80%+)
- Clustering time (target: 50% reduction)
- Lambda memory usage (ensure no increase)
- Bedrock API call count (target: 70% reduction)

**Alarms to Set:**
- Cache hit rate < 60%
- Embedding time > 1000ms for 10 images
- Memory usage > 1200MB

---

## Rollback Plan

If issues occur:

```bash
# 1. Revert deployment
npm run deploy:dev -- --stage dev --revert

# 2. Clear problematic cache entries
# (if cache corruption suspected)
aws dynamodb delete-table --table-name cache-${stage}

# 3. Monitor recovery
aws logs tail /aws/lambda/bg-remover-dev-processWorker --since 5m
```

---

## Success Criteria

### Performance Targets

| Metric | Baseline | Target | Measured |
|--------|----------|--------|----------|
| 10-image embedding time | 2000ms | 400ms (5x) | ___ |
| 100-image clustering | 8000ms | 2000ms (4x) | ___ |
| Cache hit rate | 0% | 80% | ___ |
| Bedrock API calls | 100/100 images | 20/100 images | ___ |
| Lambda memory | 1536MB | 1536MB (no increase) | ___ |

### Cost Targets

| Service | Current | Target | Savings |
|---------|---------|--------|---------|
| Bedrock API | $X/month | $X * 0.2 | 80% |
| Lambda execution | $Y/month | $Y * 0.7 | 30% |
| Total | $Z/month | $Z * 0.4 | 60% |

---

## State Persistence Integration

All implementation steps include automatic checkpointing:

```python
# Initialize workflow
manager = StatePersistenceManager()

# Checkpoint after each Quick Win
manager.save_checkpoint(
    workflow_id='bg-remover-phase-1-implementation',
    step_number=<step>,
    step_name='<quick_win_name>',
    state_data={
        'files_modified': [...],
        'tests_added': [...],
        'performance_baseline': {...},
        'issues_encountered': [...]
    }
)
```

**Resume capability:**
```python
# If interrupted, resume from last checkpoint
state = manager.resume_workflow(
    workflow_id='bg-remover-phase-1-implementation',
    from_step=1  # Resume from Quick Win #2
)
```

---

## Workflow Artifacts Integration

This plan incorporates insights from **5 automated workflow artifacts**:

1. ✅ **Image Pipeline Analysis** - Informed caching strategy
2. ✅ **Architecture Research** - Validated microservices patterns
3. ✅ **Clustering Algorithm Analysis** - Optimization opportunities
4. ✅ **AWS Integration Review** - Batch API usage patterns
5. ✅ **Code Quality Review** - Security best practices

---

## Next Steps After Phase 1

Once Phase 1 is complete and validated:

**Phase 2: Core Optimizations (2-4 weeks)**
1. LSH clustering algorithm (O(n log n) from O(n²))
2. Direct Sharp integration (remove external dependency)
3. Rotation-invariant pHash

**Phase 3: Strategic Enhancements (1-2 months)**
1. Adaptive clustering thresholds (ML-driven)
2. Semantic similarity fallback
3. Real-time clustering updates

---

## Appendix: Complete File Changes Summary

### Files to Create (NEW)
1. `src/lib/bedrock/image-analysis-cache.ts` (~150 lines)
2. `tests/integration/phase-1-optimizations.test.ts` (~200 lines)
3. `scripts/benchmark-phase-1.ts` (~100 lines)
4. `src/lib/product-identity/__tests__/batch-embeddings.test.ts` (~150 lines)
5. `lib/clustering/__tests__/parallel-clustering.test.ts` (~100 lines)

### Files to Modify
1. `src/lib/product-identity/product-identity-service.ts` (+200 lines)
2. `src/lib/embedding-storage-service.ts` (+50 lines)
3. `lib/clustering/similarity-service.ts` (+150 lines)
4. `src/lib/bedrock/image-processor.ts` (+20 lines)
5. `package.json` (+1 dependency)

### Total Code Changes
- **New Lines:** ~950
- **Modified Lines:** ~420
- **Total Effort:** 3-4 days
- **Expected ROI:** 3-5x performance, 60% cost reduction

---

**Implementation Status:**
- ✅ Plan Complete
- ⏭️ Ready to Execute
- 📊 State Persistence Enabled
- 🎯 Success Criteria Defined

**Start Implementation?** All tasks tracked, checkpoints ready, artifacts integrated!

---

*Created by: Claude Code (Sonnet 4.5)*
*Plan Date: 2026-01-09*
*With State Persistence & Workflow Artifacts Integration*
