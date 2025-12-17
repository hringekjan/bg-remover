"""
Classifier Handler for Carousel Image Processing

Consumes CarouselImageProcessed events from EventBridge,
runs Rekognition classification on processed images,
and persists memories to mem0 service.

Uses IAM authentication for service-to-service communication.
"""

import json
import boto3
import os
from typing import Dict, Any, Optional
from datetime import datetime
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.credentials import Credentials
import urllib.request
import urllib.error

# AWS clients
rekognition = boto3.client('rekognition', region_name='eu-west-1')
s3 = boto3.client('s3', region_name='eu-west-1')
sts = boto3.client('sts', region_name='eu-west-1')

# Configuration from environment
# Uses shared HTTP API Gateway: https://api.{stage}.carousellabs.co/mem0
STAGE = os.environ.get('STAGE', 'dev')
MEM0_API_ENDPOINT = os.environ.get('MEM0_API_ENDPOINT', f'https://api.{STAGE}.carousellabs.co/mem0')
TENANT_ID = os.environ.get('TENANT', 'carousel-labs')
AWS_REGION = os.environ.get('AWS_REGION', 'eu-west-1')

def handle(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    EventBridge handler for CarouselImageProcessed events
    """
    print(f"Received event: {json.dumps(event, indent=2)}")

    # Parse EventBridge event
    if 'detail' not in event:
        print("No detail in event")
        return {'statusCode': 400, 'body': 'No detail in event'}

    detail = event['detail']

    # Extract image information
    output_key = detail.get('output_key')
    tenant_id = detail.get('tenant_id', TENANT_ID)
    file_hash = detail.get('file_hash')

    if not output_key:
        print("No output_key in event detail")
        return {'statusCode': 400, 'body': 'No output_key in event detail'}

    try:
        # Run Rekognition classification
        predictions = classify_image(output_key, tenant_id)

        # Create memory in mem0
        memory = create_product_memory(file_hash, predictions, detail, tenant_id)

        print(f"Successfully classified image and created memory: {memory}")

        return {
            'statusCode': 200,
            'body': json.dumps({
                'message': 'Classification completed',
                'memory_id': memory.get('id'),
                'predictions': predictions
            })
        }

    except Exception as e:
        print(f"Error processing classification: {str(e)}")
        return {
            'statusCode': 500,
            'body': json.dumps({
                'error': str(e)
            })
        }

def classify_image(output_key: str, tenant_id: str) -> Dict[str, Any]:
    """
    Run AWS Rekognition on the processed image
    """
    # Extract bucket and key from output_key
    # Assuming output_key is like 'processed/jobId.png'
    bucket = f"bg-remover-dev-{tenant_id}-output"  # From serverless.yml

    try:
        response = rekognition.detect_labels(
            Image={
                'S3Object': {
                    'Bucket': bucket,
                    'Name': output_key
                }
            },
            MaxLabels=10,
            MinConfidence=70.0
        )

        # Process labels into product categories
        predictions = []
        for label in response['Labels']:
            predictions.append({
                'label': label['Name'],
                'confidence': label['Confidence'],
                'category': map_to_product_category(label['Name'])
            })

        return {
            'predictions': predictions,
            'model': 'aws-rekognition',
            'timestamp': datetime.utcnow().isoformat()
        }

    except Exception as e:
        print(f"Rekognition error: {str(e)}")
        # Fallback predictions
        return {
            'predictions': [{
                'label': 'unknown',
                'confidence': 0.0,
                'category': 'uncategorized'
            }],
            'model': 'fallback',
            'timestamp': datetime.utcnow().isoformat(),
            'error': str(e)
        }

def map_to_product_category(label: str) -> str:
    """
    Map Rekognition labels to product categories
    """
    label_lower = label.lower()

    # Simple mapping - in production, this would be more sophisticated
    if any(word in label_lower for word in ['clothing', 'shirt', 'pants', 'dress', 'jacket']):
        return 'apparel'
    elif any(word in label_lower for word in ['shoe', 'boot', 'sandal']):
        return 'footwear'
    elif any(word in label_lower for word in ['bag', 'handbag', 'backpack']):
        return 'accessories'
    elif any(word in label_lower for word in ['electronics', 'phone', 'computer', 'device']):
        return 'electronics'
    else:
        return 'general'

def get_aws_credentials() -> Optional[Credentials]:
    """
    Get AWS credentials from the Lambda execution role
    """
    try:
        session = boto3.Session()
        credentials = session.get_credentials()
        if credentials:
            return credentials.get_frozen_credentials()
        return None
    except Exception as e:
        print(f"Failed to get AWS credentials: {str(e)}")
        return None


def sign_request(method: str, url: str, headers: Dict[str, str], body: Optional[bytes] = None) -> Dict[str, str]:
    """
    Sign a request using AWS SigV4 for IAM authentication
    """
    credentials = get_aws_credentials()
    if not credentials:
        raise ValueError("Unable to get AWS credentials for request signing")

    # Create an AWSRequest
    request = AWSRequest(method=method, url=url, headers=headers, data=body)

    # Sign the request
    SigV4Auth(credentials, 'execute-api', AWS_REGION).add_auth(request)

    # Return signed headers
    return dict(request.headers)


def create_product_memory(file_hash: str, predictions: Dict[str, Any], event_detail: Dict[str, Any], tenant_id: str) -> Dict[str, Any]:
    """
    Create a memory in mem0 service using IAM authentication
    """
    memory_data = {
        'type': 'ProductClassificationMemory',
        'content': f"Product classification for image {file_hash}",
        'metadata': {
            'file_hash': file_hash,
            'predictions': predictions,
            'original_filename': event_detail.get('original_filename'),
            'processing_time_ms': event_detail.get('processing_time_ms'),
            'model_name': event_detail.get('model_name'),
            'tenant_id': tenant_id,
            'timestamp': datetime.utcnow().isoformat()
        },
        'tags': ['product-classification', 'automated', tenant_id],
        'run_id': f'bg-remover-{file_hash}'  # Required by mem0 API
    }

    url = f"{MEM0_API_ENDPOINT}/memories"
    body = json.dumps(memory_data).encode('utf-8')

    # Base headers
    headers = {
        'Content-Type': 'application/json',
        'X-Tenant-Id': tenant_id,
        'Host': url.split('/')[2]  # Extract host from URL
    }

    try:
        # Sign request with IAM credentials
        signed_headers = sign_request('POST', url, headers, body)

        # Create request
        req = urllib.request.Request(
            url,
            data=body,
            headers=signed_headers,
            method='POST'
        )

        # Execute request
        with urllib.request.urlopen(req, timeout=10) as response:
            response_body = response.read().decode('utf-8')

            if response.status == 201:
                result = json.loads(response_body)
                print(f"Memory created successfully: {result}")
                return result
            else:
                print(f"Mem0 API returned status {response.status}: {response_body}")
                raise RuntimeError(f"Mem0 API error: status {response.status}")

    except urllib.error.HTTPError as e:
        error_body = e.read().decode('utf-8') if e.fp else str(e)
        print(f"Mem0 API HTTP error: {e.code} - {error_body}")
        raise RuntimeError(f"Mem0 API HTTP error: {e.code} - {error_body}")

    except urllib.error.URLError as e:
        print(f"Mem0 API connection error: {str(e)}")
        raise RuntimeError(f"Mem0 API connection error: {str(e)}")

    except Exception as e:
        print(f"Failed to create memory in mem0: {str(e)}")
        raise RuntimeError(f"Failed to create memory: {str(e)}")