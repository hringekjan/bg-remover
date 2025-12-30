# S3 Tables (Apache Iceberg) Implementation Guide

## Overview

This document describes the implementation of Apache Iceberg tables on AWS S3 for the Pricing Intelligence data lake. This enables efficient analytics, historical data querying, and supports the Vision-Enhanced Pricing Intelligence system (Phase 5).

## Architecture

### Data Flow

```
Sales Data (SmartGo + Carousel)
    ↓
DynamoDB (Real-time)
    ↓
S3 Tables (Iceberg) ← Lambda ETL Pipeline
    ↓
Athena (SQL Queries)
    ↓
Analytics Dashboard
```

### Iceberg Table Structure

```
Database: pricing_intelligence_{stage}
Table: sales_history

S3 Location:
s3://carousel-{stage}-analytics/pricing-intelligence/sales_history/
  ├── year=2023/
  │   ├── month=01/
  │   │   ├── 2023-01-001.parquet
  │   │   └── 2023-01-002.parquet
  │   ├── month=02/
  │   └── ...
  └── year=2024/
      ├── month=01/
      └── ...
```

## Schema Specification

### Table: `sales_history`

| Column | Type | Description |
|--------|------|-------------|
| `product_id` | STRING | Product identifier |
| `tenant_id` | STRING | Multi-tenant identifier |
| `category` | STRING | Product category (coats, handbags, etc.) |
| `brand` | STRING | Product brand |
| `condition` | STRING | Product condition (new_with_tags, like_new, etc.) |
| `sold_price` | DECIMAL(10,2) | Actual sale price |
| `sold_date` | TIMESTAMP | Sale completion date |
| `season` | STRING | Quarter (Q1, Q2, Q3, Q4) |
| `image_s3_key` | STRING | S3 key for product image |
| `embedding` | ARRAY<DOUBLE> | 1024-dimensional Titan embedding vector |
| `description` | STRING | Product description |
| `source` | STRING | Data source (smartgo \| carousel) |

### Partitioning

- **Partition Columns:** `year`, `month`
- **Strategy:** Time-based partitioning for efficient queries
- **Benefits:**
  - Faster Athena queries (partition pruning)
  - Efficient data lifecycle management
  - Easy data expiration policies

### Format

- **Table Format:** Apache Iceberg
- **File Format:** PARQUET
- **Compression:** SNAPPY

## Deployment

### Prerequisites

1. **AWS CLI** configured with appropriate credentials
2. **Python 3.11+** with boto3
3. **Permissions:**
   - Glue: CreateDatabase, CreateTable
   - S3: PutObject, GetObject, ListBucket
   - Athena: StartQueryExecution

### Installation Steps

1. **Create Glue Database and Iceberg Table:**
   ```bash
   cd services/bg-remover
   bash scripts/deploy-s3-tables.sh dev eu-west-1
   ```

2. **Verify Creation:**
   ```bash
   aws glue get-table \
     --database-name pricing_intelligence_dev \
     --name sales_history \
     --region eu-west-1
   ```

3. **Load Sample Data (Optional):**
   ```bash
   python3 scripts/load-sample-sales-data.py \
     --stage dev \
     --region eu-west-1 \
     --num-records 5000
   ```

4. **Test Athena Query:**
   ```bash
   aws athena start-query-execution \
     --query-string "SELECT * FROM pricing_intelligence_dev.sales_history LIMIT 10" \
     --query-execution-context Database=pricing_intelligence_dev \
     --result-configuration OutputLocation=s3://carousel-dev-analytics/athena-results/ \
     --region eu-west-1
   ```

## Key Files

### Scripts

1. **`scripts/create-s3-tables-schema.py`**
   - Creates Glue database and Iceberg table
   - Idempotent (safe to run multiple times)
   - Validates AWS credentials before execution

2. **`scripts/deploy-s3-tables.sh`**
   - Orchestrates schema creation with error handling
   - Generates timestamped logs
   - Provides colored output for clarity

3. **`scripts/load-sample-sales-data.py`**
   - Generates realistic sample sales data
   - Writes data to S3 in Iceberg partition structure
   - Supports custom record count

### Queries

**`sql/sales-history-queries.sql`** contains 12 pre-built Athena queries:

1. **Sales Volume by Category and Month** - Seasonal trends
2. **Brand Performance Analysis** - Top brands per season
3. **Product Condition Impact** - Pricing by condition
4. **Category-Brand Cross-Tab** - Brand performance within categories
5. **Data Source Comparison** - SmartGo vs Carousel analysis
6. **Monthly Sales Trend** - Volume and pricing evolution
7. **High-Value Products** - Revenue concentration
8. **Embedding Similarity Candidates** - Products with embeddings
9. **Partition Pruning Example** - Efficient querying
10. **Data Quality Check** - Missing values and anomalies
11. **Price Distribution** - Quartile analysis by category
12. **Season Performance** - Q1-Q4 comparison

## AWS Permissions

Updated `serverless.yml` includes:

```yaml
# Glue permissions
- glue:CreateDatabase
- glue:CreateTable
- glue:GetTable
- glue:UpdateTable
- glue:BatchCreatePartition

# S3 permissions
- s3:GetObject
- s3:PutObject
- s3:ListBucket
- s3:GetBucketVersioning

# Athena permissions
- athena:StartQueryExecution
- athena:GetQueryExecution
- athena:GetQueryResults
```

## Integration with Lambda Functions

### Writing Data to Iceberg

```typescript
import * as AWS from 'aws-sdk';

const glue = new AWS.Glue();

// Batch insert records into Iceberg table
const salesData = [
  {
    product_id: 'product-001',
    tenant_id: 'carousel-labs',
    category: 'handbags',
    brand: 'Gucci',
    condition: 'like_new',
    sold_price: 1500.00,
    sold_date: new Date().toISOString(),
    season: 'Q4',
    image_s3_key: 's3://images/product-001.jpg',
    embedding: [...], // 1024-dim array
    description: 'Gucci handbag in like new condition',
    source: 'carousel'
  }
];

// Write to Iceberg via DynamoDB + async ETL pipeline
// (See pricing-insight-aggregator for example)
```

### Querying via Athena

```typescript
import * as AWS from 'aws-sdk';

const athena = new AWS.Athena();

const params = {
  QueryString: `
    SELECT
      category,
      AVG(sold_price) as avg_price,
      COUNT(*) as sales_count
    FROM pricing_intelligence_dev.sales_history
    WHERE tenant_id = 'carousel-labs'
      AND year = 2024
      AND month >= 9
    GROUP BY category
  `,
  QueryExecutionContext: {
    Database: 'pricing_intelligence_dev'
  },
  ResultConfiguration: {
    OutputLocation: 's3://carousel-dev-analytics/athena-results/'
  }
};

const result = await athena.startQueryExecution(params).promise();
console.log('Query execution ID:', result.QueryExecutionId);
```

## Data Lifecycle

### Retention Policy

- **Active Data:** 2 years (kept in Iceberg)
- **Archive:** Older than 2 years (transition to Glacier)
- **Deletion:** 7 years (compliance requirement)

### S3 Lifecycle Configuration

```json
{
  "Rules": [
    {
      "Id": "ArchiveOldPartitions",
      "Status": "Enabled",
      "Transitions": [
        {
          "Days": 730,
          "StorageClass": "GLACIER"
        }
      ],
      "Expiration": {
        "Days": 2555
      }
    }
  ]
}
```

## Cost Optimization

### Estimated Costs (Monthly)

| Service | Usage | Cost |
|---------|-------|------|
| Glue Catalog | 1 table | $1.00 |
| S3 Storage | 100 GB | $2.30 |
| Athena Queries | 1,000 queries | $5.00 |
| S3 Data Scanned | 50 GB/month | $0.26 |
| **Total** | | **~$8.56** |

### Optimization Strategies

1. **Partition Pruning:** Always filter by year/month
2. **Columnar Format:** Parquet reduces storage by 60-80%
3. **Compression:** SNAPPY provides good compression ratio
4. **Query Optimization:** Use Athena query result caching
5. **S3 Intelligent-Tiering:** Automatically move old data

## Monitoring and Alerts

### CloudWatch Metrics

Monitor these metrics in CloudWatch:

- **Athena Queries:** DataScannedInBytes, EngineExecutionTime
- **S3 Storage:** BucketSizeBytes
- **Glue Jobs:** job_run_duration, job_errors

### Sample CloudWatch Alarm

```yaml
AthenaQueryFailureAlarm:
  Type: AWS::CloudWatch::Alarm
  Properties:
    AlarmName: pricing-intelligence-athena-failures
    MetricName: EngineExecutionTime
    Namespace: AWS/Athena
    Statistic: Sum
    Period: 3600
    EvaluationPeriods: 1
    Threshold: 30000  # 30 seconds
    ComparisonOperator: GreaterThanThreshold
```

## Troubleshooting

### Issue: Table Not Found in Athena

**Solution:**
```bash
# Verify database exists
aws glue get-database --name pricing_intelligence_dev

# Verify table exists
aws glue get-table --database-name pricing_intelligence_dev --name sales_history

# Refresh Athena metadata
aws athena start-query-execution \
  --query-string "SHOW TABLES IN pricing_intelligence_dev"
```

### Issue: Slow Athena Queries

**Solution:**
- Always filter by partition columns (year, month)
- Use column projection (SELECT specific columns)
- Enable query result caching
- Consider partitioning by tenant_id for multi-tenant workloads

### Issue: High S3 Costs

**Solution:**
- Review S3 Intelligent-Tiering settings
- Implement S3 Glacier archival for old data
- Use partition deletion for data cleanup
- Monitor query patterns (expensive full table scans)

## Advanced Topics

### Iceberg Version History

```sql
-- View table version history
SELECT * FROM "pricing_intelligence_dev"."sales_history$history"
ORDER BY committed_at DESC
LIMIT 20;

-- Roll back to previous version
-- Note: Iceberg provides time-travel capability
SELECT * FROM "pricing_intelligence_dev"."sales_history"
FOR SYSTEM_TIME AS OF timestamp '2024-01-15 10:00:00';
```

### Partition Evolution

If you need to change partition scheme:

```python
# Example: Add tenant_id as partition column
# This requires creating new table and migrating data
# See AWS Glue documentation for partition evolution
```

### Multi-Tenant Optimization

For better multi-tenant performance, consider:

1. **Partition by tenant_id first:** `PARTITIONED BY (tenant_id, year, month)`
2. **Separate tables per tenant:** `sales_history_carousel_labs`, `sales_history_other_tenant`
3. **Cross-tenant indexes:** Bloom filters for efficient filtering

## References

- [Apache Iceberg Documentation](https://iceberg.apache.org/)
- [AWS Glue Iceberg Support](https://docs.aws.amazon.com/glue/latest/dg/aws-glue-programming-etl-libraries.html)
- [Athena for Iceberg Tables](https://docs.aws.amazon.com/athena/latest/ug/querying-iceberg-open-table-formats.html)
- [S3 Tables Documentation](https://docs.aws.amazon.com/s3/latest/userguide/s3-tables.html)

## Support

For issues or questions:

1. Check the Troubleshooting section above
2. Review CloudWatch logs: `/aws/glue/jobs`
3. Check Athena query history: AWS Console → Athena
4. Contact: pricing-intelligence@carousellabs.com
