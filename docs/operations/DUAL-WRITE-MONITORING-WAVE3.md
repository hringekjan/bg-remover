---
title: "Wave 3: Dual-Write Monitoring for BG-Remover Outcome Posting"
---

# Wave 3: Dual-Write Monitoring for BG-Remover Outcome Posting

**Status:** Configuration & Implementation
**Timeline:** 2026-04-29 to 2026-05-01 (48h comparison window)
**Decision Gate:** Post-48h success criteria validation
**Primary Target:** < 1% divergence between carousel-main and lcp-api outcomes

---

## 1. Context

After LCP-API deployment (Wave 2, 2026-04-29), bg-remover begins dual-writing outcomes to:
- **Primary (carousel-main):** Original DynamoDB table in carousel service
- **Secondary (lcp-api):** `lcp-outcomes-{stage}` table for learning loop

Both writes operate in parallel with independent retry logic (see `src/lib/outcome-dual-writer.ts`).
Metric emission and divergence tracking are already instrumented.

---

## 2. CloudWatch Dashboard: "bg-remover-DualWrite-Validation"

Dashboard purpose: Real-time visibility into dual-write health during 48-hour window.

### 2.1 Key Metrics

| Metric Name | Source | Target | Purpose |
|-------------|--------|--------|---------|
| **Dual-Write Success %** | `bg-remover/dual-write-success` | > 99.5% | Overall outcome posting success across both systems |
| **Carousel-Main Write Success %** | `bg-remover/carousel/write-success` | > 99.8% | Primary system write health |
| **LCP-API Write Success %** | `bg-remover/lcp-outcomes/write-success` | > 99% | Secondary system write health |
| **Divergence Count (6h)** | `bg-remover/divergence-detected` (Sum) | < 1 per 6h cohort | One-sided write failures |
| **Divergence %** | `(DivergenceCount / TotalWrites) * 100` (custom metric) | < 1% | Computed health ratio |
| **Write Latency — Carousel-Main (p99)** | `bg-remover/carousel-main/write-duration` | < 500ms | Primary system performance |
| **Write Latency — LCP-API (p99)** | `bg-remover/lcp-outcomes/write-duration` | < 600ms | Secondary system performance |
| **Latency Delta (p99)** | `LcpApi_p99 - CarouselMain_p99` | < 100ms | Consistency indicator |
| **DLQ Message Count** | AWS/SQS `ApproximateNumberOfMessagesVisible` | 0 | Failed write accumulation |
| **Mem0 Cloud API Failures (6h)** | `bg-remover/mem0-api/error-count` | Trending to zero | External dependency health |

### 2.2 Dashboard Layout (YAML for IaC)

See section 2.3 below for Serverless Framework resource definition.

---

## 2.3 CloudWatch Dashboard Definition (Serverless Resources)

```yaml
DualWriteValidationDashboard:
  Type: AWS::CloudWatch::Dashboard
  Properties:
    DashboardName: bg-remover-DualWrite-Validation
    DashboardBody: !Sub |
      {
        "widgets": [
          {
            "type": "metric",
            "properties": {
              "metrics": [
                ["bg-remover", "dual-write-success", {"stat": "Sum", "label": "Success Count (6h)"}],
                [".", "dual-write-failure", {"stat": "Sum", "label": "Failure Count (6h)"}],
                [".", "divergence-detected", {"stat": "Sum", "label": "Divergence Events (6h)"}]
              ],
              "period": 300,
              "stat": "Sum",
              "region": "${AWS::Region}",
              "title": "Dual-Write Status (6-Hour Window)",
              "yAxis": {"left": {"min": 0}},
              "annotations": {
                "horizontal": [
                  {"value": 100, "label": "Target: <1 divergence per 6h cohort"}
                ]
              }
            }
          },
          {
            "type": "metric",
            "properties": {
              "metrics": [
                ["bg-remover", "carousel-main/write-success", {"stat": "Sum", "label": "Carousel-Main Success"}],
                [".", "carousel-main/write-failure", {"stat": "Sum", "label": "Carousel-Main Failure"}],
                [".", "lcp-outcomes/write-success", {"stat": "Sum", "label": "LCP-API Success"}],
                [".", "lcp-outcomes/write-failure", {"stat": "Sum", "label": "LCP-API Failure"}]
              ],
              "period": 60,
              "stat": "Sum",
              "region": "${AWS::Region}",
              "title": "Per-System Write Success Rate",
              "yAxis": {"left": {"min": 0}}
            }
          },
          {
            "type": "metric",
            "properties": {
              "metrics": [
                ["bg-remover", "carousel-main/write-duration", {"stat": "p99"}],
                [".", "lcp-outcomes/write-duration", {"stat": "p99"}]
              ],
              "period": 300,
              "stat": "p99",
              "region": "${AWS::Region}",
              "title": "Write Latency p99 (ms)",
              "yAxis": {"left": {"min": 0, "max": 1000}},
              "annotations": {
                "horizontal": [
                  {"value": 500, "label": "Carousel-Main Target: <500ms"},
                  {"value": 600, "label": "LCP-API Target: <600ms"}
                ]
              }
            }
          },
          {
            "type": "metric",
            "properties": {
              "metrics": [
                ["AWS/SQS", "ApproximateNumberOfMessagesVisible", 
                  {"dimensions": {"QueueName": "lcp-vendor-approval-recorder-dlq-${self:provider.stage}"},
                   "label": "Recorder DLQ Depth"}],
                [".", ".", 
                  {"dimensions": {"QueueName": "lcp-vendor-approval-events-dlq-${self:provider.stage}"},
                   "label": "Vendor Approval Events DLQ"}],
                [".", ".",
                  {"dimensions": {"QueueName": "lcp-sale-events-dlq-${self:provider.stage}"},
                   "label": "Sale Events DLQ"}]
              ],
              "period": 300,
              "stat": "Average",
              "region": "${AWS::Region}",
              "title": "DLQ Depth (Failure Accumulation)",
              "yAxis": {"left": {"min": 0}}
            }
          },
          {
            "type": "log",
            "properties": {
              "query": """
                fields @timestamp, outcomeId, mem0Success, ddbSuccess, diverged
                | filter diverged = true
                | stats count() as DivergenceCount by bin(5m)
              """,
              "region": "${AWS::Region}",
              "title": "Divergence Detection (CloudWatch Logs Insights)",
              "labels": {"Divergence Events": "DivergenceCount"}
            }
          },
          {
            "type": "metric",
            "properties": {
              "metrics": [
                ["AWS/DynamoDB", "ConsumedWriteCapacityUnits", 
                  {"dimensions": {"TableName": "carousel-main-${self:provider.stage}"},
                   "stat": "Sum", "label": "Carousel-Main WCU"}],
                [".", ".",
                  {"dimensions": {"TableName": "lcp-outcomes-${self:provider.stage}"},
                   "stat": "Sum", "label": "LCP-API WCU"}]
              ],
              "period": 300,
              "stat": "Sum",
              "region": "${AWS::Region}",
              "title": "DynamoDB Write Capacity Utilization (WCU)"
            }
          }
        ]
      }
```

---

## 3. Real-Time Divergence Detection: "divergence-check" Lambda

**Purpose:** Query outcomes from both systems every 6 hours, compare critical fields, emit divergence metrics.

**Invocation:** CloudWatch Events rule (cron-based) + on-demand via SNS alert system.

### 3.1 Function Signature & Behavior

```typescript
// src/handlers/divergence-check.handler.ts
export async function handler(event: ScheduledEvent): Promise<CheckResult>

// Runs every 6 hours: 0 2 * * ?, 0 8 * * ?, 0 14 * * ?, 0 20 * * ?
// Queries outcomes created in past 6h from both systems
// Compares: saleId, accuracy, classification, timestamp ±5sec tolerance
// Logs divergences with "DIVERGENCE_DETECTED" marker for CloudWatch Insights filtering
```

### 3.2 Comparison Logic

**Critical Fields (must match exactly or fail):**
- `saleId` (or `outcomeId` PK)
- `classification` (e.g., "vendor_approval_accepted" vs "vendor_approval_edited")
- `accuracy` (or `qualityScores.overallAccuracy`) — tolerance: ±0.5%
- `createdAt` — tolerance: ±5 seconds

**Success Criteria (per outcome pair):**
- Both systems have the outcome
- All critical fields match within tolerance
- No divergence flag set

**Failure Criteria (count as divergence):**
- Outcome in carousel-main but missing from lcp-outcomes
- Outcome in lcp-outcomes but missing from carousel-main
- Critical fields differ beyond tolerance
- One system has different outcome type for same saleId

### 3.3 Serverless Configuration

```yaml
divergenceCheck:
  handler: dist/handlers/divergence-check.handler
  description: Query outcome divergence between carousel-main and lcp-api every 6h
  timeout: 120
  memorySize: 512
  environment:
    CAROUSEL_MAIN_TABLE: carousel-main-${self:provider.stage}
    LCP_OUTCOMES_TABLE: lcp-outcomes-${self:provider.stage}
    SLACK_WEBHOOK_URL: !Sub 'sm:bg-remover/slack-webhook-${self:provider.stage}'
  events:
    # Run at 02:00, 08:00, 14:00, 20:00 UTC daily
    - schedule:
        rate: 'cron(0 2,8,14,20 * * ? *)'
        description: 'Dual-write divergence check (6-hourly)'
        input:
          checkWindow: 6
    # Also triggered by SNS alert if > 1% divergence detected
    - sns:
        arn: !Ref DivergenceAlertTopic
        topicName: bg-remover-divergence-alert-${self:provider.stage}

divergenceCheckDLQ:
  Type: AWS::SQS::Queue
  Properties:
    QueueName: bg-remover-divergence-check-dlq-${self:provider.stage}
    MessageRetentionPeriod: 604800  # 7 days
```

---

## 4. Success/Failure Tracking

### 4.1 Outcome Types & Tracking Table

Every outcome posting is categorized into one of:

| Category | Condition | Expected Count | Metric |
|----------|-----------|-----------------|--------|
| **Dual Success** | Both systems succeed | > 99.5% of total | `bg-remover/dual-write-success` |
| **Partial Success (Carousel wins)** | Carousel-main succeeds, LCP-API fails → LCP DLQ | 0–1% | `bg-remover/divergence-detected` + metric dimension `fail_target=lcp` |
| **Partial Success (LCP wins)** | LCP-API succeeds, Carousel-main fails → rare, investigation required | 0–0.1% | `bg-remover/divergence-detected` + dimension `fail_target=carousel` |
| **Complete Failure** | Both systems fail → both go to respective DLQs | 0–0.5% (target: 0) | `bg-remover/dual-write-failure` |

### 4.2 DLQ Monitoring

- **Carousel-main DLQ:** Not used for dual-write (carousel is primary, writes inline)
- **LCP-API DLQ (lcp-vendor-approval-recorder-dlq):** Collects outcomes that failed to write to lcp-outcomes
  - Processed async by `dlq-processor` Lambda
  - Retried with exponential backoff (max 3 attempts)
  - Failure after 3 retries: logged to CloudWatch with outcome ID for manual investigation
- **SNS Topic (bg-remover-divergence-alert):** Triggered by divergence alarm (>1% per 6h cohort)
  - Publishes to oncall channel
  - Includes sample divergent record(s) for triage

### 4.3 Metrics Emitted (CloudWatch)

| Metric Name | Unit | Dimensions | Trigger | Purpose |
|-------------|------|-----------|---------|---------|
| `dual-write-success` | Count | `outcomeType`, `tenantId` | Both writes succeed | Track healthy completions |
| `divergence-detected` | Count | `fail_target` (lcp\|carousel), `outcomeId` | One write fails | Track partial failures |
| `dual-write-failure` | Count | `outcomeId` | Both writes fail | Track complete failures |
| `carousel-main/write-duration` | ms | `outcomeType` | Every write attempt | Latency tracking |
| `lcp-outcomes/write-duration` | ms | `outcomeType` | Every write attempt | Latency tracking |

---

## 5. Post-48h Decision Logic & Gate Closure

**Window:** 2026-04-29 00:00 UTC to 2026-05-01 00:00 UTC (exact 48 hours)

### 5.1 Success Criteria (PROCEED to Layer 2)

All of the following must be true:

1. **Divergence < 1%**
   - Total outcomes written: N
   - Divergence events (one-sided failures): M
   - Success rate: `(N - M) / N >= 0.99`
   - Source: CloudWatch Logs Insights query over 48h

2. **No Critical Incidents**
   - No DLQ message retention > 24h (indicates stuck retry loop)
   - No Mem0 API errors exceeding < 0.5% of Mem0 writes
   - No "DIVERGENCE_DETECTED" marker with `fail_target=carousel` (primary failure, rollback trigger)

3. **Write Latency Acceptable**
   - Carousel-main p99: < 750ms (normal < 500ms, but allow some variance during validation)
   - LCP-API p99: < 800ms (normal < 600ms)
   - Latency delta: < 150ms

4. **Dual-Write Success Rate**
   - At least one system succeeds for >= 99.5% of outcomes

### 5.2 Rollback Criteria (HALT at Layer 1)

If ANY of the following is true:

1. **Divergence >= 1%**
   - Indicates systemic mismatch; must investigate root cause before Layer 2 activation

2. **Carousel-main Write Failure > 0.5%**
   - Primary system degradation; may indicate shared resource exhaustion or misconfiguration
   - Rollback: disable dual-write, revert bg-remover to carousel-main-only writes
   - Investigation: check carousel-main DynamoDB provisioning, Cognito auth, S3 bucket policies

3. **LCP-API Table Capacity Exceeded**
   - Write throttling detected (exceeds provisioned WCU)
   - Rollback: disable LCP-API writes, increase provisioning manually
   - Investigation: review partition key design or query patterns causing hot partitions

4. **Mem0 Cloud API Down (> 5 minutes)**
   - External dependency failure
   - Rollback: N/A (Mem0 is optional telemetry; DDB is primary)
   - Mitigation: escalate to Mem0 support

5. **Critical Data Mismatch (e.g., saleId mismatch)**
   - Indicates bug in dual-write logic, not network/performance issue
   - Rollback: revert to carousel-main-only; create bug task in TaskHarbinger
   - Investigation: code review of outcome serialization in both paths

### 5.3 Gating Decision Document

At 2026-05-01 00:00 UTC, a human decision-maker will:

1. Query CloudWatch Insights for `DIVERGENCE_DETECTED` events over 48h window
2. Calculate divergence %: `(SUM(divergence_detected) / SUM(dual_write_attempts)) * 100`
3. Review DLQ depths for > 24h retained messages
4. Check Mem0 API error log for SLA breaches
5. **Decision:**
   - **PROCEED:** All criteria met → notify squad → enable Layer 2 event topology (SNS topic activation)
   - **ROLLBACK:** Any failure criterion → disable dual-write → schedule postmortem
   - **EXTEND:** Gray area (e.g., 0.8% divergence) → extend window by 24h, retry decision

### 5.4 Decision Documentation

Create file: `/docs/operations/DUAL-WRITE-VALIDATION-{DATE}.md`

Template:
```markdown
# Dual-Write Validation Decision — {DATE}

**Window:** 2026-04-29 to 2026-05-01
**Decision:** [PROCEED | ROLLBACK | EXTEND]

## Metrics Summary

| Metric | Target | Actual | Status |
|--------|--------|--------|--------|
| Divergence % | < 1% | 0.XX% | [PASS|FAIL] |
| Carousel-main Write Success % | > 99.5% | XX.X% | [PASS|FAIL] |
| LCP-API Write Success % | > 99% | XX.X% | [PASS|FAIL] |
| p99 Latency Delta | < 100ms | XXms | [PASS|FAIL] |

## DLQ Summary

- Vendor Approval Recorder DLQ: N messages (aged < 1h)
- Resolution: Manual retry or auto-resubmit

## Critical Incidents

[List any] or "None"

## Recommendation

[Text]

## Next Steps

If PROCEED:
1. Enable SNS→Lambda routes (activate Layer 2)
2. Monitor for 7 days post-activation
3. File Layer 2 activation task in TaskHarbinger

If ROLLBACK:
1. Disable bg-remover dual-write (revert to carousel-main-only)
2. Create postmortem task for root cause analysis
3. Schedule retry for [DATE+14d]
```

---

## 6. Automated Alert Logic

### 6.1 Divergence Alert (SNS + Slack)

**Trigger:** Any 6-hour cohort with divergence > 1%

**Action:**
1. CloudWatch Alarm fires: `bg-remover-divergence-alarm-{stage}`
2. SNS publishes to `bg-remover-divergence-alert-{stage}` topic
3. Lambda `divergence-notifier` consumes SNS message:
   - Queries last 100 divergent outcomes from CloudWatch Logs
   - Formats sample records for human review
   - Posts to Slack: `#platform-alerts` channel

**Slack Message Format:**
```
⚠️ BG-Remover Dual-Write Divergence Detected

Window: [start – end UTC]
Divergence Count: N outcomes
Divergence %: X.XX%
Status: [ALERT | CRITICAL]

Sample Divergent Records:
- outcomeId: abc123, carousel: SUCCESS, lcp: FAIL (error: timeout)
- outcomeId: def456, carousel: SUCCESS, lcp: FAIL (error: throttle)

Action Required:
1. Check /services/platform/lcp-api CloudWatch dashboard
2. Review DLQ depth: lcp-vendor-approval-recorder-dlq-{stage}
3. If trend continues, prepare rollback plan

Dashboard: https://console.aws.amazon.com/cloudwatch/...
Decision Gate: 2026-05-01 00:00 UTC
```

### 6.2 DLQ Depth Alert (SQS)

**Trigger:** ApproximateNumberOfMessagesVisible > 50 for > 1 hour

**Action:**
1. CloudWatch Alarm fires
2. SNS publishes to `bg-remover-operational-alerts-{stage}`
3. Squad receives Slack notification with remediation steps

---

## 7. Rollback Procedure (Emergency)

### 7.1 Disable Dual-Write (Immediate)

If human decision or auto-rollback triggers, execute:

```bash
# 1. Update bg-remover env to disable LCP-API writes
aws lambda update-function-configuration \
  --function-name bg-remover-{stage} \
  --environment Variables={DUAL_WRITE_ENABLED=false}

# 2. Verify carousel-main-only mode active
# (outcome-dual-writer.ts will skip lcp-outcomes writes if env var is false)

# 3. Monitor for outcome write recovery (should see all writes on carousel-main path)
```

### 7.2 Drain DLQ (Manual or Automated)

```bash
# Check DLQ depth
aws sqs get-queue-attributes \
  --queue-url https://sqs.eu-west-1.amazonaws.com/{account}/lcp-vendor-approval-recorder-dlq-{stage} \
  --attribute-names ApproximateNumberOfMessages

# If depth > 100, trigger DLQ processor manually
aws lambda invoke \
  --function-name lcp-api-{stage}-dlq-processor \
  --invocation-type RequestResponse \
  response.json

# Or drain via resubmit (dlq-processor will retry with new timestamp)
```

### 7.3 Validation Post-Rollback

1. Check bg-remover logs: all outcomes writing to carousel-main only
2. Check lcp-outcomes table: no new writes (writes stop immediately)
3. Confirm: `lcp-api:vendor-approval-recorder` Lambda still active (listening to carousel-main stream)
   - This is OK; it will re-sync next outcomes when dual-write re-enabled

---

## 8. Monitoring Setup Checklist

- [ ] CloudWatch Dashboard "bg-remover-DualWrite-Validation" deployed
- [ ] `divergence-check` Lambda deployed with 6-hourly schedule
- [ ] CloudWatch Alarm "bg-remover-divergence-alarm-{stage}" created (threshold: 1 divergence per 6h)
- [ ] SNS Topic "bg-remover-divergence-alert-{stage}" subscribed to Slack/email oncall
- [ ] `divergence-notifier` Lambda deployed (consumes SNS, posts to Slack)
- [ ] DLQ monitoring Alarms created:
  - [ ] Recorder DLQ depth > 50 for 1h
  - [ ] Vendor Approval Events DLQ depth > 100 for 1h
  - [ ] Sale Events DLQ depth > 100 for 1h
- [ ] CloudWatch Logs Insights queries saved:
  - [ ] "DIVERGENCE_DETECTED" marker filtering (5m binning)
  - [ ] Success rate by system (daily)
  - [ ] Write latency percentiles (p50, p99)
- [ ] Access to decision document template at `/docs/operations/`
- [ ] Rollback runbook tested in dev (disable/enable dual-write cycle)
- [ ] Squad oncall briefing: dual-write validation window, decision date, escalation path

---

## 9. Related Documentation

- [[outcome-dual-writer.ts]] — Dual-write implementation details
- [[cloudwatch-metrics.ts]] — Metrics emission helper
- `services/platform/lcp-api/docs/reference/prd-carousel-learnings.md` — Layer 2 gating criteria
- `services/platform/carousel/organisms/bg-remover/docs/decisions/ADR-001-pricing-telemetry.md` — Outcome telemetry contract

---

## 10. Success Metrics (Post-48h)

- **Divergence Rate:** < 1% (target: < 0.1%)
- **Dual-Write Success Rate:** > 99.5% (at least one system succeeds)
- **P99 Latency Delta:** < 100ms between systems
- **Zero Critical Incidents:** No "fail_target=carousel" divergences detected
- **DLQ Drain Time:** All messages processed within 4 hours of arrival

---

**Created:** 2026-04-29
**Owner:** Platform Squad
**Next Review:** 2026-05-01 (Post-48h decision gate)
