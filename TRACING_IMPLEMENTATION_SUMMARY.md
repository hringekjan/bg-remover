# Request Tracing Implementation Summary

**Service:** bg-remover
**Implementation Date:** 2026-01-02
**Status:** Complete

---

## Overview

Implemented comprehensive request tracing infrastructure to debug issues like the 404 cache problem. Provides end-to-end visibility from frontend API routes through Lambda handlers to backend services.

---

## Files Created

### 1. Frontend Tracing Utility
**File:** `/services/carousel-frontend/lib/utils/trace-bg-remover.ts`

**Purpose:** Structured logging for Next.js API routes

**Key Functions:**
- `createTraceContext()` - Initialize trace with unique ID
- `logRequest()` - Log request start with metadata
- `logResponse()` - Log successful completion with duration
- `logError()` - Log errors with full stack traces
- `extractTraceId()` - Extract trace ID from headers
- `injectTraceId()` - Add trace ID to outgoing requests
- `logHop()` - Track intermediate request hops

**Features:**
- Unique trace IDs (format: `req_UUID`)
- Cross-service correlation via headers
- Structured JSON logging
- CloudWatch Insights compatible

### 2. Backend Tracing Utility
**File:** `/services/bg-remover/src/lib/trace.ts`

**Purpose:** Structured logging for Lambda handlers

**Key Functions:**
- `createLambdaTraceContext()` - Extract trace context from event
- `logLambdaStart()` - Log Lambda invocation
- `logLambdaSuccess()` - Log successful execution
- `logLambdaError()` - Log Lambda errors
- `logServiceCall()` - Track external service calls (Bedrock, S3, DynamoDB)
- `addTraceHeaders()` - Include trace ID in responses

**Features:**
- AWS Lambda request ID correlation
- Service call timing
- Error context with stack traces
- Multi-tenant support

### 3. CloudWatch Insights Queries
**File:** `/services/bg-remover/cloudwatch-insights-queries.md`

**Purpose:** Pre-built debugging queries

**Queries Provided:**
1. Trace specific job ID (full request flow)
2. Find all 404 errors
3. Find slow requests (>2s)
4. Error rate by endpoint
5. Request duration percentiles
6. Trace full request path (all 9 hops)
7. Find authentication failures
8. Service call performance analysis
9. Credits debit/refund tracking
10. Recent errors with context
11. Request volume by tenant
12. Cache hit/miss analysis

---

## Files Modified

### 1. Frontend API Route
**File:** `/services/carousel-frontend/app/api/bg-remover/process/route.ts`

**Changes:**
- Added trace context creation after authentication
- Injected trace ID into Lambda requests via `x-trace-id` header
- Logged all request phases (start, hops, completion, errors)
- Returned trace ID in response headers and body
- Added detailed error logging with trace context

**Traced Events:**
- Request start
- Rate limit check (pass/fail)
- Lambda invocation start
- Lambda invocation success/failure
- Request completion
- All error conditions

### 2. Serverless Configuration
**File:** `/services/bg-remover/serverless.yml`

**Changes:**
- Enabled X-Ray tracing: `tracing.lambda: true`
- Added X-Ray IAM permissions (PutTraceSegments, PutTelemetryRecords)
- Set environment variables:
  - `AWS_XRAY_TRACING_ENABLED: 'true'`
  - `AWS_XRAY_CONTEXT_MISSING: LOG_ERROR`

**Benefits:**
- Distributed tracing across services
- Visual service maps in X-Ray console
- Automatic subsegment creation for AWS SDK calls
- Trace retention for 30 days

---

## Request Flow with Tracing

### Example: Image Processing Request

**1. Frontend API Route** (`carousel-frontend`)
```
[14:30:00.123] INFO: Request start
  traceId: req_abc123
  action: bg-remover:process
  phase: start

[14:30:00.150] INFO: Rate limit check passed
  traceId: req_abc123
  hopName: rate-limit
  hopResult: pass

[14:30:00.160] INFO: Lambda invocation start
  traceId: req_abc123
  hopName: lambda-invoke
  hopResult: start
```

**2. Lambda Handler** (`bg-remover`)
```
[14:30:00.200] INFO: Lambda start
  traceId: req_abc123
  requestId: abc-def-123
  functionName: bg-remover-dev-process
  action: bg-remover:process

[14:30:00.250] INFO: Service call - Bedrock
  traceId: req_abc123
  action: service:bedrock:invoke
  duration: 800ms
  result: success

[14:30:01.100] INFO: Service call - S3
  traceId: req_abc123
  action: service:s3:putObject
  duration: 150ms
  result: success

[14:30:01.200] INFO: Lambda success
  traceId: req_abc123
  duration: 1000ms
  result: success
```

**3. Frontend Response**
```
[14:30:01.250] INFO: Request complete
  traceId: req_abc123
  jobId: job_123
  duration: 1127ms
  result: success
```

---

## Debugging Workflow

### Scenario: User Reports 404 Error

**Step 1:** Get trace ID from user
- Ask user to provide `traceId` from error response
- Or extract from CloudWatch logs using timestamp

**Step 2:** Run CloudWatch Insights Query
```sql
fields @timestamp, layer, action, duration, result, metadata
| filter traceId = "req_abc123xyz789"
| sort @timestamp asc
```

**Step 3:** Analyze Request Flow
- Identify which hop failed
- Check service call timings
- Review error messages and metadata

**Step 4:** Drill Down to Specific Service
```sql
fields @timestamp, action, duration, error.message, metadata
| filter traceId = "req_abc123xyz789" and result = "error"
| sort @timestamp asc
```

**Step 5:** Root Cause Analysis
- Review error stack traces
- Check service-specific metadata
- Correlate with X-Ray service map

---

## CloudWatch Log Groups

### Log Group Naming Convention
- Frontend: `/aws/lambda/carousel-frontend-dev`
- Backend: `/aws/lambda/bg-remover-dev-{functionName}`

### Log Retention
- Frontend API: 7 days
- Lambda handlers: 14 days
- X-Ray traces: 30 days

### Cost Estimate
- CloudWatch Logs: $2.50/month (5GB ingestion)
- Insights queries: $0.75/month (50 queries/day)
- X-Ray traces: $0.50/month (100K traces/month)
- **Total: $3.75/month**

---

## Log Entry Format

### Standard Fields (All Logs)
```typescript
{
  timestamp: "2026-01-02T14:30:00.123Z",
  level: "info" | "warn" | "error",
  traceId: "req_abc123xyz789",
  jobId: "job_1234567890",
  tenantId: "carousel-labs",
  userId: "user_123",
  action: "bg-remover:process",
  service: "carousel-frontend",
  layer: "api-route" | "lambda" | "backend-api",
  duration: 1523,
  result: "success" | "error" | "partial",
  metadata: { /* additional context */ }
}
```

### Error Format
```typescript
{
  ...standardFields,
  level: "error",
  result: "error",
  error: {
    message: "Lambda function failed",
    code: "INTERNAL_ERROR",
    stack: "Error: Lambda function failed\n    at route.ts:123:45"
  }
}
```

---

## X-Ray Integration

### Enabled Features
- Lambda function tracing
- Automatic subsegments for AWS SDK calls
- Custom annotations for tenant/user context
- Service map visualization

### X-Ray Segments
```
Request (2.5s total)
├── Frontend API Route (1.5s)
│   ├── Authentication (50ms)
│   ├── Rate Limit Check (10ms)
│   └── Lambda Invoke (1.4s)
└── Lambda Handler (1.4s)
    ├── JWT Validation (20ms)
    ├── Bedrock Invoke (800ms)
    ├── S3 PutObject (150ms)
    └── DynamoDB PutItem (50ms)
```

### Viewing Traces
1. AWS Console → X-Ray → Service Map
2. Filter by trace ID: `req_abc123xyz789`
3. View timeline and subsegments
4. Analyze performance bottlenecks

---

## Testing Tracing

### 1. Make Test Request
```bash
curl -X POST https://www.dev.carousellabs.co/api/bg-remover/process \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "imageUrl": "https://example.com/image.jpg"
  }'
```

### 2. Extract Trace ID from Response
```json
{
  "success": true,
  "jobId": "job_123",
  "traceId": "req_abc123xyz789"
}
```

Or from response headers:
```
x-trace-id: req_abc123xyz789
```

### 3. Query CloudWatch Logs
```sql
fields @timestamp, layer, action, duration, result
| filter traceId = "req_abc123xyz789"
| sort @timestamp asc
```

### 4. Verify Complete Flow
Expected output shows all 9 hops with timings.

---

## Best Practices

### 1. Always Include Trace ID
- In all error responses
- In response headers (`x-trace-id`)
- In support tickets

### 2. Log at Key Decision Points
- Authentication success/failure
- Rate limit checks
- Service call start/end
- Business logic branches

### 3. Avoid Logging Sensitive Data
- Never log passwords or API keys
- Redact PII (email, phone, address)
- Use hashed identifiers when possible

### 4. Use Appropriate Log Levels
- `info` - Normal operations
- `warn` - Recoverable errors, degraded performance
- `error` - Unrecoverable errors, exceptions

### 5. Include Actionable Metadata
- Service call URLs
- Status codes
- Retry counts
- Cache hit/miss

---

## Troubleshooting

### Issue: Logs Not Appearing in CloudWatch

**Solution:**
1. Check Lambda execution role has `logs:CreateLogGroup`, `logs:CreateLogStream`, `logs:PutLogEvents`
2. Verify log group exists: `/aws/lambda/{functionName}`
3. Check CloudWatch Logs console for errors

### Issue: Trace ID Not Propagating

**Solution:**
1. Verify `x-trace-id` header in request
2. Check `injectTraceId()` is called before fetch
3. Confirm Lambda extracts trace ID from headers

### Issue: X-Ray Traces Missing

**Solution:**
1. Verify `tracing.lambda: true` in serverless.yml
2. Check IAM permissions for X-Ray
3. Ensure `AWS_XRAY_TRACING_ENABLED=true` environment variable

---

## Future Enhancements

### 1. Automated Alerting
- CloudWatch Alarms for error rate > 5%
- SNS notifications for critical errors
- PagerDuty integration

### 2. Performance Monitoring
- Real-time dashboards
- P95/P99 latency tracking
- Service dependency graphs

### 3. Trace Sampling
- Reduce costs by sampling 10% of traces
- Always trace errors
- Sample based on tenant priority

### 4. Custom Metrics
- Business metrics (images processed, credits used)
- Cost attribution by tenant
- Usage patterns analysis

---

## References

- **Template:** `.claude/templates/bg-remover/4.1-tracing-implementation.template.md`
- **CloudWatch Insights:** https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/AnalyzingLogData.html
- **AWS X-Ray:** https://docs.aws.amazon.com/xray/latest/devguide/
- **Request Flow Analysis:** Agent a422770 (9 hops documented)
- **Architecture:** Agent a0459f6 (component mapping)

---

## Support

For issues or questions:
1. Check CloudWatch Insights queries first
2. Review X-Ray service map for bottlenecks
3. Search logs by trace ID
4. Contact DevOps team with trace ID and timestamp
