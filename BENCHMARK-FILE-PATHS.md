# bg-remover Performance Benchmarking - File Paths Reference

**Purpose:** Quick reference for all file paths needed for end-to-end integration testing and performance benchmarking.

**Date:** 2026-01-10

---

## 1. New Optimization Modules (Quick Wins)

### Quick Win #1: Batch Embedding Generation
```
/Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover/src/lib/product-identity/batch-embeddings.ts
```
- **Lines:** 367
- **Key Functions:** `generateBatchImageEmbeddings()`, `generateSingleImageEmbedding()`
- **Test Coverage:** 17/17 ✅

### Quick Win #2: Multi-Level Caching
```
/Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover/src/lib/product-identity/image-analysis-cache.ts
```
- **Lines:** 390
- **Key Classes:** `ImageAnalysisCache`
- **Exports:** `embeddingCache`, `analysisCache`, `clusteringCache`
- **Test Coverage:** 21/21 ✅

### Quick Win #3: Parallel Clustering
```
/Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover/src/lib/product-identity/parallel-clustering.ts
```
- **Lines:** 293
- **Key Functions:** `processParallel()`, `clusterImagesParallel()`, `extractFeaturesParallel()`
- **Test Coverage:** 18/18 ✅

---

## 2. Modified Core Service File

### Product Identity Service (Integrated with Quick Wins)
```
/Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover/src/lib/product-identity/product-identity-service.ts
```
- **Lines:** 850
- **Modified Functions:**
  - `batchProcessForGrouping()` - Lines 548-621 (uses batch embeddings)
  - `batchProcessWithMultiSignal()` - Lines 685-846 (uses batch embeddings)
- **Key Baseline Functions (for comparison):**
  - `generateImageEmbedding()` - Line 108 (original sequential)
  - `cosineSimilarity()` - Line 159
  - `clusterBySimilarity()` - Line 628 (original sequential)

---

## 3. Related Core Files

### Multi-Signal Similarity (Feature Extraction)
```
/Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover/src/lib/product-identity/multi-signal-similarity.ts
```
- **Purpose:** Feature extraction for clustering
- **Relevant for:** Parallel processing benchmarks

### Settings Loader
```
/Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover/src/lib/product-identity/settings-loader.ts
```
- **Purpose:** Configuration management
- **Relevant for:** Threshold and cache settings

### Index Export
```
/Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover/src/lib/product-identity/index.ts
```
- **Purpose:** Public API exports

---

## 4. API Endpoints (Integration Testing)

### Batch Processing Endpoint
```
/Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover/app/api/batch/route.ts
```
- **Purpose:** Batch image processing API
- **Benchmark:** Compare before/after optimization
- **Expected Improvement:** 5-10x faster

### Clustering Endpoint
```
/Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover/app/api/cluster/route.ts
```
- **Purpose:** Image clustering API
- **Benchmark:** Test parallel clustering performance
- **Expected Improvement:** 4x faster

### Create Products Endpoint
```
/Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover/app/api/create-products/route.ts
```
- **Purpose:** Product creation with embeddings
- **Benchmark:** Test batch embedding + caching
- **Expected Improvement:** 3-5x faster (first run), 50x faster (cached)

### Process Endpoint
```
/Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover/app/api/process/route.ts
```
- **Purpose:** Single image processing
- **Benchmark:** Cache hit/miss performance

### Status Endpoint
```
/Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover/app/api/status/[jobId]/route.ts
```
- **Purpose:** Job status tracking
- **Monitoring:** Track processing times

---

## 5. Lambda Handlers (Serverless Functions)

### Main Handler
```
/Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover/src/handler.ts
```
- **Purpose:** Lambda entry point
- **Benchmark:** Cold start vs. warm start with cache

### Create Products Handler
```
/Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover/src/handlers/create-products-handler.ts
```
- **Purpose:** Serverless product creation
- **Benchmark:** End-to-end latency

### Group Images Handler
```
/Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover/src/handlers/group-images-handler.ts
```
- **Purpose:** Image grouping/clustering
- **Benchmark:** Clustering performance with real data

---

## 6. Unit Test Files

### Batch Embeddings Tests
```
/Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover/src/lib/product-identity/__tests__/batch-embeddings.test.ts
```
- **Tests:** 17
- **Coverage:** Batch processing, error handling, performance

### Cache Tests
```
/Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover/src/lib/product-identity/__tests__/image-analysis-cache.test.ts
```
- **Tests:** 21
- **Coverage:** Caching, TTL, eviction, statistics

### Parallel Clustering Tests
```
/Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover/src/lib/product-identity/__tests__/parallel-clustering.test.ts
```
- **Tests:** 18
- **Coverage:** Concurrency, clustering, performance

### Existing Product Identity Tests (Baseline)
```
/Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover/tests/product-identity.test.ts
```
- **Purpose:** Original test suite for comparison

---

## 7. Configuration Files

### Serverless Configuration
```
/Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover/serverless.yml
```
- **Relevant Sections:**
  - Lambda memory/timeout settings
  - Environment variables
  - AWS resource configuration

### Package Configuration
```
/Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover/package.json
```
- **Dependencies:** Check for any new dependencies needed
- **Scripts:** Test and build commands

### TypeScript Configuration
```
/Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover/tsconfig.json
```
- **Compiler options:** Ensure proper build settings

---

## 8. Benchmark Test Data Locations

### Sample Images for Testing
```
/Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover/tests/fixtures/
```
- **Create test datasets:** 10, 25, 50, 100, 250 images
- **Image sizes:** Small (100KB), Medium (500KB), Large (2MB)

### Performance Test Results (To Be Created)
```
/Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover/benchmarks/
```
- `baseline-performance.json` - Performance without optimizations
- `optimized-performance.json` - Performance with all Quick Wins
- `comparison-report.md` - Detailed comparison report

---

## 9. Documentation Files

### Implementation Summary
```
/Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover/BG-REMOVER-QUICK-WINS-IMPLEMENTATION-COMPLETE.md
```
- **Purpose:** Complete implementation summary
- **Content:** Performance targets, test results, next steps

### Comprehensive Analysis
```
/Users/davideagle/git/CarouselLabs/enterprise-packages/BG-REMOVER-COMPREHENSIVE-ANALYSIS-2026-01-09.md
```
- **Purpose:** Original analysis and optimization roadmap
- **Content:** Performance bottlenecks, recommendations

### Phase 1 Implementation Plan
```
/Users/davideagle/git/CarouselLabs/enterprise-packages/BG-REMOVER-PHASE-1-IMPLEMENTATION-PLAN.md
```
- **Purpose:** Detailed implementation guide
- **Content:** Code snippets, test cases, deployment steps

---

## 10. Benchmark Script Template

### Create Benchmark Script
```bash
# Location: /Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover/scripts/benchmark.ts

import { generateImageEmbedding, batchProcessForGrouping } from '../src/lib/product-identity/product-identity-service';
import { generateBatchImageEmbeddings } from '../src/lib/product-identity/batch-embeddings';
import { clusterImagesParallel } from '../src/lib/product-identity/parallel-clustering';

// Test datasets
const testSizes = [10, 25, 50, 100];

// Benchmark functions
async function benchmarkBaseline(images) { /* ... */ }
async function benchmarkOptimized(images) { /* ... */ }
async function comparePerformance() { /* ... */ }
```

---

## Performance Benchmarking Workflow

### Step 1: Baseline Measurement
```bash
# Run original code (before optimizations)
cd /Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover

# Test with 25 images (baseline)
npm run benchmark:baseline

# Expected results:
# - Embedding generation: ~12,500ms (25 × 500ms)
# - Clustering: ~30,000ms
```

### Step 2: Optimized Measurement
```bash
# Run optimized code (with all Quick Wins)
npm run benchmark:optimized

# Expected results:
# - Embedding generation: ~2,500ms (3-5x faster)
# - Clustering: ~7,500ms (4x faster)
# - Cached operations: ~200ms (50x faster)
```

### Step 3: Generate Comparison Report
```bash
npm run benchmark:compare

# Output: benchmarks/comparison-report.md
```

---

## Key Performance Indicators (KPIs)

### Metrics to Track

1. **Embedding Generation Time**
   - Baseline: ~500ms per image
   - Optimized (batch): ~100ms per image
   - Optimized (cached): ~10ms per image

2. **Clustering Time**
   - Baseline (100 images): ~267,500ms (4.5 min)
   - Optimized (parallel): ~66,875ms (1.1 min)

3. **Cache Hit Rate**
   - Target: >80%
   - Measure: CloudWatch custom metrics

4. **Cost Reduction**
   - Baseline: 100 API calls
   - Optimized: 20 API calls (80% cached)
   - Savings: 60%

5. **End-to-End Latency**
   - Baseline: ~15 seconds (10 images)
   - Optimized: ~3 seconds (10 images, first run)
   - Optimized: ~0.3 seconds (10 images, cached)

---

## Git Comparison Commands

### Compare Modified Files
```bash
# See changes to product-identity-service.ts
git diff HEAD -- src/lib/product-identity/product-identity-service.ts

# See all new files
git status --short

# View file history
git log --oneline -- src/lib/product-identity/
```

### Create Baseline Branch (if needed)
```bash
# Create branch before optimizations for comparison
git checkout -b baseline-before-quick-wins HEAD~1

# Switch back to optimized version
git checkout develop
```

---

## Quick Reference Commands

### Run All Tests
```bash
cd /Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover

# Run all Quick Wins tests
npx jest src/lib/product-identity/__tests__/batch-embeddings.test.ts
npx jest src/lib/product-identity/__tests__/image-analysis-cache.test.ts
npx jest src/lib/product-identity/__tests__/parallel-clustering.test.ts

# Run all product-identity tests
npx jest src/lib/product-identity/__tests__/

# Generate coverage report
npx jest --coverage
```

### View Test Coverage
```bash
# Open coverage report
open coverage/lcov-report/index.html
```

### Deploy for Testing
```bash
# Deploy to dev environment
npm run deploy:dev

# Test deployed endpoints
curl -X POST https://dev-api.example.com/api/batch \
  -H "Content-Type: application/json" \
  -d '{"images": [...]}' \
  -w "\nTime: %{time_total}s\n"
```

---

## Monitoring & Observability

### CloudWatch Metrics Paths
```
# Cache hit rate
/aws/lambda/bg-remover-dev/cache/hit-rate

# Embedding generation time
/aws/lambda/bg-remover-dev/embeddings/generation-time

# Clustering time
/aws/lambda/bg-remover-dev/clustering/duration
```

### Log Groups
```
/aws/lambda/bg-remover-dev-batch-processor
/aws/lambda/bg-remover-dev-cluster-processor
```

---

## Summary

**Total Files Created:** 6
- 3 optimization modules (1,050 lines)
- 3 test suites (1,288 lines)

**Total Files Modified:** 1
- product-identity-service.ts (3 integration points)

**All file paths are absolute** and ready for copy-paste into benchmark scripts.

**Next Action:** Create `scripts/benchmark.ts` using the template above to run comparative performance tests.
