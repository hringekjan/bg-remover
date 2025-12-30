# S3 Tables Deployment Guide

## Complete Step-by-Step Deployment

This guide walks through the complete process of setting up and validating the S3 Tables (Apache Iceberg) schema for the Pricing Intelligence data lake.

## Prerequisites

### Required Tools

- AWS CLI v2+ configured with appropriate credentials
- Python 3.11+ with `boto3` library
- Bash shell
- Git (for navigating the repository)

### Required AWS Permissions

Your AWS IAM user/role must have these permissions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "glue:CreateDatabase",
        "glue:GetDatabase",
        "glue:UpdateDatabase",
        "glue:CreateTable",
        "glue:GetTable",
        "glue:UpdateTable",
        "glue:DeleteTable",
        "glue:BatchCreatePartition",
        "glue:BatchDeletePartition",
        "glue:GetPartition",
        "glue:GetPartitions"
      ],
      "Resource": [
        "arn:aws:glue:eu-west-1:*:catalog",
        "arn:aws:glue:eu-west-1:*:database/pricing_intelligence_*",
        "arn:aws:glue:eu-west-1:*:table/pricing_intelligence_*/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:CreateBucket",
        "s3:GetBucketVersioning",
        "s3:PutBucketVersioning",
        "s3:PutPublicAccessBlock",
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::carousel-*-analytics",
        "arn:aws:s3:::carousel-*-analytics/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "athena:StartQueryExecution",
        "athena:GetQueryExecution",
        "athena:GetQueryResults",
        "athena:StopQueryExecution",
        "athena:GetWorkGroup"
      ],
      "Resource": "*"
    }
  ]
}
```

### Environment Variables to Check

```bash
# Verify these are set correctly
echo "AWS_PROFILE: $AWS_PROFILE"
echo "AWS_REGION: $AWS_REGION"
echo "AWS_DEFAULT_REGION: $AWS_DEFAULT_REGION"

# Or use AWS CLI profiles
export AWS_PROFILE=carousel-labs-dev-admin
```

## Deployment Steps

### Step 1: Navigate to Service Directory

```bash
cd /Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover
```

### Step 2: Verify AWS Credentials

```bash
# Check AWS CLI is configured
aws sts get-caller-identity --region eu-west-1

# Expected output:
# {
#     "UserId": "...",
#     "Account": "123456789012",
#     "Arn": "arn:aws:iam::123456789012:user/your-user"
# }
```

### Step 3: Verify Python Dependencies

```bash
# Check Python version
python3 --version
# Should be >= 3.11

# Install boto3 if needed
python3 -m pip install --upgrade boto3

# Verify installation
python3 -c "import boto3; print(f'boto3 {boto3.__version__}')"
```

### Step 4: Create Glue Database and Iceberg Table

```bash
# For development environment
bash scripts/deploy-s3-tables.sh dev eu-west-1

# For staging environment
bash scripts/deploy-s3-tables.sh staging eu-west-1

# For production environment
bash scripts/deploy-s3-tables.sh prod eu-west-1
```

**Expected Output:**
```
[2025-01-30 10:15:23] Creating S3 Tables schema for stage: dev
[2025-01-30 10:15:23] Region: eu-west-1
[2025-01-30 10:15:23] Database: pricing_intelligence_dev
[2025-01-30 10:15:23] Table: sales_history
[2025-01-30 10:15:23] S3 Location: s3://carousel-dev-analytics/pricing-intelligence/sales_history/
[2025-01-30 10:15:24] Verifying AWS credentials...
[2025-01-30 10:15:25] SUCCESS AWS credentials verified (Account: 123456789012)
[2025-01-30 10:15:25] Checking Python dependencies...
[2025-01-30 10:15:25] Python script: .../scripts/create-s3-tables-schema.py
[2025-01-30 10:15:25] Creating S3 Tables schema...
[2025-01-30 10:15:26] Command: python3 .../scripts/create-s3-tables-schema.py --stage dev --region eu-west-1
... (Python script output)
[2025-01-30 10:15:28] SUCCESS S3 Tables schema creation completed
```

### Step 5: Verify Installation

```bash
# Run the verification script
bash scripts/verify-s3-tables.sh dev eu-west-1

# Expected output shows:
# - AWS credentials verified
# - Glue database exists
# - Glue table exists
# - S3 bucket accessible
# - Athena WorkGroup accessible
# - All checks passed!
```

### Step 6: Verify in AWS Console (Optional)

1. **AWS Glue Console:**
   - Navigate to AWS Glue > Databases
   - Verify `pricing_intelligence_dev` database exists
   - Click to see tables
   - Verify `sales_history` table exists
   - Click to inspect schema

2. **S3 Console:**
   - Navigate to S3 > Buckets
   - Find `carousel-dev-analytics` bucket
   - Browse to `pricing-intelligence/sales_history/`
   - Should be empty initially (no data yet)

3. **Athena Console:**
   - Navigate to Athena > Query Editor
   - Select database: `pricing_intelligence_dev`
   - Should show `sales_history` in table list

## Data Loading

### Option 1: Load Sample Data (Recommended for Testing)

```bash
# Generate and load 1000 sample records
python3 scripts/load-sample-sales-data.py \
  --stage dev \
  --region eu-west-1 \
  --num-records 1000

# Generate 10,000 records (larger dataset for testing)
python3 scripts/load-sample-sales-data.py \
  --stage dev \
  --region eu-west-1 \
  --num-records 10000
```

**Expected Output:**
```
2025-01-30 10:20:15 - INFO - Generating 1000 sample sales records...
2025-01-30 10:20:15 - INFO - Stage: dev, Region: eu-west-1
2025-01-30 10:20:15 - INFO - Generated 1000 records
2025-01-30 10:20:15 - INFO - Records grouped into 24 partitions
2025-01-30 10:20:15 - INFO - Converting 42 records to Parquet (Y=2023, M=1)...
2025-01-30 10:20:15 - INFO - Uploaded 102400 bytes to s3://carousel-dev-analytics/pricing-intelligence/sales_history/year=2023/month=01/...
...
2025-01-30 10:20:18 - INFO - Successfully uploaded 24 Parquet files
2025-01-30 10:20:18 - INFO - Total records loaded: 1000
```

### Option 2: Verify Data in Athena

```bash
# Start a test query
aws athena start-query-execution \
  --query-string "SELECT COUNT(*) as total_records FROM pricing_intelligence_dev.sales_history" \
  --query-execution-context Database=pricing_intelligence_dev \
  --result-configuration OutputLocation=s3://carousel-dev-analytics/athena-results/ \
  --region eu-west-1

# Expected output includes QueryExecutionId
# {
#     "QueryExecutionId": "12345678-1234-1234-1234-123456789012"
# }

# Get query results
aws athena get-query-results \
  --query-execution-id 12345678-1234-1234-1234-123456789012 \
  --region eu-west-1
```

## Validation Checklist

Use this checklist to verify everything is working:

### Schema Creation
- [ ] Glue database created: `pricing_intelligence_{stage}`
- [ ] Iceberg table created: `sales_history`
- [ ] Table schema matches specification (12 columns + year/month partitions)
- [ ] PARQUET format with SNAPPY compression configured
- [ ] S3 bucket created: `carousel-{stage}-analytics`
- [ ] S3 location accessible with proper permissions

### Data Loading (if applicable)
- [ ] Sample data loaded successfully
- [ ] Parquet files in S3 partition structure (year=YYYY/month=MM/)
- [ ] Row count matches expected count
- [ ] Data types correct (decimal, timestamp, array)

### Query Execution
- [ ] Athena can query the table
- [ ] Query returns expected results
- [ ] Partition pruning works (filter by year/month)
- [ ] Embedding arrays handled correctly

### Permissions
- [ ] Lambda functions can read from Iceberg table
- [ ] Lambda functions can write to S3 (if implementing write path)
- [ ] Glue permissions in serverless.yml updated

## Troubleshooting

### Issue: "EntityNotFoundException" - Table not found

**Cause:** Table wasn't created or already exists
**Solution:**
```bash
# Manually create table
python3 scripts/create-s3-tables-schema.py --stage dev --region eu-west-1

# Verify creation
aws glue get-table --database-name pricing_intelligence_dev --name sales_history --region eu-west-1
```

### Issue: "AccessDenied" when running scripts

**Cause:** Insufficient IAM permissions
**Solution:**
```bash
# Check which user/role is being used
aws sts get-caller-identity

# Verify permissions
aws glue get-database --name pricing_intelligence_dev
aws s3 ls s3://carousel-dev-analytics

# If needed, update IAM policy with required permissions
```

### Issue: "NoCredentialsError" - AWS credentials not found

**Cause:** AWS CLI not configured
**Solution:**
```bash
# Configure AWS CLI
aws configure

# Or set environment variables
export AWS_ACCESS_KEY_ID=your_access_key
export AWS_SECRET_ACCESS_KEY=your_secret_key
export AWS_DEFAULT_REGION=eu-west-1

# Verify credentials
aws sts get-caller-identity
```

### Issue: Python script errors

**Cause:** Missing boto3 library or Python version mismatch
**Solution:**
```bash
# Update pip
python3 -m pip install --upgrade pip

# Install boto3
python3 -m pip install boto3

# Check Python version
python3 --version
# Should be >= 3.11
```

### Issue: Athena query returns "Table not found"

**Cause:** Athena metadata cache stale
**Solution:**
```bash
# Refresh Glue catalog
aws glue get-partitions \
  --database-name pricing_intelligence_dev \
  --table-name sales_history

# Try query again after 30 seconds
```

## Integration with serverless.yml

The `serverless.yml` has been updated with S3 Tables permissions:

```yaml
provider:
  iam:
    role:
      statements:
        # S3 Tables / Glue permissions (Apache Iceberg)
        - Effect: Allow
          Action:
            - glue:CreateDatabase
            - glue:GetDatabase
            - glue:CreateTable
            - glue:GetTable
            - glue:UpdateTable
            - glue:BatchCreatePartition
          Resource:
            - "arn:aws:glue:${aws:region}:${aws:accountId}:catalog"
            - "arn:aws:glue:${aws:region}:${aws:accountId}:database/pricing_intelligence_*"
            - "arn:aws:glue:${aws:region}:${aws:accountId}:table/pricing_intelligence_*/*"

        # S3 access for Iceberg table storage
        - Effect: Allow
          Action:
            - s3:GetObject
            - s3:PutObject
            - s3:DeleteObject
            - s3:ListBucket
          Resource:
            - "arn:aws:s3:::carousel-${sls:stage}-analytics"
            - "arn:aws:s3:::carousel-${sls:stage}-analytics/*"

        # Athena permissions for querying
        - Effect: Allow
          Action:
            - athena:StartQueryExecution
            - athena:GetQueryExecution
            - athena:GetQueryResults
          Resource:
            - "arn:aws:athena:${aws:region}:${aws:accountId}:workgroup/primary"
```

## Post-Deployment Tasks

### 1. Update ETL Pipeline

Implement data write path in your ETL Lambda:

```python
import boto3
from datetime import datetime

glue = boto3.client('glue')
s3 = boto3.client('s3')

def write_to_iceberg(sales_records):
    """Write sales records to Iceberg table via S3."""
    # Convert to Parquet
    # Upload to S3 in partition structure
    # Glue will automatically discover and add partitions
    pass
```

### 2. Set Up Monitoring

Create CloudWatch alarms for data quality:

```bash
# Monitor Athena query performance
aws cloudwatch put-metric-alarm \
  --alarm-name pricing-intelligence-athena-slow-queries \
  --alarm-description "Alert on slow Athena queries" \
  --metric-name EngineExecutionTime \
  --namespace AWS/Athena \
  --statistic Average \
  --period 3600 \
  --evaluation-periods 1 \
  --threshold 30000 \
  --comparison-operator GreaterThanThreshold
```

### 3. Configure Data Lifecycle

Set up S3 Glacier archival for old data:

```bash
aws s3api put-bucket-lifecycle-configuration \
  --bucket carousel-dev-analytics \
  --lifecycle-configuration file://lifecycle-policy.json
```

### 4. Configure Athena Query Results Location

```bash
# Create results bucket
aws s3 mb s3://carousel-dev-athena-results/

# Set results location in Athena WorkGroup
aws athena update-work-group \
  --work-group primary \
  --configuration ResultConfigurationUpdates={OutputLocation=s3://carousel-dev-athena-results/}
```

## Rollback Procedure

If needed to rollback the deployment:

### Remove Iceberg Table (Keep Data)
```bash
aws glue delete-table \
  --database-name pricing_intelligence_dev \
  --name sales_history \
  --region eu-west-1
```

### Remove Glue Database
```bash
aws glue delete-database \
  --name pricing_intelligence_dev \
  --region eu-west-1
```

### Remove S3 Bucket (Delete All Data)
```bash
# WARNING: This deletes all data!
aws s3 rm s3://carousel-dev-analytics/ --recursive
aws s3 rb s3://carousel-dev-analytics/
```

## Success Criteria

Your deployment is successful when:

1. All verification checks pass
2. Sample data loads without errors
3. Athena queries return results
4. No IAM permission errors
5. CloudWatch shows normal metrics
6. serverless.yml is updated with S3 Tables permissions

## Next Steps

1. Implement data write pipeline in your application
2. Connect Athena to BI tool (QuickSight, Tableau)
3. Set up automated backups and archival
4. Monitor costs and optimize partitioning
5. Build dashboards for analytics

## Support and Troubleshooting

For issues:

1. Check deployment logs: `.serverless/s3-tables-logs/`
2. Review AWS service logs in CloudWatch
3. Verify permissions: `aws iam get-user-policy`
4. Test connectivity: `aws glue list-databases`

## Additional Resources

- Full documentation: `docs/S3_TABLES_IMPLEMENTATION.md`
- Quick start guide: `docs/S3_TABLES_QUICKSTART.md`
- Sample queries: `sql/sales-history-queries.sql`
- Scripts: `scripts/`
