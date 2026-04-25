#!/bin/bash

# Build validation script to ensure Lambda and S3 always reference the same build hash

set -e  # Exit on any error

echo "Validating deployment consistency..."

# Get the build ID from Lambda function environment variables
LAMBDA_BUILD_ID=$(aws lambda get-function --function-name bg-remover --query 'Configuration.Environment.Variables.BUILD_ID' --output text 2>/dev/null || echo "")

# Get the build ID from S3
S3_BUCKET="${S3_BUCKET:-bg-remover-artifacts}"

# Try to get the latest build ID from S3
# This assumes we have a way to identify the latest build
S3_BUILD_ID=$(aws s3 cp s3://$S3_BUCKET/latest-build.json - 2>/dev/null | jq -r '.buildId' || echo "")

echo "Lambda build ID: $LAMBDA_BUILD_ID"
echo "S3 build ID: $S3_BUILD_ID"

# Compare build IDs
if [ "$LAMBDA_BUILD_ID" = "$S3_BUILD_ID" ]; then
  echo "✅ Deployment validation passed: Both Lambda and S3 reference the same build ID"
  exit 0
else
  echo "❌ Deployment validation failed: Lambda ($LAMBDA_BUILD_ID) and S3 ($S3_BUILD_ID) reference different build IDs"
  exit 1
fi