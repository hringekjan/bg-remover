# S3 Tables Quick Start Guide

## TL;DR - Deploy in 5 Minutes

```bash
cd services/bg-remover

# 1. Create Glue database and Iceberg table
bash scripts/deploy-s3-tables.sh dev eu-west-1

# 2. Verify creation
aws glue get-table --database-name pricing_intelligence_dev --name sales_history --region eu-west-1

# 3. Load sample data (optional)
python3 scripts/load-sample-sales-data.py --stage dev --region eu-west-1 --num-records 1000

# 4. Run test query
aws athena start-query-execution \
  --query-string "SELECT COUNT(*) as total_records FROM pricing_intelligence_dev.sales_history" \
  --query-execution-context Database=pricing_intelligence_dev \
  --result-configuration OutputLocation=s3://carousel-dev-analytics/athena-results/ \
  --region eu-west-1
```

## Files Overview

| File | Purpose |
|------|---------|
| `scripts/create-s3-tables-schema.py` | Create Glue DB + Iceberg table |
| `scripts/deploy-s3-tables.sh` | Orchestration with error handling |
| `scripts/load-sample-sales-data.py` | Generate and load sample data |
| `sql/sales-history-queries.sql` | 12 pre-built analytics queries |
| `docs/S3_TABLES_IMPLEMENTATION.md` | Full documentation |

## Quick Queries

### 1. Sales by Category (2024)
```sql
SELECT
    category,
    COUNT(*) as sales_count,
    ROUND(AVG(sold_price), 2) as avg_price
FROM pricing_intelligence_dev.sales_history
WHERE tenant_id = 'carousel-labs' AND year = 2024
GROUP BY category
ORDER BY sales_count DESC;
```

### 2. Brand Performance
```sql
SELECT
    brand,
    COUNT(*) as items_sold,
    ROUND(AVG(sold_price), 2) as avg_price
FROM pricing_intelligence_dev.sales_history
WHERE tenant_id = 'carousel-labs' AND year = 2024
GROUP BY brand
HAVING COUNT(*) >= 10
ORDER BY items_sold DESC;
```

### 3. Monthly Trend
```sql
SELECT
    year,
    month,
    COUNT(*) as sales_count,
    ROUND(AVG(sold_price), 2) as avg_price
FROM pricing_intelligence_dev.sales_history
WHERE tenant_id = 'carousel-labs'
GROUP BY year, month
ORDER BY year DESC, month DESC;
```

## Verify Installation

### Check Database
```bash
aws glue get-database --name pricing_intelligence_dev --region eu-west-1
```

### Check Table
```bash
aws glue get-table --database-name pricing_intelligence_dev --name sales_history --region eu-west-1
```

### Check S3 Location
```bash
aws s3 ls s3://carousel-dev-analytics/pricing-intelligence/sales_history/
```

## Integration with Lambda

### Write Data
```python
# Data is written via your ETL pipeline
# Example: pricing-insight-aggregator Lambda function

data = {
    'product_id': 'product-123',
    'tenant_id': 'carousel-labs',
    'category': 'handbags',
    'brand': 'Gucci',
    'condition': 'like_new',
    'sold_price': 1500.00,
    'sold_date': datetime.now().isoformat(),
    'season': 'Q4',
    'image_s3_key': 's3://bucket/image.jpg',
    'embedding': [0.1, 0.2, ...],  # 1024 dims
    'description': 'Gucci handbag',
    'source': 'carousel'
}
# Write to Iceberg via batch ETL
```

### Query Data
```python
import boto3

athena = boto3.client('athena')

response = athena.start_query_execution(
    QueryString="""
        SELECT * FROM pricing_intelligence_dev.sales_history
        WHERE tenant_id = 'carousel-labs'
        LIMIT 100
    """,
    QueryExecutionContext={'Database': 'pricing_intelligence_dev'},
    ResultConfiguration={'OutputLocation': 's3://carousel-dev-analytics/athena-results/'}
)

query_id = response['QueryExecutionId']
```

## Troubleshooting

### Table Not Found
```bash
# Refresh Glue catalog
aws glue get-partitions \
  --database-name pricing_intelligence_dev \
  --table-name sales_history \
  --region eu-west-1
```

### Slow Queries
- Always filter by year/month (partition columns)
- Use column projection instead of SELECT *
- Consider LIMIT for initial exploration

### High S3 Costs
- Check query execution time: `EngineExecutionTime`
- Review data scanned: `DataScannedInBytes`
- Implement S3 Intelligent-Tiering

## Configuration

### Credentials
```bash
# Use AWS CLI profiles
export AWS_PROFILE=carousel-labs-dev-admin
bash scripts/deploy-s3-tables.sh dev eu-west-1

# Or set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
```

### Environment Variables
```bash
# Stage (dev, staging, prod)
STAGE=dev

# AWS Region
REGION=eu-west-1

# Number of sample records
NUM_RECORDS=5000
```

## Cost Estimates

| Component | Monthly Cost |
|-----------|--------------|
| Glue Catalog | $1.00 |
| S3 Storage (100GB) | $2.30 |
| Athena Queries (1000) | $5.00 |
| **Total** | **~$8.56** |

## Next Steps

1. **Load Real Data:** Implement ETL pipeline to load actual sales data
2. **Build Dashboard:** Connect to QuickSight or Tableau
3. **Set Alerts:** Configure CloudWatch alarms for data quality
4. **Archive Old Data:** Implement S3 Glacier transition policy
5. **Optimize Queries:** Add indexes and partitioning strategies

## Resources

- Full docs: `docs/S3_TABLES_IMPLEMENTATION.md`
- Queries: `sql/sales-history-queries.sql`
- Scripts: `scripts/`

## Support

For issues:
1. Check logs: `tail -f .serverless/s3-tables-logs/deploy-s3-tables-*.log`
2. Verify AWS credentials: `aws sts get-caller-identity`
3. Check Glue job history: AWS Console → Glue → Jobs
