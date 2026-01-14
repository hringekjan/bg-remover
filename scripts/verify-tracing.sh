#!/bin/bash
# Verify request tracing implementation
# Usage: ./scripts/verify-tracing.sh

set -e

echo "========================================"
echo "Verifying Request Tracing Implementation"
echo "========================================"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check that trace utilities exist
echo ""
echo "1. Checking trace utility files..."

if [ -f "services/carousel-frontend/lib/utils/trace-bg-remover.ts" ]; then
  echo -e "${GREEN}✓ Frontend trace utility exists${NC}"
else
  echo -e "${RED}✗ Frontend trace utility missing${NC}"
  exit 1
fi

if [ -f "services/bg-remover/src/lib/trace.ts" ]; then
  echo -e "${GREEN}✓ Backend trace utility exists${NC}"
else
  echo -e "${RED}✗ Backend trace utility missing${NC}"
  exit 1
fi

# Check CloudWatch queries documentation
echo ""
echo "2. Checking CloudWatch Insights queries..."

if [ -f "services/bg-remover/cloudwatch-insights-queries.md" ]; then
  echo -e "${GREEN}✓ CloudWatch queries documentation exists${NC}"

  # Count number of queries
  QUERY_COUNT=$(grep -c "^##.*\." services/bg-remover/cloudwatch-insights-queries.md || true)
  echo -e "${GREEN}  Found $QUERY_COUNT pre-built queries${NC}"
else
  echo -e "${RED}✗ CloudWatch queries documentation missing${NC}"
  exit 1
fi

# Check serverless.yml X-Ray configuration
echo ""
echo "3. Checking serverless.yml X-Ray configuration..."

if grep -q "tracing:" services/bg-remover/serverless.yml; then
  if grep -q "lambda: true" services/bg-remover/serverless.yml; then
    echo -e "${GREEN}✓ X-Ray Lambda tracing enabled${NC}"
  else
    echo -e "${RED}✗ X-Ray Lambda tracing not enabled${NC}"
    exit 1
  fi
else
  echo -e "${RED}✗ X-Ray tracing configuration missing${NC}"
  exit 1
fi

# Check X-Ray IAM permissions
if grep -q "xray:PutTraceSegments" services/bg-remover/serverless.yml; then
  echo -e "${GREEN}✓ X-Ray IAM permissions configured${NC}"
else
  echo -e "${RED}✗ X-Ray IAM permissions missing${NC}"
  exit 1
fi

# Check X-Ray environment variables
if grep -q "AWS_XRAY_TRACING_ENABLED" services/bg-remover/serverless.yml; then
  echo -e "${GREEN}✓ X-Ray environment variables set${NC}"
else
  echo -e "${YELLOW}⚠ X-Ray environment variables not set${NC}"
fi

# Check frontend API route integration
echo ""
echo "4. Checking frontend API route integration..."

if grep -q "createTraceContext" services/carousel-frontend/app/api/bg-remover/process/route.ts; then
  echo -e "${GREEN}✓ Frontend uses createTraceContext${NC}"
else
  echo -e "${RED}✗ Frontend missing createTraceContext${NC}"
  exit 1
fi

if grep -q "logRequest" services/carousel-frontend/app/api/bg-remover/process/route.ts; then
  echo -e "${GREEN}✓ Frontend logs requests${NC}"
else
  echo -e "${RED}✗ Frontend missing logRequest${NC}"
  exit 1
fi

if grep -q "logResponse" services/carousel-frontend/app/api/bg-remover/process/route.ts; then
  echo -e "${GREEN}✓ Frontend logs responses${NC}"
else
  echo -e "${RED}✗ Frontend missing logResponse${NC}"
  exit 1
fi

if grep -q "logError" services/carousel-frontend/app/api/bg-remover/process/route.ts; then
  echo -e "${GREEN}✓ Frontend logs errors${NC}"
else
  echo -e "${RED}✗ Frontend missing logError${NC}"
  exit 1
fi

if grep -q "injectTraceId" services/carousel-frontend/app/api/bg-remover/process/route.ts; then
  echo -e "${GREEN}✓ Frontend injects trace ID into Lambda requests${NC}"
else
  echo -e "${RED}✗ Frontend missing injectTraceId${NC}"
  exit 1
fi

if grep -q "x-trace-id" services/carousel-frontend/app/api/bg-remover/process/route.ts; then
  echo -e "${GREEN}✓ Frontend returns trace ID in headers${NC}"
else
  echo -e "${RED}✗ Frontend missing x-trace-id header${NC}"
  exit 1
fi

# Check trace ID in response body
if grep -q "traceId: context.traceId" services/carousel-frontend/app/api/bg-remover/process/route.ts; then
  echo -e "${GREEN}✓ Frontend returns trace ID in response body${NC}"
else
  echo -e "${YELLOW}⚠ Frontend may not return trace ID in response body${NC}"
fi

# Verify implementation summary exists
echo ""
echo "5. Checking implementation documentation..."

if [ -f "services/bg-remover/TRACING_IMPLEMENTATION_SUMMARY.md" ]; then
  echo -e "${GREEN}✓ Implementation summary exists${NC}"
else
  echo -e "${YELLOW}⚠ Implementation summary missing${NC}"
fi

# Summary
echo ""
echo "========================================"
echo -e "${GREEN}✓ Request Tracing Implementation Verified${NC}"
echo "========================================"
echo ""
echo "Next Steps:"
echo "1. Deploy bg-remover service to enable X-Ray tracing"
echo "2. Deploy carousel-frontend with trace integration"
echo "3. Make test request and extract trace ID"
echo "4. Use CloudWatch Insights queries to verify logs"
echo ""
echo "CloudWatch Queries: services/bg-remover/cloudwatch-insights-queries.md"
echo "Documentation: services/bg-remover/TRACING_IMPLEMENTATION_SUMMARY.md"
echo ""
