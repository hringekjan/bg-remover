# Background Remover Service

A TypeScript microservice for automatically removing backgrounds from images using AWS Bedrock AI models.

## Purpose

This service processes images to remove backgrounds and generate bilingual product descriptions (English + Icelandic) for e-commerce/consignment store workflows.

## Features

- **AI-Powered Background Removal**: Uses Amazon Nova Canvas via AWS Bedrock
- **Bilingual Product Descriptions**: Generates descriptions in English and Icelandic
  - English: Generated using Mistral Pixtral Large vision model
  - Icelandic: Translated using OpenAI GPT-OSS Safeguard 20B via Bedrock
- **Image Enhancements**: Auto-trim, center subject, color enhancement using Sharp
- **Multiple Input Sources**: URL, base64, or file upload
- **Batch Processing**: Process multiple images concurrently

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     bg-remover Service                          │
├─────────────────────────────────────────────────────────────────┤
│  API Routes                                                     │
│  ├── /api/process     - Single image processing                │
│  ├── /api/batch       - Batch image processing                 │
│  ├── /api/status/:id  - Job status                             │
│  └── /api/health      - Health check                           │
├─────────────────────────────────────────────────────────────────┤
│  Bedrock Integration (lib/bedrock/)                            │
│  ├── client.ts        - Bedrock API client                     │
│  │   ├── removeBackgroundWithNovaCanvas()                      │
│  │   ├── generateProductDescription()  [Mistral Pixtral]       │
│  │   ├── translateToIcelandic()        [GPT-OSS Safeguard]     │
│  │   └── generateBilingualProductDescription()                 │
│  └── image-processor.ts - Processing pipeline                  │
├─────────────────────────────────────────────────────────────────┤
│  AWS Bedrock Models                                            │
│  ├── amazon.nova-canvas-v1:0         - Background removal      │
│  ├── us.mistral.pixtral-large-2502-v1:0 - Vision/description  │
│  └── openai.gpt-oss-safeguard-20b    - Icelandic translation  │
└─────────────────────────────────────────────────────────────────┘
```

## Quick Start

```bash
# Install dependencies
npm install

# Build the project
npm run build

# Run development server
npm run dev

# Run tests
npm test
```

## API Usage

### Process Single Image

```bash
curl -X POST http://localhost:3000/api/process \
  -H "Content-Type: application/json" \
  -d '{
    "imageUrl": "https://example.com/image.jpg",
    "generateDescription": true,
    "productName": "Blue Cotton Shirt"
  }'
```

### Response Format

```json
{
  "success": true,
  "jobId": "uuid",
  "outputUrl": "s3://bucket/processed/image.png",
  "processingTimeMs": 1234,
  "metadata": {
    "originalSize": 102400,
    "processedSize": 51200,
    "width": 1024,
    "height": 1024
  },
  "bilingualDescription": {
    "en": {
      "description": "A classic blue cotton button-up shirt with a relaxed fit.",
      "category": "Shirt",
      "color": "Blue",
      "features": ["Button-up", "Cotton", "Relaxed fit"],
      "condition": "Like New"
    },
    "is": {
      "description": "Klassísk blá bómullarskyrta með hnöppum og rúmgóðu sniði.",
      "category": "Skyrta",
      "color": "Blár",
      "features": ["Hnappaskyrta", "Bómull", "Rúmgott snið"],
      "condition": "Eins og nýtt"
    }
  }
}
```

## Configuration

### Environment Variables

```bash
# AWS Region for Bedrock
AWS_REGION=us-east-1

# S3 Configuration
S3_INPUT_BUCKET=bg-remover-input
S3_OUTPUT_BUCKET=bg-remover-output

# Processing defaults
MAX_IMAGE_SIZE_MB=10
DEFAULT_OUTPUT_FORMAT=png
DEFAULT_QUALITY=95
```

### SSM Parameter Paths

```
/tf/{stage}/{tenant}/services/bg-remover/config
/tf/{stage}/{tenant}/services/bg-remover/secrets
```

## Models Used

| Model | Purpose | Model ID |
|-------|---------|----------|
| Amazon Nova Canvas | Background removal | `amazon.nova-canvas-v1:0` |
| Mistral Pixtral Large | Vision analysis & English descriptions | `us.mistral.pixtral-large-2502-v1:0` |
| OpenAI GPT-OSS Safeguard 20B | Icelandic translation | `openai.gpt-oss-safeguard-20b` |
| Claude 3.5 Sonnet | Image analysis (optional) | `anthropic.claude-3-5-sonnet-20241022-v2:0` |

## Processing Options

```typescript
interface ImageProcessingOptions {
  format: 'png' | 'webp' | 'jpeg';
  quality: number;                // 1-100
  autoTrim?: boolean;             // Remove whitespace
  centerSubject?: boolean;        // Center and crop
  enhanceColors?: boolean;        // Boost saturation
  targetSize?: {                  // Resize
    width: number;
    height: number;
  };
  generateDescription?: boolean;  // Generate bilingual description
  productName?: string;           // Hint for description
}
```

## Development

```bash
# Type checking
npm run type-check

# Linting
npm run lint

# Build
npm run build
```

## Deployment

```bash
# Deploy to dev
TENANT=carousel-labs ./deploy.sh

# Deploy to production
TENANT=carousel-labs ./deploy.sh production
```

## Cache Architecture

The service implements a **two-layer caching system** for JWT validation and other frequently accessed data:

```
┌──────────────────────────────────────────────────────────┐
│                   Cache Architecture                     │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  ┌─────────────┐                                        │
│  │   Request   │                                        │
│  └──────┬──────┘                                        │
│         │                                                │
│         v                                                │
│  ┌─────────────────────────────────────┐                │
│  │  L1: In-Memory Cache (Map)          │  ← Fastest     │
│  │  ─ TTL: 5 minutes (default)         │    < 1ms       │
│  │  ─ Max: 1000 entries (LRU eviction) │                │
│  │  ─ Hit tracking for eviction score  │                │
│  └────────────┬────────────────────────┘                │
│               │ Cache Miss                               │
│               v                                          │
│  ┌─────────────────────────────────────┐                │
│  │  L2: Cache Service (HTTP)           │  ← Distributed │
│  │  ─ TTL: 1 hour (default)            │    ~10-50ms    │
│  │  ─ Circuit breaker for reliability  │                │
│  │  ─ Retry logic with backoff         │                │
│  │  ─ Per-tenant isolation              │                │
│  └─────────────────────────────────────┘                │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### L1: Memory Cache
- **Storage**: In-process Map (fastest)
- **TTL**: 5 minutes (configurable via `memoryTtl`)
- **Eviction**: LRU with weighted scoring (age - hit bonus)
- **Max Size**: 1000 entries (configurable via `maxMemoryEntries`)
- **Use Cases**: JWT validation, frequently accessed config

### L2: Cache Service
- **Storage**: Distributed HTTP cache service
- **TTL**: 1 hour (configurable via `cacheServiceTtl`)
- **Resilience**: Circuit breaker, retry logic, timeout handling
- **Tenant Isolation**: Separate cache namespaces per tenant
- **Use Cases**: Shared data across Lambda invocations

### Multi-Tenant Isolation

Each tenant gets its own cache manager instance to prevent data mixing:

```typescript
// Per-tenant cache managers
const globalCacheManagers: Map<string, CacheManager> = new Map();

// Isolated cache for each tenant
getCacheManager({ tenantId: 'carousel-labs' });
getCacheManager({ tenantId: 'hringekjan' });
```

## Security Considerations

### JWT Token Hashing (HMAC-SHA256)

**Critical Security Feature**: JWT tokens are hashed using HMAC-SHA256 before caching to prevent cache poisoning attacks.

```typescript
// SECURE: HMAC with secret key
const tokenHash = createHmac('sha256', CACHE_KEY_SECRET)
  .update(token)
  .digest('hex');

// Cache key uses full 64-char hash (not substring)
const cacheKey = `jwt-validation-${tokenHash}`;
```

**Why HMAC?**
- Plain SHA-256 allows attackers to generate hash collisions
- HMAC requires secret key, making collision attacks infeasible
- Full 64-char hash provides maximum collision resistance

**Configuration**:
```bash
# SSM Parameter (per-tenant SecureString)
/tf/dev/carousel-labs/services/bg-remover/cache-key-secret
/tf/dev/hringekjan/services/bg-remover/cache-key-secret
/tf/prod/carousel-labs/services/bg-remover/cache-key-secret
/tf/prod/hringekjan/services/bg-remover/cache-key-secret
```

### Tenant ID Validation

All tenant IDs are validated to prevent header injection attacks:

```typescript
// Validation rules:
// - Format: [a-z0-9-]+ (lowercase alphanumeric + hyphens only)
// - Length: 1-63 characters (DNS-style limit)
// - No leading/trailing hyphens
// - No uppercase letters or special characters
```

### Circuit Breaker Protection

Protects against cascading failures when cache service is unavailable:

```
States:
  CLOSED    → Normal operation (all requests allowed)
  OPEN      → Service unavailable (block all requests)
  HALF_OPEN → Testing recovery (allow 1 request only)

Thresholds:
  failureThreshold: 3  (CLOSED → OPEN after 3 failures)
  successThreshold: 2  (HALF_OPEN → CLOSED after 2 successes)
  timeout: 30000ms     (OPEN → HALF_OPEN after 30 seconds)
```

**Race Condition Fix**: Only ONE request allowed in HALF_OPEN state to prevent thundering herd during service recovery.

## Monitoring & Observability

### CloudWatch Metrics

The cache layer emits CloudWatch Embedded Metric Format (EMF) for monitoring:

**Metrics**:
- `CacheWriteSuccess` - Successful L2 cache writes
- `CacheWriteFailure` - Failed L2 cache writes (non-retryable errors)
- `CacheWriteException` - L2 cache write exceptions (network/timeout)

**Dimensions**:
- `tenant` - Tenant ID (carousel-labs, hringekjan, etc.)
- `layer` - Cache layer (L1, L2)

**Example Query** (CloudWatch Logs Insights):
```
fields @timestamp, tenant, layer, CacheWriteFailure, CacheWriteSuccess
| filter service = "cache"
| stats sum(CacheWriteFailure) as failures, sum(CacheWriteSuccess) as successes by tenant, layer
```

### CloudWatch Alarms

Two alarms monitor cache health:

1. **Cache Write Failure Alarm**
   - Triggers when > 10 failures in 10 minutes
   - Indicates persistent L2 cache issues

2. **Cache Write Exception Alarm**
   - Triggers on any exception (network/timeout)
   - Indicates immediate cache service connectivity issues

**See [CLOUDWATCH_ALARMS.md](./CLOUDWATCH_ALARMS.md)** for complete alarm configuration, thresholds, response procedures, and testing instructions.

### Health Check

The `/bg-remover/health` endpoint includes cache statistics:

```json
{
  "status": "healthy",
  "checks": [
    {
      "name": "cache",
      "status": "pass",
      "message": "Memory: 237 entries, Cache Service: available (closed)",
      "details": {
        "tenantManagers": 2,
        "cacheServiceAvailable": true,
        "circuitBreakerState": "closed"
      }
    }
  ]
}
```

## Troubleshooting

### Circuit Breaker States

**CLOSED (Normal)**:
- All cache requests allowed
- Failures counted toward threshold

**OPEN (Service Down)**:
- All cache requests blocked immediately
- Returns cached error without attempting request
- Automatically transitions to HALF_OPEN after timeout

**HALF_OPEN (Testing Recovery)**:
- Only 1 test request allowed (others blocked)
- Success → CLOSED, Failure → OPEN
- Prevents thundering herd on recovery

### Common Issues

#### High Cache Miss Rate
```bash
# Symptoms: Increased latency, higher Bedrock costs
# Check: Memory cache size vs. entry count
curl https://api.dev.carousellabs.co/bg-remover/health | jq '.checks[] | select(.name == "cache")'

# Solution: Increase maxMemoryEntries or memoryTtl
```

#### Circuit Breaker Stuck OPEN
```bash
# Symptoms: "Circuit breaker open" errors in logs
# Check: Circuit breaker state and last failure time
# Solution:
#   1. Verify cache service is healthy
#   2. Wait for timeout (30 seconds default)
#   3. Manual reset via Lambda environment variable (FORCE_CACHE_RESET=true)
```

#### Cache Write Failures
```bash
# Symptoms: CacheWriteFailure metrics, degraded performance
# Check: CloudWatch Logs for cache service errors
# Query: fields @message | filter @message like /Cache service storage failed/

# Common causes:
#   - Cache service unavailable
#   - Network timeout
#   - Invalid tenant ID
#   - Key format validation failure
```

#### Memory Cache Evictions
```bash
# Symptoms: Unexpected cache misses for recent data
# Check: Eviction logs
# Query: fields @message | filter @message like /Evicted LRU cache entry/

# Solution: Increase maxMemoryEntries (default: 1000)
```

### Debug Logging

Enable debug logging for cache operations:

```bash
# Serverless.yml environment variable
DEBUG: cache:*

# View cache operations in CloudWatch Logs
fields @timestamp, message, operation, key, tenant, layer
| filter service = "cache" and level = "debug"
| sort @timestamp desc
```

### Cache Key Validation Errors

```bash
# Error: "Invalid cache key format"
# Cause: Cache keys must match [a-zA-Z0-9_-]+ (max 256 chars)
# Example: jwt-validation-abc123def456... (valid)
#          jwt-validation-abc.123 (invalid - contains dot)
```

---

## Testing

The **bg-remover** service ships with three layers of automated tests:

| Type          | Location                              | Runner                     |
|---------------|---------------------------------------|----------------------------|
| Unit          | `src/**/*.ts` & `lib/**/*.ts`        | **Jest** (`npm run test`) |
| Integration   | `integration/**/*.test.ts`            | **Jest** (`npm run test`) |
| End-to-End    | `e2e/**/*.e2e.test.ts`               | **Playwright** (`npm run test:e2e`) |

All tests are written in **TypeScript** and run under strict mode.

### Test Scripts

| Script            | Description |
|-------------------|-------------|
| `npm run test` | Runs unit + integration tests (Jest). |
| `npm run test:e2e` | Executes Playwright E2E suite against the local API. |
| `npm run test:all` | Runs *all* tests in the monorepo (root, bg-remover, carousel-frontend). |
| `npm run test:ci` | Parallel CI-friendly entry point (requires `npm-run-all`). |

### Test Prerequisites

| Variable | Description | Default |
|----------|-------------|---------|
| `BG_REMOVER_API_URL` | Base URL for the API when running Playwright tests. | `http://localhost:3000` |
| `SERVERLESS_OFFLINE_PORT` | Port used by `serverless offline` (integration test). | `3000` |
| `TEST_USER_EMAIL` / `TEST_USER_PASSWORD` | Credentials for the token-refresh UI test in `carousel-frontend`. | *none* (set locally) |

### Running Tests

```bash
# Unit + integration (Jest)
cd services/bg-remover
npm run test

# End-to-end (Playwright)
npm run test:e2e
```

The Playwright configuration (`playwright.config.ts`) points to `./e2e` and uses the **API** project only – no browsers are launched.

### CI Integration

The root script `npm run test:ci` runs the unit tests and the two service-specific suites in parallel.
Add the following step to your CI pipeline:

```yaml
- name: Install dependencies
  run: npm ci

- name: Run all tests
  run: npm run test:ci
```

### Test Descriptions

**Unit Tests** (`src/**/*.test.ts`):
* Validate pure functions, request validation, and utility helpers.

**Integration Tests** (`integration/serverless-offline.integration.test.ts`):
* Spins up `serverless offline` and hits the real Lambda handler (`/dev/api/remove-bg`).
* Confirms end-to-end request/response flow, including error handling.

**E2E Tests** (`e2e/*.e2e.test.ts`):

| Test | Goal |
|------|------|
| `corrupted-image.e2e.test.ts` | Verify the service returns **400** for a corrupted JPEG. |
| `png-with-alpha.e2e.test.ts` | Ensure PNGs with an alpha channel are processed correctly and the response contains a new image URL. |
| `burst-rate-limit.e2e.test.ts` | Confirm that a burst of concurrent requests triggers **429** rate-limit responses. |

### Adding New Tests

1. **Create the file** under the appropriate folder (`__tests__`, `integration`, or `e2e`).
2. **Follow import ordering** (external → internal → relative).
3. **Use explicit return types** and avoid `any`.
4. **Run the suite locally** before committing.

### Test Coverage

Jest is configured with **80% coverage thresholds** for:
- Branches
- Functions
- Lines
- Statements

Coverage reports are generated in `coverage/` directory.

### Test Troubleshooting

**Playwright cannot reach the API**:
- Ensure `BG_REMOVER_API_URL` points to a running instance (e.g., `npm run start` or `serverless offline`).

**Rate-limit test flakiness**:
- Adjust `REQUESTS_IN_BURST` or the server's configured limits in `src/config/rateLimit.ts`.

**Integration test hangs**:
- Verify that the `serverless offline` binary is installed (`npm i -g serverless`).
