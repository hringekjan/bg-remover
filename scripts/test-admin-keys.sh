#!/bin/bash
# Test admin API key authentication
#
# This script tests the admin API key authentication by making requests to the
# bg-remover API with valid and invalid keys.
#
# Usage:
#   ./test-admin-keys.sh [STAGE] [API_KEY]
#
# Examples:
#   ./test-admin-keys.sh dev a1b2c3d4-e5f6-7890-abcd-ef1234567890

set -euo pipefail

# Configuration
STAGE="${1:-dev}"
API_KEY="${2:-}"
API_URL="https://api.${STAGE}.carousellabs.co/bg-remover/process"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Admin API Key Testing${NC}"
echo -e "${GREEN}========================================${NC}"
echo "Stage: ${STAGE}"
echo "API URL: ${API_URL}"
echo ""

# Test data
TEST_IMAGE_URL="https://images.unsplash.com/photo-1560343090-f0409e92791a?w=400"

# Test 1: Request with valid API key
if [ -n "$API_KEY" ]; then
  echo -e "${YELLOW}Test 1: Valid API key authentication${NC}"
  RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_URL" \
    -H "Content-Type: application/json" \
    -H "X-Api-Key: $API_KEY" \
    -H "X-Tenant-Id: carousel-labs" \
    -d "{
      \"imageUrl\": \"$TEST_IMAGE_URL\",
      \"outputFormat\": \"png\",
      \"skipCreditValidation\": true
    }")

  HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
  BODY=$(echo "$RESPONSE" | head -n-1)

  if [ "$HTTP_CODE" = "200" ]; then
    echo -e "${GREEN}✅ PASS: Valid key accepted (HTTP $HTTP_CODE)${NC}"
    echo "$BODY" | jq -r '.success, .jobId' 2>/dev/null || echo "$BODY"
  else
    echo -e "${RED}❌ FAIL: Valid key rejected (HTTP $HTTP_CODE)${NC}"
    echo "$BODY"
  fi
  echo ""
else
  echo -e "${YELLOW}Skipping valid key test (no API key provided)${NC}"
  echo ""
fi

# Test 2: Request with invalid API key
echo -e "${YELLOW}Test 2: Invalid API key authentication${NC}"
INVALID_KEY="00000000-0000-0000-0000-000000000000"
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $INVALID_KEY" \
  -H "X-Tenant-Id: carousel-labs" \
  -d "{
    \"imageUrl\": \"$TEST_IMAGE_URL\",
    \"outputFormat\": \"png\",
    \"skipCreditValidation\": true
  }")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n-1)

if [ "$HTTP_CODE" = "401" ] || [ "$HTTP_CODE" = "402" ]; then
  echo -e "${GREEN}✅ PASS: Invalid key rejected (HTTP $HTTP_CODE)${NC}"
  echo "$BODY" | jq -r '.error' 2>/dev/null || echo "$BODY"
else
  echo -e "${RED}❌ FAIL: Invalid key accepted (HTTP $HTTP_CODE)${NC}"
  echo "$BODY"
fi
echo ""

# Test 3: Request without API key (should require credits)
echo -e "${YELLOW}Test 3: No API key (credit validation required)${NC}"
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -H "X-Tenant-Id: carousel-labs" \
  -d "{
    \"imageUrl\": \"$TEST_IMAGE_URL\",
    \"outputFormat\": \"png\"
  }")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n-1)

if [ "$HTTP_CODE" = "401" ] || [ "$HTTP_CODE" = "402" ]; then
  echo -e "${GREEN}✅ PASS: Credit validation enforced (HTTP $HTTP_CODE)${NC}"
  echo "$BODY" | jq -r '.error' 2>/dev/null || echo "$BODY"
else
  echo -e "${RED}❌ FAIL: Credit validation bypassed (HTTP $HTTP_CODE)${NC}"
  echo "$BODY"
fi
echo ""

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Testing Complete${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "Summary:"
echo "- Valid key test: Check output above"
echo "- Invalid key test: Should be rejected (401/402)"
echo "- No key test: Should require credits (401/402)"
echo ""
echo -e "${YELLOW}Note: All tests should show proper authentication behavior${NC}"
