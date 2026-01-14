# BG-Remover Telemetry Error Handling - Quick Reference

## Overview

The `BgRemoverTelemetry` class now handles all telemetry errors gracefully, ensuring the application continues processing images even when telemetry fails.

## Error Handling Pattern

### Constructor
```typescript
try {
  this.telemetry = new AgentTelemetry({...});
} catch (error) {
  console.error('[BgRemoverTelemetry] Failed to initialize AgentTelemetry:', error);
  this.telemetry = null; // Graceful degradation
}
```

### All Methods
```typescript
if (!this.telemetry) {
  console.warn('[BgRemoverTelemetry] Telemetry not initialized, skipping...');
  return; // or return safe default
}

try {
  await this.telemetry.someMethod();
} catch (error) {
  console.error('[BgRemoverTelemetry] Failed to...', error);
  // Don't throw - telemetry failures shouldn't break processing
}
```

## Usage Examples

### Recording Image Processing
```typescript
import { bgRemoverTelemetry } from './lib/telemetry/bg-remover-telemetry';

// Always safe to call - won't throw errors
await bgRemoverTelemetry.recordImageProcessing({
  taskId: 'img-123',
  success: true,
  responseTimeMs: 1500,
  costUsd: 0.0001,
  metadata: {
    imageSize: 1024000,
    processingMode: 'single',
    qualityLevel: 'high',
    outputFormat: 'png',
  }
});
```

### Recording Batch Jobs
```typescript
// Safe even if telemetry is unavailable
await bgRemoverTelemetry.recordBatchJob({
  batchId: 'batch-456',
  imagesProcessed: 100,
  successCount: 98,
  failureCount: 2,
  totalCost: 0.012,
  durationMs: 60000,
  pipeline: 'bg-removal-v2'
});
```

### Health Checks
```typescript
// Always returns a valid response
const health = await bgRemoverTelemetry.healthCheck();

// health.status will be:
// - 'healthy' if telemetry working and success rate >= 95%
// - 'degraded' if telemetry working but success rate < 95%
// - 'unhealthy' if telemetry not initialized or success rate < 50%
```

### Getting Metrics
```typescript
// Returns empty metrics if telemetry unavailable
const metrics = await bgRemoverTelemetry.getMetrics('1h');

console.log(metrics.totalTasks); // Always defined (0 if unavailable)
console.log(metrics.successRate); // Always defined (0 if unavailable)
```

### Creating Trackers
```typescript
// Returns no-op tracker if telemetry unavailable
const tracker = bgRemoverTelemetry.createTracker('task-789');

tracker.start(); // Safe to call
tracker.end();   // Safe to call
```

## Behavior When Telemetry Fails

| Method | Behavior When Unavailable |
|--------|---------------------------|
| `recordImageProcessing()` | Logs warning, returns immediately |
| `recordBatchJob()` | Logs warning, returns immediately |
| `getMetrics()` | Returns empty metrics object with zeros |
| `healthCheck()` | Returns 'unhealthy' status with zero metrics |
| `publishMetrics()` | Logs warning, returns immediately |
| `createTracker()` | Returns no-op tracker with empty functions |

## CloudWatch Logs

### Initialization Failure
```
[BgRemoverTelemetry] Failed to initialize AgentTelemetry: Error: EventBridge bus not found
```

### Operation Warnings
```
[BgRemoverTelemetry] Telemetry not initialized, skipping image processing metric
[BgRemoverTelemetry] Telemetry not initialized, skipping batch job metric
[BgRemoverTelemetry] Telemetry not initialized, returning empty metrics
```

### Runtime Errors
```
[BgRemoverTelemetry] Failed to record image processing: Error: DynamoDB timeout
[BgRemoverTelemetry] Failed to publish metrics: Error: EventBridge throttled
```

## Testing Scenarios

### Test 1: Missing EventBridge Bus
```bash
# Remove EVENT_BUS_NAME environment variable
unset EVENT_BUS_NAME

# Telemetry will fail to initialize but app continues
```

### Test 2: DynamoDB Table Not Found
```bash
# Point to non-existent table
export DYNAMODB_TABLE_NAME=nonexistent-table

# Telemetry operations will fail gracefully
```

### Test 3: Invalid AWS Credentials
```bash
# Remove AWS credentials
unset AWS_ACCESS_KEY_ID
unset AWS_SECRET_ACCESS_KEY

# Telemetry will log errors but app keeps running
```

## Performance Impact

- **No telemetry overhead** when telemetry is unavailable
- **Single null check** per method call (negligible)
- **No exceptions thrown** - prevents try/catch overhead in callers

## Integration Points

All telemetry calls are in:
- `/Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover/src/handlers/process-handler.ts`
- `/Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover/src/handlers/process-worker-handler.ts`
- `/Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover/src/handlers/health-handler.ts`
- `/Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover/src/handlers/metrics-handler.ts`

All handlers continue to work normally when telemetry fails.

## Monitoring

To detect telemetry failures in production:

1. **CloudWatch Logs Insights Query:**
```
fields @timestamp, @message
| filter @message like /BgRemoverTelemetry.*Failed/
| stats count() by bin(5m)
```

2. **CloudWatch Metric Filter:**
- Pattern: `[BgRemoverTelemetry] Failed to initialize`
- Metric: `BgRemoverTelemetryInitFailures`
- Alarm: Trigger when count > 0 in 5 minutes

3. **Health Check Monitoring:**
- Monitor `status: 'unhealthy'` responses from `/health` endpoint
- May indicate telemetry system issues

## Troubleshooting

### Issue: Telemetry not recording metrics

**Check:**
1. CloudWatch Logs for initialization errors
2. EventBridge bus exists: `carousel-labs-dev-agent-events`
3. DynamoDB table permissions
4. Lambda IAM role has required permissions

**Solution:**
```bash
# Verify EventBridge bus
aws events describe-event-bus \
  --name carousel-labs-dev-agent-events \
  --region eu-west-1

# Check Lambda role permissions
aws iam get-role-policy \
  --role-name bg-remover-dev-lambda-role \
  --policy-name telemetry-access
```

### Issue: High warning log volume

**Cause:** Telemetry failing to initialize repeatedly

**Solution:**
1. Fix underlying EventBridge/DynamoDB issue
2. Or disable telemetry in dev: `ENABLE_TELEMETRY=false`

## Best Practices

1. **Don't await telemetry** if not needed - use fire-and-forget pattern
2. **Check health endpoint** to verify telemetry status
3. **Monitor CloudWatch Logs** for telemetry warnings
4. **Use metrics dashboard** to ensure telemetry data flowing
5. **Test locally** without telemetry to ensure app works

## Related Documentation

- [Agent Telemetry Implementation](/Users/davideagle/git/CarouselLabs/enterprise-packages/packages/core/backend-kit/src/agent-telemetry.ts)
- [Agent Gateway Setup](/Users/davideagle/git/CarouselLabs/enterprise-packages/services/agent-gateway/README.md)
- [EventBridge A2A Protocol](/Users/davideagle/git/CarouselLabs/enterprise-packages/packages/core/backend-kit/src/a2a-adapter.ts)
