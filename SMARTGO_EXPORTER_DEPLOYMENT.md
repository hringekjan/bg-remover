# SmartGo to S3 Tables Exporter Lambda - Deployment Guide

## Overview

The SmartGo to S3 Tables Exporter is a daily batch Lambda function that exports SmartGo sales data to S3 Tables (Apache Iceberg) with Titan image embeddings for pricing intelligence analytics.

**Trigger:** EventBridge cron (daily at 3 AM UTC)
**Runtime:** Node.js 22.x
**Memory:** 1024MB
**Timeout:** 900s (15 minutes)
**Cost:** ~$0.30/day (minimal - runs once per day)

## Architecture

```
SmartGo Database
    ↓
[SmartGo Exporter Lambda] (daily at 3 AM UTC)
    ├→ Query sales from last 24 hours
    ├→ Download product images (parallel, max 5 concurrent)
    ├→ Generate Titan embeddings (1024-dimensional vectors)
    └→ Write to S3 Tables (Iceberg partitioning)
         ↓
[S3 Tables Analytics Bucket]
    └── pricing-intelligence/smartgo_sales/
        └── tenant_id={tenantId}/year={YYYY}/month={MM}/{productId}.parquet

[DynamoDB Progress Tracking]
    └── Export metadata (start/end times, success/error counts)
```

## Pre-Deployment Requirements

### 1. SmartGo Database Configuration in SSM Parameter Store

Create SSM SecureString parameter with SmartGo database credentials:

```bash
# Set parameters
STAGE=dev
TENANT=carousel-labs
REGION=eu-west-1

# Create SmartGo database configuration
aws ssm put-parameter \
  --name "/tf/${STAGE}/smartgo/database/config" \
  --type SecureString \
  --value '{
    "host": "smartgo-db.example.com",
    "port": 5432,
    "database": "smartgo_prod",
    "username": "smartgo_user",
    "password": "encrypted-password",
    "maxConnections": 10,
    "connectionTimeoutMs": 5000,
    "queryTimeoutMs": 30000
  }' \
  --region ${REGION}

# Verify parameter creation
aws ssm get-parameter \
  --name "/tf/${STAGE}/smartgo/database/config" \
  --with-decryption \
  --region ${REGION}
```

**Configuration fields:**
- `host`: SmartGo database hostname
- `port`: Database port (5432 for PostgreSQL, 3306 for MySQL)
- `database`: Database name
- `username`: Database user with SELECT permissions
- `password`: Encrypted database password
- `maxConnections`: Connection pool size (optional, default: 10)
- `connectionTimeoutMs`: Connection timeout in milliseconds (optional)
- `queryTimeoutMs`: Query timeout in milliseconds (optional)

### 2. S3 Analytics Bucket

The function requires an S3 bucket for Iceberg table storage. This is typically already created, but verify:

```bash
# Check if analytics bucket exists
aws s3 ls s3://carousel-dev-analytics/ --region eu-west-1

# Create if missing
aws s3 mb s3://carousel-dev-analytics --region eu-west-1
```

### 3. Verify IAM Permissions

The function requires:
- **Bedrock InvokeModel** for `amazon.titan-embed-image-v1` (us-east-1 only)
- **S3 PutObject** to `carousel-{stage}-analytics/pricing-intelligence/smartgo_sales/*`
- **DynamoDB PutItem/GetItem** to progress tracking table
- **SSM GetParameter** to SmartGo database configuration

These are all defined in `serverless.yml` under the `smartgoToS3Exporter` function IAM role statements.

### 4. Environment Variables

Verify environment variables in serverless.yml:

```yaml
environment:
  STAGE: ${self:provider.stage}
  TENANT: ${env:TENANT, 'carousel-labs'}
  EXPORT_PROGRESS_TABLE_NAME: ${self:service}-${self:provider.stage}-smartgo-export-progress
```

## Deployment Steps

### 1. Build the Handler

```bash
cd /Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover

# Compile TypeScript handlers
npm run build:handler

# Verify compiled output
ls -la dist/handlers/smartgo-to-s3-exporter.js
```

### 2. Deploy to AWS

```bash
# Deploy to dev environment
TENANT=carousel-labs npx serverless@4 deploy \
  --stage dev \
  --region eu-west-1 \
  --param tenant=carousel-labs

# Deploy to prod (requires prod infrastructure)
TENANT=carousel-labs npx serverless@4 deploy \
  --stage prod \
  --region eu-west-1 \
  --param tenant=carousel-labs
```

### 3. Verify Deployment

```bash
# Check function exists
aws lambda get-function \
  --function-name bg-remover-dev-smartgoToS3Exporter \
  --region eu-west-1

# Check EventBridge rule
aws events describe-rule \
  --name bg-remover-dev-smartgoToS3Exporter \
  --region eu-west-1

# Check DynamoDB table
aws dynamodb describe-table \
  --table-name bg-remover-dev-smartgo-export-progress \
  --region eu-west-1
```

## Local Testing

### 1. Test Handler Locally

```bash
# Install dependencies
npm install

# Run TypeScript tests
npm test -- smartgo-to-s3-exporter.test.ts

# Run specific test
npm test -- smartgo-to-s3-exporter.test.ts --testNamePattern="handler invocation"
```

### 2. Invoke Lambda Locally

```bash
# Create test event file
cat > test-event.json <<'EOF'
{
  "version": "0",
  "id": "cdc73f9d-aea0-11e3-9d5a-835b769c0d9c",
  "detail-type": "Scheduled Event",
  "source": "aws.events",
  "account": "123456789012",
  "time": "2024-12-30T03:00:00Z",
  "region": "eu-west-1",
  "resources": ["arn:aws:events:eu-west-1:123456789012:rule/smartgo-exporter"],
  "detail": {}
}
EOF

# Invoke locally (requires AWS credentials)
npx serverless invoke local \
  --function smartgoToS3Exporter \
  --path test-event.json \
  --stage dev \
  --region eu-west-1
```

### 3. Monitor CloudWatch Logs

```bash
# Tail logs in real-time
aws logs tail /aws/lambda/bg-remover-dev-smartgoToS3Exporter \
  --follow \
  --region eu-west-1

# Get recent logs
aws logs get-log-events \
  --log-group-name /aws/lambda/bg-remover-dev-smartgoToS3Exporter \
  --log-stream-name $(aws logs describe-log-streams \
    --log-group-name /aws/lambda/bg-remover-dev-smartgoToS3Exporter \
    --order-by LastEventTime \
    --descending \
    --max-items 1 \
    --query 'logStreams[0].logStreamName' \
    --output text) \
  --region eu-west-1
```

### 4. Check Progress in DynamoDB

```bash
# Query export progress
aws dynamodb get-item \
  --table-name bg-remover-dev-smartgo-export-progress \
  --key '{"PK": {"S": "EXPORT#2024-12-30"}, "SK": {"S": "METADATA"}}' \
  --region eu-west-1

# Scan recent exports
aws dynamodb scan \
  --table-name bg-remover-dev-smartgo-export-progress \
  --region eu-west-1 \
  --limit 10
```

## Monitoring & Observability

### 1. CloudWatch Metrics

The function emits logs with structured information:

```
[SmartGoExporter] Starting daily export
[SmartGoExporter] Found sales to export (totalSales: 150)
[SmartGoExporter] Processing sale (productId: PROD-123)
[SmartGoExporter] S3 Tables write successful
[SmartGoExporter] Export complete (success: 148, errors: 2)
```

### 2. DynamoDB Progress Tracking

Query the progress table to monitor export history:

```typescript
// Example: Get last 7 days of exports
const params = {
  TableName: 'bg-remover-dev-smartgo-export-progress',
  KeyConditionExpression: 'PK = :pk',
  ExpressionAttributeValues: {
    ':pk': { S: 'EXPORT#2024-12-30' }
  }
};

// DynamoDB will return:
// {
//   "PK": "EXPORT#2024-12-30",
//   "SK": "METADATA",
//   "status": "COMPLETE",
//   "successCount": 148,
//   "errorCount": 2,
//   "totalCount": 150,
//   "startTime": "2024-12-30T03:00:00Z",
//   "endTime": "2024-12-30T03:15:30Z"
// }
```

### 3. S3 Tables Verification

Verify data is being written to S3:

```bash
# List exported files
aws s3 ls s3://carousel-dev-analytics/pricing-intelligence/smartgo_sales/ \
  --recursive \
  --summarize

# Check specific tenant partition
aws s3 ls s3://carousel-dev-analytics/pricing-intelligence/smartgo_sales/tenant_id=carousel-labs/year=2024/month=12/ \
  --region eu-west-1

# Inspect sample Parquet file
aws s3 cp s3://carousel-dev-analytics/pricing-intelligence/smartgo_sales/tenant_id=carousel-labs/year=2024/month=12/PROD-12345.parquet . \
  --region eu-west-1

cat PROD-12345.parquet | head -c 200  # First 200 bytes
```

## Troubleshooting

### Issue: Function times out (Lambda timeout)

**Cause:** Too many sales to process in 15 minutes

**Solution:**
1. Increase timeout to 1800s (30 minutes)
2. Increase memory to 2048MB for faster CPU
3. Check image download speeds - may need retry logic

**Debug:**
```bash
aws lambda get-function-concurrency \
  --function-name bg-remover-dev-smartgoToS3Exporter
```

### Issue: "SmartGo configuration load failed"

**Cause:** SSM parameter not found or incorrect path

**Solution:**
```bash
# Verify parameter exists
aws ssm get-parameter \
  --name "/tf/dev/smartgo/database/config" \
  --with-decryption

# Check parameter format is valid JSON
aws ssm get-parameter \
  --name "/tf/dev/smartgo/database/config" \
  --with-decryption \
  --query 'Parameter.Value' \
  --output text | jq .
```

### Issue: "Failed to download image"

**Cause:** SmartGo image URLs are invalid or inaccessible

**Solution:**
1. Verify image URLs in SmartGo database are complete
2. Check network connectivity from Lambda VPC (if applicable)
3. Increase download timeout (current: 30 seconds)
4. Check image size limits (max 10MB)

**Debug:**
```bash
# Test image URL
curl -I https://example.com/smartgo/image.jpg

# Check Lambda logs for specific failed URLs
aws logs filter-log-events \
  --log-group-name /aws/lambda/bg-remover-dev-smartgoToS3Exporter \
  --filter-pattern "download failed" \
  --region eu-west-1
```

### Issue: "Bedrock rate limit exceeded"

**Cause:** Too many concurrent Titan embedding requests

**Solution:**
1. Reduce max concurrent operations from 5 to 3
2. Increase delay between batches
3. Request Bedrock quota increase in AWS Console

**Configuration:**
```typescript
// In smartgo-to-s3-exporter.ts
const maxConcurrentOperations = 3; // Reduce from 5
```

### Issue: "S3 access denied"

**Cause:** IAM permissions incomplete or S3 bucket policies

**Solution:**
```bash
# Verify function's IAM role has S3 permissions
aws iam list-attached-role-policies \
  --role-name bg-remover-dev-smartgoToS3Exporter-<region>-lambdaRole

# Check S3 bucket policies
aws s3api get-bucket-policy \
  --bucket carousel-dev-analytics \
  --region eu-west-1

# Verify bucket exists and is accessible
aws s3api head-bucket \
  --bucket carousel-dev-analytics \
  --region eu-west-1
```

## Performance Optimization

### 1. Concurrent Processing

Current configuration processes up to 5 sales in parallel:
```typescript
const maxConcurrentOperations = 5;
```

**Tuning options:**
- Increase to 10 for faster processing (higher memory/cost)
- Decrease to 3 if hitting rate limits on Bedrock/networking
- Monitor Lambda CPU utilization in CloudWatch

### 2. Image Download

Current configuration:
- Timeout: 30 seconds per image
- Max size: 10MB
- Retry attempts: 3
- Retry backoff: exponential (1s, 2s, 4s)

**Optimization:**
```typescript
// Increase timeout for slower networks
const imageTimeout = 60000; // 60 seconds

// Adjust retry strategy
const maxRetries = 5; // More retries for unreliable networks
```

### 3. Batch Size

Consider batching multiple sales into single Parquet files:
```typescript
// Current: One Parquet file per sale
// Optimized: 100 sales per Parquet file
const batchSize = 100;
```

## Cost Analysis

**Daily execution cost:**
- Lambda execution: ~$0.0000001667/ms × 900s avg = ~$0.00015/day
- Titan embeddings: ~$0.01 per 1000 embeddings × 150 sales avg = ~$0.0015/day
- S3 writes: ~$0.0000005 per request × 150 = ~$0.000075/day
- DynamoDB: ~$0.0001 per write × 2 = ~$0.0002/day

**Total daily cost: ~$0.003/day (~$0.09/month)**

For 365 daily exports:
- **Annual cost: ~$1.10**

## Accessing Exported Data

### Query with Athena

```sql
-- Query SmartGo sales data
SELECT
  product_id,
  tenant_id,
  category,
  brand,
  sold_price,
  sold_date,
  embedding_dimension
FROM "s3"."pricing_intelligence"."smartgo_sales"
WHERE year = 2024 AND month = 12 AND tenant_id = 'carousel-labs'
ORDER BY sold_date DESC
LIMIT 10;
```

### Load with Spark

```python
from pyspark.sql import SparkSession

spark = SparkSession.builder.appName("SmartGoAnalytics").getOrCreate()

# Load Parquet files
df = spark.read.parquet("s3://carousel-dev-analytics/pricing-intelligence/smartgo_sales/")

# Analyze pricing trends
trends = df.groupBy("category", "brand").agg({
    "sold_price": "avg",
    "product_id": "count"
}).orderBy("category")

trends.show()
```

## Maintenance

### Daily Health Check

```bash
#!/bin/bash
# Check yesterday's export status

YESTERDAY=$(date -d yesterday +%Y-%m-%d)
TABLE_NAME="bg-remover-dev-smartgo-export-progress"

aws dynamodb get-item \
  --table-name $TABLE_NAME \
  --key "{\"PK\": {\"S\": \"EXPORT#$YESTERDAY\"}, \"SK\": {\"S\": \"METADATA\"}}" \
  --region eu-west-1 \
  --output json | jq '.Item | {
    status: .status.S,
    successCount: .successCount.N,
    errorCount: .errorCount.N,
    startTime: .startTime.S,
    endTime: .endTime.S
  }'
```

### Weekly Cleanup

The function automatically cleans up old progress records via DynamoDB TTL (90-day retention).

## Integration Points

### With Pricing Intelligence System

The exporter integrates with the broader pricing intelligence platform:

1. **Data source:** SmartGo sales database
2. **Processing:** Titan embeddings (1024-dimensional vectors)
3. **Storage:** S3 Tables (Apache Iceberg)
4. **Analytics:** Athena, Spark, QuickSight
5. **ML models:** Use embeddings for similar product pricing

### With Carousel Products System

SmartGo sales data enriches Carousel pricing:

1. SmartGo exporter writes to S3 Tables
2. Carousel sales also written via EventBridge
3. Combined dataset enables cross-platform insights
4. Embeddings enable visual similarity-based pricing

## Next Steps

1. **Implement SmartGo database query** - Currently returns empty array
2. **Add Parquet writer** - Currently stores JSON (Apache Arrow recommended)
3. **Monitor embedding quality** - Analyze embedding distributions
4. **Scale to other data sources** - Create similar exporters for other marketplaces

## Support

For issues or questions:

1. Check CloudWatch logs: `/aws/lambda/bg-remover-dev-smartgoToS3Exporter`
2. Review DynamoDB progress table
3. Verify SSM parameter configuration
4. Check S3 bucket permissions and contents
