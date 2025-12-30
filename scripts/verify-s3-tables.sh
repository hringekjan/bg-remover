#!/bin/bash
###############################################################################
# Verify S3 Tables (Apache Iceberg) Schema and Data
#
# This script validates that the Glue database and Iceberg table were
# created successfully and performs basic connectivity tests.
#
# Usage:
#   ./verify-s3-tables.sh [stage] [region]
#
# Examples:
#   ./verify-s3-tables.sh dev eu-west-1
#   ./verify-s3-tables.sh prod eu-west-1
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
    echo -e "${GREEN}[✓]${NC} $1"
}

error() {
    echo -e "${RED}[✗]${NC} $1"
}

warning() {
    echo -e "${YELLOW}[!]${NC} $1"
}

# Test counter
TESTS_PASSED=0
TESTS_FAILED=0

# Test helper
test_command() {
    local test_name=$1
    local command=$2

    if $command > /dev/null 2>&1; then
        success "$test_name"
        ((TESTS_PASSED++))
        return 0
    else
        error "$test_name"
        ((TESTS_FAILED++))
        return 1
    fi
}

# Get arguments
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
echo ""

# Configuration
DATABASE_NAME="pricing_intelligence_${STAGE}"
TABLE_NAME="sales_history"
BUCKET_NAME="carousel-${STAGE}-analytics"

# Header
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}S3 Tables Verification${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Test 1: AWS Credentials
log "Checking AWS credentials..."
test_command "AWS credentials configured" "aws sts get-caller-identity --region $REGION"

# Test 2: Glue database exists
log "Checking Glue database..."
test_command "Glue database exists: $DATABASE_NAME" \
    "aws glue get-database --name $DATABASE_NAME --region $REGION"

# Test 3: Glue table exists
log "Checking Glue table..."
test_command "Glue table exists: $TABLE_NAME" \
    "aws glue get-table --database-name $DATABASE_NAME --name $TABLE_NAME --region $REGION"

# Test 4: S3 bucket exists
log "Checking S3 bucket..."
test_command "S3 bucket exists: $BUCKET_NAME" \
    "aws s3api head-bucket --bucket $BUCKET_NAME --region $REGION"

# Test 5: S3 table location accessible
log "Checking S3 table location..."
test_command "S3 table location accessible: s3://$BUCKET_NAME/pricing-intelligence/sales_history/" \
    "aws s3api list-objects-v2 --bucket $BUCKET_NAME --prefix pricing-intelligence/sales_history/ --region $REGION"

# Test 6: Athena WorkGroup (primary)
log "Checking Athena WorkGroup..."
test_command "Athena primary WorkGroup accessible" \
    "aws athena get-work-group --work-group primary --region $REGION"

# Get more details
echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Detailed Information${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Get Glue database info
log "Glue Database Details:"
if aws glue get-database --name "$DATABASE_NAME" --region "$REGION" > /tmp/glue-db.json 2>/dev/null; then
    echo "  Location: $(jq -r '.Database.LocationUri' /tmp/glue-db.json)"
    echo "  Parameters: $(jq -r '.Database.Parameters' /tmp/glue-db.json)"
else
    warning "Could not retrieve database details"
fi

# Get Glue table info
log "Glue Table Details:"
if aws glue get-table --database-name "$DATABASE_NAME" --name "$TABLE_NAME" --region "$REGION" > /tmp/glue-table.json 2>/dev/null; then
    TABLE_LOCATION=$(jq -r '.Table.StorageDescriptor.Location' /tmp/glue-table.json)
    INPUT_FORMAT=$(jq -r '.Table.StorageDescriptor.InputFormat' /tmp/glue-table.json)
    OUTPUT_FORMAT=$(jq -r '.Table.StorageDescriptor.OutputFormat' /tmp/glue-table.json)
    SERDE=$(jq -r '.Table.StorageDescriptor.SerdeInfo.SerializationLibrary' /tmp/glue-table.json)
    NUM_COLUMNS=$(jq '.Table.StorageDescriptor.Columns | length' /tmp/glue-table.json)
    NUM_PARTITIONS=$(jq '.Table.PartitionKeys | length' /tmp/glue-table.json)

    echo "  Location: $TABLE_LOCATION"
    echo "  Input Format: $INPUT_FORMAT"
    echo "  Output Format: $OUTPUT_FORMAT"
    echo "  Serialization: $SERDE"
    echo "  Columns: $NUM_COLUMNS"
    echo "  Partitions: $NUM_PARTITIONS"

    # List columns
    echo "  Column Schema:"
    jq -r '.Table.StorageDescriptor.Columns[] | "    - \(.Name): \(.Type)"' /tmp/glue-table.json
else
    warning "Could not retrieve table details"
fi

# Check S3 bucket contents
log "S3 Bucket Contents:"
OBJECT_COUNT=$(aws s3api list-objects-v2 \
    --bucket "$BUCKET_NAME" \
    --prefix pricing-intelligence/sales_history/ \
    --region "$REGION" \
    --query 'length(Contents)' \
    --output text 2>/dev/null || echo "0")

if [ "$OBJECT_COUNT" = "None" ] || [ "$OBJECT_COUNT" = "0" ]; then
    warning "  No data files in S3 (expected if just created)"
else
    echo "  Objects: $OBJECT_COUNT"
    echo "  Sample objects:"
    aws s3api list-objects-v2 \
        --bucket "$BUCKET_NAME" \
        --prefix pricing-intelligence/sales_history/ \
        --region "$REGION" \
        --query 'Contents[0:5].[Key]' \
        --output text 2>/dev/null | while read key; do
        echo "    - $key"
    done
fi

# Check table metadata
log "Table Metadata:"
if [ -f /tmp/glue-table.json ]; then
    TABLE_TYPE=$(jq -r '.Table.Parameters.table_type // "unknown"' /tmp/glue-table.json)
    FORMAT=$(jq -r '.Table.Parameters.format // "unknown"' /tmp/glue-table.json)
    COMPRESSION=$(jq -r '.Table.Parameters."write.parquet.compression-codec" // "unknown"' /tmp/glue-table.json)
    IS_EXTERNAL=$(jq -r '.Table.Parameters.EXTERNAL // "false"' /tmp/glue-table.json)

    echo "  Table Type: $TABLE_TYPE"
    echo "  File Format: $FORMAT"
    echo "  Compression: $COMPRESSION"
    echo "  External Table: $IS_EXTERNAL"
fi

# Cleanup
rm -f /tmp/glue-db.json /tmp/glue-table.json

# Summary
echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Verification Summary${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo -e "Tests Passed: ${GREEN}$TESTS_PASSED${NC}"
echo -e "Tests Failed: ${RED}$TESTS_FAILED${NC}"
echo ""

if [ $TESTS_FAILED -eq 0 ]; then
    success "All checks passed!"
    echo ""
    echo "Next steps:"
    echo "1. Load sample data:"
    echo "   python3 scripts/load-sample-sales-data.py --stage $STAGE --region $REGION"
    echo ""
    echo "2. Run test query:"
    echo "   aws athena start-query-execution \\"
    echo "     --query-string \"SELECT COUNT(*) FROM $DATABASE_NAME.$TABLE_NAME\" \\"
    echo "     --query-execution-context Database=$DATABASE_NAME \\"
    echo "     --result-configuration OutputLocation=s3://$BUCKET_NAME/athena-results/ \\"
    echo "     --region $REGION"
    echo ""
    exit 0
else
    error "Some checks failed!"
    echo ""
    echo "Troubleshooting:"
    echo "1. Verify AWS credentials: aws sts get-caller-identity"
    echo "2. Check IAM permissions for Glue and S3"
    echo "3. Verify stage is correct: $STAGE"
    echo "4. Check region availability: $REGION"
    echo ""
    exit 1
fi
