---
title: "Wave 3: Dual-Write Monitoring — Executive Summary"
---

# Wave 3: Dual-Write Monitoring — Executive Summary

**Status:** Configuration Complete
**Timeline:** 2026-04-29 to 2026-05-01 (48-hour validation window)
**Deliverables:** Monitoring infrastructure, automated divergence checks, decision gate automation
**Success Criteria:** Divergence < 1%, no critical incidents, post-48h PROCEED/ROLLBACK decision

---

## What Was Delivered

### 1. Monitoring Documentation (4 files)

| File | Purpose | Audience |
|------|---------|----------|
| **DUAL-WRITE-MONITORING-WAVE3.md** | Complete monitoring specification (2,000+ lines) | Engineers, oncall |
| **WAVE3-MONITORING-RESOURCES.yml** | CloudFormation resources for deployment | DevOps, platform team |
| **WAVE3-DEPLOYMENT-GUIDE.md** | Step-by-step deployment walkthrough | Deployers, platform squad |
| **WAVE3-DECISION-GATE-TEMPLATE.md** | Post-48h decision documentation template | Decision makers, squad leads |

### 2. Monitoring Lambda Functions (2 new handlers)

| Handler | Purpose | Frequency |
|---------|---------|-----------|
| **divergence-check.handler.ts** | Query both systems, compare outcomes, emit metrics/alerts | Every 6 hours (4x/day) |
| **divergence-notifier.handler.ts** | Format alerts, send Slack notifications | On divergence detection |

### 3. CloudWatch Infrastructure

| Resource | Type | Purpose |
|----------|------|---------|
| **bg-remover-DualWrite-Validation** | Dashboard | Real-time visibility into dual-write health |
| **bg-remover-divergence-alarm** | CloudWatch Alarm | Alert when divergence > 1% |
| **bg-remover-carousel-main-failure-alarm** | CloudWatch Alarm | Alert when carousel-main write success < 99.5% |
| **bg-remover-lcp-dlq-depth-alarm** | CloudWatch Alarm | Alert when DLQ accumulates > 50 messages |
| **bg-remover-write-latency-alarm** | CloudWatch Alarm | Alert when p99 latency > 750ms |
| **bg-remover-divergence-alert-{stage}** | SNS Topic | Fanout for alerts to oncall/Slack |

### 4. Key Metrics Being Tracked

**Per-System Write Health:**
- Carousel-Main write success/failure count
- LCP-API write success/failure count
- Write latency (p50, p99) for each system

**Dual-Write Status:**
- Dual-write success rate (both systems succeed)
- Divergence events (one system fails)
- Complete failure rate (both systems fail)

**Outcome Comparison:**
- Total outcomes in carousel-main (past 6h)
- Total outcomes in lcp-outcomes (past 6h)
- Matched outcomes (found in both systems)
- Divergence count and percentage
- Breakdown by divergence type:
  - Missing from lcp-outcomes
  - Missing from carousel-main
  - Field mismatch (timestamp, accuracy, classification)

**Operational Health:**
- DLQ depth (failed message accumulation)
- Mem0 API error rate (external dependency)
- Write throughput (outcomes per hour)

---

## How It Works

### Phase 1: Continuous Monitoring (2026-04-29 to 2026-05-01)

**Every 6 hours (02:00, 08:00, 14:00, 20:00 UTC):**

1. `divergence-check` Lambda executes
2. Queries carousel-main outcomes created in past 6h
3. Queries lcp-outcomes for same time period
4. Compares critical fields (saleId, accuracy, classification, timestamp)
5. Emits CloudWatch metrics:
   - Outcome counts per system
   - Divergence count and percentage
   - Per-type divergence breakdown
6. If divergence > 0, logs with `DIVERGENCE_DETECTED` marker for searchability
7. If divergence > 1%, triggers CloudWatch Alarm

**When Alarm Fires:**

1. SNS topic publishes alert message
2. Oncall email receives notification
3. `divergence-notifier` Lambda consumes SNS message
4. Formats alert with sample divergent records
5. Sends formatted Slack message to #platform-alerts
6. Slack message includes:
   - Divergence percentage and count
   - Carousel-main vs LCP-API outcome counts
   - Recommendations for investigation
   - Buttons to dashboard, logs, and rollback documentation

### Phase 2: Post-48h Decision (2026-05-01 00:00 UTC)

**Human decision-maker will:**

1. Query CloudWatch Logs for divergence events over 48h window
2. Calculate final divergence % and review DLQ health
3. Complete WAVE3-DECISION-GATE-{DATE}.md template
4. Make **PROCEED**, **ROLLBACK**, or **EXTEND** decision

**If PROCEED:**
- Layer 2 event topology activated
- SNS→Lambda routes for EventBridge publishing enabled
- Continue monitoring for 7 days post-activation

**If ROLLBACK:**
- Disable dual-write in bg-remover
- Revert to carousel-main-only writes
- Schedule postmortem and retry after root cause fixed

**If EXTEND:**
- Continue monitoring for additional 24h
- Re-evaluate at 2026-05-02 00:00 UTC

---

## Success Criteria (Decision Gate)

### Must-Have (All Required to PROCEED)

1. **Divergence < 1%**
   - Indicates acceptable consistency between systems
   - Accounts for occasional network timeouts, retries

2. **Carousel-Main Write Success > 99.5%**
   - Primary system must remain reliable
   - Failure indicates shared resource exhaustion

3. **LCP-API Write Success > 99%**
   - Secondary system target; slightly lower tolerance due to dual-write scenario

4. **Write Latency Acceptable**
   - Carousel-main p99 < 750ms (normal < 500ms)
   - LCP-API p99 < 800ms (normal < 600ms)
   - Latency delta < 150ms

5. **Zero "fail_target=carousel" Divergences**
   - Primary system failures are not acceptable
   - Any failure on carousel-main requires investigation

### Nice-to-Have (Inform Decision, Not Blockers)

- DLQ stays < 10 messages
- Mem0 API error rate < 0.5%
- Write throughput trending upward (more outcomes being recorded)
- Divergence trend flat or declining (no systemic degradation)

---

## Deployment Checklist

- [ ] **Code Review:** divergence-check.ts and divergence-notifier.ts approved
- [ ] **Config Review:** WAVE3-MONITORING-RESOURCES.yml merged into serverless.yml
- [ ] **Pre-Deploy:** Slack webhook URL stored in SSM Parameter Store
- [ ] **Deploy:** `serverless deploy --stage dev` successful
- [ ] **Post-Deploy Verification:**
  - [ ] divergence-check Lambda created and invocable
  - [ ] divergence-notifier Lambda created
  - [ ] SNS topic created
  - [ ] CloudWatch alarms created
  - [ ] CloudWatch dashboard created
  - [ ] 6-hourly schedule triggered (cron rule active)
- [ ] **Manual Test:** Invoke divergence-check manually, verify output format
- [ ] **Alert Test:** Publish test SNS message, verify Slack notification received
- [ ] **Squad Briefing:** Notify oncall, platform squad of validation window

---

## Operational Responsibilities During 48-Hour Window

### Oncall Engineer

**Responsibilities:**
- Watch for Slack alerts in #platform-alerts
- If alert received: check dashboard, investigate divergence reason
- Document any incidents in this Slack thread
- Page platform squad if divergence > 1% or critical incidents detected

**Expected Alert Frequency:**
- Minimal (< 1 per day in normal operation)
- If receiving > 2 alerts per 6h cohort, trend is concerning

### Platform Squad

**Responsibilities:**
- Monitor divergence trend via dashboard (optional, but recommended)
- Respond to oncall escalations
- Prepare rollback runbook if needed
- Schedule decision gate meeting for 2026-05-01 00:00 UTC

### Metrics Review (Optional, Daily)

**Quick Health Check (2 minutes):**
1. Open CloudWatch dashboard: bg-remover-DualWrite-Validation
2. Check latest divergence % (should be 0–0.1%)
3. Check DLQ depth (should be < 5)
4. Verify no "FAIL" status alarms

---

## Key Insights & Design Decisions

### Why 6-Hourly Checks?

- Balances cost and visibility
- 4 checks per day = 4 data points for trend analysis
- Aligns with typical operational shift rotations
- Fast enough to detect degradation within 6h

### Why < 1% Divergence Threshold?

- Network and transient failures in distributed systems are expected
- Accounts for retry logic and eventual consistency
- At < 1%, absolute divergence count is small enough for manual triage
- At >= 1%, indicates systemic issue requiring investigation

### Why Latency Delta Matters

- If LCP-API is much slower than carousel-main, indicates:
  - Network issues between regions
  - DynamoDB provisioning problems
  - Partition key hot spots in lcp-outcomes table
- < 100ms delta means both systems are performing similarly

### Why DLQ Matters

- DLQ depth > 50 for > 1h indicates:
  - Messages piling up faster than processor can handle
  - Potential exponential growth if trend continues
- Threshold chosen to allow transient spikes but alert on sustained backlog

---

## Post-Decision Actions

### If PROCEED to Layer 2

**Immediate:**
1. Enable SNS→Lambda routes for EventBridge publishing
2. Activate bg-remover event emission to SNS topics
3. Start monitoring outcome-poster and dlq-processor Lambda invocations

**Week +1:**
1. Review Layer 2 health: event throughput, SNS message counts, Lambda errors
2. Verify EventBridge rules are triggering correctly
3. Check for cascading failures in event topology

**Month +1:**
1. Evaluate Layer 3 training cycle gating conditions:
   - Gate A: >= 500 outcomes accumulated (gating criterion for mem0 self-hosted)
   - Gate B: >= 5% spread between "approved-as-suggested" vs "approved-with-edits" outcomes
   - Gate C: autosearch hyperparameter optimization (not scheduled)

### If ROLLBACK

**Immediate:**
1. Disable dual-write: set env var `DUAL_WRITE_ENABLED=false`
2. Drain DLQ: trigger dlq-processor to resubmit failed outcomes
3. Notify squad of rollback decision and root cause

**Week +1:**
1. Post-mortem: Analyze root cause, document findings
2. Implement fix in bg-remover or lcp-api
3. Schedule Wave 3 retry for 14 days later

**Before Retry:**
1. Validate fix in dev/staging environment
2. Run chaos engineering tests to confirm robustness
3. Brief squad on changes before re-running Wave 3

---

## Runbook Excerpts

### If Divergence Alert Fires

**In Slack alert, look for:**
- **Status:** WARN (0.5–1%) or FAIL (≥ 1%)
- **Sample divergent records:** Shows saleId, outcome ID, divergence reason

**Quick Investigation:**
1. Click "View Dashboard" button in alert
2. Check "Divergence %" widget (top right)
3. Check "DLQ Depth" widget (bottom left)
4. If DLQ depth is high, outcomes are accumulating; check lcp-outcomes write success rate

**Decision:**
- **WARN status:** Continue monitoring, check back in 6h
- **FAIL status (≥1%):** Notify squad, prepare rollback, escalate to leadership

### If DLQ Alert Fires

**Symptoms:** Messages in `lcp-vendor-approval-recorder-dlq-dev` > 50

**Investigation:**
1. Check lcp-outcomes write latency (p99) in dashboard
2. Check lcp-outcomes table WCU utilization in CloudWatch
3. Check Lambda logs for timeout or throttle errors

**Remediation:**
- If throttled: Increase lcp-outcomes table WCU (short-term) or review partition key (long-term)
- If timeout: Check network connectivity, verify credentials, increase Lambda timeout
- If application error: Review dlq-processor logs for stack trace

---

## Monitoring Forever (Post-Wave 3)

After the 48-hour validation window, divergence-check continues running as operational telemetry:

**Purpose:**
- Early warning system for write inconsistencies
- Trending metric for system health over months/years
- Baseline for performance degradation detection

**Maintenance:**
- Keep Lambda code current with any outcome schema changes
- Update divergence-check if new fields added to outcomes
- Monitor divergence trend for slow growth (indicate emerging issues)

**Decommission Criteria:**
- If Layer 2/3 fully operational and mature: divergence-check could be deprecated
- For now: Keep running indefinitely as safety net

---

## Related Systems & Dependencies

### Dual-Write Core Components

- **OutcomeDualWriter** (`src/lib/outcome-dual-writer.ts`) — Implements write logic with retry
- **CloudWatch Metrics** (`src/lib/cloudwatch-metrics.ts`) — Emits custom metrics
- **Outcome Model** — Must have consistent schema between carousel-main and lcp-outcomes

### Alerting & Integration

- **SNS Topic:** `bg-remover-divergence-alert-{stage}`
- **Slack Webhook:** Stored in SSM `/bg-remover/slack-webhook-{stage}`
- **CloudWatch:** Dashboard, alarms, logs for investigation

### Downstream Systems (Layer 2)

- **LCP-API** — Receives outcomes via vendor-approval-recorder (DDB stream) and divergence-notified outcomes
- **EventBridge** — Routes events to downstream processors (not yet activated)
- **SNS Topics:** Vendor approval events, sale events, stale events (for Layer 2 activation)

---

## Cost Impact

### Lambda Invocations

- **divergence-check:** 4 invocations/day × 30 days = 120 invocations/month
  - Cost: ~$0.01/month (negligible)

- **divergence-notifier:** ~1 invocation per alert (expected: 0–5 per month)
  - Cost: ~$0.001/month (negligible)

### CloudWatch

- **Custom Metrics:** ~5 metrics per 6h check = 20 per day
  - Cost: ~$0.20/month (standard custom metrics pricing)

- **Dashboard:** 1 dashboard
  - Cost: $3/month (AWS-managed dashboards free; only applies if using custom dashboard for third parties)

- **Logs:** ~1KB per divergence-check invocation = ~120KB/month
  - Cost: ~$0.005/month (negligible)

- **Alarms:** 4 alarms
  - Cost: ~$0.10/month (if using CloudWatch Alarms pricing)

**Total Wave 3 Monitoring Cost:** < $1/month (negligible)

---

## Success Metrics (Post-Wave 3)

If PROCEED decision is made:

- **Within 7 days:** Layer 2 event topology active, SNS→Lambda routes functioning
- **Within 30 days:** >= 1,000 outcomes flowing through Layer 2 event chain
- **Within 90 days:** `meanAbsoluteErrorPct` metric stable or improving (pricing suggestion quality)

---

## Document Map

```
docs/operations/
├── DUAL-WRITE-MONITORING-WAVE3.md         ← Full 2,000+ line spec
├── WAVE3-MONITORING-RESOURCES.yml         ← CloudFormation resources
├── WAVE3-DEPLOYMENT-GUIDE.md              ← Deployment walkthrough
├── WAVE3-DECISION-GATE-TEMPLATE.md        ← Decision document template
├── WAVE3-SUMMARY.md                       ← This file
└── WAVE3-DECISION-GATE-2026-05-01.md     ← Filled-in decision (post-validation)

src/handlers/
├── divergence-check.handler.ts            ← Divergence check Lambda
└── divergence-notifier.handler.ts         ← Slack alert sender
```

---

## Contact & Escalation

**Questions during deployment:**
- Slack: #platform-engineering

**Alert fires during 48h window:**
- Respond to Slack alert (includes escalation path)
- Page oncall engineer if status is FAIL

**Rollback needed:**
- Follow "Emergency Rollback" section in DUAL-WRITE-MONITORING-WAVE3.md
- Notify platform squad immediately

**Post-decision issues:**
- File TaskHarbinger task for investigation
- Schedule sync with squad for root cause analysis

---

**Wave 3 Configuration Complete:** 2026-04-29
**Validation Window Start:** 2026-04-29 00:00 UTC
**Decision Gate:** 2026-05-01 00:00 UTC
**Owner:** Platform Squad, BG-Remover Team
**Status:** Ready for Deployment
