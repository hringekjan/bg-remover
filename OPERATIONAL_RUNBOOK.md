# Operational Runbook: Vision-Enhanced Pricing Intelligence

**Service:** bg-remover (pricing-intelligence)
**Last Updated:** 2025-12-30
**Maintainer:** DevOps Team
**Service Type:** Data validation, embedding generation, sales intelligence pipeline
**Deployment Path:** `/services/bg-remover`

---

## Table of Contents

1. [Rollback Procedures](#1-rollback-procedures)
2. [Incident Response Workflow](#2-incident-response-workflow)
3. [On-Call Procedures](#3-on-call-procedures)
4. [Production Smoke Test Checklist](#4-production-smoke-test-checklist)
5. [Cost Monitoring Procedures](#5-cost-monitoring-procedures)
6. [Common Issues & Resolutions](#6-common-issues--resolutions)

---

## 1. Rollback Procedures

### 1.1 Lambda Function Rollback

**Scenario:** New Lambda deployment introduces bugs or performance degradation.

**Rollback Steps:**

1. **Identify Previous Version:**
   ```bash
   aws lambda list-versions-by-function \
     --function-name bg-remover-dev-s3TablesDataValidator \
     --region eu-west-1 \
     --query 'Versions[?LastModified>`date -u -d "1 hour ago" +"%Y-%m-%dT%H:%M:%S.000Z"`].{Version:Version,LastModified:LastModified}' \
     --output table
   ```

2. **List Recent Deployments (CloudFormation):**
   ```bash
   aws cloudformation describe-stack-resources \
     --stack-name bg-remover-dev \
     --region eu-west-1 \
     --query 'StackResources[?LogicalResourceId==`S3TablesDataValidatorFunction`]'
   ```

3. **Revert Lambda Function (Option A: Manual Version):**
   ```bash
   # Get previous working version (e.g., version 42)
   PREV_VERSION=42

   # Alias points to specific version
   aws lambda update-alias \
     --function-name bg-remover-dev-s3TablesDataValidator \
     --name live \
     --function-version $PREV_VERSION \
     --region eu-west-1

   # Verify alias points to old version
   aws lambda get-alias \
     --function-name bg-remover-dev-s3TablesDataValidator \
     --name live \
     --region eu-west-1
   ```

4. **Revert via CloudFormation (Option B: Complete Stack):**
   ```bash
   # View previous template
   aws cloudformation get-template \
     --stack-name bg-remover-dev \
     --region eu-west-1 \
     --query 'TemplateBody' > previous-stack.json

   # Revert to previous stack
   aws cloudformation continue-update-rollback \
     --stack-name bg-remover-dev \
     --region eu-west-1

   # Monitor rollback
   aws cloudformation describe-stack-events \
     --stack-name bg-remover-dev \
     --region eu-west-1 \
     --query 'StackEvents[0:10]' \
     --output table
   ```

5. **Verify Rollback:**
   ```bash
   # Check Lambda environment
   aws lambda get-function-configuration \
     --function-name bg-remover-dev-s3TablesDataValidator \
     --region eu-west-1

   # Tail logs to confirm rollback
   npx serverless@4 logs \
     --function s3TablesDataValidator \
     --stage dev \
     --tail
   ```

**Rollback Success Criteria:**
- Lambda function serving traffic from previous version
- No errors in CloudWatch logs
- Health checks passing (see section 4)

---

### 1.2 DynamoDB Point-in-Time Recovery

**Scenario:** Data corruption or accidental deletion from sales_intelligence table.

**Prerequisites:**
- Point-in-time backup enabled on `bg-remover-dev-sales-intelligence` table
- Backup retention: 35 days (automatic)

**Recovery Steps:**

1. **Identify Corruption Point:**
   ```bash
   # Check table stream for recent suspicious activity
   aws dynamodbstreams list-streams \
     --table-name bg-remover-dev-sales-intelligence \
     --region eu-west-1

   # Get stream records around corruption time
   aws dynamodbstreams describe-stream \
     --stream-arn "arn:aws:dynamodb:eu-west-1:ACCOUNT_ID:table/bg-remover-dev-sales-intelligence/stream/2025-12-29T10:00:00.000" \
     --region eu-west-1
   ```

2. **Estimate Recovery Point:**
   ```bash
   # Example: Corruption detected at 2025-12-30 14:00 UTC
   # Restore to 2025-12-30 13:55 UTC (5 minutes before)
   RESTORE_TIME="2025-12-30T13:55:00Z"
   ```

3. **Create Backup for Analysis:**
   ```bash
   # List available backups
   aws dynamodb list-backups \
     --table-name bg-remover-dev-sales-intelligence \
     --region eu-west-1 \
     --query 'BackupSummaries[*].{BackupName:BackupName,CreateTime:BackupCreationDateTime}'
   ```

4. **Restore to Point-in-Time:**
   ```bash
   RESTORE_TIME="2025-12-30T13:55:00Z"
   NEW_TABLE_NAME="bg-remover-dev-sales-intelligence-restore"

   aws dynamodb restore-table-to-point-in-time \
     --source-table-name bg-remover-dev-sales-intelligence \
     --target-table-name $NEW_TABLE_NAME \
     --use-latest-restorable-time \
     --restore-date-time $RESTORE_TIME \
     --region eu-west-1

   # Monitor restore progress
   aws dynamodb describe-table \
     --table-name $NEW_TABLE_NAME \
     --region eu-west-1 \
     --query 'Table.TableStatus'
   ```

5. **Verify Restored Data:**
   ```bash
   # Sample record count from restored table
   aws dynamodb scan \
     --table-name $NEW_TABLE_NAME \
     --select COUNT \
     --region eu-west-1 \
     --query 'Count'

   # Compare with corrupted table
   aws dynamodb scan \
     --table-name bg-remover-dev-sales-intelligence \
     --select COUNT \
     --region eu-west-1 \
     --query 'Count'
   ```

6. **Swap Tables (if corruption confirmed):**
   ```bash
   # Delete corrupted table
   aws dynamodb delete-table \
     --table-name bg-remover-dev-sales-intelligence \
     --region eu-west-1

   # Rename restored table to original
   # Note: DynamoDB doesn't support direct rename, so:
   # 1. Export all data from restored table
   # 2. Create new table with original name
   # 3. Import data
   # 4. Delete restored table

   # For large tables, use AWS DataPipeline or Lambda batch job
   ```

7. **Update Lambda Environment:**
   ```bash
   # Lambda automatically uses correct table name from environment variable
   # Verify in CloudWatch
   npx serverless@4 logs --function s3TablesDataValidator --stage dev --tail
   ```

**DynamoDB Recovery Success Criteria:**
- Restored table shows correct record count
- Data integrity verified (spot-check 10 records)
- Lambda can read from restored table
- Health checks passing

---

### 1.3 S3 Tables Time-Travel (Iceberg)

**Scenario:** Need to revert S3 Tables data to previous state using Iceberg time-travel.

**Prerequisites:**
- S3 Tables uses Apache Iceberg format with snapshots
- Snapshots retained for 7 days by default

**Recovery Steps:**

1. **List Available Snapshots:**
   ```bash
   # Use AWS Glue Catalog to find Iceberg snapshots
   aws glue get-table \
     --catalog-id ACCOUNT_ID \
     --database-name pricing_intelligence_dev \
     --name sales_history \
     --region eu-west-1 \
     --query 'Table.Parameters' | jq .

   # Query recent snapshots via Athena
   SELECT
     snapshot_id,
     committed_at,
     summary
   FROM pricing_intelligence_dev.sales_history.iceberg_snapshots
   WHERE committed_at > current_timestamp - interval '7' day
   ORDER BY committed_at DESC;
   ```

2. **Identify Corrupted Snapshot:**
   ```bash
   # Query data at specific snapshot (time-travel)
   SELECT COUNT(*) as record_count
   FROM pricing_intelligence_dev.sales_history
   FOR SYSTEM_TIME AS OF '2025-12-30T13:55:00Z'
   WHERE tenant_id = 'carousel-labs';
   ```

3. **Create Snapshot Backup:**
   ```bash
   # Create copy of good snapshot before rollback
   CREATE TABLE pricing_intelligence_dev.sales_history_backup_20251230
   AS SELECT * FROM pricing_intelligence_dev.sales_history
   FOR SYSTEM_TIME AS OF '2025-12-30T13:55:00Z';
   ```

4. **Rollback Table to Previous Snapshot:**
   ```bash
   # Get snapshot ID to rollback to
   GOOD_SNAPSHOT_ID="12345678901234567890"

   # Use Iceberg API to rollback
   # Note: Execute via Lambda or local tool
   aws s3api head-object \
     --bucket carousel-labs-analytics-dev \
     --key pricing-intelligence/metadata/snap-12345678901234567890.avro

   # Update Iceberg manifest to point to previous snapshot
   # This requires custom Lambda or local Iceberg tool
   ```

5. **Verify S3 Tables Rollback:**
   ```bash
   # Query rolled-back table
   SELECT COUNT(*) as record_count
   FROM pricing_intelligence_dev.sales_history
   WHERE tenant_id = 'carousel-labs';

   # Compare with backup
   SELECT COUNT(*) as record_count
   FROM pricing_intelligence_dev.sales_history_backup_20251230
   WHERE tenant_id = 'carousel-labs';
   ```

6. **Update Athena Views (if used):**
   ```bash
   # Refresh materialized views
   aws athena start-query-execution \
     --query-string "REFRESH TABLE pricing_intelligence_dev.sales_history" \
     --query-execution-context Database=pricing_intelligence_dev \
     --result-configuration OutputLocation=s3://carousel-labs-analytics-dev/athena-results/ \
     --region eu-west-1
   ```

**S3 Tables Rollback Success Criteria:**
- Athena queries return expected data
- Record count matches backup
- DynamoDB validation shows consistency
- Health checks passing

---

## 2. Incident Response Workflow

### 2.1 Incident Classification

| Severity | Definition | Response SLA | Examples |
|----------|-----------|--------------|----------|
| **P1 (Critical)** | Service completely down, data loss, or security breach | 15 minutes | Lambda not invoking, DynamoDB deleted, data corruption affecting all tenants |
| **P2 (High)** | Service degraded but partially functional | 1 hour | 50% of validations failing, DLQ backing up, embedding generation slow |
| **P3 (Medium)** | Non-critical feature broken or slow | 4 hours | Specific tenant affected, SNS alerts not sending, Athena queries slow |
| **P4 (Low)** | Minor issues or feature requests | 24 hours | Documentation typo, log verbosity adjustment, cost optimization suggestion |

### 2.2 Incident Detection

**Automated Detection (CloudWatch Alarms):**

1. **Lambda Errors Alarm:**
   - Threshold: >5 errors per invocation
   - Action: Page on-call engineer
   - Dashboard: `/aws/lambda/bg-remover-dev-*`

2. **DLQ Backlog Alarm:**
   - Threshold: >10 messages in DLQ
   - Action: Page on-call engineer, escalate to data team
   - Queue: `bg-remover-dev-dlq`

3. **DynamoDB Throttling:**
   - Threshold: >0 throttled requests in 5 min
   - Action: Alert to on-call, check table capacity
   - Metric: `AWS/DynamoDB.UserErrors`

4. **Athena Query Timeout:**
   - Threshold: >30% of queries exceeding 5 minutes
   - Action: Escalate to analytics team
   - Log group: `/aws/athena/query-execution`

**Manual Detection:**

- User reports via Slack: `#bg-remover-alerts`
- Health check failures (see section 4)
- CloudWatch dashboard manual review (hourly)

### 2.3 Incident Triage

**P1 Triage (15 minute response):**

1. **Assess Scope:**
   ```bash
   # Check service status
   curl -s https://api.dev.carousellabs.co/bg-remover/health | jq .

   # Check Lambda invocation count (last 1 hour)
   aws cloudwatch get-metric-statistics \
     --namespace AWS/Lambda \
     --metric-name Invocations \
     --dimensions Name=FunctionName,Value=bg-remover-dev-s3TablesDataValidator \
     --start-time $(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%S) \
     --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
     --period 300 \
     --statistics Sum \
     --region eu-west-1
   ```

2. **Review Recent Changes:**
   ```bash
   # Check recent deployments
   aws cloudformation describe-stack-resources \
     --stack-name bg-remover-dev \
     --region eu-west-1 | jq .StackResources[].PhysicalResourceId

   # View recent git commits (if deployed from source)
   cd /Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover
   git log --oneline -10
   ```

3. **Check Service Dependencies:**
   ```bash
   # Verify DynamoDB is accessible
   aws dynamodb describe-table \
     --table-name bg-remover-dev-sales-intelligence \
     --region eu-west-1 | jq .Table.TableStatus

   # Verify S3 is accessible
   aws s3 ls s3://carousel-labs-analytics-dev/

   # Verify Athena is working
   aws athena list-query-executions \
     --region eu-west-1 --max-results 5 | jq .
   ```

4. **Decision Point:**
   - **If rollback needed:** Execute section 1.1 or 1.2
   - **If workaround available:** Document and apply
   - **If partial outage:** Escalate to team lead

**P2-P4 Triage (1-24 hour response):**

1. Assign to on-call engineer
2. Create incident ticket in Jira/GitHub Issues
3. Add to daily standup agenda
4. Follow standard triage process (collect logs, identify root cause)

### 2.4 Incident Resolution

**Resolution Workflow:**

```
Detect → Triage → Implement Fix → Verify → Document → Close
```

**For Each Severity Level:**

**P1 Resolution Steps:**
1. Activate incident commander
2. Execute rollback if available (section 1)
3. Verify fix (health checks + smoke tests)
4. Notify stakeholders on Slack
5. Begin post-mortem (within 24 hours)

**P2 Resolution Steps:**
1. Assign to engineer
2. Implement fix or workaround
3. Test in dev environment
4. Deploy to prod with monitoring
5. Verify resolution
6. Close ticket with notes

**P3-P4 Resolution Steps:**
1. Add to backlog or next sprint
2. Implement during normal development
3. Merge and deploy with standard process
4. Close with resolution notes

### 2.5 Post-Incident Process

**P1 Incidents (Mandatory Post-Mortem):**
- Held within 24 hours
- Attendees: on-call engineer, team lead, product owner
- Document: root cause, impact timeline, prevention measures
- Track: action items with owner and deadline

**P2-P4 Incidents (Optional Retrospective):**
- Document lessons learned in ticket
- Consider prevention measures
- Share findings with team

---

## 3. On-Call Procedures

### 3.1 Escalation Matrix

| Issue Type | Primary | Secondary | Tertiary |
|------------|---------|-----------|----------|
| Lambda errors, deployment | On-call Engineer | Service Owner (David Eagle) | DevOps Lead |
| DynamoDB issues | On-call Engineer | Data Engineer | AWS Support (if P1) |
| Athena/S3 Tables issues | On-call Engineer | Data Warehouse Team | AWS Support (if P1) |
| Data corruption (P1) | On-call Engineer | Data Engineer + Service Owner | CTO (if customer impact) |
| Security/Auth issues | On-call Engineer | Security Team | CISO (if P1) |

### 3.2 On-Call Responsibilities

**During Shift (24-hour rotation):**

1. **Monitor Alarms** - Check CloudWatch dashboard every 2 hours
   ```bash
   Dashboard: https://console.aws.amazon.com/cloudwatch/home?region=eu-west-1#dashboards:name=bg-remover-dev-overview
   ```

2. **Respond to Pages** - Target SLA: 5 minutes
   - Pagerduty notification → acknowledge within 5 min
   - Page escalates if not acknowledged in 10 min

3. **Triage Incidents** - See section 2.2-2.4
   - P1: Begin remediation immediately
   - P2+: Assess and plan response

4. **Health Checks** - Every 6 hours
   - Execute production smoke test checklist (section 4)
   - Log results in incident tracking system

5. **Handoff** - End of shift
   - Brief next on-call on any open issues
   - Document shift summary (alarms, incidents, actions)

### 3.3 Emergency Contacts

**Stored in AWS Secrets Manager:**
```bash
aws secretsmanager get-secret-value \
  --secret-id bg-remover/on-call-contacts \
  --region eu-west-1 | jq .SecretString
```

| Role | Contact Method | Escalation Level |
|------|---|---|
| On-call Engineer | Slack: `@oncall-bg-remover` | P1-P4 |
| Service Owner (David) | Email: david@carousellabs.com | P1-P2 |
| DevOps Lead | Slack: `@devops-lead` | P1 (critical) |
| Data Engineer | Slack: `#data-engineering` | P2-P3 (data) |
| AWS Support | Premium Support | P1 (escalation) |

### 3.4 Knowledge Base Links

- **Runbook:** This document
- **Architecture Diagram:** `/services/bg-remover/docs/ARCHITECTURE.md`
- **Schema Reference:** `/services/bg-remover/SALES_INTELLIGENCE_IMPLEMENTATION_GUIDE.md`
- **Troubleshooting Guide:** `/services/bg-remover/S3_TABLES_DATA_VALIDATOR_README.md`
- **Recent Deployments:** Check git tags: `git tag -l "bg-remover-*" | sort -V | tail -10`

---

## 4. Production Smoke Test Checklist

**Frequency:** Every 6 hours during business hours, before major deployments

**Estimated Duration:** 5-10 minutes

### 4.1 Health Check - Lambda

```bash
#!/bin/bash
set -e

echo "=== bg-remover Health Check ==="
echo "Timestamp: $(date -u)"

# 1. Lambda is responding
echo -e "\n[1/6] Lambda HTTP endpoint..."
HEALTH_RESPONSE=$(curl -s -w "%{http_code}" \
  https://api.dev.carousellabs.co/bg-remover/health)

if [[ $HEALTH_RESPONSE == *"200" ]]; then
  echo "✓ Health endpoint returning 200 OK"
else
  echo "✗ CRITICAL: Health endpoint returned $HEALTH_RESPONSE"
  exit 1
fi

# 2. Parse health response
echo -e "\n[2/6] Checking health status..."
HEALTH_JSON=$(curl -s https://api.dev.carousellabs.co/bg-remover/health)
echo $HEALTH_JSON | jq .

STATUS=$(echo $HEALTH_JSON | jq -r '.status // .state // .overall // .health')
if [[ "$STATUS" == "healthy" || "$STATUS" == "ok" ]]; then
  echo "✓ Service reports healthy status: $STATUS"
else
  echo "✗ WARNING: Service status: $STATUS (expected: healthy)"
fi
```

### 4.2 DLQ Monitoring

```bash
#!/bin/bash

echo -e "\n[3/6] DLQ Depth Check..."

DLQ_DEPTH=$(aws sqs get-queue-attributes \
  --queue-url "https://sqs.eu-west-1.amazonaws.com/ACCOUNT_ID/bg-remover-dev-dlq" \
  --attribute-names ApproximateNumberOfMessages \
  --region eu-west-1 \
  --query 'Attributes.ApproximateNumberOfMessages' \
  --output text)

if [[ "$DLQ_DEPTH" == "0" || -z "$DLQ_DEPTH" ]]; then
  echo "✓ DLQ is empty (depth: 0)"
else
  echo "✗ WARNING: DLQ has $DLQ_DEPTH messages"
  echo "  Action: Check Lambda logs for processing errors"

  # Show sample message
  aws sqs receive-message \
    --queue-url "https://sqs.eu-west-1.amazonaws.com/ACCOUNT_ID/bg-remover-dev-dlq" \
    --region eu-west-1 | jq '.Messages[0]' 2>/dev/null || true
fi
```

### 4.3 Latest Embedding Generation

```bash
#!/bin/bash

echo -e "\n[4/6] Embedding Generation Freshness..."

# Check CloudWatch logs for recent success
LATEST_LOG=$(aws logs tail /aws/lambda/bg-remover-dev-embeddings \
  --since 5m \
  --follow=false \
  --region eu-west-1 \
  --filter-pattern "EmbeddingGenerated\|Successfully" \
  2>/dev/null | tail -1)

if [[ ! -z "$LATEST_LOG" ]]; then
  echo "✓ Recent embedding generation detected (within 5 min)"
  echo "  Log: $LATEST_LOG"
else
  echo "✗ WARNING: No recent embedding generation found"

  # Check if function is even running
  INVOCATIONS=$(aws cloudwatch get-metric-statistics \
    --namespace AWS/Lambda \
    --metric-name Invocations \
    --dimensions Name=FunctionName,Value=bg-remover-dev-embeddings \
    --start-time $(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%S) \
    --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
    --period 3600 \
    --statistics Sum \
    --region eu-west-1 \
    --query 'Datapoints[0].Sum' \
    --output text)

  echo "  Function invocations (1h): $INVOCATIONS"
fi
```

### 4.4 Mem0 Memory Creation

```bash
#!/bin/bash

echo -e "\n[5/6] Mem0 Integration..."

# Query DynamoDB for recent mem0 memory entries
RECENT_MEMORIES=$(aws dynamodb query \
  --table-name bg-remover-dev-sales-intelligence \
  --index-name GSI2 \
  --key-condition-expression "GSI2PK = :pk AND #t > :timestamp" \
  --expression-attribute-names '{"#t":"CreatedAt"}' \
  --expression-attribute-values '{":pk":{"S":"TENANT#carousel-labs#EMBEDTYPE#MEM0"},":timestamp":{"N":"'$(date -d "5 minutes ago" +%s)'000"}}' \
  --scan-index-forward false \
  --limit 5 \
  --region eu-west-1 \
  --query 'Items | length(@)' \
  --output text 2>/dev/null || echo "0")

if [[ "$RECENT_MEMORIES" -gt "0" ]]; then
  echo "✓ Mem0 integration active: $RECENT_MEMORIES memories created (5 min)"
else
  echo "✗ WARNING: No recent mem0 memory creation"
  echo "  This may be normal if mem0 sync is not running"
fi
```

### 4.5 Data Validation Metrics

```bash
#!/bin/bash

echo -e "\n[6/6] Data Validation Status..."

# Check latest validation run
LATEST_VALIDATION=$(aws logs tail /aws/lambda/bg-remover-dev-s3TablesDataValidator \
  --since 24h \
  --follow=false \
  --region eu-west-1 \
  --filter-pattern "validation_summary" \
  2>/dev/null | tail -1)

if [[ ! -z "$LATEST_VALIDATION" ]]; then
  echo "✓ Latest validation completed:"
  echo "  $LATEST_VALIDATION"

  # Check for critical issues
  if [[ $LATEST_VALIDATION == *"CRITICAL"* ]]; then
    echo "  ⚠️  CRITICAL issue detected in last validation - review SNS alerts"
  fi
else
  echo "✗ No validation data found in last 24h"
  echo "  Expected: Daily run at 4 AM UTC via EventBridge"
fi

echo -e "\n=== Health Check Complete ==="
```

### 4.6 Full Smoke Test Script

Save as `/scripts/smoke-test.sh`:

```bash
#!/bin/bash
set -e

STAGE=${1:-dev}
REGION=${2:-eu-west-1}

echo "Starting smoke test for bg-remover-$STAGE..."

# Run all checks
bash /scripts/health-check.sh $STAGE
bash /scripts/dlq-check.sh $STAGE
bash /scripts/embedding-freshness.sh $STAGE
bash /scripts/mem0-integration.sh $STAGE
bash /scripts/validation-status.sh $STAGE

echo ""
echo "Smoke test completed successfully!"
exit 0
```

**Run before deployment:**
```bash
bash /scripts/smoke-test.sh dev eu-west-1
```

**Success Criteria:**
- All 5 checks pass (or show expected warnings)
- No CRITICAL status in any check
- Response times < 2 seconds
- DLQ depth = 0

---

## 5. Cost Monitoring Procedures

### 5.1 Daily Cost Review

**Time Required:** 5 minutes
**Frequency:** Daily, 9 AM UTC (morning standup)

```bash
#!/bin/bash

echo "=== bg-remover Daily Cost Report ==="
echo "Date: $(date -u +%Y-%m-%d)"

# Get yesterday's costs from AWS Cost Explorer
YESTERDAY=$(date -u -d "yesterday" +%Y-%m-%d)
COSTS=$(aws ce get-cost-and-usage \
  --time-period Start=$YESTERDAY,End=$YESTERDAY \
  --granularity DAILY \
  --metrics BlendedCost \
  --group-by Type=DIMENSION,Key=SERVICE \
  --region eu-west-1)

echo $COSTS | jq -r '.ResultsByTime[0].Groups[] | select(.Keys[0] | contains("Lambda","DynamoDB","S3","Athena","SNS")) | "\(.Keys[0]): $\(.Metrics.BlendedCost.Amount)"'

# Calculate total
TOTAL=$(echo $COSTS | jq '.ResultsByTime[0].Groups | map(.Metrics.BlendedCost.Amount | tonumber) | add' 2>/dev/null || echo "0")
echo ""
echo "Total bg-remover cost: \$$TOTAL"
echo "Expected monthly run-rate: \$$(echo "$TOTAL * 30" | bc -l | cut -d. -f1)"
```

**Expected Daily Costs (Baseline):**
| Component | Cost/Day |
|-----------|----------|
| Lambda (validation) | $0.07 |
| DynamoDB (on-demand) | $0.01 |
| S3 Tables/Athena | $0.05 |
| SNS | $0.01 |
| **Total** | **~$0.14/day** |

**Monthly Baseline:** ~$4.20/month

### 5.2 Cost Alerts & Thresholds

**Alert Thresholds (Daily):**
- >$0.20/day (43% above baseline) → Review Lambda logs for excessive Scans
- >$0.50/day (257% above baseline) → Critical - potential runaway costs

**Setup CloudWatch Alarm:**
```bash
aws cloudwatch put-metric-alarm \
  --alarm-name bg-remover-high-cost \
  --alarm-description "Daily cost exceeds $0.20" \
  --metric-name EstimatedCharges \
  --namespace AWS/Billing \
  --statistic Maximum \
  --period 86400 \
  --threshold 0.20 \
  --comparison-operator GreaterThanThreshold \
  --alarm-actions arn:aws:sns:eu-west-1:ACCOUNT_ID:bg-remover-cost-alerts
```

### 5.3 Monthly Cost Analysis

**Frequency:** First business day of month

```bash
#!/bin/bash

MONTH=$(date -u +%Y-%m)
LAST_MONTH=$(date -u -d "1 month ago" +%Y-%m)

echo "=== bg-remover Monthly Cost Report ==="
echo "Month: $LAST_MONTH"

aws ce get-cost-and-usage \
  --time-period Start=$LAST_MONTH-01,End=$LAST_MONTH-31 \
  --granularity MONTHLY \
  --metrics BlendedCost \
  --group-by Type=DIMENSION,Key=SERVICE \
  --filter file://cost-filter.json \
  --region eu-west-1 | jq .

# Compare to budget
BUDGET_LIMIT=5.00  # Monthly budget in USD
LAST_COST=$(aws ce get-cost-and-usage ... | jq '.ResultsByTime[0].Total.BlendedCost.Amount' | tr -d '"')

echo ""
echo "Budget: \$$BUDGET_LIMIT"
echo "Actual: \$$LAST_COST"
echo "Remaining: \$$(echo "$BUDGET_LIMIT - $LAST_COST" | bc)"

if (( $(echo "$LAST_COST > $BUDGET_LIMIT" | bc -l) )); then
  echo "⚠️  OVER BUDGET - Review cost drivers"
fi
```

### 5.4 Cost Optimization Opportunities

**Regular Reviews:**

1. **Lambda Duration** - Target: <120s per invocation
   - Check CloudWatch: `aws logs tail /aws/lambda/bg-remover-dev-* | grep Duration`
   - If >120s: Review Athena queries, add pagination

2. **DynamoDB Scans** - Target: 0 Scans per day
   - Use Query with GSI instead
   - Check: `aws cloudwatch get-metric-statistics --metric-name UserErrors`
   - Alert if any Scans detected

3. **S3 Requests** - Target: <1000 PUT requests/day
   - Batch writes reduce costs by 4x
   - Monitor: `aws s3 ls --summarize`

4. **Athena Query Volume** - Target: <50 queries/day
   - Cache results (Athena caches 24 hours)
   - Use LIMIT for testing queries

### 5.5 Bedrock API Costs (Future)

When embeddings generation is enabled:

**Monitor:**
```bash
# Bedrock invocation costs (charged per 1000 input/output tokens)
aws cloudwatch get-metric-statistics \
  --namespace AWS/Bedrock \
  --metric-name InvocationCount \
  --dimensions Name=Model,Value=titan-embed-text-v2 \
  --start-time $(date -u -d "1 day ago" +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 86400 \
  --statistics Sum \
  --region eu-west-1
```

**Expected cost:** ~$0.10 per 1000 embeddings

---

## 6. Common Issues & Resolutions

### 6.1 DLQ Messages Accumulating

**Symptom:**
- DLQ shows >10 messages
- User reports validation not running
- SNS alerts not received

**Root Causes:**
1. Lambda timeout (function takes >900s)
2. Athena query fails
3. DynamoDB table error
4. SNS publish fails
5. Insufficient IAM permissions

**Diagnosis:**

```bash
# Check DLQ message
aws sqs receive-message \
  --queue-url "https://sqs.eu-west-1.amazonaws.com/ACCOUNT_ID/bg-remover-dev-dlq" \
  --region eu-west-1 | jq '.Messages[0].Body'

# Check Lambda error logs
npx serverless@4 logs \
  --function s3TablesDataValidator \
  --stage dev \
  --startTime 1h

# Check recent Lambda duration
aws cloudwatch get-metric-statistics \
  --namespace AWS/Lambda \
  --metric-name Duration \
  --dimensions Name=FunctionName,Value=bg-remover-dev-s3TablesDataValidator \
  --start-time $(date -u -d "1 hour ago" +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 300 \
  --statistics Average,Maximum \
  --region eu-west-1
```

**Resolutions:**

**If Lambda Timeout:**
```bash
# 1. Increase timeout from 900s to 1200s (20 min)
aws lambda update-function-configuration \
  --function-name bg-remover-dev-s3TablesDataValidator \
  --timeout 1200 \
  --region eu-west-1

# 2. Optimize Athena queries - add LIMIT
# Edit handler and redeploy
cd /Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover
npm run build && npm run deploy:dev

# 3. Retry DLQ messages after fix
aws sqs send-message-batch \
  --queue-url "https://sqs.eu-west-1.amazonaws.com/ACCOUNT_ID/bg-remover-dev-main" \
  --entries file://dlq-messages.json \
  --region eu-west-1
```

**If Athena Query Fails:**
```bash
# 1. Check Athena query status
aws athena get-query-execution \
  --query-execution-id "query-id-from-logs" \
  --region eu-west-1 | jq .QueryExecution.Status

# 2. Check if table exists
aws athena start-query-execution \
  --query-string "SHOW TABLES FROM pricing_intelligence_dev" \
  --query-execution-context Database=pricing_intelligence_dev \
  --result-configuration OutputLocation=s3://carousel-labs-analytics-dev/athena-results/ \
  --region eu-west-1

# 3. Verify S3 Tables path
aws s3 ls s3://carousel-labs-analytics-dev/pricing-intelligence/ --recursive | head -20
```

**If DynamoDB Error:**
```bash
# 1. Check table status
aws dynamodb describe-table \
  --table-name bg-remover-dev-sales-intelligence \
  --region eu-west-1 | jq .Table.TableStatus

# 2. Check for throttling
aws cloudwatch get-metric-statistics \
  --namespace AWS/DynamoDB \
  --metric-name UserErrors \
  --dimensions Name=TableName,Value=bg-remover-dev-sales-intelligence \
  --start-time $(date -u -d "1 hour ago" +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 300 \
  --statistics Sum \
  --region eu-west-1

# 3. Enable auto-scaling if needed
# Edit serverless.yml and add autoscaling plugin
```

**Resolution Checklist:**
- [ ] DLQ messages cleared
- [ ] Lambda logs show success
- [ ] Next invocation completes without errors
- [ ] SNS alert received (or verified it's not needed)

---

### 6.2 Lambda Timeout (>900s)

**Symptom:**
- Function consistently timeout at 900s
- Validation report incomplete
- No SNS alerts sent (fails during alert phase)

**Root Causes:**
1. Athena query >600s (scanning too much data)
2. DynamoDB Scan on large table
3. SNS publish slow
4. Network connectivity issue

**Diagnosis:**

```bash
# View execution logs with timestamps
npx serverless@4 logs \
  --function s3TablesDataValidator \
  --stage dev \
  --filter "Duration\|START\|END"

# Check which phase times out
# Look for phase_completed vs phase_started timestamps

# Example log analysis:
# 2025-12-30 04:00:30 - RowCountCheck START
# 2025-12-30 04:12:45 - RowCountCheck COMPLETED (12m 15s) ← TOO LONG
# 2025-12-30 04:13:00 - EmbeddingCheck START
# 2025-12-30 04:14:45 - EmbeddingCheck COMPLETED (1m 45s)
# ...timeout occurs...
```

**Resolutions:**

**Quick Fix - Increase Timeout:**
```bash
aws lambda update-function-configuration \
  --function-name bg-remover-dev-s3TablesDataValidator \
  --timeout 1200 \
  --region eu-west-1 && \
npx serverless@4 deploy --function s3TablesDataValidator --stage dev --region eu-west-1
```

**Proper Fix - Optimize Queries:**

**Athena Query Optimization:**
```yaml
# Before (slow):
SELECT COUNT(*) FROM sales_history WHERE tenant_id = 'carousel-labs'

# After (fast - uses partition):
SELECT COUNT(*) FROM sales_history
WHERE tenant_id = 'carousel-labs'
AND year = 2025 AND month = 12
```

**DynamoDB Query Optimization:**
```typescript
// Before (slow Scan):
const result = await dynamodb.scan({
  TableName: 'bg-remover-dev-sales-intelligence',
  FilterExpression: 'tenant_id = :tid',
  ExpressionAttributeValues: { ':tid': 'carousel-labs' }
});

// After (fast Query with GSI):
const result = await dynamodb.query({
  TableName: 'bg-remover-dev-sales-intelligence',
  IndexName: 'GSI1',
  KeyConditionExpression: 'GSI1PK = :pk',
  ExpressionAttributeValues: { ':pk': 'TENANT#carousel-labs' }
});
```

**Verification:**
- Redeploy with optimized queries
- Monitor next execution duration
- Target: <300s total (80% of timeout budget)

---

### 6.3 DynamoDB Throttling

**Symptom:**
- Lambda logs show "ProvisionedThroughputExceededException"
- Data validation runs slow
- Errors occur during peak times

**Root Causes:**
1. Too many concurrent Scans
2. Table capacity too low
3. GSI burst capacity exhausted
4. Too many simultaneous queries

**Diagnosis:**

```bash
# Check throttling metrics
aws cloudwatch get-metric-statistics \
  --namespace AWS/DynamoDB \
  --metric-name ConsumedReadCapacityUnits \
  --dimensions Name=TableName,Value=bg-remover-dev-sales-intelligence \
  --start-time $(date -u -d "1 hour ago" +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 60 \
  --statistics Sum,Maximum \
  --region eu-west-1

# Check for UserErrors (throttling)
aws cloudwatch get-metric-statistics \
  --namespace AWS/DynamoDB \
  --metric-name UserErrors \
  --dimensions Name=TableName,Value=bg-remover-dev-sales-intelligence \
  --start-time $(date -u -d "1 hour ago" +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 60 \
  --statistics Sum \
  --region eu-west-1
```

**Resolutions:**

**Immediate - Reduce Concurrent Queries:**
```typescript
// Add delay between shard queries
const queryCategorySeason = async (tenant, category, season, startDate, endDate) => {
  const shards = [0,1,2,3,4,5,6,7,8,9];
  const results = [];

  // Sequential instead of parallel to reduce load
  for (const shard of shards) {
    const result = await query(tenant, category, shard, startDate, endDate);
    results.push(result);

    // Add 50ms delay between queries
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  return results;
};
```

**Optimal - Enable Auto-Scaling:**
```yaml
# serverless.yml
plugins:
  - serverless-dynamodb-autoscaling

custom:
  dynamodb:
    autoscaling:
      - table: SalesIntelligenceTable
        read:
          minimum: 10
          maximum: 100
          targetUtilization: 70
```

**Cost-Based - Use On-Demand Billing:**
```yaml
# Change from provisioned to pay-per-request
resources:
  Resources:
    SalesIntelligenceTable:
      Type: AWS::DynamoDB::Table
      Properties:
        BillingMode: PAY_PER_REQUEST  # Instead of PROVISIONED
```

**Verification:**
```bash
# Monitor after fix
watch -n 5 'aws cloudwatch get-metric-statistics \
  --namespace AWS/DynamoDB \
  --metric-name UserErrors \
  --dimensions Name=TableName,Value=bg-remover-dev-sales-intelligence \
  --start-time $(date -u -d "5 min ago" +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 60 \
  --statistics Sum \
  --region eu-west-1 | jq .Datapoints'
```

---

### 6.4 S3 Tables Sync Lag

**Symptom:**
- Athena queries show stale data (>1 hour old)
- Record counts don't match between DynamoDB and S3 Tables
- Data validation shows high variance (>10%)

**Root Causes:**
1. Exporter Lambda not running
2. EventBridge rule disabled
3. S3 Tables Iceberg metadata out of sync
4. Network connectivity to S3

**Diagnosis:**

```bash
# Check when last export happened
aws logs tail /aws/lambda/bg-remover-dev-s3-exporter \
  --since 2h \
  --follow=false \
  --region eu-west-1 \
  --filter-pattern "COMPLETED\|ERROR" | tail -5

# Check S3 Tables latest modification time
aws s3api list-object-versions \
  --bucket carousel-labs-analytics-dev \
  --prefix pricing-intelligence/ \
  --max-items 5 \
  --region eu-west-1 | jq '.Versions[0].LastModified'

# Check EventBridge rule
aws events describe-rule \
  --name bg-remover-dev-s3-export-schedule \
  --region eu-west-1
```

**Resolutions:**

**If Exporter Lambda Not Running:**
```bash
# Check CloudWatch logs
aws logs tail /aws/lambda/bg-remover-dev-s3-exporter --since 6h | grep ERROR

# Manually trigger export
aws lambda invoke \
  --function-name bg-remover-dev-s3-exporter \
  --payload '{"source":"manual-trigger"}' \
  /tmp/export-response.json \
  --region eu-west-1

# Check output
cat /tmp/export-response.json | jq .
```

**If EventBridge Rule Disabled:**
```bash
# Check rule state
aws events describe-rule \
  --name bg-remover-dev-s3-export-schedule \
  --region eu-west-1 | jq .State

# Enable rule
aws events enable-rule \
  --name bg-remover-dev-s3-export-schedule \
  --region eu-west-1

# Verify
aws events describe-rule \
  --name bg-remover-dev-s3-export-schedule \
  --region eu-west-1 | jq .State
```

**If S3 Tables Metadata Out of Sync:**
```bash
# Force Athena to refresh metadata
aws athena start-query-execution \
  --query-string "REFRESH TABLE pricing_intelligence_dev.sales_history" \
  --query-execution-context Database=pricing_intelligence_dev \
  --result-configuration OutputLocation=s3://carousel-labs-analytics-dev/athena-results/ \
  --region eu-west-1

# Monitor refresh
aws athena get-query-execution \
  --query-execution-id "returned-above" \
  --region eu-west-1 | jq .QueryExecution.Status
```

**Verification:**
```bash
# Check data freshness
aws athena start-query-execution \
  --query-string "SELECT MAX(updated_at) FROM pricing_intelligence_dev.sales_history" \
  --query-execution-context Database=pricing_intelligence_dev \
  --result-configuration OutputLocation=s3://carousel-labs-analytics-dev/athena-results/ \
  --region eu-west-1
```

**Expected Lag:** <15 minutes
**Alert Threshold:** >1 hour

---

## Summary

This operational runbook provides procedures for:

✅ Rollback strategies (Lambda, DynamoDB, S3 Tables)
✅ Incident response workflow with SLAs
✅ On-call escalation procedures
✅ Production smoke test checklist
✅ Cost monitoring thresholds
✅ Common issues with step-by-step resolutions

**Key Contacts:**
- On-call Engineer: Slack `@oncall-bg-remover`
- Service Owner (David): david@carousellabs.com
- DevOps Lead: Slack `@devops-lead`

**Documents to Review:**
- Architecture: `/services/bg-remover/docs/ARCHITECTURE.md`
- Schema: `/services/bg-remover/SALES_INTELLIGENCE_IMPLEMENTATION_GUIDE.md`
- Validation Guide: `/services/bg-remover/S3_TABLES_DATA_VALIDATOR_README.md`

**Last Reviewed:** 2025-12-30
**Next Review Due:** 2026-01-30 (monthly)
