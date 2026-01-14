#!/bin/bash
# Rotate admin API keys (zero-downtime)
#
# This script rotates admin API keys stored in SSM Parameter Store (SecureString)
# by adding a new key and removing the oldest key, maintaining 3 active keys at all times.
#
# Usage:
#   ./rotate-admin-keys.sh [STAGE] [TENANT]
#
# Examples:
#   ./rotate-admin-keys.sh dev carousel-labs
#   ./rotate-admin-keys.sh prod carousel-labs
#
# Security:
# - Keys stored as SecureString (KMS-encrypted)
# - Zero-downtime rotation (3 keys in rotation)
# - Old keys remain valid for grace period
# - CloudWatch logs track rotation events

set -euo pipefail

# Configuration
STAGE="${1:-dev}"
TENANT="${2:-carousel-labs}"
PARAM_NAME="/tf/${STAGE}/${TENANT}/services/bg-remover/admin-api-keys"
METADATA_PARAM="/tf/${STAGE}/${TENANT}/services/bg-remover/admin-api-keys-metadata"
AWS_REGION="${AWS_REGION:-eu-west-1}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Admin API Key Rotation${NC}"
echo -e "${GREEN}========================================${NC}"
echo "Stage: ${STAGE}"
echo "Tenant: ${TENANT}"
echo "Parameter: ${PARAM_NAME}"
echo ""

# Check if AWS CLI is available
if ! command -v aws &> /dev/null; then
  echo -e "${RED}Error: AWS CLI not found. Please install it first.${NC}"
  exit 1
fi

# Check if uuidgen is available
if ! command -v uuidgen &> /dev/null; then
  echo -e "${RED}Error: uuidgen not found. Please install uuid-runtime.${NC}"
  exit 1
fi

# Check if jq is available
if ! command -v jq &> /dev/null; then
  echo -e "${RED}Error: jq not found. Please install it first.${NC}"
  exit 1
fi

# Generate new key
echo -e "${YELLOW}Generating new API key...${NC}"
NEW_KEY=$(uuidgen | tr '[:upper:]' '[:lower:]')
echo "New key (first 8 chars): ${NEW_KEY:0:8}..."

# Get existing keys
echo -e "${YELLOW}Fetching existing keys from SSM...${NC}"
if ! EXISTING=$(aws ssm get-parameter \
  --name "$PARAM_NAME" \
  --with-decryption \
  --query 'Parameter.Value' \
  --output text \
  --region "$AWS_REGION" 2>&1); then

  if echo "$EXISTING" | grep -q "ParameterNotFound"; then
    echo -e "${YELLOW}No existing keys found. Creating initial key set...${NC}"
    EXISTING=""
  else
    echo -e "${RED}Error fetching existing keys: $EXISTING${NC}"
    exit 1
  fi
fi

# Add new key to beginning (most recent first)
if [ -z "$EXISTING" ]; then
  # First time setup - create 3 initial keys
  KEY1=$(uuidgen | tr '[:upper:]' '[:lower:]')
  KEY2=$(uuidgen | tr '[:upper:]' '[:lower:]')
  KEY3=$(uuidgen | tr '[:upper:]' '[:lower:]')
  NEW_KEYS="$KEY1,$KEY2,$KEY3"
  echo -e "${YELLOW}Creating initial key set (3 keys)${NC}"
else
  NEW_KEYS="$NEW_KEY,$EXISTING"
  echo -e "${YELLOW}Adding new key to existing set${NC}"
fi

# Keep only 3 most recent keys
NEW_KEYS=$(echo "$NEW_KEYS" | awk -F',' '{print $1","$2","$3}')
NUM_KEYS=$(echo "$NEW_KEYS" | tr ',' '\n' | wc -l)

echo "Keys in rotation: $NUM_KEYS"

# Update parameter
echo -e "${YELLOW}Updating SSM parameter...${NC}"
if aws ssm put-parameter \
  --name "$PARAM_NAME" \
  --value "$NEW_KEYS" \
  --type SecureString \
  --kms-key-id "alias/aws/ssm" \
  --overwrite \
  --region "$AWS_REGION" \
  --description "Admin API keys for bg-remover service (3 keys for rotation)" \
  --tags "Key=Service,Value=bg-remover" "Key=Environment,Value=${STAGE}" "Key=Tenant,Value=${TENANT}" \
  > /dev/null 2>&1; then
  echo -e "${GREEN}✅ SSM parameter updated successfully${NC}"
else
  echo -e "${RED}❌ Failed to update SSM parameter${NC}"
  exit 1
fi

# Update metadata
echo -e "${YELLOW}Updating key metadata...${NC}"
CURRENT_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
METADATA=$(cat <<EOF
{
  "keys": [
    {
      "id": "key1",
      "createdAt": "$CURRENT_DATE",
      "status": "active",
      "keyPrefix": "${NEW_KEY:0:8}"
    },
    {
      "id": "key2",
      "createdAt": "$CURRENT_DATE",
      "status": "active"
    },
    {
      "id": "key3",
      "createdAt": "$CURRENT_DATE",
      "status": "active"
    }
  ],
  "rotationSchedule": "30d",
  "lastRotation": "$CURRENT_DATE"
}
EOF
)

if aws ssm put-parameter \
  --name "$METADATA_PARAM" \
  --value "$METADATA" \
  --type String \
  --overwrite \
  --region "$AWS_REGION" \
  > /dev/null 2>&1; then
  echo -e "${GREEN}✅ Metadata updated successfully${NC}"
else
  echo -e "${YELLOW}⚠️  Failed to update metadata (non-critical)${NC}"
fi

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Key Rotation Complete${NC}"
echo -e "${GREEN}========================================${NC}"
echo "✅ New key added: ${NEW_KEY:0:8}..."
echo "✅ Total active keys: $NUM_KEYS"
echo "⚠️  Oldest key will be removed on next rotation"
echo ""
echo "Next steps:"
echo "1. Test API with new key"
echo "2. Update client applications within 30 days"
echo "3. Schedule next rotation in 30 days"
echo ""
echo -e "${YELLOW}Note: Lambda functions will pick up new keys within 5 minutes (cache TTL)${NC}"
