# CloudWatch Alarms Configuration

**Service:** bg-remover (Vision-Enhanced Pricing Intelligence)
**Last Updated:** 2025-12-30
**Environments:** dev, staging, prod
**Region:** eu-west-1

---

## Overview

This document describes all CloudWatch alarms configured for the bg-remover service, which performs AI-powered background removal and pricing intelligence processing.

**Alarm Philosophy:**
- Use **native AWS metrics** (FREE, no custom metrics cost)
- Alert on **actionable** conditions only (minimize noise)
- **Escalate** critical alarms to on-call (P1/P2)
- **Log** informational alarms for post-mortem analysis
- **Test** all alarms monthly to ensure SNS delivery

**Cost:** All alarms use free CloudWatch metrics (up to 10 alarms included in free tier)

---

## 1. Current Alarm Definitions

### 1.1 Cache Write Failure Alarm (WARNING)

**Purpose:** Detect persistent L2 cache storage failures
**Metric:** Custom metric `CacheWriteFailure` (emitted via CloudWatch EMF)
**Namespace:** `bg-remover/cache`
**Threshold:** > 10 failures
**Period:** 5 minutes (300 seconds)
**Evaluation Periods:** 2 (must breach for 10 minutes total)
**Comparison:** GreaterThanThreshold
**Action:** SNS notification to ops team
**Severity:** P2 (degrades cache performance, not critical)
**Dimensions:** tenant, layer (L2)

**What it detects:**
- Cache service storage failures (database/storage errors)
- Rate limits or capacity issues on cache backend
- Network timeouts to cache service (non-exception)

**When to escalate:**
- More than 100 failures in 1 hour
- Affects multiple tenants simultaneously
- Associated with increased Bedrock API calls

**Serverless Configuration (serverless.yml):**
```yaml
CacheWriteFailureAlarm:
  Type: AWS::CloudWatch::Alarm
  Properties:
    AlarmName: ${self:service}-${self:provider.stage}-${env:TENANT, 'carousel-labs'}-cache-write-failures
    AlarmDescription: Alert when cache write failure rate exceeds threshold
    MetricName: CacheWriteFailure
    Namespace: bg-remover/cache
    Statistic: Sum
    Period: 300                    # 5 minutes
    EvaluationPeriods: 2          # Must breach twice (10 minutes total)
    Threshold: 10                 # More than 10 failures per 5-min window
    ComparisonOperator: GreaterThanThreshold
    TreatMissingData: notBreaching
    Dimensions:
      - Name: tenant
        Value: ${env:TENANT, 'carousel-labs'}
      - Name: layer
        Value: L2
```

**Response Procedure:**
1. Check SNS email alert for timestamp and failure count
2. Query CloudWatch Logs Insights:
   ```
   fields @timestamp, @message, @duration
   | filter service = "cache" and level = "error"
   | filter @message like /CacheWriteFailure/
   | sort @timestamp desc
   | limit 20
   ```
3. Investigate root cause:
   - Check cache service health endpoint
   - Verify network connectivity to cache service
   - Check for rate limiting (cache service metrics)
   - Review cache service logs for database errors
4. If transient, monitor for resolution
5. If persistent, escalate to infrastructure team

---

### 1.2 Cache Write Exception Alarm (CRITICAL)

**Purpose:** Detect cache service connectivity issues (network/timeout exceptions)
**Metric:** Custom metric `CacheWriteException` (emitted via CloudWatch EMF)
**Namespace:** `bg-remover/cache`
**Threshold:** > 0 exceptions
**Period:** 1 minute (60 seconds)
**Evaluation Periods:** 1 (immediate alert)
**Comparison:** GreaterThanThreshold
**Action:** SNS notification to ops team (immediate)
**Severity:** P1 (indicates immediate cache service outage)
**Dimensions:** tenant, layer (L2)

**What it detects:**
- Network connectivity failures to cache service
- Connection timeouts (service not responding)
- DNS resolution failures for cache service endpoint
- TLS/SSL certificate validation errors

**When to escalate:**
- Immediately (any exception indicates service issue)
- Check if this correlates with cache service deployment

**Serverless Configuration (serverless.yml):**
```yaml
CacheWriteExceptionAlarm:
  Type: AWS::CloudWatch::Alarm
  Properties:
    AlarmName: ${self:service}-${self:provider.stage}-${env:TENANT, 'carousel-labs'}-cache-write-exceptions
    AlarmDescription: Alert on cache write exceptions (network/timeout errors)
    MetricName: CacheWriteException
    Namespace: bg-remover/cache
    Statistic: Sum
    Period: 60                     # 1 minute
    EvaluationPeriods: 1          # Immediate alert on first exception
    Threshold: 0                   # Zero tolerance for exceptions
    ComparisonOperator: GreaterThanThreshold
    TreatMissingData: notBreaching
    Dimensions:
      - Name: tenant
        Value: ${env:TENANT, 'carousel-labs'}
      - Name: layer
        Value: L2
```

**Response Procedure:**
1. **IMMEDIATE**: Check cache service status
   ```bash
   # Check CloudWatch dashboard for cache service
   # Check cache service logs for deployment or errors
   ```
2. Query CloudWatch Logs for exception details:
   ```
   fields @timestamp, @message, @duration, @log
   | filter service = "cache" and level = "error"
   | filter @message like /exception|timeout|connection/i
   | sort @timestamp desc
   | limit 50
   ```
3. Check network connectivity:
   - Verify cache service endpoint is reachable
   - Check security groups allow traffic from Lambda
   - Verify VPC routing (if using private cache service)
4. If cache service was recently deployed, coordinate rollback
5. Monitor resolution (should clear within 5 minutes of fix)

---

### 1.3 Lambda Duration Alarm (Optional - Not Configured by Default)

**Purpose:** Warn when Lambda functions approach timeout
**Metric:** AWS/Lambda Duration metric
**Threshold:** > 25 seconds (83% of 30-second timeout for API handlers)
**Period:** 5 minutes
**Evaluation Periods:** 2
**Severity:** P2 (indicates performance degradation)

**Note:** This alarm is **not currently deployed** but can be added to serverless.yml:

```yaml
LambdaDurationAlarm:
  Type: AWS::CloudWatch::Alarm
  Properties:
    AlarmName: ${self:service}-${self:provider.stage}-${env:TENANT, 'carousel-labs'}-duration-high
    AlarmDescription: Alert when Lambda functions approach timeout
    MetricName: Duration
    Namespace: AWS/Lambda
    Statistic: Average
    Period: 300                    # 5 minutes
    EvaluationPeriods: 2          # Must be high for 10 minutes
    Threshold: 25000              # 25 seconds (milliseconds)
    ComparisonOperator: GreaterThanThreshold
    TreatMissingData: notBreaching
    Dimensions:
      - Name: FunctionName
        Value: ${self:service}-${self:provider.stage}-process
      - Name: FunctionName
        Value: ${self:service}-${self:provider.stage}-groupImages
      - Name: FunctionName
        Value: ${self:service}-${self:provider.stage}-createProducts
```

**When to enable:** During Phase 4 (Vision AI) when performance testing shows duration concerns

---

### 1.4 Lambda Error Alarm (Optional - Not Configured by Default)

**Purpose:** Alert on function-level errors
**Metric:** AWS/Lambda Errors metric
**Threshold:** > 5 errors in 5 minutes
**Severity:** P1 (indicates function failures)

**Note:** This alarm is **not currently deployed** but can be added:

```yaml
LambdaErrorAlarm:
  Type: AWS::CloudWatch::Alarm
  Properties:
    AlarmName: ${self:service}-${self:provider.stage}-${env:TENANT, 'carousel-labs'}-errors
    AlarmDescription: Alert when Lambda errors exceed threshold
    MetricName: Errors
    Namespace: AWS/Lambda
    Statistic: Sum
    Period: 300                    # 5 minutes
    EvaluationPeriods: 1          # Single period
    Threshold: 5                   # More than 5 errors
    ComparisonOperator: GreaterThanThreshold
    TreatMissingData: notBreaching
    Dimensions:
      - Name: FunctionName
        Value: ${self:service}-${self:provider.stage}-process
```

---

## 2. Alarm Thresholds Reference

| Alarm Name | Metric | Threshold | Period | Eval Periods | Severity | Status |
|------------|--------|-----------|--------|--------------|----------|--------|
| Cache Write Failure | CacheWriteFailure (custom) | >10 | 5 min | 2 | P2 | Deployed |
| Cache Write Exception | CacheWriteException (custom) | >0 | 1 min | 1 | P1 | Deployed |
| Lambda Duration | AWS/Lambda Duration | >25s | 5 min | 2 | P2 | Not deployed |
| Lambda Errors | AWS/Lambda Errors | >5 | 5 min | 1 | P1 | Not deployed |

---

## 3. SNS Topic Configuration

### Data Validation Alert Topic

**Purpose:** Receives alerts from s3TablesDataValidator Lambda (daily data quality checks)

**Serverless Configuration (serverless.yml):**
```yaml
DataValidationAlertTopic:
  Type: AWS::SNS::Topic
  Properties:
    TopicName: ${self:service}-${self:provider.stage}-data-validation-alerts
    DisplayName: S3 Tables Data Validation Alerts
    Tags:
      - Key: Service
        Value: ${self:service}
      - Key: Stage
        Value: ${self:provider.stage}
      - Key: Purpose
        Value: data-quality-monitoring

DataValidationAlertSubscription:
  Type: AWS::SNS::Subscription
  Properties:
    Protocol: email
    TopicArn: !Ref DataValidationAlertTopic
    Endpoint: ${env:ALERT_EMAIL, 'devops@carousellabs.co'}
```

**Configuration:**
- **Topic Name:** `bg-remover-{stage}-data-validation-alerts`
- **Subscription Protocol:** email
- **Default Endpoint:** devops@carousellabs.co
- **Override:** Set `ALERT_EMAIL` environment variable during deployment

**SNS Subscription Confirmation:**
1. Topic owner receives email from AWS SNS
2. Click "Confirm subscription" link
3. Subscription status changes from "Pending Confirmation" to "Subscribed"
4. Alarms can now deliver to email

**Testing SNS Delivery:**
```bash
# Publish test message to SNS topic
aws sns publish \
  --topic-arn arn:aws:sns:eu-west-1:ACCOUNT_ID:bg-remover-dev-data-validation-alerts \
  --subject "Test Data Validation Alert" \
  --message "This is a test alert message" \
  --region eu-west-1

# Check email inbox for message (verify SNS subscription works)
```

---

## 4. Custom Metrics (CloudWatch EMF)

The cache layer emits custom CloudWatch metrics via Embedded Metric Format (EMF) for detailed monitoring.

### Metric Definitions

**Namespace:** `bg-remover/cache`

**Metrics Emitted:**
1. **CacheWriteSuccess**
   - **Description:** Successful L2 cache writes
   - **Unit:** Count
   - **Dimensions:** tenant, layer
   - **Emitted by:** `src/lib/cache/cache-manager.ts` on successful write

2. **CacheWriteFailure**
   - **Description:** Failed L2 cache writes (non-retryable errors)
   - **Unit:** Count
   - **Dimensions:** tenant, layer
   - **Emitted by:** `src/lib/cache/cache-manager.ts` on non-retryable failure

3. **CacheWriteException**
   - **Description:** L2 cache write exceptions (network/timeout)
   - **Unit:** Count
   - **Dimensions:** tenant, layer
   - **Emitted by:** `src/lib/cache/cache-manager.ts` on exception

4. **CircuitBreakerStateChange**
   - **Description:** Circuit breaker state transitions
   - **Unit:** Count
   - **Dimensions:** tenant, state (CLOSED, OPEN, HALF_OPEN)
   - **Emitted by:** `src/lib/cache/circuit-breaker.ts`

### CloudWatch Logs Insights Queries

**Query cache write success rate:**
```
fields @timestamp, @message, CacheWriteSuccess, CacheWriteFailure
| filter ispresent(CacheWriteSuccess) or ispresent(CacheWriteFailure)
| stats sum(CacheWriteSuccess) as successes, sum(CacheWriteFailure) as failures by tenant
| fields tenant, successes, failures, ((successes / (successes + failures)) * 100) as success_rate_pct
```

**Query circuit breaker state transitions:**
```
fields @timestamp, @message, tenant, state
| filter @message like /CircuitBreakerStateChange/
| sort @timestamp desc
| limit 50
```

**Query cache exceptions with details:**
```
fields @timestamp, @message, @duration, tenant, layer
| filter @message like /CacheWriteException/
| sort @timestamp desc
| limit 100
```

---

## 5. Future Alarms (Pending Implementation)

### Phase 4: Vision AI Integration

When Phase 4 (Vision AI - Bedrock Nova Canvas) is implemented, add:

#### Bedrock API Throttling Alarm
```yaml
BedrockThrottlingAlarm:
  Type: AWS::CloudWatch::Alarm
  Properties:
    AlarmName: ${self:service}-${self:provider.stage}-bedrock-throttling
    AlarmDescription: Alert when Bedrock API throttling occurs
    MetricName: TooManyRequestsException
    Namespace: AWS/Bedrock
    Statistic: Sum
    Period: 300                    # 5 minutes
    EvaluationPeriods: 1
    Threshold: 5                   # More than 5 throttling errors
    ComparisonOperator: GreaterThanThreshold
    Severity: P1
```

#### S3 GetObject Error Alarm
```yaml
S3GetObjectErrorAlarm:
  Type: AWS::CloudWatch::Alarm
  Properties:
    AlarmName: ${self:service}-${self:provider.stage}-s3-4xx-5xx
    AlarmDescription: Alert on S3 4xx/5xx errors during GetObject calls
    MetricName: 4xxErrors
    Namespace: AWS/S3
    Statistic: Sum
    Period: 300
    EvaluationPeriods: 1
    Threshold: 10                  # More than 10 errors per 5 minutes
    ComparisonOperator: GreaterThanThreshold
    Severity: P2
```

### Phase 5-7: Data Quality & Aggregation

When Phase 5+ features are implemented, add:

#### DynamoDB Provisioned Throughput Exceeded
```yaml
DynamoDBThrottleAlarm:
  Type: AWS::CloudWatch::Alarm
  Properties:
    AlarmName: ${self:service}-${self:provider.stage}-dynamodb-throttle
    AlarmDescription: Alert when DynamoDB throughput is exceeded
    MetricName: ConsumedWriteCapacityUnits
    Namespace: AWS/DynamoDB
    Statistic: Sum
    Period: 60
    EvaluationPeriods: 2
    Threshold: 40                  # >80% of provisioned 50 units
    ComparisonOperator: GreaterThanThreshold
    Severity: P2
```

#### Data Validation Quality Alarm
```yaml
DataQualityAlarm:
  Type: AWS::CloudWatch::Alarm
  Properties:
    AlarmName: ${self:service}-${self:provider.stage}-data-quality
    AlarmDescription: Alert when data quality checks fail
    MetricName: DataValidationFailures
    Namespace: bg-remover/quality
    Statistic: Sum
    Period: 300
    EvaluationPeriods: 1
    Threshold: 1                   # Zero tolerance for quality issues
    ComparisonOperator: GreaterThanThreshold
    Severity: P1
```

---

## 6. Alarm Response Procedures

### Triage Matrix

| Alarm | Severity | Detection Latency | Action | Owner |
|-------|----------|------------------|--------|-------|
| Cache Write Exception | P1 | 1 minute | Immediate investigation | On-call |
| Cache Write Failure | P2 | 10 minutes | Investigate within 30 min | On-call |
| Lambda Duration | P2 | 10 minutes | Review & optimize | Dev team |
| Lambda Errors | P1 | 5 minutes | Immediate investigation | On-call |

### Response Runbooks

#### Cache Write Exception (P1)
```
DETECTION: Alert fires within 1 minute
├─ Step 1: Check cache service status
│  └─ Verify cache service is running and responding
├─ Step 2: Check network connectivity
│  └─ Verify security groups allow bg-remover → cache service traffic
├─ Step 3: Check recent deployments
│  └─ See if cache service was recently deployed
├─ Step 4: Review circuit breaker state
│  └─ Check if circuit breaker is OPEN (blocks requests)
└─ Step 5: Escalate if not resolved in 5 minutes
   └─ Alert infrastructure team for cache service investigation
```

#### Cache Write Failure (P2)
```
DETECTION: Alert fires after 10 minutes of failures
├─ Step 1: Analyze failure pattern
│  └─ Is it affecting one tenant or multiple?
├─ Step 2: Check cache service health
│  └─ Verify no errors on cache service
├─ Step 3: Check cache storage backend
│  └─ Verify database/storage is not full
├─ Step 4: Review rate limiting
│  └─ Check if cache service rate limits exceeded
└─ Step 5: Implement mitigation
   └─ Increase failure threshold or reduce cache write frequency
```

#### Lambda Duration High (P2)
```
DETECTION: Alert fires after 10 minutes of high duration
├─ Step 1: Review CloudWatch metrics
│  └─ Check which function is slow (process, groupImages, createProducts?)
├─ Step 2: Analyze request patterns
│  └─ See if specific input types cause slowness
├─ Step 3: Check dependencies
│  └─ Verify Bedrock, S3, and cache service performance
├─ Step 4: Review resource utilization
│  └─ Check if Lambda needs more memory
└─ Step 5: Optimize or scale
   └─ Increase memory, add caching, or distribute load
```

---

## 7. Alarm Testing Procedures

### Monthly Alarm Test Checklist

**Frequency:** First Tuesday of each month at 14:00 UTC (during business hours)

**Procedure:**

1. **Test Cache Write Exception Alarm**
   ```bash
   # Simulate exception by breaking cache service connectivity
   # (offline cache service or block network)

   # Monitor: Alert should fire within 1 minute
   # Verify: Check SNS email received
   # Time to resolution: <2 minutes (after fixing connectivity)
   ```

2. **Test Cache Write Failure Alarm**
   ```bash
   # Simulate storage failure (database error)
   # Make 15 requests that trigger storage failures

   # Monitor: Alert should fire after 10 minutes of failures
   # Verify: Check SNS email received
   # Time to resolution: <10 minutes (after fixing storage)
   ```

3. **Test SNS Delivery**
   ```bash
   # Send test message to SNS topic
   aws sns publish \
     --topic-arn arn:aws:sns:eu-west-1:ACCOUNT_ID:bg-remover-dev-data-validation-alerts \
     --subject "Monthly Alarm Test" \
     --message "This is the monthly alarm test. If received, SNS is working." \
     --region eu-west-1

   # Verify: Email received within 5 minutes
   ```

4. **Log Test Results**
   ```bash
   # Record in #alarms Slack channel:
   # - Timestamp of test
   # - Which alarms were tested
   # - Time to alert delivery
   # - Any issues encountered
   ```

### Automated Testing (Recommended)

For production environments, implement automated alarm testing using Lambda:

```yaml
AlarmTestFunction:
  Type: AWS::Lambda::Function
  Properties:
    Handler: index.handler
    Runtime: nodejs22.x
    Environment:
      ALARM_NAMES:
        - ${self:service}-${self:provider.stage}-cache-write-exceptions
        - ${self:service}-${self:provider.stage}-cache-write-failures
    Code:
      ZipFile: |
        exports.handler = async (event) => {
          // Test alarm configuration and delivery
          // Verify SNS topics are subscribed
          // Check alarm state transitions
        };
    Events:
      Schedule:
        Type: Schedule
        Properties:
          Schedule: 'cron(0 14 ? * TUE *)'  # First Tue, 14:00 UTC
```

---

## 8. Dashboard Deployment

### Create Dashboard in AWS Console

**Manual Approach:**
1. Go to CloudWatch → Dashboards
2. Click "Create dashboard"
3. Name: `bg-remover-{stage}-monitoring`
4. Add widgets using JSON template below

**Automated Approach:**
Deploy dashboard using AWS CLI:

```bash
# Deploy dashboard for dev environment
aws cloudwatch put-dashboard \
  --dashboard-name bg-remover-dev-monitoring \
  --dashboard-body file://CLOUDWATCH_DASHBOARD.json \
  --region eu-west-1

# Deploy for other stages
STAGE=staging  && aws cloudwatch put-dashboard --dashboard-name bg-remover-staging-monitoring --dashboard-body file://CLOUDWATCH_DASHBOARD.json --region eu-west-1
STAGE=prod     && aws cloudwatch put-dashboard --dashboard-name bg-remover-prod-monitoring    --dashboard-body file://CLOUDWATCH_DASHBOARD.json --region eu-west-1
```

**Dashboard Widgets:**
- Cache Write Success/Failure/Exception metrics
- Lambda Duration (p50, p95, p99, max)
- Lambda Error rate
- DynamoDB consumed capacity
- S3 GetObject errors
- Recent error logs (last 20 errors)

See `CLOUDWATCH_DASHBOARD.json` for complete configuration.

---

## 9. Monitoring Strategy

### Metrics Collection & Retention

| Metric Type | Frequency | Retention | Storage Cost |
|-------------|-----------|-----------|--------------|
| Native AWS | 1 minute | 15 months | Free (first 10) |
| Custom (EMF) | 1 minute | 15 months | $0.30/month per metric |
| Logs | Real-time | 7 days (default) | $0.50/GB ingested |

### Current Costs

- **CloudWatch Alarms:** $0.10/alarm × 2 = **$0.20/month**
- **SNS Notifications:** ~$0.50/month (100 messages estimated)
- **Custom Metrics:** $0.30/month × 4 metrics = **$1.20/month**
- **Log Retention:** ~$2-5/month (depends on log volume)

**Total:** ~$3.90/month (minimal impact)

---

## 10. Integration with Other Services

### EventBridge Integration

CloudWatch Alarms can trigger EventBridge rules for automated remediation:

```yaml
AlarmEventRule:
  Type: AWS::Events::Rule
  Properties:
    Description: Route CloudWatch Alarms to Lambda remediation
    EventPattern:
      source:
        - aws.cloudwatch
      detail-type:
        - CloudWatch Alarm State Change
      detail:
        alarmName:
          - ${self:service}-${self:provider.stage}-cache-write-failures
    State: ENABLED
    Targets:
      - Arn: !GetAtt RemediationLambda.Arn
        RoleArn: !GetAtt EventBridgeRole.Arn
```

### PagerDuty Integration (Optional)

For production environments, integrate with PagerDuty:

1. Create PagerDuty integration key
2. Create Lambda function to send alerts to PagerDuty
3. Subscribe SNS topic to Lambda
4. Lambda forwards alerts to PagerDuty API

---

## 11. Cost Analysis

### Free Tier Benefits

AWS CloudWatch offers free tier:
- **10 alarms** (free)
- **1 dashboard** (free)
- **5GB logs ingested** (free)
- **Custom metrics** ($0.30/metric/month after 10)

### Current Service Cost Breakdown

| Component | Quantity | Unit Price | Monthly Cost |
|-----------|----------|-----------|--------------|
| CloudWatch Alarms | 2 | $0.10 | $0.20 |
| SNS Notifications | 100 (est.) | $0.005 | $0.50 |
| Custom Metrics | 4 | $0.30 | $1.20 |
| CloudWatch Dashboard | 1 | Free | $0.00 |
| Log Retention | ~100GB/month | $0.50/GB | $3-5 |
| **TOTAL** | | | **$5-6/month** |

---

## 12. Troubleshooting

### Alarm Not Triggering

**Symptoms:** Alarm state shows "INSUFFICIENT_DATA" despite errors in logs

**Diagnosis:**
```bash
# Check if metric is being published
aws cloudwatch get-metric-statistics \
  --namespace bg-remover/cache \
  --metric-name CacheWriteFailure \
  --dimensions Name=tenant,Value=carousel-labs Name=layer,Value=L2 \
  --start-time 2025-12-30T12:00:00Z \
  --end-time 2025-12-30T14:00:00Z \
  --period 300 \
  --statistics Sum \
  --region eu-west-1
```

**Solutions:**
1. Verify metric is being emitted from Lambda logs
2. Check alarm threshold is reasonable
3. Ensure dimensions match exactly
4. Increase evaluation periods (may need 3-5 data points)

### Too Many False Positives

**Symptoms:** Alarm fires frequently for non-critical events

**Solutions:**
1. Increase threshold (e.g., 10 → 50 failures)
2. Increase evaluation periods (e.g., 1 → 3)
3. Increase period (e.g., 1 min → 5 min)
4. Use composite alarms (require multiple conditions)

### SNS Not Delivering Emails

**Symptoms:** SNS topic exists but emails not received

**Diagnosis:**
```bash
# Verify subscription is confirmed
aws sns list-subscriptions \
  --region eu-west-1 | jq '.Subscriptions[] | select(.TopicArn | contains("bg-remover"))'

# Should show "Subscribed" not "PendingConfirmation"
```

**Solutions:**
1. Check email inbox (and spam folder) for confirmation email
2. Click confirmation link if pending
3. Re-subscribe if subscription lapsed
4. Verify email endpoint is correct

### Alarm State Stuck in ALARM

**Symptoms:** Alarm fires once and never clears even after problem resolves

**Solutions:**
1. Manually set alarm state back to OK:
   ```bash
   aws cloudwatch set-alarm-state \
     --alarm-name bg-remover-dev-cache-write-failures \
     --state-value OK \
     --state-reason "Manual reset - issue resolved" \
     --region eu-west-1
   ```
2. Verify metric is actually improving
3. Check if threshold is set too low

---

## 13. Maintenance & Updates

### Quarterly Review Checklist

- [ ] Review alarm trigger frequency (too many false positives?)
- [ ] Update thresholds based on baseline metrics
- [ ] Test SNS delivery (send test message)
- [ ] Review and update runbooks
- [ ] Check for new services/integrations to monitor
- [ ] Update documentation with any changes

### When to Disable Alarms

- During scheduled maintenance (disable, don't delete)
- During testing phases (use separate test alarms)
- If service is being decommissioned

**Never delete alarms** - disable instead to preserve history

---

## 14. Related Documentation

- **README.md** - Service overview and architecture
- **CLOUDWATCH_DASHBOARD.json** - Complete dashboard configuration
- **src/lib/cache/cache-manager.ts** - Custom metric emission code
- **serverless.yml** - Alarm CloudFormation definitions
- **docs/guides/** - Additional deployment guides

---

## Appendix A: Alarm State Diagram

```
┌────────────────────────────────────────────────────────┐
│            CloudWatch Alarm States                     │
├────────────────────────────────────────────────────────┤
│                                                        │
│  ┌──────────────┐         ┌──────────────┐           │
│  │              │         │              │           │
│  │     OK       ├────────→│    ALARM     │           │
│  │ (metric OK)  │Threshold│  (metric    │           │
│  │              │ exceeded │   exceeded) │           │
│  └──────────────┘         │              │           │
│         ↑                  └──────────────┘           │
│         │                       │                    │
│         └───────────────────────┘                    │
│              Threshold cleared                       │
│                                                      │
│  ┌──────────────────────────────────────┐           │
│  │                                      │           │
│  │    INSUFFICIENT_DATA                 │           │
│  │ (not enough metric data points)      │           │
│  └──────────────────────────────────────┘           │
│         ↑              ↓                             │
│         └──────────────┘                             │
│    (wait 5+ minutes or get data)                    │
│                                                     │
└────────────────────────────────────────────────────┘
```

---

**Last Review:** 2025-12-30
**Next Review:** 2026-03-30 (quarterly)
**Owner:** Platform Engineering Team
