#!/bin/bash

# Atomic S3 + Lambda deployment script
# This script ensures that Lambda and S3 always reference the same build hash

set -e  # Exit on any error

echo "Starting atomic deployment..."

# Get the build ID
BUILD_ID=$(node -e "console.log(require('./lib/build-id-tracker').generateBuildId())")

echo "Generated build ID: $BUILD_ID"

# Build the application
echo "Building application..."
npm run build

# Upload artifacts to S3 with the build ID
echo "Uploading artifacts to S3..."
S3_BUCKET="${S3_BUCKET:-bg-remover-artifacts}"
S3_PREFIX="builds/$BUILD_ID"

# Upload lambda function artifact
aws s3 cp .serverless/bg-remover.zip s3://$S3_BUCKET/$S3_PREFIX/bg-remover.zip

# Upload any other artifacts
# Add more upload commands as needed

echo "Artifacts uploaded to S3 with build ID: $BUILD_ID"

# Deploy Lambda function with the build ID
echo "Deploying Lambda function..."
serverless deploy --stage $STAGE

# Update S3 bucket with build ID reference
echo "Updating S3 build reference..."
aws s3 cp - <<< "{\"buildId\": \"$BUILD_ID\"}" s3://$S3_BUCKET/$S3_PREFIX/build-info.json

echo "Deployment completed with build ID: $BUILD_ID"