---
title: "Wave 3 Dual-Write Validation Decision — [DATE]"
---

# Wave 3 Dual-Write Validation Decision — [DATE]

**Validation Window:** 2026-04-29 00:00 UTC to 2026-05-01 00:00 UTC (48 hours)
**Decision Date:** 2026-05-01 00:00 UTC
**Decision Maker:** [Name]
**Peer Review:** [Names]

---

## Executive Summary

[1–2 sentences describing overall outcome: e.g., "Dual-write validation successful with <0.1% divergence. Recommend proceeding to Layer 2 event topology activation."]

---

## Metrics Summary

### Primary Success Criteria

| Metric | Target | Actual | Status |
|--------|--------|--------|--------|
| **Divergence %** | < 1% | [X]% | [PASS/FAIL] |
| **Carousel-Main Write Success %** | > 99.5% | [X]% | [PASS/FAIL] |
| **LCP-API Write Success %** | > 99% | [X]% | [PASS/FAIL] |
| **P99 Latency Delta** | < 100ms | [X]ms | [PASS/FAIL] |
| **Dual-Write Success Rate** | > 99.5% | [X]% | [PASS/FAIL] |

### Secondary Metrics

| Metric | Expected | Actual | Notes |
|--------|----------|--------|-------|
| **Total Outcomes Written** | > 10,000 | [X] | Volume confidence indicator |
| **Carousel-Main p99 Latency** | < 500ms | [X]ms | Baseline performance |
| **LCP-API p99 Latency** | < 600ms | [X]ms | Secondary system performance |
| **Max DLQ Depth** | < 50 | [X] | Failed message accumulation |
| **Mem0 API Error Rate** | < 0.5% | [X]% | External dependency health |
| **"fail_target=carousel" Divergences** | 0 | [X] | Primary system failure indicator |

---

## DLQ Summary

### Vendor Approval Recorder DLQ (lcp-vendor-approval-recorder-dlq-dev)

- **Final Depth:** [X] messages
- **Messages Aged > 4h:** [X] (should be 0)
- **Max Retention Time:** [Time]
- **Status:** [HEALTHY | DEGRADED | PROBLEMATIC]
- **Resolution:** [Processed by dlq-processor, manual retry, or left for investigation]

### Notes on Message Retention
[If DLQ has retained messages, describe investigation and remediation steps taken.]

---

## Critical Incidents & Anomalies

[List any incidents that occurred during the 48-hour window, including:]

### Incident Template (if applicable)

**Incident 1:** [Title]
- **Time:** [Timestamp UTC]
- **Duration:** [Minutes/Hours]
- **Impact:** [Divergence count, affected outcomes]
- **Root Cause:** [Brief description]
- **Resolution:** [How was it resolved]
- **Prevention:** [What mitigates recurrence]

[Repeat for each incident, or write "None" if validation was incident-free]

---

## Divergence Analysis

### Divergence Distribution

| Reason | Count | Percentage | Example Outcome IDs |
|--------|-------|-----------|-------------------|
| Missing from lcp-outcomes | [X] | [X]% | [Example IDs] |
| Missing from carousel-main | [X] | [X]% | [Example IDs] |
| Timestamp mismatch (>5s) | [X] | [X]% | [Example IDs] |
| Accuracy score mismatch (>0.5%) | [X] | [X]% | [Example IDs] |
| Classification type mismatch | [X] | [X]% | [Example IDs] |
| **Total Divergences** | **[X]** | **[X]%** | — |

### Trend Analysis

[Describe divergence trend over the 48-hour period]

Example analysis:
- Hour 1–6: 0 divergences (0%)
- Hour 7–12: 2 divergences (0.05%) — brief latency spike, resolved
- Hour 13–24: 0 divergences (0%)
- Hour 25–36: 1 divergence (0.02%) — timeout on lcp-outcomes write, retried successfully
- Hour 37–48: 0 divergences (0%)

**Trend:** Stable with two isolated incidents, both below alert threshold.

---

## System Health Assessment

### Carousel-Main (Primary)

- **Write Success Rate:** [X]% (target: > 99.5%)
- **Average Write Latency:** [X]ms
- **P99 Write Latency:** [X]ms
- **No. of Write Failures:** [X]
- **Health:** [HEALTHY | DEGRADED | AT RISK]

### LCP-API (Secondary)

- **Write Success Rate:** [X]% (target: > 99%)
- **Average Write Latency:** [X]ms
- **P99 Write Latency:** [X]ms
- **No. of Write Failures:** [X]
- **DynamoDB WCU Utilization:** [X]% (peak)
- **Health:** [HEALTHY | DEGRADED | AT RISK]

### Network & Timeouts

- **Mem0 API Availability:** [X]% uptime
- **Mem0 API P99 Latency:** [X]ms
- **Mem0 API Error Rate:** [X]%
- **Health:** [HEALTHY | DEGRADED | AT RISK]

---

## Gate Closure Criteria Evaluation

### Criterion 1: Divergence < 1% ✅ or ❌

**Target:** Divergence % < 1%
**Actual:** [X]%
**Status:** [PASS/FAIL]

**Rationale:** [Explanation of why this criterion passed/failed]

### Criterion 2: No Critical Incidents ✅ or ❌

**Target:** Zero "fail_target=carousel" divergences (primary system failure)
**Actual:** [X] incidents of this type
**Status:** [PASS/FAIL]

**Rationale:** [List any critical incidents or confirm none occurred]

### Criterion 3: Write Latency Acceptable ✅ or ❌

**Target:** Latency delta < 100ms, carousel-main p99 < 750ms, lcp-api p99 < 800ms
**Actual:** Delta [X]ms, Carousel [X]ms, LCP [X]ms
**Status:** [PASS/FAIL]

**Rationale:** [Notes on latency performance]

### Criterion 4: Dual-Write Success Rate > 99.5% ✅ or ❌

**Target:** At least one system succeeds for >= 99.5% of outcomes
**Actual:** [X]%
**Status:** [PASS/FAIL]

**Rationale:** [Explanation of success rate]

---

## Rollback Criteria Check

[For each criterion below, mark as triggered or not]

- [ ] Divergence >= 1% **[TRIGGERED/NOT TRIGGERED]**
- [ ] Carousel-Main write failure > 0.5% **[TRIGGERED/NOT TRIGGERED]**
- [ ] LCP-API table capacity exceeded **[TRIGGERED/NOT TRIGGERED]**
- [ ] Mem0 Cloud API down > 5 minutes **[TRIGGERED/NOT TRIGGERED]**
- [ ] Critical data mismatch (saleId, etc.) **[TRIGGERED/NOT TRIGGERED]**

**Rollback Status:** [NO ROLLBACK CRITERIA TRIGGERED / ROLLBACK INDICATED]

---

## Decision & Recommendation

### Primary Decision

**Decision:** [PROCEED | ROLLBACK | EXTEND]

**Justification:**

[3–5 sentences explaining the decision based on metrics and incidents above]

Example text (PROCEED):
"All success criteria met: divergence at 0.15% (well below 1% threshold), dual-write success rate at 99.8%, write latencies within acceptable range, and zero critical incidents. Two minor one-sided failures were detected and self-resolved; no systemic issues identified. Recommend proceeding to Layer 2 event topology activation."

### Next Steps

#### If PROCEED

1. **Immediate Actions:**
   - [ ] Notify platform squad of validation success in #platform-engineering Slack
   - [ ] File TaskHarbinger task: "Layer 2 Event Topology Activation (Wave 3 success)"
   - [ ] Enable SNS→Lambda routes for Layer 2 event posting

2. **Monitoring (7 days post-activation):**
   - [ ] Continue divergence-check every 6h
   - [ ] Monitor SNS topic and Lambda invocation metrics
   - [ ] Watch for cascading failures in event topology

3. **Timeline:**
   - Day +7: Review Layer 2 health; decide on Layer 3 training cycle gating

#### If ROLLBACK

1. **Immediate Actions:**
   - [ ] Notify platform squad of validation failure in #platform-engineering Slack
   - [ ] Disable dual-write: `DUAL_WRITE_ENABLED=false`
   - [ ] Drain DLQ: Trigger dlq-processor to resubmit failed outcomes

2. **Root Cause Analysis:**
   - [ ] Create TaskHarbinger postmortem task
   - [ ] Schedule sync with squad for problem analysis
   - [ ] Document findings in postmortem page

3. **Retry Timeline:**
   - [ ] Minimum 14 days after root cause fix is deployed
   - [ ] Run Wave 3 validation again with same 48h window

#### If EXTEND

1. **Immediate Actions:**
   - [ ] Notify squad that validation is inconclusive
   - [ ] Keep divergence-check running for next 24h

2. **Re-evaluation Timeline:**
   - [ ] Decision meeting scheduled for 2026-05-02 00:00 UTC

---

## Data Confidence

**Sample Size:** [X] outcomes written during validation window
**Confidence Level:** [HIGH / MEDIUM / LOW]

[Explanation: e.g., "10,000+ outcomes written provides high statistical confidence in divergence rate estimate. With <100 divergences in 10,000 outcomes (0.1%), we can be 95% confident true divergence rate is < 0.5% at the 95% confidence interval."]

---

## Post-Validation Recommendations

[Any suggestions for operational improvements, monitoring enhancements, or future changes]

Example:
- Increase divergence-check frequency to 4h if divergence trend shows slow growth
- Implement automatic rollback if divergence exceeds 2% (twice the decision threshold)
- Add metric for "age of oldest DLQ message" to detect stuck retry loops
- Consider using eventual consistency patterns if latency delta grows in Layer 2

---

## Sign-Off

| Role | Name | Date | Signature |
|------|------|------|-----------|
| **Decision Maker** | [Name] | 2026-05-01 | _______ |
| **Peer Reviewer 1** | [Name] | 2026-05-01 | _______ |
| **Peer Reviewer 2** | [Name] | 2026-05-01 | _______ |

---

## Appendices

### A. CloudWatch Dashboard Export

[If needed, export dashboard JSON for archival purposes]

### B. Full Divergence Event Log

[Link to CloudWatch Logs Insights query result or S3 export of divergence events]

### C. Incident Timeline

[Detailed timeline of all incidents, including screenshot of metrics at peak impact]

### D. Related Documents

- [[DUAL-WRITE-MONITORING-WAVE3.md]] — Monitoring specification
- [[WAVE3-DEPLOYMENT-GUIDE.md]] — Deployment instructions
- [[../../src/lib/outcome-dual-writer.ts]] — Dual-write implementation
- [[services/platform/lcp-api/docs/reference/prd-carousel-learnings.md]] — Layer 2 gating

---

**Document Created:** 2026-05-01 00:00 UTC
**Last Updated:** [Date/Time if modified]
**Owner:** [Name]
**Status:** [DRAFT | APPROVED | ARCHIVED]
