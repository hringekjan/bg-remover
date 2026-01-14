# BG-Remover Telemetry Quick Start

## Usage Examples

### Basic Image Processing
```typescript
import { bgRemoverTelemetry } from './lib/telemetry/bg-remover-telemetry';

const taskId = 'image-123';
const startTime = Date.now();

try {
  // Process image...
  const result = await processImage(imageUrl);

  // Record success
  await bgRemoverTelemetry.recordImageProcessing({
    taskId,
    success: true,
    responseTimeMs: Date.now() - startTime,
    costUsd: 0.002,
    metadata: {
      imageSize: result.imageSize,
      processingMode: 'single',
      qualityLevel: 'medium',
      outputFormat: 'png'
    }
  });
} catch (error) {
  // Record failure
  await bgRemoverTelemetry.recordImageProcessing({
    taskId,
    success: false,
    responseTimeMs: Date.now() - startTime,
    costUsd: 0,
    error: {
      message: error.message,
      code: error.code,
      stack: error.stack
    }
  });
}
```

### Batch Job Processing
```typescript
const batchId = 'batch-456';
const startTime = Date.now();
let successCount = 0;
let failureCount = 0;
let totalCost = 0;

// Process batch...
for (const image of images) {
  try {
    await processImage(image);
    successCount++;
    totalCost += 0.002;
  } catch (error) {
    failureCount++;
  }
}

// Record batch metrics
await bgRemoverTelemetry.recordBatchJob({
  batchId,
  imagesProcessed: images.length,
  successCount,
  failureCount,
  totalCost,
  durationMs: Date.now() - startTime,
  pipeline: 'clustering-v2'
});
```

### Using Tracker (Recommended)
```typescript
const tracker = bgRemoverTelemetry.createTracker('image-789');
const operation = tracker.startOperation('image-789', {
  imageSize: 1024000,
  processingMode: 'single'
});

try {
  // Process image...
  await processImage(imageUrl);

  // End operation with success
  await operation.endOperation({
    success: true,
    costUsd: 0.002,
    additionalMetrics: {
      outputSize: 512000,
      compressionRatio: 0.5
    }
  });
} catch (error) {
  // End operation with failure
  await operation.endOperation({
    success: false,
    errorMessage: error.message,
    errorCode: error.code,
    errorStack: error.stack
  });
}
```

### Health Check
```typescript
const health = await bgRemoverTelemetry.healthCheck();

console.log(`Status: ${health.status}`); // healthy | degraded | unhealthy
console.log(`Total tasks: ${health.metrics.totalTasks}`);
console.log(`Success rate: ${health.metrics.successRate}%`);
console.log(`Avg response time: ${health.metrics.avgResponseTimeMs}ms`);
console.log(`Total cost: $${health.metrics.totalCostUsd}`);
```

### Get Metrics
```typescript
// Get 1-hour metrics
const metrics1h = await bgRemoverTelemetry.getMetrics('1h');

// Get 24-hour metrics
const metrics24h = await bgRemoverTelemetry.getMetrics('24h');

// Get 7-day metrics
const metrics7d = await bgRemoverTelemetry.getMetrics('7d');

console.log(`P95 response time: ${metrics24h.p95ResponseTimeMs}ms`);
console.log(`Success rate: ${metrics24h.successRate}%`);
console.log(`Total cost: $${metrics24h.totalCostUsd}`);
```

### Publish to EventBridge
```typescript
// Publish 1-hour metrics to EventBridge
await bgRemoverTelemetry.publishMetrics('1h');

// Publish 24-hour metrics
await bgRemoverTelemetry.publishMetrics('24h');
```

## Cost Calculation Helper

```typescript
import { calculateBgRemoverCost } from './lib/telemetry/bg-remover-telemetry';

const cost = calculateBgRemoverCost({
  imageSize: 2048000,        // 2MB
  processingTime: 1500,      // 1.5 seconds
  qualityLevel: 'medium',    // low | medium | high
  imageCount: 1              // optional, defaults to 1
});

console.log(`Estimated cost: $${cost}`);
```

## Environment Setup

```bash
# .env
STAGE=dev
TENANT=carousel-labs
EVENT_BUS_NAME=carousel-labs-dev-agent-events  # optional
```

## Integration with Lambda Handler

```typescript
import { bgRemoverTelemetry } from './lib/telemetry/bg-remover-telemetry';

export async function handler(event: any) {
  const taskId = event.requestContext.requestId;
  const startTime = Date.now();

  try {
    const result = await processImage(event);

    await bgRemoverTelemetry.recordImageProcessing({
      taskId,
      success: true,
      responseTimeMs: Date.now() - startTime,
      costUsd: result.cost,
      metadata: {
        imageSize: result.inputSize,
        processingMode: 'single',
        qualityLevel: event.quality || 'medium',
        outputFormat: result.format
      }
    });

    return {
      statusCode: 200,
      body: JSON.stringify(result)
    };
  } catch (error) {
    await bgRemoverTelemetry.recordImageProcessing({
      taskId,
      success: false,
      responseTimeMs: Date.now() - startTime,
      costUsd: 0,
      error: {
        message: error.message,
        code: error.code,
        stack: error.stack
      }
    });

    throw error;
  }
}
```

## Data Flow

```
Lambda Invocation
       ↓
bgRemoverTelemetry.recordImageProcessing()
       ↓
AgentTelemetry.recordTask()
       ↓
   ┌───┴────┬────────────┬──────────────┐
   ↓        ↓            ↓              ↓
DynamoDB  EventBridge  CloudWatch   Aggregations
(tasks)   (A2A msgs)   (metrics)    (1h/24h/7d)
```

## Monitoring Queries

### DynamoDB Task Records
```bash
aws dynamodb query \
  --table-name carousel-labs-dev-agents \
  --key-condition-expression "PK = :pk" \
  --expression-attribute-values '{":pk":{"S":"AGENT#bg-remover"}}'
```

### CloudWatch Metrics
```bash
aws cloudwatch get-metric-statistics \
  --namespace CarouselAgents \
  --metric-name TaskExecution \
  --dimensions Name=AgentId,Value=bg-remover \
  --start-time 2026-01-03T00:00:00Z \
  --end-time 2026-01-03T23:59:59Z \
  --period 3600 \
  --statistics Sum
```

### EventBridge Events
```bash
aws events list-rules \
  --event-bus-name carousel-labs-dev-agent-events \
  --name-prefix bg-remover
```

## Troubleshooting

### No metrics appearing
1. Check DynamoDB table exists: `carousel-labs-dev-agents`
2. Verify EventBridge bus: `carousel-labs-dev-agent-events`
3. Check Lambda IAM permissions for DynamoDB and EventBridge
4. Verify `STAGE` and `TENANT` environment variables

### Type errors
1. Ensure `/src/types/backend-kit.d.ts` exists
2. Rebuild backend-kit: `cd packages/core/backend-kit && npm run build`
3. Check TypeScript config includes type declaration files

### Telemetry failures
- Telemetry errors are logged but don't throw
- Check CloudWatch logs for `[BgRemoverTelemetry]` messages
- Verify AWS SDK credentials are configured

---

**Updated:** 2026-01-03
**Version:** 1.0.0 (Un-stubbed)
