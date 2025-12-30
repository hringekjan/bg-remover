#!/usr/bin/env python3
"""
Create Apache Iceberg table schema for sales history data lake.

This script creates an AWS Glue database and Iceberg table for storing
historical sales data with support for analytics queries via Athena.

Usage:
    python create-s3-tables-schema.py --stage dev --region eu-west-1
"""

import argparse
import json
import logging
import sys
from typing import Dict, Any

import boto3
from botocore.exceptions import ClientError

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


def create_glue_database(glue_client, database_name: str, s3_location: str) -> bool:
    """
    Create AWS Glue database if it doesn't exist.

    Args:
        glue_client: boto3 Glue client
        database_name: Name of the database
        s3_location: S3 location for the database

    Returns:
        bool: True if created or already exists, False on error
    """
    try:
        # Check if database already exists
        glue_client.get_database(Name=database_name)
        logger.info(f"Database '{database_name}' already exists")
        return True
    except ClientError as e:
        if e.response['Error']['Code'] != 'EntityNotFoundException':
            logger.error(f"Error checking database: {e}")
            return False

    try:
        # Create database
        glue_client.create_database(
            DatabaseInput={
                'Name': database_name,
                'Description': 'Pricing intelligence data lake for sales history analytics',
                'LocationUri': s3_location,
                'Parameters': {
                    'classification': 'parquet',
                    'data_format': 'iceberg'
                }
            }
        )
        logger.info(f"Created database '{database_name}' at {s3_location}")
        return True
    except ClientError as e:
        logger.error(f"Error creating database: {e}")
        return False


def create_iceberg_table(
    glue_client,
    database_name: str,
    table_name: str,
    s3_location: str
) -> bool:
    """
    Create Apache Iceberg table in AWS Glue.

    Args:
        glue_client: boto3 Glue client
        database_name: Name of the database
        table_name: Name of the table
        s3_location: S3 location for the table

    Returns:
        bool: True if created or already exists, False on error
    """
    try:
        # Check if table already exists
        glue_client.get_table(DatabaseName=database_name, Name=table_name)
        logger.info(f"Table '{database_name}.{table_name}' already exists")
        return True
    except ClientError as e:
        if e.response['Error']['Code'] != 'EntityNotFoundException':
            logger.error(f"Error checking table: {e}")
            return False

    try:
        # Create Iceberg table
        table_input = {
            'Name': table_name,
            'TableType': 'EXTERNAL_TABLE',
            'StorageDescriptor': {
                'Columns': [
                    {'Name': 'product_id', 'Type': 'string', 'Comment': 'Product identifier'},
                    {'Name': 'tenant_id', 'Type': 'string', 'Comment': 'Multi-tenant identifier'},
                    {'Name': 'category', 'Type': 'string', 'Comment': 'Product category (coats, handbags, etc.)'},
                    {'Name': 'brand', 'Type': 'string', 'Comment': 'Product brand'},
                    {'Name': 'condition', 'Type': 'string', 'Comment': 'Product condition (new_with_tags, like_new, etc.)'},
                    {'Name': 'sold_price', 'Type': 'decimal(10,2)', 'Comment': 'Actual sale price'},
                    {'Name': 'sold_date', 'Type': 'timestamp', 'Comment': 'Sale completion date'},
                    {'Name': 'season', 'Type': 'string', 'Comment': 'Quarter (Q1, Q2, Q3, Q4)'},
                    {'Name': 'image_s3_key', 'Type': 'string', 'Comment': 'S3 key for product image'},
                    {'Name': 'embedding', 'Type': 'array<double>', 'Comment': '1024-dimensional Titan embedding vector'},
                    {'Name': 'description', 'Type': 'string', 'Comment': 'Product description'},
                    {'Name': 'source', 'Type': 'string', 'Comment': 'Data source (smartgo | carousel)'},
                ],
                'Location': s3_location,
                'InputFormat': 'org.apache.iceberg.mr.mapreduce.IcebergInputFormat',
                'OutputFormat': 'org.apache.iceberg.mr.mapreduce.IcebergOutputFormat',
                'SerdeInfo': {
                    'SerializationLibrary': 'org.apache.iceberg.mr.hive.HiveIcebergSerDe',
                    'Parameters': {
                        'serialization.format': '1'
                    }
                },
                'StoredAsSubDirectories': False,
            },
            'PartitionKeys': [
                {'Name': 'year', 'Type': 'int', 'Comment': 'Year of the sale'},
                {'Name': 'month', 'Type': 'int', 'Comment': 'Month of the sale'},
            ],
            'Parameters': {
                'table_type': 'ICEBERG',
                'format': 'parquet',
                'write.parquet.compression-codec': 'snappy',
                'classification': 'parquet',
                'EXTERNAL': 'TRUE'
            }
        }

        glue_client.create_table(
            DatabaseName=database_name,
            TableInput=table_input
        )
        logger.info(f"Created Iceberg table '{database_name}.{table_name}' at {s3_location}")
        return True
    except ClientError as e:
        logger.error(f"Error creating table: {e}")
        return False


def create_s3_bucket_if_needed(
    s3_client,
    bucket_name: str,
    region: str
) -> bool:
    """
    Create S3 bucket for Iceberg table storage if it doesn't exist.

    Args:
        s3_client: boto3 S3 client
        bucket_name: Name of the bucket
        region: AWS region

    Returns:
        bool: True if created or already exists, False on error
    """
    try:
        # Check if bucket exists
        s3_client.head_bucket(Bucket=bucket_name)
        logger.info(f"S3 bucket '{bucket_name}' already exists")
        return True
    except ClientError as e:
        if e.response['Error']['Code'] != '404':
            logger.error(f"Error checking bucket: {e}")
            return False

    try:
        # Create bucket
        if region == 'us-east-1':
            s3_client.create_bucket(Bucket=bucket_name)
        else:
            s3_client.create_bucket(
                Bucket=bucket_name,
                CreateBucketConfiguration={'LocationConstraint': region}
            )
        logger.info(f"Created S3 bucket '{bucket_name}' in {region}")

        # Block public access
        s3_client.put_public_access_block(
            Bucket=bucket_name,
            PublicAccessBlockConfiguration={
                'BlockPublicAcls': True,
                'IgnorePublicAcls': True,
                'BlockPublicPolicy': True,
                'RestrictPublicBuckets': True
            }
        )
        logger.info(f"Configured public access blocking for '{bucket_name}'")

        return True
    except ClientError as e:
        logger.error(f"Error creating bucket: {e}")
        return False


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description='Create Apache Iceberg table schema for sales history data lake'
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

    args = parser.parse_args()

    # Configuration
    stage = args.stage
    region = args.region
    database_name = f'pricing_intelligence_{stage}'
    table_name = 'sales_history'
    bucket_name = f'carousel-{stage}-analytics'
    s3_database_location = f's3://{bucket_name}/pricing-intelligence/'
    s3_table_location = f's3://{bucket_name}/pricing-intelligence/{table_name}/'

    logger.info(f"Creating S3 Tables schema for stage: {stage}")
    logger.info(f"Region: {region}")
    logger.info(f"Database: {database_name}")
    logger.info(f"Table: {table_name}")
    logger.info(f"S3 Location: {s3_table_location}")

    # Initialize AWS clients
    try:
        glue_client = boto3.client('glue', region_name=region)
        s3_client = boto3.client('s3', region_name=region)
    except Exception as e:
        logger.error(f"Error initializing AWS clients: {e}")
        sys.exit(1)

    # Create S3 bucket
    if not create_s3_bucket_if_needed(s3_client, bucket_name, region):
        logger.error("Failed to create S3 bucket")
        sys.exit(1)

    # Create Glue database
    if not create_glue_database(glue_client, database_name, s3_database_location):
        logger.error("Failed to create Glue database")
        sys.exit(1)

    # Create Iceberg table
    if not create_iceberg_table(glue_client, database_name, table_name, s3_table_location):
        logger.error("Failed to create Iceberg table")
        sys.exit(1)

    logger.info("S3 Tables schema creation completed successfully!")
    logger.info(f"Database: {database_name}")
    logger.info(f"Table: {table_name}")
    logger.info(f"Query via Athena: SELECT * FROM {database_name}.{table_name} LIMIT 10")


if __name__ == '__main__':
    main()
