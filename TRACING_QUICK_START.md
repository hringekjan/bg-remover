# Request Tracing Quick Start Guide

**5-Minute Guide to Debugging with Traces**

---

## Step 1: Get Trace ID

### Option A: From API Response
```json
{
  "success": true,
  "jobId": "job_123",
  "traceId": "req_abc123xyz789"
}
```

### Option B: From Response Headers
```bash
curl -v https://www.dev.carousellabs.co/api/bg-remover/process
# Look for:
# x-trace-id: req_abc123xyz789
```

### Option C: From Error Message
```json
{
  "error": "Processing failed",
  "traceId": "req_abc123xyz789"
}
```

---

## Step 2: View Full Request Flow

### CloudWatch Insights Query
```sql
fields @timestamp, layer, action, duration, result
| filter traceId = "req_abc123xyz789"
| sort @timestamp asc
```

### Where to Run
1. AWS Console → CloudWatch → Log Insights
2. Select log group: `/aws/lambda/carousel-frontend-dev`
3. Add log group: `/aws/lambda/bg-remover-dev-process`
4. Paste query above
5. Click "Run query"

### Expected Output
```
@timestamp               layer       action                   duration  result
2026-01-02T14:30:00.123  api-route   bg-remover:process       1523      success
2026-01-02T14:30:00.150  lambda      bg-remover:process       1450      success
2026-01-02T14:30:00.200  lambda      service:bedrock:invoke   800       success
2026-01-02T14:30:01.100  lambda      service:s3:putObject     150       success
```

---

## Step 3: Find the Error

### If Request Failed
```sql
fields @timestamp, error.message, error.stack, metadata
| filter traceId = "req_abc123xyz789" and result = "error"
| sort @timestamp asc
```

### Common Errors

**404 Not Found:**
```sql
fields @timestamp, action, metadata.statusCode, error.message
| filter traceId = "req_abc123xyz789" and metadata.statusCode = 404
```

**Timeout:**
```sql
fields @timestamp, action, duration, error.message
| filter traceId = "req_abc123xyz789" and duration > 30000
```

**Auth Failure:**
```sql
fields @timestamp, action, error.message
| filter traceId = "req_abc123xyz789" and action like /^auth/
```

---

## Step 4: Check Service Performance

### Which service was slow?
```sql
fields @timestamp, action, duration
| filter traceId = "req_abc123xyz789" and action like /^service:/
| sort duration desc
```

### Example Output
```
action                       duration
service:bedrock:invoke       2500      ← SLOW!
service:s3:putObject         150
service:dynamodb:putItem     50
```

---

## Step 5: View X-Ray Trace (Visual)

1. AWS Console → X-Ray → Traces
2. Filter by Trace ID: `req_abc123xyz789`
3. Click trace to see timeline
4. View service map

### What You'll See
- Visual timeline of all service calls
- Subsegments for AWS SDK calls
- Performance bottlenecks highlighted
- Error locations marked in red

---

## Common Debugging Scenarios

### Scenario 1: "My request returned 404"

**Query:**
```sql
fields @timestamp, layer, action, metadata.statusCode
| filter traceId = "YOUR_TRACE_ID" and metadata.statusCode = 404
| sort @timestamp asc
```

**Root Cause:**
- Check which layer returned 404
- If `api-route`: Route not configured in Next.js
- If `lambda`: Lambda function not deployed or wrong path
- If `backend-api`: S3 object not found

### Scenario 2: "My request is slow"

**Query:**
```sql
fields @timestamp, action, duration
| filter traceId = "YOUR_TRACE_ID"
| sort duration desc
```

**Root Cause:**
- Look at longest duration
- If `service:bedrock:invoke`: Bedrock API slow (normal)
- If `service:s3:putObject`: Large image upload
- If `lambda`: Cold start or memory issue

### Scenario 3: "Request failed with 500 error"

**Query:**
```sql
fields @timestamp, error.message, error.stack, metadata
| filter traceId = "YOUR_TRACE_ID" and result = "error"
```

**Root Cause:**
- Read `error.message` for details
- Check `error.stack` for code location
- Review `metadata` for context

### Scenario 4: "Credits not deducted"

**Query:**
```sql
fields @timestamp, action, metadata.creditsUsed, metadata.newBalance
| filter traceId = "YOUR_TRACE_ID" and action like /^credits/
```

**Root Cause:**
- Check if `credits:debit` succeeded
- If `credits:refund` present: Processing failed
- If no credit logs: Credits not required (dev mode)

---

## Pro Tips

### 1. Search Last Hour Only
Always set time range to "Last 1 hour" in CloudWatch console (faster queries)

### 2. Use Short Trace IDs
Trace IDs are unique, so search by last 8 characters:
```sql
filter traceId like /xyz789/
```

### 3. Save Frequent Queries
Click "Save" in CloudWatch Insights to reuse queries

### 4. Export Results
Click "Export results" to download CSV for analysis

### 5. Set Up Alarms
Create CloudWatch Alarms for:
- Error rate > 5%
- P99 latency > 3s
- No requests in 1 hour

---

## Quick Reference

### Get All Jobs for User
```sql
fields @timestamp, jobId, action, result
| filter userId = "user_123"
| sort @timestamp desc
| limit 50
```

### Find Recent Errors
```sql
fields @timestamp, traceId, error.message, action
| filter level = "error"
| sort @timestamp desc
| limit 20
```

### Performance Stats (Last Hour)
```sql
fields duration
| filter action = "bg-remover:process" and result = "success"
| stats avg(duration) as avg_ms,
        pct(duration, 50) as p50,
        pct(duration, 90) as p90,
        pct(duration, 99) as p99
```

### Error Rate by Endpoint
```sql
stats count(*) as total,
      sum(result = "error") as errors,
      (sum(result = "error") / count(*)) * 100 as error_rate
  by action
| sort error_rate desc
```

---

## Cost Impact

**Per Query:**
- Scans 10-100MB of data
- Cost: ~$0.0005 (half a cent)

**Monthly (50 queries/day):**
- 1500 queries
- Cost: $0.75/month

**Negligible cost for debugging value!**

---

## Need Help?

1. Check full documentation: `TRACING_IMPLEMENTATION_SUMMARY.md`
2. Review all queries: `cloudwatch-insights-queries.md`
3. Contact DevOps with trace ID + timestamp
4. Include X-Ray trace link if available

---

## Deployment Checklist

- [ ] Deploy bg-remover service with X-Ray enabled
- [ ] Deploy carousel-frontend with trace integration
- [ ] Make test request and verify trace ID in response
- [ ] Run CloudWatch Insights query to verify logs
- [ ] Check X-Ray console for trace visibility
- [ ] Set up CloudWatch alarms for errors/latency
- [ ] Share this guide with team

---

**Happy Debugging!** 🔍
