#!/bin/bash
# Seed initial admin API keys to SSM Parameter Store
#
# This script creates the initial admin API keys in SSM Parameter Store (SecureString)
# and should be run once during initial deployment.
#
# Usage:
#   ./seed-admin-keys.sh [STAGE] [TENANT]
#
# Examples:
#   ./seed-admin-keys.sh dev carousel-labs
#   ./seed-admin-keys.sh prod carousel-labs

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
echo -e "${GREEN}Admin API Key Seeding${NC}"
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

# Check if parameter already exists
echo -e "${YELLOW}Checking if parameter already exists...${NC}"
if aws ssm get-parameter \
  --name "$PARAM_NAME" \
  --region "$AWS_REGION" \
  > /dev/null 2>&1; then

  echo -e "${YELLOW}Parameter already exists. Use rotate-admin-keys.sh to rotate keys.${NC}"
  echo ""
  read -p "Do you want to overwrite existing keys? (yes/no): " CONFIRM
  if [ "$CONFIRM" != "yes" ]; then
    echo -e "${RED}Aborted.${NC}"
    exit 0
  fi
fi

# Generate 3 initial keys
echo -e "${YELLOW}Generating 3 initial API keys...${NC}"
KEY1=$(uuidgen | tr '[:upper:]' '[:lower:]')
KEY2=$(uuidgen | tr '[:upper:]' '[:lower:]')
KEY3=$(uuidgen | tr '[:upper:]' '[:lower:]')

echo "Key 1 (first 8 chars): ${KEY1:0:8}..."
echo "Key 2 (first 8 chars): ${KEY2:0:8}..."
echo "Key 3 (first 8 chars): ${KEY3:0:8}..."

# Combine keys
KEYS="$KEY1,$KEY2,$KEY3"

# Store in SSM
echo -e "${YELLOW}Storing keys in SSM Parameter Store...${NC}"
if aws ssm put-parameter \
  --name "$PARAM_NAME" \
  --value "$KEYS" \
  --type SecureString \
  --kms-key-id "alias/aws/ssm" \
  --description "Admin API keys for bg-remover service (3 keys for rotation)" \
  --overwrite \
  --region "$AWS_REGION" \
  --tags "Key=Service,Value=bg-remover" "Key=Environment,Value=${STAGE}" "Key=Tenant,Value=${TENANT}" \
  > /dev/null 2>&1; then
  echo -e "${GREEN}✅ Keys stored successfully${NC}"
else
  echo -e "${RED}❌ Failed to store keys${NC}"
  exit 1
fi

# Store metadata
echo -e "${YELLOW}Storing key metadata...${NC}"
CURRENT_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
METADATA=$(cat <<EOF
{
  "keys": [
    {
      "id": "key1",
      "createdAt": "$CURRENT_DATE",
      "status": "active",
      "keyPrefix": "${KEY1:0:8}"
    },
    {
      "id": "key2",
      "createdAt": "$CURRENT_DATE",
      "status": "active",
      "keyPrefix": "${KEY2:0:8}"
    },
    {
      "id": "key3",
      "createdAt": "$CURRENT_DATE",
      "status": "active",
      "keyPrefix": "${KEY3:0:8}"
    }
  ],
  "rotationSchedule": "30d",
  "lastRotation": "$CURRENT_DATE",
  "createdAt": "$CURRENT_DATE"
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
  echo -e "${GREEN}✅ Metadata stored successfully${NC}"
else
  echo -e "${YELLOW}⚠️  Failed to store metadata (non-critical)${NC}"
fi

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Admin API Keys Seeded${NC}"
echo -e "${GREEN}========================================${NC}"
echo "✅ 3 keys created and stored in SSM"
echo ""
echo "Full keys (SAVE THESE SECURELY):"
echo "Key 1: $KEY1"
echo "Key 2: $KEY2"
echo "Key 3: $KEY3"
echo ""
echo -e "${YELLOW}IMPORTANT: Save these keys in your password manager!${NC}"
echo -e "${YELLOW}You won't be able to retrieve them from SSM in plaintext later.${NC}"
echo ""
echo "Next steps:"
echo "1. Save keys in password manager"
echo "2. Update client applications with any one of the keys"
echo "3. Schedule key rotation in 30 days"
echo "4. Deploy bg-remover service to activate SSM integration"
