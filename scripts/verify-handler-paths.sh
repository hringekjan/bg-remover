#!/bin/bash
#
# Verify BG Remover Lambda Handler Paths
# This script validates that all TypeScript files compile correctly
# and that handler paths in serverless.yml match compiled outputs
#

set -e

echo "=========================================="
echo "BG Remover Handler Path Verification"
echo "=========================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Track errors
ERRORS=0

echo "Step 1: Building TypeScript handlers..."
echo "----------------------------------------"
npm run build:handler

if [ $? -eq 0 ]; then
  echo -e "${GREEN}✓ TypeScript compilation successful${NC}"
else
  echo -e "${RED}✗ TypeScript compilation failed${NC}"
  exit 1
fi

echo ""
echo "Step 2: Verifying compiled handler files..."
echo "----------------------------------------"

# Expected handler files
EXPECTED_HANDLERS=(
  "dist/handler.js"
  "dist/handlers/process-worker-handler.js"
  "dist/handlers/create-products-handler.js"
  "dist/handlers/group-images-handler.js"
  "dist/handlers/process-groups-handler.js"
  "dist/handlers/pricing-calculator.js"
  "dist/handlers/pricing-insight-aggregator.js"
  "dist/handlers/rotate-keys-handler.js"
  "dist/handlers/s3-tables-data-validator.js"
)

for handler in "${EXPECTED_HANDLERS[@]}"; do
  if [ -f "$handler" ]; then
    echo -e "${GREEN}✓${NC} Found: $handler"
  else
    echo -e "${RED}✗${NC} Missing: $handler"
    ERRORS=$((ERRORS + 1))
  fi
done

echo ""
echo "Step 3: Validating serverless.yml syntax..."
echo "----------------------------------------"

npx serverless@4 print --stage dev > /dev/null 2>&1

if [ $? -eq 0 ]; then
  echo -e "${GREEN}✓ serverless.yml syntax is valid${NC}"
else
  echo -e "${RED}✗ serverless.yml syntax validation failed${NC}"
  ERRORS=$((ERRORS + 1))
fi

echo ""
echo "Step 4: Checking handler path references..."
echo "----------------------------------------"

# Extract handler paths from serverless.yml and verify they exist
HANDLER_PATHS=$(grep -E "^\s+handler:" serverless.yml | awk '{print $2}' | grep "^dist/" | sort -u)

for handler_path in $HANDLER_PATHS; do
  # Convert handler path to file path
  # Examples:
  #   dist/handler.health -> dist/handler.js
  #   dist/handlers/process-worker-handler.processWorker -> dist/handlers/process-worker-handler.js

  # Extract file portion (before function name)
  file_path=$(echo "$handler_path" | sed 's/\.[^.]*$//' | sed 's/$/.js/')

  if [ -f "$file_path" ]; then
    echo -e "${GREEN}✓${NC} $handler_path -> $file_path"
  else
    echo -e "${RED}✗${NC} $handler_path -> $file_path (NOT FOUND)"
    ERRORS=$((ERRORS + 1))
  fi
done

echo ""
echo "Step 5: Verifying package patterns..."
echo "----------------------------------------"

# Check if pricingCalculator uses correct package patterns
PRICING_PATTERN=$(grep -A 5 "pricingCalculator:" serverless.yml | grep "dist/handlers/pricing-calculator.js" || true)

if [ -n "$PRICING_PATTERN" ]; then
  echo -e "${GREEN}✓${NC} pricingCalculator package patterns are correct"
else
  echo -e "${YELLOW}⚠${NC} pricingCalculator package patterns may need review"
fi

echo ""
echo "=========================================="
if [ $ERRORS -eq 0 ]; then
  echo -e "${GREEN}✓ All verification checks passed!${NC}"
  echo "=========================================="
  echo ""
  echo "Next steps:"
  echo "  1. Deploy to dev: TENANT=carousel-labs npx serverless@4 deploy --stage dev --region eu-west-1"
  echo "  2. Test health endpoint: curl https://api.dev.carousellabs.co/bg-remover/health"
  echo ""
  exit 0
else
  echo -e "${RED}✗ Verification failed with $ERRORS error(s)${NC}"
  echo "=========================================="
  echo ""
  echo "Please fix the errors above before deploying."
  echo ""
  exit 1
fi
