---
title: "Wave 3: Dual-Write Monitoring — Deployment Guide"
---

# Wave 3: Dual-Write Monitoring — Deployment Guide

**Timeline:** Post-LCP-API deployment (2026-04-29)
**Validation Window:** 2026-04-29 to 2026-05-01 (48 hours)
**Decision Gate:** 2026-05-01 00:00 UTC

---

## Overview

Wave 3 adds comprehensive monitoring to the bg-remover dual-write system. The monitoring stack includes:

1. **6-hourly divergence checks** — Query outcomes from both carousel-main and lcp-outcomes, compare critical fields
2. **CloudWatch dashboard** — Real-time visibility into write health metrics
3. **Automated alerts** — SNS + Slack notifications when divergence > 1%
4. **Decision gate automation** — Post-48h decision logic to proceed to Layer 2 or rollback

---

## Files Modified/Created

| File | Purpose | Status |
|------|---------|--------|
| `src/handlers/divergence-check.handler.ts` | 6h divergence check Lambda | NEW |
| `src/handlers/divergence-notifier.handler.ts` | Slack alert sender | NEW |
| `docs/operations/DUAL-WRITE-MONITORING-WAVE3.md` | Full monitoring specification | NEW |
| `docs/operations/WAVE3-MONITORING-RESOURCES.yml` | CloudFormation resources (functions, alarms, dashboard) | NEW |
| `serverless.yml` | Add functions and resources from WAVE3-MONITORING-RESOURCES.yml | MODIFIED |
| `docs/operations/WAVE3-DECISION-GATE-TEMPLATE.md` | Post-48h decision documentation template | NEW |

---

## Pre-Deployment Checklist

- [ ] LCP-API is deployed to dev/staging (Wave 2 complete)
- [ ] bg-remover `outcome-dual-writer.ts` is active (dual-writing to both systems)
- [ ] Slack webhook URL obtained and stored in SSM Parameter Store:
  ```bash
  aws ssm put-parameter \
    --name /bg-remover/slack-webhook-dev \
    --value "https://hooks.slack.com/services/YOUR/WEBHOOK/URL" \
    --type SecureString \
    --region eu-west-1
  ```
- [ ] Platform squad notified of 48-hour validation window
- [ ] Oncall rotation updated to watch divergence alerts during 2026-04-29 to 2026-05-01

---

## Deployment Steps

### Step 1: Merge Monitoring Resources into serverless.yml

The `WAVE3-MONITORING-RESOURCES.yml` file contains function definitions and CloudFormation resources that must be integrated into `serverless.yml`.

**Option A: Manual Integration (Recommended for review)**

1. Open `/bg-remover/serverless.yml`
2. Locate the `functions:` section (line ~463)
3. Add the two new functions from `WAVE3-MONITORING-RESOURCES.yml`:
   - `divergenceCheck`
   - `divergenceNotifier`
4. Locate the `resources: Resources:` section (line ~1032)
5. Add all SNS topics, alarms, and dashboard from `WAVE3-MONITORING-RESOURCES.yml`
6. Update the `provider: environment:` section to include:
   ```yaml
   CAROUSEL_MAIN_TABLE: carousel-main-${self:provider.stage}
   LCP_OUTCOMES_TABLE: lcp-outcomes-${self:provider.stage}
   DIVERGENCE_ALERT_TOPIC_ARN: !Ref DivergenceAlertTopic  # CloudFormation reference
   ```

**Option B: Automated Integration (via script)**

```bash
# TODO: Provide a merge script if available
# For now, manual integration ensures review and understanding
```

### Step 2: Verify TypeScript Compilation

```bash
cd /Users/davideagle/git/CarouselLabs/enterprise-packages/services/platform/carousel/organisms/bg-remover

# Build handlers
npm run build

# Verify compiled output
ls -la dist/handlers/divergence-check.handler.js
ls -la dist/handlers/divergence-notifier.handler.js
```

### Step 3: Validate Serverless Configuration

```bash
# Dry-run to validate CloudFormation template
serverless print --stage dev > /tmp/bg-remover-wave3-cfn.yml

# Check for errors (optional: manually review the output)
echo "CloudFormation template validation:"
cat /tmp/bg-remover-wave3-cfn.yml | grep -A 5 "DivergenceAlertTopic"  # Should see SNS topic defined
```

### Step 4: Deploy Monitoring Stack

```bash
# Deploy to dev
serverless deploy --stage dev --region eu-west-1

# Monitor deployment output
# Expected: 3 new Lambda functions, 1 SNS topic, 4 alarms, 1 CloudWatch dashboard
```

### Step 5: Verify Post-Deployment

```bash
# 1. Check Lambda functions created
aws lambda list-functions --region eu-west-1 | grep bg-remover | grep -E "divergence|notifier"

# 2. Check SNS topic created
aws sns list-topics --region eu-west-1 | grep divergence-alert

# 3. Check CloudWatch alarms created
aws cloudwatch describe-alarms --region eu-west-1 | grep bg-remover-divergence

# 4. Check CloudWatch dashboard created
aws cloudwatch list-dashboards --region eu-west-1 | grep DualWrite-Validation

# 5. Verify Slack webhook URL in SSM
aws ssm get-parameter \
  --name /bg-remover/slack-webhook-dev \
  --with-decryption \
  --region eu-west-1
```

### Step 6: Manual Test of Divergence Check (Optional)

Invoke the divergence-check Lambda manually to verify it works:

```bash
# Invoke with test event
aws lambda invoke \
  --function-name bg-remover-dev-divergence-check \
  --payload '{"checkWindow": 6}' \
  --region eu-west-1 \
  /tmp/divergence-check-response.json

# Check response
cat /tmp/divergence-check-response.json
```

Expected output:
```json
{
  "checkWindow": 6,
  "timeRange": {...},
  "carouselMainCount": N,
  "lcpApiCount": M,
  "matchedCount": M,
  "divergenceCount": 0,
  "divergencePercentage": 0,
  "status": "PASS",
  "recommendations": []
}
```

### Step 7: Manual Test of Alert (Optional)

Publish a test SNS message to trigger the divergence-notifier:

```bash
aws sns publish \
  --topic-arn arn:aws:sns:eu-west-1:ACCOUNT:bg-remover-divergence-alert-dev \
  --message '{"status":"WARN","divergencePercentage":0.5,"checkWindow":6,"carouselMainCount":1000,"lcpApiCount":995,"matchedCount":990,"divergenceCount":10,"divergenceEvents":[],"recommendations":["Monitor closely"],"timeRange":{"start":"2026-04-29T00:00:00Z","end":"2026-04-29T06:00:00Z"}}' \
  --region eu-west-1
```

Check Slack channel `#platform-alerts` for the formatted message.

---

## Monitoring During Validation Window

### Dashboard Access

1. Open CloudWatch console
2. Navigate to Dashboards
3. Select "bg-remover-DualWrite-Validation"

**Key Metrics to Watch:**

- **Divergence %:** Should remain < 1% (green zone)
- **Write Latency p99:** Carousel-main < 500ms, LCP-API < 600ms
- **DLQ Depth:** Should remain < 10 (messages processed quickly)
- **Success Rates:** Both systems should exceed 99%

### CloudWatch Logs Insights Queries

Useful queries for monitoring during the 48-hour window:

```
# Divergence summary by hour
fields @timestamp, divergencePercentage, divergenceCount, carouselMainCount
| filter @message like /DIVERGENCE_CHECK_COMPLETE/
| stats max(divergencePercentage) as maxDivergence, sum(divergenceCount) as totalDivergences by bin(1h)

# Divergence event details
fields @timestamp, outcomeId, divergenceReason, carouselStatus, lcpStatus
| filter @message like /DIVERGENCE_DETECTED/
| sort @timestamp desc
| limit 100

# Success rate calculation
fields @message
| filter @message like /dual-write-success/ or @message like /dual-write-failure/
| stats count_if(@message like /success/) as successCount, count_if(@message like /failure/) as failureCount
| fields (successCount / (successCount + failureCount)) * 100 as successPercentage
```

### Alert Response Procedure

If you receive a Slack alert during the validation window:

1. **Status: WARN (0.5–1% divergence)**
   - Check the dashboard for trends
   - Investigate sample divergent records listed in alert
   - No immediate action required; continue monitoring

2. **Status: FAIL (≥1% divergence)**
   - Immediately notify platform squad
   - Check CloudWatch logs for error patterns
   - Prepare for potential rollback
   - Do not enable Layer 2 event topology until root cause is identified

---

## Post-48h Decision Gate (2026-05-01 00:00 UTC)

### Decision Workflow

1. **Gather metrics** (automated script or manual query):
   ```bash
   # Query final divergence stats
   aws logs start-query \
     --log-group-name /aws/lambda/bg-remover-dev-divergence-check \
     --start-time $(date -d '48 hours ago' +%s) \
     --end-time $(date +%s) \
     --query-string 'fields divergencePercentage, divergenceCount, carouselMainCount | filter @message like /DIVERGENCE_CHECK_COMPLETE/ | stats max(divergencePercentage) as maxDivergence, avg(divergencePercentage) as avgDivergence, sum(divergenceCount) as totalDivergences'
   ```

2. **Complete decision document** (`docs/operations/WAVE3-DECISION-GATE-{DATE}.md`)
   - Use template provided in `WAVE3-DECISION-GATE-TEMPLATE.md`
   - Fill in actual metrics from queries above
   - Document any incidents or anomalies

3. **Decision:**
   - **PROCEED (✅):** All criteria met → Enable Layer 2 (SNS topic activation)
   - **ROLLBACK (❌):** Divergence ≥ 1% or critical incidents → Disable dual-write
   - **EXTEND:** Gray zone → Extend window by 24h, re-evaluate

### Proceeding to Layer 2

If decision is PROCEED:

1. Activate SNS→Lambda routes:
   ```bash
   # SNS topics are already created, just activate subscriptions
   aws sns set-topic-attributes \
     --topic-arn arn:aws:sns:eu-west-1:ACCOUNT:lcp-vendor-approval-events-dev \
     --attribute-name DeliveryPolicy \
     --attribute-value '{"http":{"defaultHealthyRetryPolicy":{"minDelayTarget":20,"maxDelayTarget":20,"numRetries":3,"numMaxDelayThresholds":0,"numNoDelayTransitions":0,"numWithExponentialBackoff":false,"maxReceiveCount":null},"disableSubscriptionOverrides":false}}'
   ```

2. Monitor for 7 days post-activation
3. File TaskHarbinger task: "Layer 2 Event Topology Activation (Wave 3 success)"

### Rolling Back

If decision is ROLLBACK:

```bash
# Disable dual-write in bg-remover
aws lambda update-function-configuration \
  --function-name bg-remover-dev-processWorker \
  --environment Variables={DUAL_WRITE_ENABLED=false} \
  --region eu-west-1

# Drain DLQ
aws lambda invoke \
  --function-name lcp-api-dev-dlq-processor \
  --invocation-type RequestResponse \
  --payload '{"triggerReason":"manual-rollback"}' \
  --region eu-west-1 \
  /tmp/dlq-drain-response.json

# Create postmortem task
# File: TaskHarbinger → Create task "BG-Remover Dual-Write Rollback — Root Cause Analysis"
```

---

## Maintenance & Cleanup

### Post-Validation Window (after 2026-05-01)

If proceeding to Layer 2:

1. **Keep monitoring active** — divergence-check continues running every 6h
2. **Archive decision document** → `docs/operations/decisions/WAVE3-DECISION-{DATE}/`
3. **Update PRD** → Mark Wave 3 as complete in `prd-carousel-learnings.md`
4. **Schedule Layer 2 review** → 7 days post-activation

If rollback occurred:

1. **Disable divergence-check** (comment out event in serverless.yml or delete function)
2. **Keep dashboard for historical analysis** — useful for postmortem
3. **Schedule retry** → Minimum 14 days after root cause fix deployed

---

## Troubleshooting

### Divergence Check Fails to Execute

**Symptoms:** CloudWatch dashboard shows no new data points after 6h

**Diagnosis:**
```bash
# Check CloudWatch Logs for errors
aws logs tail /aws/lambda/bg-remover-dev-divergence-check --follow

# Check IAM role permissions
aws iam get-role-policy \
  --role-name bg-remover-dev-divergenceCheck-role \
  --policy-name ...  # Should have DynamoDB:Query on both tables
```

**Fix:** Ensure IAM role has permissions to query both carousel-main and lcp-outcomes tables.

### Slack Notifications Not Received

**Symptoms:** Alert fires but no Slack message appears

**Diagnosis:**
```bash
# Check divergence-notifier logs
aws logs tail /aws/lambda/bg-remover-dev-divergence-notifier --follow

# Verify Slack webhook URL
aws ssm get-parameter --name /bg-remover/slack-webhook-dev --with-decryption
```

**Fix:** Verify webhook URL is valid and Slack app has permission to post to #platform-alerts.

### Divergence Detected but Should Be 0%

**Symptoms:** Non-zero divergence when systems should be in sync

**Diagnosis:**
```bash
# Query specific divergent outcomes
aws logs start-query \
  --log-group-name /aws/lambda/bg-remover-dev-divergence-check \
  --start-time ... \
  --query-string 'fields divergenceReason | filter divergenceReason like /missing_lcp|missing_carousel|field_mismatch/ | stats count() by divergenceReason'
```

**Fix:** Depends on divergence reason:
- `missing_lcp` → Check if lcp-outcomes table is receiving writes
- `missing_carousel` → Should not happen; investigate dual-writer logic
- `field_mismatch` → Check timestamp/accuracy tolerance thresholds

---

## Related Documentation

- `DUAL-WRITE-MONITORING-WAVE3.md` — Full monitoring specification
- `WAVE3-DECISION-GATE-TEMPLATE.md` — Post-48h decision document template
- `src/lib/outcome-dual-writer.ts` — Dual-write implementation details
- `services/platform/lcp-api/docs/reference/prd-carousel-learnings.md` — Layer 2 gating criteria

---

## Support & Escalation

**Questions during deployment:**
- Reach out to platform squad on Slack #platform-engineering

**Alert fires during 48h window:**
- Slack message includes dashboard link and escalation instructions
- Oncall engineer should acknowledge and assess divergence reason

**Rollback needed:**
- Follow "Rolling Back" section above
- File postmortem task for root cause analysis

---

**Created:** 2026-04-29
**Target Deployment:** 2026-04-29 (post-LCP-API Wave 2)
**Validation Window:** 2026-04-29 to 2026-05-01
**Decision Gate:** 2026-05-01 00:00 UTC
