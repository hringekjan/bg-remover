# CloudWatch Insights Queries for bg-remover Service

**Purpose:** Debug request flows, performance issues, and errors across the entire bg-remover pipeline.

**Log Groups to Query:**
- `/aws/lambda/carousel-frontend-dev` (Next.js API routes)
- `/aws/lambda/bg-remover-dev-process` (Lambda handler)
- `/aws/lambda/bg-remover-dev-processWorker` (Background worker)

---

## 1. Find All Requests for Specific Job ID

**Use Case:** Trace complete request flow from frontend → Lambda → S3

```sql
fields @timestamp, layer, action, duration, result, metadata
| filter jobId = "job_YOUR_JOB_ID_HERE"
| sort @timestamp asc
| display @timestamp, layer, action, duration, result, metadata
```

**Expected Output:**
```
@timestamp               layer       action                   duration  result
2026-01-02T14:30:00.123Z api-route   bg-remover:process       1523      success
2026-01-02T14:30:00.150Z lambda      bg-remover:process       1450      success
2026-01-02T14:30:01.200Z lambda      service:bedrock:invoke   800       success
2026-01-02T14:30:01.600Z lambda      service:s3:putObject     150       success
```

---

## 2. Find All 404 Errors

**Use Case:** Debug CloudFront cache misses, missing routes

```sql
fields @timestamp, traceId, action, error.message, metadata.statusCode
| filter result = "error" and metadata.statusCode = 404
| sort @timestamp desc
| limit 100
```

**Follow-up:** Use `traceId` to find full request context:
```sql
fields @timestamp, layer, action, duration, result
| filter traceId = "req_abc123xyz789"
| sort @timestamp asc
```

---

## 3. Find Slow Requests (>2s)

**Use Case:** Identify performance bottlenecks

```sql
fields @timestamp, traceId, action, duration, tenantId, userId
| filter duration > 2000 and result = "success"
| sort duration desc
| limit 50
```

**Drill Down:** Check which service call was slow:
```sql
fields @timestamp, action, duration, metadata
| filter traceId = "req_slow_trace_id" and action like /^service:/
| sort duration desc
```

---

## 4. Error Rate by Endpoint

**Use Case:** Monitor service health

```sql
fields action, result
| filter layer = "api-route"
| stats count(*) as total,
        sum(result = "error") as errors,
        (sum(result = "error") / count(*)) * 100 as error_rate
  by action
| sort error_rate desc
```

**Expected Output:**
```
action                   total  errors  error_rate
bg-remover:process       1000   25      2.5%
bg-remover:status        500    5       1.0%
```

---

## 5. Request Duration Percentiles

**Use Case:** Understand typical performance

```sql
fields duration
| filter action = "bg-remover:process" and result = "success"
| stats avg(duration) as avg_ms,
        pct(duration, 50) as p50,
        pct(duration, 90) as p90,
        pct(duration, 99) as p99
```

**Expected Output:**
```
avg_ms  p50    p90    p99
1234    1100   1800   2500
```

---

## 6. Trace Full Request Path (All 9 Hops)

**Use Case:** See complete request flow with timings

```sql
fields @timestamp, layer, action, duration, result
| filter traceId = "req_abc123xyz789"
| sort @timestamp asc
| display @timestamp, layer, action, duration, result, metadata
```

**Expected 9-Hop Flow:**
1. **api-route**: `bg-remover:process` (start)
2. **lambda**: `bg-remover:process` (handler invoked)
3. **lambda**: `service:jwt:validate` (authentication)
4. **lambda**: `service:bedrock:invoke` (image processing)
5. **lambda**: `service:s3:putObject` (upload processed image)
6. **lambda**: `service:dynamodb:putItem` (store job status)
7. **lambda**: `service:eventbridge:putEvents` (emit event)
8. **lambda**: `bg-remover:process` (complete)
9. **api-route**: `bg-remover:process` (response sent)

---

## 7. Find Authentication Failures

**Use Case:** Debug JWT validation issues

```sql
fields @timestamp, userId, error.message, metadata
| filter action like /^auth/ and result = "error"
| sort @timestamp desc
| limit 100
```

---

## 8. Service Call Performance Analysis

**Use Case:** Identify slow external service calls

```sql
fields @timestamp, action, duration, metadata
| filter action like /^service:/
| stats avg(duration) as avg_ms,
        pct(duration, 90) as p90,
        max(duration) as max_ms,
        count(*) as call_count
  by action
| sort avg_ms desc
```

**Expected Output:**
```
action                       avg_ms  p90    max_ms  call_count
service:bedrock:invoke       800     1200   2500    1000
service:s3:putObject         150     200    500     1000
service:dynamodb:putItem     50      80     150     1000
```

---

## 9. Credits Debit/Refund Tracking

**Use Case:** Audit credit transactions

```sql
fields @timestamp, userId, action, metadata.creditsUsed, metadata.newBalance, metadata.transactionId
| filter action like /^credits/
| sort @timestamp desc
| limit 100
```

---

## 10. Recent Errors with Context

**Use Case:** Quick error investigation

```sql
fields @timestamp, traceId, action, error.message, error.code, metadata
| filter level = "error"
| sort @timestamp desc
| limit 50
```

---

## 11. Request Volume by Tenant

**Use Case:** Multi-tenant usage analysis

```sql
fields tenantId, action, result
| filter layer = "api-route"
| stats count(*) as request_count,
        sum(result = "success") as success_count,
        sum(result = "error") as error_count
  by tenantId, action
| sort request_count desc
```

---

## 12. Cache Hit/Miss Analysis

**Use Case:** Evaluate cache effectiveness

```sql
fields @timestamp, action, metadata.hopResult, metadata.cacheKey
| filter action like /^hop:cloudfront/
| stats count(*) as total,
        sum(metadata.hopResult = "hit") as hits,
        sum(metadata.hopResult = "miss") as misses,
        (sum(metadata.hopResult = "hit") / count(*)) * 100 as hit_rate
```

---

## Usage Tips

### 1. Filter by Time Range
Always specify time range in CloudWatch console (e.g., last 1 hour, last 24 hours)

### 2. Use Trace IDs for Debugging
1. Get `traceId` from API response headers (`x-trace-id`)
2. Use Query #1 to see full request flow
3. Identify slow hops or errors

### 3. Set Up CloudWatch Alarms
Create alarms based on these queries:
- Error rate > 5%
- P99 latency > 3s
- Cache hit rate < 80%

### 4. Export Results
Use CloudWatch "Export results" to CSV for analysis in Excel/Sheets

---

## Cost Estimate

**CloudWatch Logs Insights Pricing:**
- $0.005 per GB of data scanned
- Typical query scans 10MB-100MB
- Cost per query: ~$0.0005 (negligible)

**Monthly Cost (50 queries/day):**
- 50 queries/day × 30 days = 1500 queries
- 1500 × $0.0005 = $0.75/month

---

## Next Steps

1. **Create CloudWatch Dashboard:**
   - Add top 5 queries as widgets
   - Refresh every 5 minutes
   - Share with team

2. **Set Up Alarms:**
   - Error rate > 5%
   - Latency P99 > 3s
   - No requests in 1 hour (service down)

3. **Automate Incident Response:**
   - SNS topic for alarms
   - Lambda to analyze traces
   - Slack/email notifications
