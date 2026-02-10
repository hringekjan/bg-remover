#!/bin/bash
#
# BG-Remover Endpoints Test Script
#
# Tests all bg-remover API endpoints to verify they're working correctly.
#
# Usage:
#   ./scripts/test-endpoints.sh [--token JWT_TOKEN]
#
# If no token provided, will attempt to use AWS Cognito to get one.

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
BASE_URL="${BASE_URL:-https://api.dev.hringekjan.is}"
STAGE="${STAGE:-dev}"
TENANT="${TENANT:-hringekjan}"

# Parse arguments
JWT_TOKEN=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --token)
      JWT_TOKEN="$2"
      shift 2
      ;;
    --help)
      echo "Usage: $0 [--token JWT_TOKEN]"
      echo ""
      echo "Options:"
      echo "  --token JWT_TOKEN    Use provided JWT token"
      echo "  --help               Show this help message"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# Get JWT token if not provided
if [ -z "$JWT_TOKEN" ]; then
  echo "📝 JWT token not provided. Set JWT_TOKEN environment variable or use --token flag"
  echo ""
  echo "To get a token:"
  echo "  1. Login to your application"
  echo "  2. Open browser DevTools > Application > Local Storage"
  echo "  3. Copy the access token"
  echo ""
  echo "Or use AWS Cognito CLI:"
  echo "  aws cognito-idp initiate-auth \\"
  echo "    --auth-flow USER_PASSWORD_AUTH \\"
  echo "    --client-id <your-client-id> \\"
  echo "    --auth-parameters USERNAME=<username>,PASSWORD=<password> \\"
  echo "    --query 'AuthenticationResult.AccessToken' \\"
  echo "    --output text"
  echo ""
  exit 1
fi

echo "🧪 Testing BG-Remover API Endpoints"
echo "📍 Base URL: $BASE_URL"
echo "🎯 Stage: $STAGE"
echo ""

# Test counter
TOTAL=0
PASSED=0
FAILED=0

# Helper function to test endpoint
test_endpoint() {
  local method=$1
  local path=$2
  local description=$3
  local data=$4
  local expect_auth=$5

  TOTAL=$((TOTAL + 1))
  echo -n "[$TOTAL] Testing $method $path... "

  local url="$BASE_URL$path"
  local response
  local http_code

  if [ "$method" = "GET" ]; then
    if [ "$expect_auth" = "true" ]; then
      response=$(curl -s -w "\n%{http_code}" -H "Authorization: Bearer $JWT_TOKEN" "$url")
    else
      response=$(curl -s -w "\n%{http_code}" "$url")
    fi
  else
    if [ "$expect_auth" = "true" ]; then
      response=$(curl -s -w "\n%{http_code}" -X "$method" \
        -H "Authorization: Bearer $JWT_TOKEN" \
        -H "Content-Type: application/json" \
        -d "$data" \
        "$url")
    else
      response=$(curl -s -w "\n%{http_code}" -X "$method" \
        -H "Content-Type: application/json" \
        -d "$data" \
        "$url")
    fi
  fi

  http_code=$(echo "$response" | tail -n1)
  body=$(echo "$response" | sed '$ d')

  # Check if successful (200-299)
  if [[ $http_code =~ ^2 ]]; then
    echo -e "${GREEN}✓ $http_code${NC} - $description"
    PASSED=$((PASSED + 1))
    if [ -n "$body" ]; then
      echo "   Response: $(echo "$body" | jq -c '.' 2>/dev/null || echo "$body" | head -c 100)"
    fi
  else
    echo -e "${RED}✗ $http_code${NC} - $description"
    FAILED=$((FAILED + 1))
    if [ -n "$body" ]; then
      echo "   Error: $(echo "$body" | jq -c '.' 2>/dev/null || echo "$body" | head -c 100)"
    fi
  fi
  echo ""
}

# Test public endpoints (no auth)
echo "🔓 Testing Public Endpoints (no auth required)..."
echo ""
test_endpoint "GET" "/bg-remover/health" "Health check" "" "false"
test_endpoint "GET" "/bg-remover/stats" "Statistics" "" "false"

# Test protected endpoints (require auth)
echo "🔐 Testing Protected Endpoints (auth required)..."
echo ""

# Upload URLs
test_endpoint "POST" "/bg-remover/upload-urls" "Generate upload URLs" \
  '{"files":[{"photoId":"test-1","filename":"test.jpg","contentType":"image/jpeg"}]}' \
  "true"

# Settings
test_endpoint "GET" "/bg-remover/settings" "Get settings" "" "true"

# Metrics
test_endpoint "GET" "/bg-remover/metrics" "Get metrics" "" "true"

# Status (should return 404 for non-existent job, but that's ok)
echo "⚠️  Testing job status (expecting 404 for non-existent job)..."
test_endpoint "GET" "/bg-remover/status/test-job-123" "Get job status" "" "true"

# Group status (should return 404 for non-existent job, but that's ok)
test_endpoint "GET" "/bg-remover/group-status/test-group-123" "Get group status" "" "true"

# CORS preflight tests
echo "🌐 Testing CORS Preflight (OPTIONS)..."
echo ""

test_cors_preflight() {
  local path=$1
  local description=$2

  TOTAL=$((TOTAL + 1))
  echo -n "[$TOTAL] Testing OPTIONS $path... "

  local url="$BASE_URL$path"
  local http_code=$(curl -s -o /dev/null -w "%{http_code}" -X OPTIONS \
    -H "Origin: https://example.com" \
    -H "Access-Control-Request-Method: POST" \
    -H "Access-Control-Request-Headers: Authorization, Content-Type" \
    "$url")

  if [[ $http_code =~ ^(200|204)$ ]]; then
    echo -e "${GREEN}✓ $http_code${NC} - $description"
    PASSED=$((PASSED + 1))
  else
    echo -e "${RED}✗ $http_code${NC} - $description"
    FAILED=$((FAILED + 1))
  fi
  echo ""
}

test_cors_preflight "/bg-remover/upload-urls" "Upload URLs CORS"
test_cors_preflight "/bg-remover/process" "Process CORS"
test_cors_preflight "/bg-remover/group-images" "Group Images CORS"

# Summary
echo "=" "60"
echo "📊 Test Summary"
echo "=" "60"
echo "Total tests: $TOTAL"
echo -e "Passed: ${GREEN}$PASSED${NC}"
echo -e "Failed: ${RED}$FAILED${NC}"
echo "=" "60"

if [ $FAILED -eq 0 ]; then
  echo -e "${GREEN}✅ All tests passed!${NC}"
  exit 0
else
  echo -e "${RED}❌ Some tests failed. Check the output above for details.${NC}"
  exit 1
fi
