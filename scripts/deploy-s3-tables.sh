#!/bin/bash
###############################################################################
# Deploy S3 Tables (Apache Iceberg) schema for sales history data lake
#
# This script creates the necessary AWS Glue database and Iceberg table
# for storing historical sales data with Athena query support.
#
# Usage:
#   ./deploy-s3-tables.sh [stage] [region]
#
# Examples:
#   ./deploy-s3-tables.sh dev eu-west-1
#   ./deploy-s3-tables.sh prod eu-west-1
###############################################################################

set -euo pipefail

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
log() {
    echo -e "${BLUE}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} $1"
}

success() {
    echo -e "${GREEN}[$(date +'%Y-%m-%d %H:%M:%S')] SUCCESS${NC} $1"
}

error() {
    echo -e "${RED}[$(date +'%Y-%m-%d %H:%M:%S')] ERROR${NC} $1"
}

warning() {
    echo -e "${YELLOW}[$(date +'%Y-%m-%d %H:%M:%S')] WARNING${NC} $1"
}

# Validate inputs
STAGE="${1:-dev}"
REGION="${2:-eu-west-1}"

# Validate stage
case "$STAGE" in
    dev|staging|prod)
        log "Stage: $STAGE"
        ;;
    *)
        error "Invalid stage: $STAGE (must be dev, staging, or prod)"
        exit 1
        ;;
esac

log "Region: $REGION"

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_DIR="$(dirname "$SCRIPT_DIR")"

log "Service directory: $SERVICE_DIR"

# Verify AWS CLI is available
if ! command -v aws &> /dev/null; then
    error "AWS CLI not found. Please install AWS CLI v2."
    exit 1
fi

# Verify Python is available
if ! command -v python3 &> /dev/null; then
    error "Python 3 not found. Please install Python 3."
    exit 1
fi

# Verify AWS credentials
log "Verifying AWS credentials..."
if ! aws sts get-caller-identity > /dev/null 2>&1; then
    error "AWS credentials not configured or expired"
    exit 1
fi

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
success "AWS credentials verified (Account: $ACCOUNT_ID)"

# Verify Python script exists
PYTHON_SCRIPT="$SCRIPT_DIR/create-s3-tables-schema.py"
if [ ! -f "$PYTHON_SCRIPT" ]; then
    error "Python script not found: $PYTHON_SCRIPT"
    exit 1
fi

log "Python script: $PYTHON_SCRIPT"

# Install Python dependencies if needed
log "Checking Python dependencies..."
if ! python3 -c "import boto3" 2>/dev/null; then
    warning "boto3 not found, installing..."
    pip3 install --upgrade boto3 > /dev/null 2>&1
    success "boto3 installed"
fi

# Check for pyarrow (required for data loading)
if ! python3 -c "import pyarrow" 2>/dev/null; then
    warning "pyarrow not found (required for data loading)"
    echo "Install with: pip3 install pyarrow"
fi

# Create output directory for logs
LOG_DIR="${SERVICE_DIR}/.serverless/s3-tables-logs"
mkdir -p "$LOG_DIR"
TIMESTAMP=$(date +%s)
LOG_FILE="$LOG_DIR/deploy-s3-tables-${STAGE}-${TIMESTAMP}.log"

log "Log file: $LOG_FILE"

# Run the Python script
log "Creating S3 Tables schema..."
log "Command: python3 $PYTHON_SCRIPT --stage $STAGE --region $REGION"

if python3 "$PYTHON_SCRIPT" --stage "$STAGE" --region "$REGION" 2>&1 | tee -a "$LOG_FILE"; then
    success "S3 Tables schema creation completed"
else
    error "S3 Tables schema creation failed (see $LOG_FILE)"
    exit 1
fi

# Verify table creation
log "Verifying table creation..."
DATABASE_NAME="pricing_intelligence_${STAGE}"
TABLE_NAME="sales_history"

if aws glue get-table \
    --database-name "$DATABASE_NAME" \
    --name "$TABLE_NAME" \
    --region "$REGION" > /dev/null 2>&1; then
    success "Table verification successful"
else
    warning "Table verification failed, but creation script completed"
fi

# Print next steps
echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}S3 Tables Schema Deployment Complete${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "Database: $DATABASE_NAME"
echo "Table: $TABLE_NAME"
echo "Region: $REGION"
echo ""
echo "Next steps:"
echo "1. Test query via Athena:"
echo "   aws athena start-query-execution \\"
echo "     --query-string \"SELECT * FROM $DATABASE_NAME.$TABLE_NAME LIMIT 10\" \\"
echo "     --query-execution-context Database=$DATABASE_NAME \\"
echo "     --result-configuration OutputLocation=s3://carousel-${STAGE}-analytics/athena-results/ \\"
echo "     --region $REGION"
echo ""
echo "2. Load sample data:"
echo "   python3 $SERVICE_DIR/scripts/load-sample-sales-data.py --stage $STAGE --region $REGION"
echo ""
echo "3. Update IAM permissions in serverless.yml:"
echo "   - Add Glue permissions (create/update table)"
echo "   - Add S3 permissions (read/write to analytics bucket)"
echo "   - Add Athena permissions (start queries)"
echo ""
echo "Log file: $LOG_FILE"
echo ""
