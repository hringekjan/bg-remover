# BG-Remover Telemetry Integration Summary

## Overview

Added comprehensive telemetry tracking to all bg-remover Lambda handlers using the `@carousellabs/backend-kit/agent-telemetry` module.

## Files Created

### 1. `/src/lib/telemetry/bg-remover-telemetry.ts`
Domain-specific telemetry wrapper for bg-remover operations.

**Key Features:**
- Cost calculation for Bedrock Nova Lite operations
- Image processing metrics tracking
- Batch job metrics tracking
- Health check integration
- EventBridge publishing for A2A communication

**Exports:**
- `bgRemoverTelemetry` - Singleton instance
- `calculateBgRemoverCost()` - Cost estimation function
- Type definitions for telemetry data

### 2. `/src/handlers/metrics-handler.ts`
New HTTP endpoint for retrieving agent metrics.

**Endpoint:** `GET /bg-remover/metrics?window={1h|24h|7d|30d}`

**Response Format:**
```json
{
  "success": true,
  "agent": "bg-remover",
  "window": "1h",
  "metrics": {
    "totalTasks": 150,
    "successfulTasks": 147,
    "failedTasks": 3,
    "successRate": "98.00%",
    "performance": {
      "averageResponseTimeMs": "1543.25",
      "p50ResponseTimeMs": "1450.00",
      "p95ResponseTimeMs": "2100.00",
      "p99ResponseTimeMs": "2500.00"
    },
    "costs": {
      "totalCostUsd": "0.010800",
      "averageCostPerTask": "0.000072"
    },
    "timeRange": {
      "start": "2026-01-02T10:00:00.000Z",
      "end": "2026-01-02T11:00:00.000Z"
    }
  },
  "timestamp": "2026-01-02T11:00:00.000Z"
}
```

## Files Modified

### 1. `/src/handlers/process-handler.ts`
**Changes:**
- Added telemetry import
- Record success metrics after job acceptance
- Record failure metrics in error handler
- Tracks coordinator overhead costs

**Metrics Recorded:**
- Task ID: Job ID
- Response time: Processing duration
- Cost: Coordinator overhead (minimal)
- Metadata: Processing mode, quality level, pipeline type

### 2. `/src/handlers/health-handler.ts`
**Changes:**
- Added telemetry health check
- Reports telemetry status, success rate, and task count
- Integrated into overall health response

**Health Check Format:**
```json
{
  "name": "telemetry",
  "status": "pass",
  "message": "Status: healthy, Success rate: 98.0%, Tasks: 150"
}
```

### 3. `/src/handlers/process-worker-handler.ts`
**Changes:**
- Added telemetry import
- Record single image processing success/failure
- Record batch job processing success/failure
- Detailed cost calculation per image

**Single Image Metrics:**
- Image size and quality level
- Processing time and cost
- Success/failure with error details

**Batch Job Metrics:**
- Total images processed
- Success/failure counts
- Total cost and duration
- Pipeline type

### 4. `/serverless.yml`
**Changes:**
- Added `metrics` function definition
- Route: `GET /bg-remover/metrics`
- Memory: 512MB
- Timeout: 30s

## Cost Calculation

### Bedrock Nova Lite Pricing
- Input tokens: $0.00008 per 1K tokens
- Output tokens: $0.00032 per 1K tokens
- Estimated per image: ~500 input + ~100 output tokens = $0.000072

### Lambda Pricing (arm64)
- Cost: $0.0000166667 per GB-second
- Memory: 1.5GB (1536MB)
- Processing time: Variable (typically 1-3 seconds)

### Quality Multipliers
- Low: 0.5x base cost
- Medium: 1.0x base cost (default)
- High: 1.5x base cost

### Size Multipliers
- Base: 2MB
- Multiplier: `max(1.0, imageSizeMB / 2.0)`

## Telemetry Data Flow

```
┌─────────────────┐
│  Lambda Handler │
│  (process.ts)   │
└────────┬────────┘
         │
         │ recordTask()
         ▼
┌─────────────────────────┐
│  bgRemoverTelemetry     │
│  (telemetry wrapper)    │
└────────┬────────────────┘
         │
         │ AgentTelemetry.recordTask()
         ▼
┌─────────────────────────┐
│  @carousellabs/        │
│  backend-kit/          │
│  agent-telemetry       │
└────────┬────────────────┘
         │
         ├──────────────┬──────────────┬──────────────┐
         │              │              │              │
         ▼              ▼              ▼              ▼
    DynamoDB      CloudWatch     EventBridge   Aggregations
    (raw data)    (metrics)      (A2A events)  (time windows)
```

## DynamoDB Schema

### Task Records
```
PK: AGENT#bg-remover
SK: TASK#2026-01-02T11:23:45.678Z#job-id-123
entityType: AGENT_TASK
agentId: bg-remover
taskId: job-id-123
status: success | failure | timeout | error
responseTimeMs: 1543
costUsd: 0.000072
metadata: { imageSize, qualityLevel, ... }
error: { message, code, stack } (if failure)
```

### Aggregated Metrics
```
PK: AGENT#bg-remover
SK: METRICS#{1h|24h|7d}
entityType: AGENT_METRICS
agentId: bg-remover
timeWindow: 1h
totalTasks: 150
successfulTasks: 147
failedTasks: 3
totalResponseTimeMs: 231487
totalCostUsd: 0.010800
responseTimes: [1450, 1523, 1612, ...] (max 10,000 entries)
periodStart: 2026-01-02T10:00:00.000Z
periodEnd: 2026-01-02T11:00:00.000Z
```

## CloudWatch Metrics

**Namespace:** `CarouselAgents`

**Metrics Published:**
1. `TaskExecution` (Count)
   - Dimensions: AgentId, Status, TenantId

2. `ResponseTime` (Milliseconds)
   - Dimensions: AgentId, TenantId

3. `Cost` (None)
   - Dimensions: AgentId, TenantId

## EventBridge Events

**Event Bus:** `carousel-events` (or custom via ENV)

**Event Pattern:**
```json
{
  "source": ["carousel.agents"],
  "detail-type": ["AgentMetric"]
}
```

**Event Detail:**
```json
{
  "agentId": "bg-remover",
  "tenantId": "carousel-labs",
  "timestamp": "2026-01-02T11:00:00.000Z",
  "metrics": {
    "invocations": 150,
    "duration": 1543.25,
    "errors": 3,
    "successRate": 98.0,
    "avgResponseTimeMs": 1543.25,
    "totalCostUsd": 0.010800
  }
}
```

## Environment Variables

### Required
- `STAGE` - Deployment stage (dev/prod)
- `TENANT` - Tenant ID (default: carousel-labs)
- `AWS_REGION` - AWS region (default: eu-west-1)

### Optional
- `EVENT_BUS_NAME` - Custom EventBridge bus name
- `AGENT_ID` - Override agent ID (default: bg-remover)

## IAM Permissions Required

Add to `serverless.yml`:

```yaml
provider:
  iam:
    role:
      statements:
        # EventBridge for telemetry publishing
        - Effect: Allow
          Action:
            - events:PutEvents
          Resource:
            - "arn:aws:events:${aws:region}:${aws:accountId}:event-bus/carousel-events"

        # CloudWatch for metrics
        - Effect: Allow
          Action:
            - cloudwatch:PutMetricData
          Resource: "*"

        # DynamoDB for telemetry storage
        - Effect: Allow
          Action:
            - dynamodb:GetItem
            - dynamodb:PutItem
            - dynamodb:UpdateItem
            - dynamodb:Query
          Resource:
            - "arn:aws:dynamodb:${aws:region}:${aws:accountId}:table/bg-remover-telemetry-${sls:stage}"
```

## Testing

### Manual Testing

1. **Test metrics endpoint:**
```bash
curl -H "Authorization: Bearer $TOKEN" \
  https://api.dev.carousellabs.co/bg-remover/metrics?window=1h
```

2. **Test health endpoint:**
```bash
curl https://api.dev.carousellabs.co/bg-remover/health
```

3. **Process image and check telemetry:**
```bash
# Process image
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"imageUrl": "https://example.com/image.jpg"}' \
  https://api.dev.carousellabs.co/bg-remover/process

# Wait 5 seconds for aggregation
sleep 5

# Check metrics
curl -H "Authorization: Bearer $TOKEN" \
  https://api.dev.carousellabs.co/bg-remover/metrics?window=1h
```

### Integration Tests

Located in `/tests/integration/telemetry.test.ts` (to be created):

```typescript
describe('BG-Remover Telemetry', () => {
  it('should record successful image processing', async () => {
    // Process image
    const result = await processImage(imageUrl);

    // Wait for telemetry
    await sleep(1000);

    // Fetch metrics
    const metrics = await getMetrics('1h');

    expect(metrics.totalTasks).toBeGreaterThan(0);
    expect(metrics.successRate).toBeGreaterThan(0);
  });

  it('should record failed processing with error', async () => {
    // Process invalid image
    const result = await processImage('invalid-url');

    // Wait for telemetry
    await sleep(1000);

    // Fetch metrics
    const metrics = await getMetrics('1h');

    expect(metrics.failedTasks).toBeGreaterThan(0);
  });
});
```

## Success Criteria

- ✅ Telemetry wrapper created
- ✅ Process handler instrumented
- ✅ Health handler instrumented
- ✅ Process worker instrumented (single + batch)
- ✅ Metrics endpoint created
- ✅ Serverless.yml updated
- ✅ Cost calculation implemented
- ✅ EventBridge integration
- ✅ CloudWatch integration
- ✅ DynamoDB persistence

## Next Steps

1. Deploy to dev environment
2. Test all endpoints manually
3. Create integration tests
4. Add CloudWatch dashboard
5. Set up alarms for high error rates
6. Integrate with pricing-intelligence agent
7. Add A2A message handling
8. Create metrics visualization UI

## Related Files

- Backend Kit: `/packages/core/backend-kit/src/agent-telemetry.ts`
- Backend Kit Types: `/packages/core/backend-kit/src/types/agent-telemetry.ts`
- Agent Registry: `/packages/core/backend-kit/src/agent-registry/`
- Task Master: Task 4.6 - BG-Remover Telemetry Integration

## Notes

- Telemetry failures are logged but don't break agent operations
- Sampling rate is 100% by default (can be reduced in production)
- Response times array is capped at 10,000 entries (circular buffer)
- TTL is not set on telemetry records (manual cleanup required)
- Costs are estimates based on Bedrock pricing (may vary)
