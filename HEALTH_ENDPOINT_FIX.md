# Health Endpoint HTTP Status Code Fix

## Summary

Fixed the health endpoint to return correct HTTP status codes per RFC 7230 based on dependency health state.

## Changes Made

### File: `src/handler.ts`

**Before:**
- Always returned 200 for degraded state
- No comprehensive dependency checks
- Only checked config, environment, and cache

**After:**
- ✅ Returns **200 OK** when all dependencies healthy
- ✅ Returns **207 Multi-Status** when some dependencies degraded but service operational
- ✅ Returns **503 Service Unavailable** when critical dependencies down

### Dependencies Checked

| Dependency | Type | Health Check | Status Impact |
|------------|------|--------------|---------------|
| **DynamoDB** | Critical | `DescribeTableCommand` | Unhealthy = 503 |
| **S3** | Critical | `ListBucketsCommand` | Unhealthy = 503 |
| **Cognito JWKS** | Non-Critical | Fetch JWKS endpoint | Degraded = 207 |
| **Cache Service** | Non-Critical | Circuit breaker state | Degraded = 207 |

### Response Format

```typescript
interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  dependencies: {
    dynamodb: DependencyHealth;
    s3: DependencyHealth;
    cognito: DependencyHealth;
    cacheService: DependencyHealth;
  };
}

interface DependencyHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  latency?: number;
  message?: string;
}
```

### Status Code Logic

```typescript
if (hasUnhealthy) {
  // Critical dependencies (DynamoDB, S3) down = 503 Service Unavailable
  statusCode = 503;
  overallStatus = 'unhealthy';
} else if (hasDegraded) {
  // Non-critical dependencies degraded = 207 Multi-Status
  statusCode = 207;
  overallStatus = 'degraded';
} else {
  // All healthy = 200 OK
  statusCode = 200;
  overallStatus = 'healthy';
}
```

## Testing

### Test File: `src/__tests__/health.test.ts`

Comprehensive test suite with 11 test cases:

#### 200 OK - All Healthy
- ✅ Returns 200 when all dependencies are healthy

#### 207 Multi-Status - Degraded
- ✅ Returns 207 when Cognito JWKS is degraded
- ✅ Returns 207 when cache service circuit breaker is open

#### 503 Service Unavailable - Unhealthy
- ✅ Returns 503 when DynamoDB is down
- ✅ Returns 503 when S3 is down
- ✅ Returns 503 when both DynamoDB and S3 are down

#### Response Format
- ✅ Includes latency measurements for all dependencies
- ✅ Includes timestamp in response
- ✅ Includes CORS headers

#### Edge Cases
- ✅ Handles cache service not configured gracefully
- ✅ Handles invalid path gracefully

### Test Results

```
PASS src/__tests__/health.test.ts
  Health Endpoint
    200 OK - All Healthy
      ✓ should return 200 when all dependencies are healthy
    207 Multi-Status - Degraded
      ✓ should return 207 when Cognito JWKS is degraded
      ✓ should return 207 when cache service circuit breaker is open
    503 Service Unavailable - Unhealthy
      ✓ should return 503 when DynamoDB is down
      ✓ should return 503 when S3 is down
      ✓ should return 503 when both DynamoDB and S3 are down
    Response Format
      ✓ should include latency measurements for all dependencies
      ✓ should include timestamp in response
      ✓ should include CORS headers
    Edge Cases
      ✓ should handle cache service not configured gracefully
      ✓ should handle invalid path gracefully

Test Suites: 1 passed, 1 total
Tests:       11 passed, 11 total
```

## Implementation Details

### Parallel Health Checks

All dependency checks run in parallel for optimal performance:

```typescript
const [dynamodb, s3, cognito, cacheService] = await Promise.all([
  checkDynamoDB(),
  checkS3(),
  checkCognito(),
  checkCacheService(),
]);
```

### DynamoDB Check

```typescript
async function checkDynamoDB(): Promise<DependencyHealth> {
  const startCheck = Date.now();
  try {
    const client = new DynamoDBClient({ region: 'eu-west-1' });
    const tableName = process.env.BG_REMOVER_TABLE_NAME || 'bg-remover-dev';

    await client.send(new DescribeTableCommand({ TableName: tableName }));

    return {
      status: 'healthy',
      latency: Date.now() - startCheck,
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      latency: Date.now() - startCheck,
      message: error instanceof Error ? error.message : 'DynamoDB check failed',
    };
  }
}
```

### S3 Check

```typescript
async function checkS3(): Promise<DependencyHealth> {
  const startCheck = Date.now();
  try {
    const client = new S3Client({ region: 'eu-west-1' });
    await client.send(new ListBucketsCommand({}));

    return {
      status: 'healthy',
      latency: Date.now() - startCheck,
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      latency: Date.now() - startCheck,
      message: error instanceof Error ? error.message : 'S3 check failed',
    };
  }
}
```

### Cognito JWKS Check

```typescript
async function checkCognito(): Promise<DependencyHealth> {
  const startCheck = Date.now();
  try {
    const config = await loadTenantCognitoConfig(tenant, stage);
    const jwksUrl = `${config.issuer}/.well-known/jwks.json`;

    const response = await fetch(jwksUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(5000) // 5 second timeout
    });

    if (!response.ok) {
      return {
        status: 'degraded',
        latency: Date.now() - startCheck,
        message: `JWKS endpoint returned ${response.status}`,
      };
    }

    return {
      status: 'healthy',
      latency: Date.now() - startCheck,
    };
  } catch (error) {
    // Circuit breaker open or JWKS unreachable = degraded (not critical)
    return {
      status: 'degraded',
      latency: Date.now() - startCheck,
      message: error instanceof Error ? error.message : 'Cognito JWKS check failed',
    };
  }
}
```

### Cache Service Check

```typescript
async function checkCacheService(): Promise<DependencyHealth> {
  const startCheck = Date.now();
  try {
    const cacheServiceUrl = process.env.CACHE_SERVICE_URL;

    if (!cacheServiceUrl) {
      return {
        status: 'healthy',
        latency: Date.now() - startCheck,
        message: 'Cache service not configured (optional)',
      };
    }

    const cacheManager = getCacheManager({ tenantId, cacheServiceUrl });
    const stats = cacheManager.getStats();

    if (stats.cacheService.state === 'open') {
      return {
        status: 'degraded',
        latency: Date.now() - startCheck,
        message: 'Cache service circuit breaker open',
      };
    }

    return {
      status: 'healthy',
      latency: Date.now() - startCheck,
      message: `Circuit breaker: ${stats.cacheService.state}`,
    };
  } catch (error) {
    return {
      status: 'degraded',
      latency: Date.now() - startCheck,
      message: error instanceof Error ? error.message : 'Cache service check failed',
    };
  }
}
```

## Example Responses

### All Healthy (200)

```json
{
  "status": "healthy",
  "timestamp": "2026-01-03T12:00:00.000Z",
  "dependencies": {
    "dynamodb": {
      "status": "healthy",
      "latency": 45
    },
    "s3": {
      "status": "healthy",
      "latency": 32
    },
    "cognito": {
      "status": "healthy",
      "latency": 120
    },
    "cacheService": {
      "status": "healthy",
      "latency": 15,
      "message": "Circuit breaker: closed"
    }
  }
}
```

### Degraded (207)

```json
{
  "status": "degraded",
  "timestamp": "2026-01-03T12:00:00.000Z",
  "dependencies": {
    "dynamodb": {
      "status": "healthy",
      "latency": 45
    },
    "s3": {
      "status": "healthy",
      "latency": 32
    },
    "cognito": {
      "status": "degraded",
      "latency": 5002,
      "message": "JWKS unreachable"
    },
    "cacheService": {
      "status": "healthy",
      "latency": 15,
      "message": "Circuit breaker: closed"
    }
  }
}
```

### Unhealthy (503)

```json
{
  "status": "unhealthy",
  "timestamp": "2026-01-03T12:00:00.000Z",
  "dependencies": {
    "dynamodb": {
      "status": "unhealthy",
      "latency": 102,
      "message": "Table not found"
    },
    "s3": {
      "status": "healthy",
      "latency": 32
    },
    "cognito": {
      "status": "healthy",
      "latency": 120
    },
    "cacheService": {
      "status": "healthy",
      "latency": 15,
      "message": "Circuit breaker: closed"
    }
  }
}
```

## Compliance

This implementation follows:

- ✅ **RFC 7230** - HTTP/1.1 Message Syntax and Routing
- ✅ **API Contract Review** - Finding #2 requirements
- ✅ **Health Check Best Practices**:
  - Separate critical vs non-critical dependencies
  - Include latency measurements
  - Provide actionable error messages
  - Fail fast with 503 when critical dependencies down
  - Degrade gracefully with 207 when non-critical dependencies degraded

## Next Steps

1. Deploy to dev environment
2. Monitor health endpoint behavior
3. Configure monitoring alerts:
   - Alert on 503 (critical dependencies down)
   - Warning on 207 (degraded state)
   - Track latency trends

## Related Files

- `/Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover/src/handler.ts`
- `/Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover/src/__tests__/health.test.ts`
