---
title: "Wave 3: Dual-Write Monitoring — Complete Index"
---

# Wave 3: Dual-Write Monitoring — Complete Index

**Timeline:** 2026-04-29 to 2026-05-01 (48-hour validation window)
**Purpose:** Configure comprehensive monitoring for bg-remover outcome dual-write to validate safety before Layer 2 activation
**Status:** Configuration Complete, Ready for Deployment

---

## Document Structure

### 📋 Overview & Summary (Start Here)

1. **WAVE3-SUMMARY.md** — Executive overview (10 min read)
   - What was delivered
   - How it works
   - Success criteria
   - Cost impact
   - Operational responsibilities

### 🚀 Deployment (For DevOps/Deployers)

2. **WAVE3-DEPLOYMENT-GUIDE.md** — Step-by-step deployment (30 min read)
   - Pre-deployment checklist
   - 7-step deployment process
   - Post-deployment verification
   - Manual testing procedures
   - Troubleshooting guide

3. **WAVE3-MONITORING-RESOURCES.yml** — CloudFormation resources
   - 2 Lambda functions (divergence-check, divergence-notifier)
   - 1 SNS topic for alerts
   - 4 CloudWatch alarms
   - 1 CloudWatch dashboard
   - Copy/paste into serverless.yml

### 📊 Detailed Specification (For Deep Understanding)

4. **DUAL-WRITE-MONITORING-WAVE3.md** — Complete technical spec (60+ min read)
   - Monitoring architecture
   - Dashboard metrics & definitions
   - 6-hourly divergence check logic
   - Success/failure tracking
   - Post-48h decision logic (sections 5.1–5.4)
   - Automated alert system
   - Rollback procedures
   - Full checklist

### 🎯 Decision & Operations (For Squad Leads, Oncall)

5. **WAVE3-DECISION-GATE-TEMPLATE.md** — Post-48h decision document
   - Metrics table (copy, fill in actual values)
   - DLQ summary section
   - Critical incidents section
   - Divergence analysis section
   - Gate closure criteria evaluation
   - Rollback criteria check
   - Decision matrix (PROCEED/ROLLBACK/EXTEND)
   - Sign-off section
   - **Use this after 2026-05-01 00:00 UTC**

6. **WAVE3-ONCALL-QUICKREF.md** — 2-page cheat sheet for oncall engineers
   - What to do if alert fires (WARN vs FAIL)
   - Investigation checklist
   - DLQ debugging
   - Latency troubleshooting
   - Rollback procedure (quick version)
   - FAQ
   - **Print or bookmark this**

### 💻 Implementation (For Developers)

7. **Divergence Check Lambda**
   - File: `src/handlers/divergence-check.handler.ts`
   - Queries both systems every 6h
   - Compares outcomes, emits metrics
   - Triggers alerts if divergence > 1%

8. **Divergence Notifier Lambda**
   - File: `src/handlers/divergence-notifier.handler.ts`
   - Consumes SNS alerts
   - Formats Slack messages
   - Sends to #platform-alerts channel

---

## Quick Navigation by Role

### 🛠️ DevOps/Platform Engineer

**Goal:** Deploy Wave 3 monitoring

1. Read: WAVE3-SUMMARY.md (overview)
2. Read: WAVE3-DEPLOYMENT-GUIDE.md (step-by-step)
3. Execute: Steps 1–7 in deployment guide
4. Test: Manual invocation tests
5. Verify: Post-deployment checklist

**Time estimate:** 2–4 hours

---

### 🔔 Oncall Engineer (During 2026-04-29 to 2026-05-01)

**Goal:** Respond to alerts, monitor health

1. Bookmark: WAVE3-ONCALL-QUICKREF.md
2. Read: Alert received → Follow "Immediate Actions" section
3. Check: Dashboard via CloudWatch link in Slack alert
4. Document: Alert details in Slack thread
5. Escalate: If status = FAIL, notify @platform-squad

**Time estimate:** 5–10 min per alert (low frequency expected)

---

### 👥 Platform Squad Lead (Decision Maker at 2026-05-01)

**Goal:** Make PROCEED/ROLLBACK/EXTEND decision

1. Read: DUAL-WRITE-MONITORING-WAVE3.md (sections 5.1–5.4)
2. Schedule: Decision gate meeting for 2026-05-01 00:00 UTC
3. Gather: Query CloudWatch Logs for final metrics
4. Complete: WAVE3-DECISION-GATE-TEMPLATE.md
5. Decide: PROCEED → Enable Layer 2 | ROLLBACK → Fix & retry
6. Communicate: Notify squad and update PRD

**Time estimate:** 1–2 hours for decision gate

---

### 📊 Metrics/Analytics Engineer

**Goal:** Understand monitoring architecture

1. Read: DUAL-WRITE-MONITORING-WAVE3.md (sections 2–4)
2. Review: Dashboard definition (section 2.3 in WAVE3-MONITORING-RESOURCES.yml)
3. Study: Metrics and dimensions (tables in DUAL-WRITE-MONITORING-WAVE3.md)
4. Query: CloudWatch Logs Insights examples in WAVE3-ONCALL-QUICKREF.md

**Time estimate:** 1–2 hours

---

## File Checklist

- [ ] WAVE3-SUMMARY.md (executive summary)
- [ ] WAVE3-DEPLOYMENT-GUIDE.md (deployment steps)
- [ ] WAVE3-MONITORING-RESOURCES.yml (CloudFormation)
- [ ] DUAL-WRITE-MONITORING-WAVE3.md (complete spec)
- [ ] WAVE3-DECISION-GATE-TEMPLATE.md (decision template)
- [ ] WAVE3-ONCALL-QUICKREF.md (oncall cheat sheet)
- [ ] WAVE3-INDEX.md (this file)
- [ ] divergence-check.handler.ts (Lambda code)
- [ ] divergence-notifier.handler.ts (Lambda code)

---

## Key Dates & Deadlines

| Date | Milestone | Owner |
|------|-----------|-------|
| 2026-04-29 00:00 UTC | Wave 3 monitoring deployed | DevOps squad |
| 2026-04-29 → 2026-05-01 | Dual-write validation window | Oncall engineer |
| 2026-05-01 00:00 UTC | Decision gate deadline | Squad lead |
| 2026-05-01 + 7 days | Layer 2 health review (if PROCEED) | Platform squad |

---

## Success Metrics (TL;DR)

Must-Have (All Required):
- [ ] Divergence < 1%
- [ ] Carousel-Main success > 99.5%
- [ ] LCP-API success > 99%
- [ ] Write latency acceptable (< 150ms delta)
- [ ] Zero primary system failures (fail_target=carousel)

Nice-to-Have:
- [ ] DLQ < 10 messages
- [ ] Mem0 API error < 0.5%
- [ ] Zero critical incidents

---

## Common Scenarios

### Scenario 1: Alert Fires with WARN Status (0.5–1% divergence)

**Response:** Check dashboard, document in Slack, continue monitoring
**Timeline:** Check again in 6h
**Decision Impact:** Minimal, likely self-corrected

### Scenario 2: Alert Fires with FAIL Status (≥ 1% divergence)

**Response:** Investigate immediately, check DLQ, notify squad
**Timeline:** Escalate if divergence remains > 1% in next check
**Decision Impact:** High, may trigger rollback

### Scenario 3: No Alerts During 48h Window

**Response:** Excellent! System is stable
**Timeline:** Continue normal monitoring
**Decision Impact:** Strong support for PROCEED decision

### Scenario 4: Multiple FAIL Alerts Within 24h

**Response:** Immediate escalation, prepare rollback, investigate root cause
**Timeline:** Consider emergency rollback if trend continues
**Decision Impact:** Likely rollback decision

---

## Related Resources

### Linked Documentation

- `services/platform/carousel/organisms/bg-remover/docs/decisions/ADR-001-pricing-telemetry.md` — Outcome telemetry contract
- `services/platform/lcp-api/docs/reference/prd-carousel-learnings.md` — Full PRD, Layer 2 gating criteria
- `src/lib/outcome-dual-writer.ts` — Dual-write implementation
- `src/lib/cloudwatch-metrics.ts` — Metrics emission helper

### External Resources

- [AWS CloudWatch Dashboards](https://docs.aws.amazon.com/AmazonCloudWatch/latest/userguide/CloudWatch_Dashboards.html)
- [AWS SNS Topic Filters](https://docs.aws.amazon.com/sns/latest/dg/sns-message-filtering.html)
- [CloudWatch Logs Insights](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/AnalyzingLogData.html)
- [DynamoDB GSI Design](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GSI.html)

---

## Support & Contacts

**Slack:** #platform-engineering (questions), #platform-alerts (alert notifications)
**Email:** platform-oncall@carousel-labs.com (escalations)
**GitHub:** Link to repo for code reviews, PRs

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-04-29 | Initial Wave 3 configuration (6 documents, 2 handlers) |

---

## Appendix: Glossary

| Term | Definition |
|------|-----------|
| **Carousel-Main** | Primary DynamoDB table in carousel service (source of truth for outcomes) |
| **LCP-API** | Secondary DynamoDB table in lcp-api service (learning loop outcomes) |
| **Divergence** | Outcome exists in one system but not the other, or fields differ beyond tolerance |
| **Dual-Write** | Writing outcome to both carousel-main and lcp-outcomes in parallel |
| **DLQ** | Dead-Letter Queue; SQS queue holding failed messages for retry |
| **Gate** | Milestone decision point (e.g., Layer 2 activation gated on Wave 3 success) |
| **Layer 1** | MVP outcome recording (vendor-approval-recorder from carousel-main stream) |
| **Layer 2** | Event topology with SNS, SQS, and asynchronous processors |
| **Layer 3** | Training cycle with Step Functions and model optimization |
| **OutcomeDualWriter** | TypeScript class that implements dual-write logic with retry |
| **PROCEED** | Decision to activate Layer 2 (dual-write validation successful) |
| **ROLLBACK** | Decision to disable dual-write and revert to carousel-main-only |
| **EXTEND** | Decision to run validation 24+ more hours (gray zone results) |

---

**Created:** 2026-04-29
**Owner:** Platform Squad, BG-Remover Team
**Status:** Active (Validation Window: 2026-04-29 to 2026-05-01)
**Next Review:** 2026-05-01 00:00 UTC (Decision Gate)
