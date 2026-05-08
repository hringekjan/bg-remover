---
title: "Wave 3 Dual-Write Monitoring — Oncall Quick Reference"
---

# Wave 3 Dual-Write Monitoring — Oncall Quick Reference

**Valid During:** 2026-04-29 to 2026-05-01 (48-hour validation window)
**Escalation Contact:** platform-oncall@carousel-labs.com
**Dashboard:** [CloudWatch link]

---

## Alert Received? You're Here 👇

### What This Alert Means

BG-Remover is dual-writing outcomes to both **carousel-main** (primary) and **lcp-outcomes** (secondary). The divergence check detected that some outcomes differ between the two systems.

**Status Levels:**

- **🟢 PASS:** No divergence detected (< 0.5%)
- **🟡 WARN:** Divergence 0.5–1% — monitor closely
- **🔴 FAIL:** Divergence ≥ 1% — investigate immediately

---

## Immediate Actions

### 1️⃣ Read the Slack Alert

The Slack message includes:
- **Divergence %:** How many outcomes differ
- **Carousel-Main:** Total outcomes in primary system
- **LCP-API:** Total outcomes in secondary system
- **Sample divergent records:** Specific outcomes that differ
- **Recommendations:** What to investigate

### 2️⃣ Click "View Dashboard"

Open the CloudWatch dashboard `bg-remover-DualWrite-Validation`.

**Check these 4 widgets in order:**

| Widget | What to Look For | Good Range | Bad Range |
|--------|------------------|-----------|-----------|
| **Divergence %** | Latest value in "Divergence Percentage" | < 0.5% | ≥ 1% |
| **Write Latency p99** | Blue line for Carousel-Main, orange for LCP-API | < 600ms | > 750ms |
| **Success Rates** | Green lines going up, red lines flat | 99%+ success | < 99% success |
| **DLQ Depth** | Messages in queue | < 10 | > 50 |

### 3️⃣ Determine Severity

**WARN Status (0.5–1% divergence):**
- ✅ This is expected to happen occasionally
- ✅ Likely due to transient network timeout, auto-retried
- ⏱️ Action: Set 15-min reminder to check again
- 📋 Document in thread: what time alert fired, divergence value

**FAIL Status (≥ 1% divergence):**
- ⚠️ Something is wrong; investigate
- 🚨 Notify platform squad on Slack: "@platform-squad Alert: BG-Remover divergence FAIL status"
- 📊 Check if DLQ is growing (messages piling up)
- 🔧 Prepare for potential rollback

---

## Investigation Checklist

### For WARN Status (Low Urgency)

1. **Is DLQ empty or near-empty?** (< 5 messages)
   - ✅ Yes → This was transient, likely resolved
   - ❌ No → See "DLQ Growing?" below

2. **Is divergence % trending down?**
   - ✅ Yes → System self-correcting, continue monitoring
   - ❌ No → Stay alert, expect next check in 6h

### For FAIL Status (High Urgency)

1. **Check DLQ depth:**
   ```
   Dashboard widget: "DLQ Depth"
   ```
   - **< 20 messages:** Messages are processing, likely temporary issue
   - **> 50 messages:** DLQ backing up, indicates processing problem
   - **> 100+ messages:** Critical — notify squad immediately

2. **Check write latency:**
   ```
   Dashboard widget: "Write Latency p99"
   ```
   - **Carousel-Main p99 > 1000ms:** Primary system is slow
   - **LCP-API p99 > 1500ms:** Secondary system is slow or timing out
   - **Delta > 500ms:** Large difference indicates network or regional issue

3. **Check system-specific success rates:**
   ```
   Dashboard widget: "Per-System Write Success/Failure Counts"
   ```
   - **Carousel-Main success < 99%:** Primary system degraded → escalate
   - **LCP-API success < 98%:** Secondary system struggling (more acceptable during dual-write)

4. **Check sample divergent records in Slack alert:**
   ```
   Slack message: "Sample Divergent Records"
   ```
   - **Missing from lcp-api:** → Check if lcp-outcomes table is provisioned
   - **Missing from carousel:** → Unusual; check dual-writer logic
   - **Field mismatch (timestamp, accuracy):** → Possible data serialization bug

---

## DLQ Growing?

If DLQ depth is > 50 messages, messages are accumulating faster than they're being processed.

**Quick Fix:**

```bash
# Manually trigger DLQ processor (requires AWS CLI)
aws lambda invoke \
  --function-name lcp-api-dev-dlq-processor \
  --region eu-west-1 \
  /tmp/response.json

# Check if messages drained
aws sqs get-queue-attributes \
  --queue-url https://sqs.eu-west-1.amazonaws.com/{account}/lcp-vendor-approval-recorder-dlq-dev \
  --attribute-names ApproximateNumberOfMessages \
  --region eu-west-1
```

**If DLQ Still Growing:**
- Notify platform squad: "DLQ not draining, potential application issue"
- Prepare for rollback (see below)

---

## Write Latency High?

If p99 latency > 750ms, systems are slower than expected.

**Possible Causes & Quick Checks:**

| Symptom | Likely Cause | Quick Check |
|---------|-------------|------------|
| Only Carousel-Main slow | Primary system issue | Check CloudWatch metrics for carousel Lambda/DynamoDB |
| Only LCP-API slow | Secondary system issue | Check lcp-outcomes table WCU utilization |
| Both slow | Network issue | Check for VPC/NAT gateway issues, regional latency |

**Action:** Document in Slack thread, but continue monitoring. High latency alone is not a rollback trigger unless divergence is also > 1%.

---

## Rollback Procedure (If Needed)

### When to Rollback

- Divergence ≥ 1% **AND** DLQ > 100 messages, OR
- Carousel-Main write success < 99%, OR
- Critical data mismatch detected in samples (saleId, classification mismatch)

### How to Rollback

1. **Notify squad immediately:**
   ```
   Slack: @platform-squad URGENT: BG-Remover rollback initiated
   Reason: [divergence ≥ 1% / DLQ backing up / write failure]
   ```

2. **Disable dual-write:**
   ```bash
   # Stop writing to lcp-outcomes
   aws lambda update-function-configuration \
     --function-name bg-remover-dev-processWorker \
     --environment Variables={DUAL_WRITE_ENABLED=false} \
     --region eu-west-1
   ```

3. **Drain DLQ (optional, if backlog is large):**
   ```bash
   aws lambda invoke \
     --function-name lcp-api-dev-dlq-processor \
     --region eu-west-1 \
     /tmp/drain.json
   ```

4. **Verify:** Wait 5 minutes, then check dashboard
   - Divergence-check should show 0 (no more writes to lcp-outcomes)
   - Carousel-Main should show 100% success rate

5. **Document:**
   - Create TaskHarbinger task: "BG-Remover Dual-Write Rollback — Root Cause Analysis"
   - Post summary to Slack with timestamp and reason

---

## Decision Gate (2026-05-01 00:00 UTC)

### What Happens

A human decision-maker (squad lead) will review all metrics from the 48-hour window and decide:

- **PROCEED:** Divergence < 1%, no critical issues → Enable Layer 2 event topology
- **ROLLBACK:** Divergence ≥ 1% or critical issue → Disable dual-write, schedule retry
- **EXTEND:** Gray area → Run validation 24 more hours

### Your Input

If you've been oncall during the window:
1. Post a summary in the decision gate thread:
   - When alarms fired (if at all)
   - What the issues were
   - How they were resolved
   - Any patterns observed

Example:
```
🔔 Oncall Summary (2026-04-29 to 2026-05-01):

Alarms: 2 fired (2026-04-30 14:05 UTC and 2026-04-30 20:15 UTC)
Status: Both WARN (0.3% and 0.1% divergence)
Resolution: Self-corrected within 1 check window (6h)
DLQ: Stayed < 5 messages throughout
Latency: Stable, no degradation observed

Recommendation: Metrics look good, ready to proceed.
```

---

## Cheat Sheet — What Each Alert Means

| Alert | What It Means | Typical Cause | Action |
|-------|---------------|---------------|--------|
| `bg-remover-divergence-alarm` | Divergence > 1% | Systemic write inconsistency | Check dashboard, may trigger rollback |
| `bg-remover-carousel-failure-alarm` | Carousel-Main success < 99.5% | Primary system degraded | Check carousel Lambda/DDB metrics |
| `bg-remover-lcp-dlq-alarm` | DLQ > 50 msgs for 1h | Messages accumulating | Trigger dlq-processor, check lcp-outcomes |
| `bg-remover-latency-alarm` | p99 latency > 750ms | System slow | Check CloudWatch for bottleneck |

---

## Quick Links

| Resource | Link |
|----------|------|
| **Dashboard** | https://console.aws.amazon.com/cloudwatch/#dashboards:name=bg-remover-DualWrite-Validation |
| **Logs** | https://console.aws.amazon.com/cloudwatch/#logsV2:log-groups/log-group/bg-remover-dev-divergence-check |
| **Full Spec** | `docs/operations/DUAL-WRITE-MONITORING-WAVE3.md` |
| **Rollback Guide** | `docs/operations/DUAL-WRITE-MONITORING-WAVE3.md#7-rollback-procedure` |
| **Slack Channel** | #platform-alerts (where alerts post) |

---

## FAQ

### Q: Is this divergence normal?

**A:** Yes, some divergence is expected due to:
- Transient network timeouts (auto-retried)
- Slight clock skew between regions
- Eventual consistency (outcomes eventually synced)

If divergence < 0.5% and not growing, it's normal.

### Q: Why are we dual-writing?

**A:** To validate that LCP-API (learning loop system) can handle outcome writes reliably before fully migrating from carousel-main. This 48h test run lets us catch issues early.

### Q: What happens after 2026-05-01?

**A:** If all metrics pass, we proceed to Layer 2 (event topology). If divergence is too high, we rollback and fix the issue.

### Q: Can I check metrics without looking at the dashboard?

**A:** Yes, use CloudWatch Logs Insights:
```
fields divergencePercentage, divergenceCount, carouselMainCount
| filter @message like /DIVERGENCE_CHECK_COMPLETE/
| stats max(divergencePercentage), avg(divergencePercentage) by bin(6h)
```

### Q: What if I need to escalate?

**A:** Post in #platform-alerts with:
- Alert status (WARN/FAIL)
- Divergence percentage
- DLQ depth
- Any errors in logs
- Tag @platform-squad

---

## Remember

- **Don't panic if you see an alert.** Divergence <= 1% is within acceptable range.
- **Document everything.** Your notes help the decision-maker.
- **Check the dashboard first.** Most issues are visible there.
- **Escalate if unsure.** Better safe than sorry.
- **You're protecting production.** This 48h window ensures we catch issues early.

**Wave 3 Validation Window:** 2026-04-29 to 2026-05-01
**You've got this! 🚀**
