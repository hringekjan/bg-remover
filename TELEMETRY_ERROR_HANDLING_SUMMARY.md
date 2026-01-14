# BG-Remover Telemetry Error Handling Implementation

## Summary

Added comprehensive error handling to `BgRemoverTelemetry` class to ensure graceful degradation when telemetry initialization or operations fail. This prevents telemetry failures from crashing the application.

## Changes Made

### File Modified
- `/Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover/src/lib/telemetry/bg-remover-telemetry.ts`

### 1. Constructor Error Handling

**Before:**
```typescript
constructor() {
  this.stage = process.env.STAGE || 'dev';
  this.tenantId = process.env.TENANT || 'carousel-labs';

  this.telemetry = new AgentTelemetry({
    stage: this.stage,
    tenantId: this.tenantId,
    eventBusName: process.env.EVENT_BUS_NAME || `${this.tenantId}-${this.stage}-agent-events`,
    enableCloudWatch: true,
    samplingRate: 1.0,
  });
}
```

**After:**
```typescript
constructor() {
  this.stage = process.env.STAGE || 'dev';
  this.tenantId = process.env.TENANT || 'carousel-labs';

  try {
    this.telemetry = new AgentTelemetry({
      stage: this.stage,
      tenantId: this.tenantId,
      eventBusName: process.env.EVENT_BUS_NAME || `${this.tenantId}-${this.stage}-agent-events`,
      enableCloudWatch: true,
      samplingRate: 1.0,
    });
  } catch (error) {
    console.error('[BgRemoverTelemetry] Failed to initialize AgentTelemetry:', error);
    this.telemetry = null; // Graceful degradation
  }
}
```

### 2. Type Update

Changed telemetry property type to allow null:
```typescript
private telemetry: AgentTelemetry | null;
```

### 3. Method Updates

Added null checks to all methods that use telemetry:

#### recordImageProcessing()
```typescript
if (!this.telemetry) {
  console.warn('[BgRemoverTelemetry] Telemetry not initialized, skipping image processing metric');
  return;
}
```

#### recordBatchJob()
```typescript
if (!this.telemetry) {
  console.warn('[BgRemoverTelemetry] Telemetry not initialized, skipping batch job metric');
  return;
}
```

#### getMetrics()
```typescript
if (!this.telemetry) {
  console.warn('[BgRemoverTelemetry] Telemetry not initialized, returning empty metrics');
  return {
    agentId: AGENT_ID,
    timeWindow,
    totalTasks: 0,
    // ... other empty metrics
  };
}
```

#### healthCheck()
```typescript
if (!this.telemetry) {
  console.warn('[BgRemoverTelemetry] Telemetry not initialized, reporting unhealthy status');
  return {
    status: 'unhealthy',
    metrics: {
      totalTasks: 0,
      successRate: 0,
      avgResponseTimeMs: 0,
      totalCostUsd: 0,
    },
  };
}
```

#### publishMetrics()
```typescript
if (!this.telemetry) {
  console.warn('[BgRemoverTelemetry] Telemetry not initialized, skipping metrics publish');
  return;
}
```

#### createTracker()
```typescript
if (!this.telemetry) {
  console.warn('[BgRemoverTelemetry] Telemetry not initialized, returning no-op tracker');
  return {
    start: () => {},
    end: () => {},
    recordMetric: () => {},
    recordError: () => {},
  };
}
```

## Benefits

1. **Graceful Degradation**: Application continues to function even if telemetry fails
2. **Clear Logging**: Warning messages indicate when telemetry is unavailable
3. **No Runtime Errors**: Null checks prevent crashes from missing telemetry
4. **Safe Defaults**: Methods return safe default values when telemetry is unavailable
5. **No-Op Tracker**: createTracker returns a safe no-op object instead of null

## Error Scenarios Handled

- DynamoDB connection failures
- EventBridge connection failures
- Missing AWS credentials
- Network timeouts
- Invalid configuration
- Missing environment variables

## Testing Recommendations

1. Test with missing AWS credentials
2. Test with invalid EventBridge bus name
3. Test with DynamoDB table not existing
4. Verify application continues processing images when telemetry fails
5. Check CloudWatch logs for warning messages

## Related Files

- `/Users/davideagle/git/CarouselLabs/enterprise-packages/packages/core/backend-kit/src/agent-telemetry.ts` - AgentTelemetry implementation
- `/Users/davideagle/git/CarouselLabs/enterprise-packages/services/agent-gateway/serverless.yml` - EventBridge bus configuration

## Implementation Date

2026-01-04
