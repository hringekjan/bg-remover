---
title: "Layer 2 Dual-Write Deployment — bg-remover to LCP-API"
---

# Layer 2 Dual-Write Deployment — bg-remover to LCP-API

**Status:** Ready for dev deployment  
**Validation Window:** 2026-04-29 to 2026-05-01 (48 hours)  
**Success Criteria:** < 1% divergence between carousel-main and LCP-API outcomes  
**Rollback Trigger:** > 1% divergence OR LCP-API success rate < 95%

---

## Overview

This deployment enables **dual-write pattern** for bg-remover outcomes. Outcomes are now written to:

1. **Primary:** carousel-main (DynamoDB lcp-outcomes-dev) — blocking write, standard latency
2. **Secondary:** LCP-API POST /learning/outcomes/sale — fire-and-forget, async retry via DLQ
3. **Tertiary:** mem0 — knowledge store (unchanged from Phase 1)

The LCP-API write path is **non-blocking**. If it fails after 2 retries, it queues to SQS DLQ for async retry without affecting carousel-main response time.

---

## Changes Made

### Code Changes

#### 1. **outcome-dual-writer.ts** (primary implementation)

- Extended `OutcomeDualWriter` class to include triple-write logic
- Added `writeLcpApi()` method with exponential backoff (50ms → 100ms, max 2 retries)
- Added `queueToDlq()` for async retry handling
- Added `logDualWritePattern()` for CloudWatch logging with divergence detection
- Updated `emitMetrics()` to emit individual metrics for carousel-main and LCP-API
- Added outcome type mapping (`sale_event` → `sale` for LCP-API)

#### 2. **metrics.ts** (observability enhancement)

- Added `recordLcpApiSuccess()` method
- Added `recordLcpApiFailure()` method
- Added `recordDualWriteComplete()` method (both primary and secondary succeeded)
- Updated namespace documentation to reflect Layer 2 validation period

#### 3. **serverless.yml** (infrastructure configuration)

- Added environment variables:
  - `LCP_API_BASE_URL`: https://api.${stage}.carousellabs.co/lcp-api
  - `LCP_API_AUTH_TOKEN`: Retrieved from SSM SecureString
  - `LCP_API_DLQ_URL`: Retrieved from SSM SecureString (SQS endpoint)
  
- Added IAM permissions:
  - SSM GetParameter for `lcp-api-auth-token` and `lcp-api-dlq-url`
  - execute-api:Invoke for `/lcp-api/learning/outcomes/*`
  - DynamoDB permissions for `lcp-outcomes-${stage}` table

---

## Deployment Instructions

### Prerequisites

1. **SSM Parameters must be created in dev** (run by DevOps):
   ```
   /tf/dev/platform/bg-remover/lcp-api-auth-token
   /tf/dev/platform/bg-remover/lcp-api-dlq-url
   ```

2. **LCP-API must be running** and accepting POST /learning/outcomes/sale

3. **SQS DLQ must be created** for async retries:
   ```
   Queue: bg-remover-lcp-api-dlq-dev
   Visibility timeout: 300s
   Message retention: 14 days
   ```

### Step 1: Verify SSM Parameters

```bash
aws-vault exec carousel-labs-dev-admin -- \
  aws ssm get-parameter \
    --name /tf/dev/platform/bg-remover/lcp-api-auth-token \
    --with-decryption \
    --region eu-west-1

aws-vault exec carousel-labs-dev-admin -- \
  aws ssm get-parameter \
    --name /tf/dev/platform/bg-remover/lcp-api-dlq-url \
    --with-decryption \
    --region eu-west-1
```

### Step 2: Validate Configuration

```bash
cd services/platform/carousel/organisms/bg-remover

# Verify serverless.yml compiles
npx serverless print --stage dev --region eu-west-1 > /tmp/serverless-print.json

# Check environment variables
cat /tmp/serverless-print.json | jq '.provider.environment | {LCP_API_BASE_URL, LCP_API_AUTH_TOKEN, LCP_API_DLQ_URL}'
```

### Step 3: Deploy to Dev

```bash
cd services/platform/carousel/organisms/bg-remover

# Deploy the service
npx serverless deploy \
  --stage dev \
  --region eu-west-1 \
  --param="enableCloudWatchMetrics=true"

# Verify deployment
aws-vault exec carousel-labs-dev-admin -- \
  aws lambda get-function \
    --function-name bg-remover-dev-processWorker \
    --region eu-west-1 | jq '.Configuration.Environment.Variables | {LCP_API_BASE_URL, LCP_API_DLQ_URL}'
```

### Step 4: Run Smoke Tests

```bash
# Test carousel-main write (primary)
curl -X POST https://api.dev.carousellabs.co/carousel/bg-remover/process \
  -H "Authorization: Bearer ${YOUR_TOKEN}" \
  -H "x-tenant-id: carousel-labs" \
  -d '{
    "images": [{"filename": "test.jpg", "isPrimary": true}],
    "productName": "Test Product"
  }' \
  | jq '.jobId' > /tmp/jobid.txt

JOB_ID=$(cat /tmp/jobid.txt | tr -d '"')

# Poll for completion
sleep 5
curl https://api.dev.carousellabs.co/carousel/bg-remover/status/$JOB_ID \
  -H "x-tenant-id: carousel-labs" \
  | jq '.result'
```

---

## Validation & Monitoring

### CloudWatch Metrics (Namespace: `bg-remover/outcomes`)

**Individual Write Success Rates:**
- `carousel-main-success` / `carousel-main-failure` (primary)
- `lcp-api-success` / `lcp-api-failure` (secondary)
- `mem0-success` / `mem0-failure` (knowledge store)

**Dual-Write Metrics:**
- `dual-write-complete` — both primary and secondary succeeded
- `dual-write-discrepancy` — one write succeeded, another failed (ALARM trigger)

**Log Patterns (CloudWatch Logs):**

Success:
```json
{
  "timestamp": "2026-04-29T10:15:30.000Z",
  "jobId": "job_abc123",
  "tenantId": "carousel-labs",
  "outcomeType": "sale_event",
  "writes": {
    "carouselMain": { "success": true, "retries": 0, "error": null },
    "lcpApi": { "success": true, "retries": 1, "error": null },
    "mem0": { "success": true, "retries": 0, "error": null }
  },
  "discrepancy": false
}
```

Divergence (triggers alarm):
```json
{
  "timestamp": "2026-04-29T10:15:31.000Z",
  "jobId": "job_xyz789",
  "tenantId": "carousel-labs",
  "outcomeType": "sale_event",
  "writes": {
    "carouselMain": { "success": true, "retries": 0, "error": null },
    "lcpApi": { "success": false, "retries": 2, "error": "LCP-API returned 503: Service Unavailable" },
    "mem0": { "success": true, "retries": 0, "error": null }
  },
  "discrepancy": true
}
```

### CloudWatch Alarms (to be created)

**1. Divergence Rate Alarm**
```
Metric: dual-write-discrepancy
Threshold: 10 in 5 minutes (>1% if ~1000 outcomes/hour)
Action: SNS → alerts@carousellabs.co
```

**2. LCP-API Failure Rate Alarm**
```
Metric: lcp-api-failure / (lcp-api-success + lcp-api-failure)
Threshold: > 5% in 5 minutes
Action: SNS → alerts@carousellabs.co
```

**3. DLQ Queue Depth Alarm**
```
Metric: ApproximateNumberOfMessagesVisible (SQS)
Threshold: > 100 messages
Action: SNS → alerts@carousellabs.co
```

### Validation Checklist (48-hour window: 2026-04-29 00:00 to 2026-05-01 00:00)

- [ ] Deploy to dev at 2026-04-29 10:00 UTC
- [ ] Monitor LCP-API success rate: target > 95%
- [ ] Monitor carousel-main success rate: must remain 100%
- [ ] Calculate divergence: (dual-write-discrepancy / total) < 1%
- [ ] Check DLQ queue depth: monitor for accumulation
- [ ] Verify CloudWatch logs contain expected dual-write patterns
- [ ] Confirm no LCP-API errors are blocking carousel-main responses
- [ ] Check per-tenant metrics for even distribution

### Query CloudWatch Logs

```bash
# Count successful dual-writes
aws-vault exec carousel-labs-dev-admin -- \
  aws logs filter-log-events \
    --log-group-name /aws/lambda/bg-remover-dev-processWorker \
    --filter-pattern "[*, writes.carouselMain.success=true && writes.lcpApi.success=true]" \
    --start-time 1682764800000 \
    --region eu-west-1 | jq '.events | length'

# Count divergence events
aws-vault exec carousel-labs-dev-admin -- \
  aws logs filter-log-events \
    --log-group-name /aws/lambda/bg-remover-dev-processWorker \
    --filter-pattern '[*, "Divergence detected"]' \
    --start-time 1682764800000 \
    --region eu-west-1 | jq '.events | length'
```

### Query CloudWatch Metrics

```bash
aws-vault exec carousel-labs-dev-admin -- \
  aws cloudwatch get-metric-statistics \
    --namespace bg-remover/outcomes \
    --metric-name lcp-api-success \
    --start-time 2026-04-29T00:00:00Z \
    --end-time 2026-05-01T00:00:00Z \
    --period 3600 \
    --statistics Sum \
    --region eu-west-1 | jq '.Datapoints | sort_by(.Timestamp)'
```

---

## Rollback Plan

### Trigger Rollback If:

1. **LCP-API success rate < 95%** for 15+ minutes
2. **Divergence rate > 1%** (≥1 in 100 outcomes mismatched)
3. **carousel-main latency increases > 500ms** (compared to baseline)
4. **DLQ queue accumulates > 1000 messages** without draining

### Rollback Steps

**Option A: Disable LCP-API writes (keep carousel-main)**

```typescript
// In outcome-dual-writer.ts, update writeOutcome:
const [mem0Result, ddbResult] = await Promise.allSettled([
  this.writeMem0(outcome),
  this.writeDynamoDB(outcome),
  // this.writeLcpApi(outcome),  // COMMENTED OUT
]);
```

Redeploy:
```bash
npx serverless deploy --stage dev --region eu-west-1
```

**Option B: Full rollback to Phase 1 (mem0 + DDB only)**

```bash
# Revert to last known good commit
git revert HEAD --no-edit
npx serverless deploy --stage dev --region eu-west-1
```

**Post-Rollback:**
1. Notify #devops-alerts slack channel
2. Create RCA task in TaskHarbinger
3. Investigate LCP-API logs for root cause
4. Schedule remediation meeting

---

## Post-Deployment Tasks

### Week 1 (Phase 2 — 2026-05-06)

- [ ] Review divergence metrics — confirm < 1%
- [ ] Review LCP-API success rate — confirm > 98%
- [ ] Update documentation with 48h validation results
- [ ] Archive CloudWatch logs for analysis
- [ ] Schedule promotion to stage (if approved)

### Week 3+ (Phase 3 — Cleanup, if approved)

- [ ] Remove mem0 writes if LCP-API stable
- [ ] Remove DynamoDB fallback (keep only LCP-API)
- [ ] Deprecate `outcome-dual-writer.ts`
- [ ] Update documentation

---

## DLQ Async Retry Handler

Create Lambda for processing DLQ:

```typescript
// services/platform/carousel/organisms/bg-remover/src/handlers/lcp-api-dlq-handler.ts
import { SQSEvent } from 'aws-lambda';
import { OutcomeDualWriter } from '../lib/outcomes/outcome-dual-writer';

const writer = new OutcomeDualWriter();

export async function handler(event: SQSEvent): Promise<void> {
  for (const record of event.Records) {
    const message = JSON.parse(record.body);
    
    // Increment retry count
    message.retryCount = (message.retryCount || 0) + 1;
    
    if (message.retryCount > 5) {
      console.error(`[DLQ] Max retries exceeded: ${message.jobId}`);
      // TODO: Send to dead-letter-queue (DLQ) or alert
      continue;
    }

    try {
      // Retry LCP-API write
      const result = await writer.writeLcpApi(message);
      
      if (result.success) {
        console.log(`[DLQ] Retry succeeded: ${message.jobId}`);
        // Delete from queue
      } else {
        console.warn(`[DLQ] Retry failed: ${message.jobId}, re-queuing`);
        // Re-queue with exponential backoff
      }
    } catch (error) {
      console.error(`[DLQ] Error processing message:`, error);
    }
  }
}
```

---

## Support & Questions

For questions during validation window, contact:
- **Architecture:** platform-architecture@carousellabs.co
- **Operations:** #devops-alerts on Slack
- **Escalation:** CTO on-call (via PagerDuty)

---

## References

- LCP-API Handler: `services/platform/lcp-api/src/handlers/outcomes.ts`
- Event Emitter (Phase 1): `services/platform/carousel/organisms/bg-remover/src/lib/lcp-event-emitter.ts`
- Dual-Write Architecture: `services/platform/lcp-api/docs/reference/archive/2026-02-bg-remover-prd/LAYER2-DUAL-WRITE.md`
- Serverless Config: `services/platform/carousel/organisms/bg-remover/serverless.yml`
