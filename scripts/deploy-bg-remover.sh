#!/bin/bash

set -e

echo "========================================="
echo "BG Remover Deployment Script"
echo "========================================="

# Configuration
STAGE=${1:-dev}
TENANT=${TENANT:-carousel-labs}
REGION=${AWS_REGION:-eu-west-1}

echo "Stage: $STAGE"
echo "Tenant: $TENANT"
echo "Region: $REGION"
echo "========================================="

# Step 1: Clean previous build
echo ""
echo "Step 1/5: Cleaning previous build..."
rm -rf .next .open-next dist node_modules/.cache

# Step 2: Ensure Sharp is built for Lambda ARM64
echo ""
echo "Step 2/5: Installing Sharp for Lambda ARM64..."
npm install --force --no-save --os=linux --cpu=arm64 --libc=glibc sharp || {
  echo "⚠️  Sharp install failed, trying rebuild..."
  npm rebuild --force sharp --os=linux --cpu=arm64 --libc=glibc
}

# Step 3: Build TypeScript
echo ""
echo "Step 3/5: Building TypeScript..."
npm run build

# Step 4: Deploy via Serverless
echo ""
echo "Step 4/5: Deploying to AWS via Serverless Framework..."
TENANT=$TENANT aws-vault exec carousel-labs-dev-admin --no-session -- \
  npx serverless@4 deploy --stage $STAGE --region $REGION --verbose

# Step 5: Verify deployment
echo ""
echo "Step 5/5: Verifying deployment..."
echo "Testing health endpoint..."
HEALTH_URL="https://api.$STAGE.hringekjan.is/bg-remover/health"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$HEALTH_URL" || echo "000")

if [ "$HTTP_CODE" = "200" ]; then
  echo "✅ Health check passed: $HEALTH_URL"
else
  echo "⚠️  Health check returned: $HTTP_CODE"
  echo "   URL: $HEALTH_URL"
fi

echo ""
echo "========================================="
echo "Deployment Complete!"
echo "========================================="
echo ""
echo "Endpoints:"
echo "  Health: https://api.$STAGE.hringekjan.is/bg-remover/health"
echo "  Group:  https://api.$STAGE.hringekjan.is/bg-remover/group-images"
echo "  Process: https://api.$STAGE.hringekjan.is/bg-remover/process-groups"
echo ""
