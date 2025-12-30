#!/usr/bin/env python3
"""
Load sample sales data into S3 Tables (Apache Iceberg).

This script generates sample sales history data and writes it to the
Iceberg table for testing analytics queries.

Usage:
    python load-sample-sales-data.py --stage dev --region eu-west-1 [--num-records 1000]
"""

import argparse
import json
import logging
import random
from datetime import datetime, timedelta
from typing import List, Dict, Any
import io

import boto3
import pyarrow as pa
import pyarrow.parquet as pq
from botocore.exceptions import ClientError

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


class SalesDataGenerator:
    """Generate realistic sample sales data."""

    CATEGORIES = ['coats', 'handbags', 'shoes', 'dresses', 'jackets', 'accessories', 'pants', 'sweaters']
    BRANDS = ['Gucci', 'Prada', 'Louis Vuitton', 'Chanel', 'Dior', 'Hermes', 'Versace', 'Coach']
    CONDITIONS = ['new_with_tags', 'new_without_tags', 'like_new', 'very_good', 'good', 'fair']
    SOURCES = ['smartgo', 'carousel']
    SEASONS = ['Q1', 'Q2', 'Q3', 'Q4']

    # Price ranges by category (in dollars)
    PRICE_RANGES = {
        'coats': (200, 2000),
        'handbags': (150, 3000),
        'shoes': (100, 1500),
        'dresses': (100, 1000),
        'jackets': (150, 1500),
        'accessories': (50, 500),
        'pants': (80, 800),
        'sweaters': (60, 600),
    }

    def __init__(self, num_records: int = 1000):
        """Initialize generator with desired record count."""
        self.num_records = num_records
        self.record_id = 0

    def generate_records(self) -> List[Dict[str, Any]]:
        """Generate sample sales records."""
        records = []
        base_date = datetime(2023, 1, 1)

        for i in range(self.num_records):
            # Distribute dates across 2 years
            days_offset = random.randint(0, 730)
            sold_date = base_date + timedelta(days=days_offset)

            category = random.choice(self.CATEGORIES)
            price_range = self.PRICE_RANGES.get(category, (100, 1000))

            # Generate embedding (1024-dimensional vector for Titan)
            embedding = [random.uniform(-1.0, 1.0) for _ in range(1024)]

            record = {
                'product_id': f'product-{i:06d}',
                'tenant_id': 'carousel-labs',
                'category': category,
                'brand': random.choice(self.BRANDS),
                'condition': random.choice(self.CONDITIONS),
                'sold_price': round(random.uniform(price_range[0], price_range[1]), 2),
                'sold_date': sold_date.isoformat(),
                'season': self.SEASONS[(sold_date.month - 1) // 3],
                'image_s3_key': f's3://carousel-images/product-{i:06d}/main.jpg',
                'embedding': embedding,
                'description': f'{category.title()} from {random.choice(self.BRANDS)}',
                'source': random.choice(self.SOURCES),
                'year': sold_date.year,
                'month': sold_date.month,
            }
            records.append(record)

        return records

    @staticmethod
    def records_to_parquet(records: List[Dict[str, Any]]) -> bytes:
        """Convert records to Parquet format."""
        # Convert records to PyArrow format
        data = {
            'product_id': [r['product_id'] for r in records],
            'tenant_id': [r['tenant_id'] for r in records],
            'category': [r['category'] for r in records],
            'brand': [r['brand'] for r in records],
            'condition': [r['condition'] for r in records],
            'sold_price': [r['sold_price'] for r in records],
            'sold_date': [r['sold_date'] for r in records],
            'season': [r['season'] for r in records],
            'image_s3_key': [r['image_s3_key'] for r in records],
            'embedding': [r['embedding'] for r in records],
            'description': [r['description'] for r in records],
            'source': [r['source'] for r in records],
            'year': [r['year'] for r in records],
            'month': [r['month'] for r in records],
        }

        # Create PyArrow table
        schema = pa.schema([
            pa.field('product_id', pa.string()),
            pa.field('tenant_id', pa.string()),
            pa.field('category', pa.string()),
            pa.field('brand', pa.string()),
            pa.field('condition', pa.string()),
            pa.field('sold_price', pa.decimal128(10, 2)),
            pa.field('sold_date', pa.timestamp('us')),
            pa.field('season', pa.string()),
            pa.field('image_s3_key', pa.string()),
            pa.field('embedding', pa.list_(pa.float64())),
            pa.field('description', pa.string()),
            pa.field('source', pa.string()),
            pa.field('year', pa.int32()),
            pa.field('month', pa.int32()),
        ])

        table = pa.table(data, schema=schema)

        # Write to Parquet in memory
        buf = io.BytesIO()
        pq.write_table(table, buf, compression='snappy')
        return buf.getvalue()


def upload_to_s3(
    s3_client,
    bucket: str,
    key: str,
    data: bytes,
    partition_year: int,
    partition_month: int
) -> bool:
    """Upload Parquet file to S3 in Iceberg partition structure."""
    try:
        # Use Iceberg partition naming convention
        partition_key = f'pricing-intelligence/sales_history/year={partition_year}/month={partition_month}/{key}'

        s3_client.put_object(
            Bucket=bucket,
            Key=partition_key,
            Body=data,
            ContentType='application/octet-stream',
            Metadata={
                'table': 'sales_history',
                'format': 'parquet',
                'compression': 'snappy',
            }
        )
        logger.info(f"Uploaded {len(data)} bytes to s3://{bucket}/{partition_key}")
        return True
    except ClientError as e:
        logger.error(f"Error uploading to S3: {e}")
        return False


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description='Load sample sales data into S3 Tables (Apache Iceberg)'
    )
    parser.add_argument(
        '--stage',
        required=True,
        help='Deployment stage (dev, staging, prod)'
    )
    parser.add_argument(
        '--region',
        default='eu-west-1',
        help='AWS region (default: eu-west-1)'
    )
    parser.add_argument(
        '--num-records',
        type=int,
        default=1000,
        help='Number of sample records to generate (default: 1000)'
    )

    args = parser.parse_args()

    # Configuration
    stage = args.stage
    region = args.region
    num_records = args.num_records
    bucket = f'carousel-{stage}-analytics'

    logger.info(f"Generating {num_records} sample sales records...")
    logger.info(f"Stage: {stage}, Region: {region}")

    # Generate sample data
    generator = SalesDataGenerator(num_records=num_records)
    records = generator.generate_records()

    logger.info(f"Generated {len(records)} records")

    # Group records by year/month for efficient Iceberg partition writing
    partitions: Dict[tuple, List[Dict[str, Any]]] = {}
    for record in records:
        key = (record['year'], record['month'])
        if key not in partitions:
            partitions[key] = []
        partitions[key].append(record)

    logger.info(f"Records grouped into {len(partitions)} partitions")

    # Initialize S3 client
    try:
        s3_client = boto3.client('s3', region_name=region)
    except Exception as e:
        logger.error(f"Error initializing S3 client: {e}")
        return 1

    # Upload each partition
    uploaded_count = 0
    for (year, month), partition_records in sorted(partitions.items()):
        logger.info(f"Converting {len(partition_records)} records to Parquet (Y={year}, M={month})...")

        try:
            parquet_data = SalesDataGenerator.records_to_parquet(partition_records)

            # Generate filename
            filename = f'{stage}-sales-{year}-{month:02d}-{uploaded_count:06d}.parquet'

            if upload_to_s3(s3_client, bucket, filename, parquet_data, year, month):
                uploaded_count += 1
            else:
                logger.warning(f"Failed to upload partition Y={year}, M={month}")
        except Exception as e:
            logger.error(f"Error processing partition Y={year}, M={month}: {e}")
            continue

    logger.info(f"Successfully uploaded {uploaded_count} Parquet files")
    logger.info(f"Total records loaded: {sum(len(v) for v in partitions.values())}")
    logger.info("")
    logger.info("Sample query to verify data:")
    logger.info(f"SELECT * FROM pricing_intelligence_{stage}.sales_history LIMIT 10")
    logger.info("")

    return 0


if __name__ == '__main__':
    exit(main())
