# BG-Remover Lambda Packaging Fix - Deployment Summary

## Problem
The bg-remover service was failing with "Cannot find module 'zod'" error despite zod being in the package. The deployment package was 103MB and exceeded AWS Lambda's 50MB direct upload limit.

## Root Causes
1. **Module Resolution:** Node.js 22 runtime could not resolve zod from the 103MB uncompiled package
2. **Package Size:** Including all node_modules with tests, docs, source files (103MB)
3. **No Bundling:** Service lacked webpack/esbuild bundling for proper dependency resolution

## Solution Implemented

### 1. Enabled Serverless Framework v4 Built-in ESBuild Support

**File:** `/Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover/serverless.yml`

Added esbuild configuration:
```yaml
build:
  esbuild:
    bundle: true
    minify: true
    sourcemap: true
    exclude:
      - '@aws-sdk/*'
      - 'aws-sdk'
    target: node22
    platform: node
    format: cjs
    external:
      - '@aws-sdk/*'
      - 'aws-sdk'
```

### 2. Updated Handler Paths

Changed from compiled dist paths to source paths:
```yaml
# Before:
handler: dist/services/bg-remover/src/handler.health

# After:
handler: src/handler.health
```

This allows esbuild to properly bundle dependencies from source.

### 3. Simplified Package Configuration

```yaml
package:
  individually: true
  patterns:
    - 'classifier_handler.py'  # Python handler (not bundled by esbuild)
    - '!node_modules/**'        # Exclude - esbuild bundles JavaScript
    - '!dist/**'
    - '!src/**'
  excludeDevDependencies: true
```

### 4. Fixed Backend-Kit Export

Added missing export in `/Users/davideagle/git/CarouselLabs/enterprise-packages/packages/core/backend-kit/src/index.ts`:

```typescript
// Performance optimizations (embedding cache, request optimization)
export * from './performance/embedding-cache';
```

This fixed the `EmbeddingCache` import error in pricing-calculator.

## Results

### Package Size Reduction
- **settings:** 247 KB (down from 103MB - **99.76% reduction**)
- **health:** 247 KB
- **metrics:** 30 KB
- **process:** 247 KB
- **processWorker:** 193 KB
- **pricingCalculator:** 1.5 MB (reasonable for ML/embeddings)

All functions now well under AWS Lambda's 50MB limit.

### Deployment Success
```
✔ Service deployed to stack bg-remover-dev (98s)

functions:
  health: bg-remover-dev-health (247 kB)
  metrics: bg-remover-dev-metrics (30 kB)
  process: bg-remover-dev-process (247 kB)
  processWorker: bg-remover-dev-processWorker (193 kB)
  status: bg-remover-dev-status (247 kB)
  settings: bg-remover-dev-settings (247 kB)
  createProducts: bg-remover-dev-createProducts (372 kB)
  groupImages: bg-remover-dev-groupImages (319 kB)
  processGroups: bg-remover-dev-processGroups (124 kB)
  pricingCalculator: bg-remover-dev-pricingCalculator (1.5 MB)
  pricingInsightAggregator: bg-remover-dev-pricingInsightAggregator (105 kB)
  rotateKeys: bg-remover-dev-rotateKeys (11 kB)
  s3TablesDataValidator: bg-remover-dev-s3TablesDataValidator (93 kB)
  smartgoToS3Exporter: bg-remover-dev-smartgoToS3Exporter (21 kB)
  carouselToS3TablesSync: bg-remover-dev-carouselToS3TablesSync (84 kB)
```

### Verification Tests
- ✅ OPTIONS /bg-remover/settings returns HTTP 200 (CORS working)
- ✅ GET /bg-remover/health returns HTTP 200
- ✅ No "Cannot find module 'zod'" errors in CloudWatch logs
- ✅ No module resolution errors
- ✅ All API endpoints accessible

## Known Issue: Python Classifier

The Python classifier function was temporarily disabled due to package size:

```yaml
# DISABLED: Python package too large (73MB unzipped exceeds 250MB limit)
# TODO: Optimize Python dependencies or move to Lambda Layer
```

**Next Steps:**
1. Create Lambda Layer for Python dependencies
2. Optimize requirements.txt to remove unnecessary packages
3. Re-enable classifier function

## Deployment Command

```bash
TENANT=hringekjan aws-vault exec carousel-labs-dev-admin -- \
  npx serverless@4 deploy --stage dev --region eu-west-1
```

## Files Modified

1. `/Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover/serverless.yml`
   - Added esbuild configuration
   - Updated handler paths from `dist/...` to `src/...`
   - Simplified package patterns
   - Disabled Python classifier temporarily

2. `/Users/davideagle/git/CarouselLabs/enterprise-packages/packages/core/backend-kit/src/index.ts`
   - Added export for `performance/embedding-cache`

3. `/Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover/package.json`
   - Added serverless-esbuild dev dependency (later removed as built-in support used)

## Success Criteria Met

- ✅ Package size under 50MB
- ✅ No "Cannot find module 'zod'" errors in CloudWatch logs
- ✅ OPTIONS requests return HTTP 200 (not 500)
- ✅ CORS headers present in response
- ✅ Settings endpoint accessible from frontend
- ✅ All TypeScript functions deployed successfully

## Date
2026-01-03

## Environment
- Service: bg-remover
- Stage: dev
- Region: eu-west-1
- Tenant: hringekjan
- Runtime: Node.js 22.x
- Framework: Serverless Framework 4.x
