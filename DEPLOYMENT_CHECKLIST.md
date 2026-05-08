---
title: "Layer 2 Dual-Write Deployment Checklist"
---

# Layer 2 Dual-Write Deployment Checklist

**Service:** bg-remover  
**Feature:** Dual-write to LCP-API (secondary Layer 2 outcomes)  
**Validation Window:** 2026-04-29 to 2026-05-01 (48 hours)  
**Success Criteria:** < 1% divergence, > 95% LCP-API success

---

## Pre-Deployment (DevOps) — Do This FIRST

- [ ] Create SSM SecureString parameter for LCP-API auth token
- [ ] Create SSM SecureString parameter for DLQ URL
- [ ] Verify SSM parameters are readable
- [ ] Create SQS DLQ queue (bg-remover-lcp-api-dlq-dev)
- [ ] Create SQS Dead-Letter Queue (DLQ-of-DLQ)
- [ ] Verify LCP-API is running and healthy
- [ ] Test LCP-API POST /learning/outcomes/sale endpoint

---

## Deployment — Step by Step

### Code Review
- [ ] Review outcome-dual-writer.ts changes
- [ ] Review serverless.yml changes
- [ ] Review test file coverage

### Validation
- [ ] Navigate to bg-remover directory
- [ ] Check serverless.yml syntax
- [ ] Verify environment variables in config
- [ ] Verify IAM permissions in config

### Deploy
- [ ] Deploy the service with CloudWatch metrics enabled
- [ ] Check deployment completed successfully

### Post-Deployment Verification
- [ ] Check Lambda function environment variables
- [ ] Verify IAM role has required permissions
- [ ] Verify CloudWatch Log Group exists
- [ ] Verify SQS DLQ is configured

---

## Smoke Tests — Run Immediately After Deployment

- [ ] Service health check passes
- [ ] Submit test outcome request
- [ ] Monitor CloudWatch Logs for [DualWrite] pattern
- [ ] Verify writes to carousel-main succeeded
- [ ] Verify writes to LCP-API succeeded

---

## CloudWatch Monitoring Setup — Day 1

- [ ] Create Divergence Rate Alarm
- [ ] Create LCP-API Failure Rate Alarm
- [ ] Create DLQ Queue Depth Alarm
- [ ] Create monitoring dashboard

---

## Validation Window (48 Hours: 2026-04-29 to 2026-05-01)

### Daily Checks
- [ ] LCP-API success rate > 95%?
- [ ] Divergence rate < 1%?
- [ ] DLQ queue depth < 100?
- [ ] No alarms triggered?
- [ ] carousel-main latency unchanged?

### Final Analysis
- [ ] Calculate final divergence rate
- [ ] Calculate final LCP-API success rate
- [ ] Review error logs
- [ ] Check DLQ processing

---

## Decision Gate

- [ ] Validation PASSED? (divergence < 1%, LCP-API > 95%)
  - [ ] Create success summary
  - [ ] Approve Phase 2
  - [ ] Notify stakeholders

- [ ] Validation FAILED?
  - [ ] Trigger rollback
  - [ ] Create RCA task
  - [ ] Document root cause
  - [ ] Schedule remediation

---

## Quick Rollback (< 5 minutes)

- [ ] Comment out `this.writeLcpApi(outcome)` in outcome-dual-writer.ts
- [ ] Redeploy: `npx serverless deploy --stage dev --region eu-west-1`
- [ ] Notify #devops-alerts
- [ ] Create RCA task

---

## Sign-Off

**Deployment Date:** _____________  
**Deployed By:** _____________  
**Validation Result:** PASS / FAIL  
**Decision:** Approve Phase 2 / Rollback & RCA  

