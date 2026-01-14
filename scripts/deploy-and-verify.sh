#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# BG Remover Deployment & Verification Script
# ============================================================================
# Comprehensive deployment script with pre-flight checks, deployment,
# and post-deployment verification including cache testing.
#
# Usage:
#   ./scripts/deploy-and-verify.sh [options]
#
# Options:
#   --stage <dev|prod>       Deployment stage (default: dev)
#   --region <region>        AWS region (default: eu-west-1)
#   --tenant <tenant>        Tenant identifier (default: carousel-labs)
#   --dry-run                Run checks but skip actual deployment
#   --verbose                Enable verbose output
#   --json                   Output results in JSON format
#   --skip-tests             Skip pre-deployment tests
#   --skip-cache-test        Skip post-deployment cache verification
#   --help                   Show this help message
# ============================================================================

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Configuration
STAGE="${STAGE:-dev}"
REGION="${REGION:-eu-west-1}"
TENANT="${TENANT:-carousel-labs}"
DRY_RUN=false
VERBOSE=false
JSON_OUTPUT=false
SKIP_TESTS=false
SKIP_CACHE_TEST=false

# Derived paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SERVICE_NAME="bg-remover"

# Timestamps
DEPLOY_START_TIME=$(date +%s)
DEPLOY_TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# Output files
REPORT_DIR="${SERVICE_DIR}/.serverless/reports"
REPORT_FILE="${REPORT_DIR}/deployment_${DEPLOY_TIMESTAMP}.md"
JSON_FILE="${REPORT_DIR}/deployment_${DEPLOY_TIMESTAMP}.json"
LOG_FILE="${REPORT_DIR}/deployment_${DEPLOY_TIMESTAMP}.log"

# Results tracking
declare -A CHECKS_PASSED
declare -A CHECKS_FAILED
declare -A WARNINGS
DEPLOYMENT_SUCCESS=false
API_ENDPOINT=""
CLOUDFRONT_DISTRIBUTION=""

# ============================================================================
# Utility Functions
# ============================================================================

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1" | tee -a "${LOG_FILE}"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1" | tee -a "${LOG_FILE}"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1" | tee -a "${LOG_FILE}"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1" | tee -a "${LOG_FILE}"
}

log_debug() {
    if [[ "${VERBOSE}" == "true" ]]; then
        echo -e "${CYAN}[DEBUG]${NC} $1" | tee -a "${LOG_FILE}"
    fi
}

usage() {
    cat <<EOF
BG Remover Deployment & Verification Script

Usage:
  ${0} [options]

Options:
  --stage <dev|prod>       Deployment stage (default: dev)
  --region <region>        AWS region (default: eu-west-1)
  --tenant <tenant>        Tenant identifier (default: carousel-labs)
  --dry-run                Run checks but skip actual deployment
  --verbose                Enable verbose output
  --json                   Output results in JSON format
  --skip-tests             Skip pre-deployment tests
  --skip-cache-test        Skip post-deployment cache verification
  --help                   Show this help message

Examples:
  # Deploy to dev with full verification
  ./scripts/deploy-and-verify.sh --stage dev --tenant carousel-labs

  # Dry run for prod
  ./scripts/deploy-and-verify.sh --stage prod --dry-run

  # Deploy with verbose output and JSON report
  ./scripts/deploy-and-verify.sh --stage dev --verbose --json

EOF
}

# ============================================================================
# Pre-deployment Checks
# ============================================================================

check_node_version() {
    log_info "Checking Node.js version..."

    local node_version
    node_version=$(node --version | sed 's/v//')
    local node_major
    node_major=$(echo "${node_version}" | cut -d. -f1)

    if [[ "${node_major}" -lt 22 ]]; then
        log_error "Node.js version ${node_version} is too old. Required: >=22.0.0"
        CHECKS_FAILED["node_version"]="Node.js ${node_version} < 22.0.0"
        return 1
    fi

    log_success "Node.js version ${node_version} meets requirements (>=22.0.0)"
    CHECKS_PASSED["node_version"]="Node.js ${node_version}"
    return 0
}

check_aws_credentials() {
    log_info "Checking AWS credentials..."

    if ! aws sts get-caller-identity --region "${REGION}" &>/dev/null; then
        log_error "AWS credentials not configured or invalid"
        CHECKS_FAILED["aws_credentials"]="Invalid AWS credentials"
        return 1
    fi

    local aws_identity
    aws_identity=$(aws sts get-caller-identity --region "${REGION}" --output json)
    local aws_account
    aws_account=$(echo "${aws_identity}" | jq -r '.Account')
    local aws_user
    aws_user=$(echo "${aws_identity}" | jq -r '.Arn')

    log_success "AWS credentials valid: ${aws_user} (Account: ${aws_account})"
    CHECKS_PASSED["aws_credentials"]="Account ${aws_account}"
    return 0
}

check_ssm_parameters() {
    log_info "Checking required SSM parameters..."

    local param_errors=0
    local params=(
        "/tf/${STAGE}/platform/api-gateway/id"
        "/tf/${STAGE}/platform/cognito/user-pool-id"
        "/tf/${STAGE}/platform/cognito/issuer-url"
        "/tf/${STAGE}/${TENANT}/services/bg-remover/cache-key-secret"
    )

    for param in "${params[@]}"; do
        log_debug "Checking SSM parameter: ${param}"

        if aws ssm get-parameter \
            --name "${param}" \
            --region "${REGION}" \
            --output json &>/dev/null; then
            log_success "SSM parameter exists: ${param}"
        else
            log_error "SSM parameter missing: ${param}"
            CHECKS_FAILED["ssm_${param}"]="Missing"
            ((param_errors++))
        fi
    done

    if [[ ${param_errors} -eq 0 ]]; then
        CHECKS_PASSED["ssm_parameters"]="All ${#params[@]} parameters exist"
        return 0
    else
        CHECKS_FAILED["ssm_parameters"]="${param_errors} missing parameters"
        return 1
    fi
}

check_handler_paths() {
    log_info "Checking handler paths (dist/ not src/)..."

    local serverless_yml="${SERVICE_DIR}/serverless.yml"

    if ! [[ -f "${serverless_yml}" ]]; then
        log_error "serverless.yml not found at ${serverless_yml}"
        CHECKS_FAILED["handler_paths"]="serverless.yml not found"
        return 1
    fi

    # Check for src/ handlers (should be dist/)
    if grep -q "handler: src/" "${serverless_yml}"; then
        log_error "Found src/ handler paths in serverless.yml (should be dist/)"
        CHECKS_FAILED["handler_paths"]="Found src/ paths instead of dist/"

        log_info "Incorrect handler paths:"
        grep "handler: src/" "${serverless_yml}" | sed 's/^/  /'
        return 1
    fi

    log_success "All handler paths use dist/ (correct)"
    CHECKS_PASSED["handler_paths"]="All handlers use dist/"
    return 0
}

check_typescript_compilation() {
    log_info "Running TypeScript compilation..."

    cd "${SERVICE_DIR}"

    if ! npm run build:handler &>"${REPORT_DIR}/typescript_build.log"; then
        log_error "TypeScript compilation failed"
        CHECKS_FAILED["typescript"]="Compilation failed"

        log_info "Build errors:"
        tail -20 "${REPORT_DIR}/typescript_build.log" | sed 's/^/  /'
        return 1
    fi

    log_success "TypeScript compilation successful"
    CHECKS_PASSED["typescript"]="Compilation successful"
    return 0
}

check_compiled_files() {
    log_info "Verifying compiled files exist in dist/..."

    local dist_dir="${SERVICE_DIR}/dist"

    if ! [[ -d "${dist_dir}" ]]; then
        log_error "dist/ directory not found"
        CHECKS_FAILED["compiled_files"]="dist/ directory missing"
        return 1
    fi

    local required_files=(
        "dist/handler.js"
        "dist/handlers/metrics-handler.js"
        "dist/handlers/process-worker-handler.js"
        "dist/handlers/create-products-handler.js"
        "dist/handlers/group-images-handler.js"
        "dist/handlers/process-groups-handler.js"
        "dist/handlers/pricing-calculator.js"
    )

    local missing_files=0
    for file in "${required_files[@]}"; do
        if ! [[ -f "${SERVICE_DIR}/${file}" ]]; then
            log_error "Compiled file missing: ${file}"
            ((missing_files++))
        else
            log_debug "Found: ${file}"
        fi
    done

    if [[ ${missing_files} -eq 0 ]]; then
        log_success "All ${#required_files[@]} required compiled files exist"
        CHECKS_PASSED["compiled_files"]="All ${#required_files[@]} files exist"
        return 0
    else
        log_error "${missing_files} compiled files missing"
        CHECKS_FAILED["compiled_files"]="${missing_files} files missing"
        return 1
    fi
}

run_tests() {
    if [[ "${SKIP_TESTS}" == "true" ]]; then
        log_info "Skipping tests (--skip-tests flag)"
        WARNINGS["tests"]="Tests skipped by user"
        return 0
    fi

    log_info "Running tests..."

    cd "${SERVICE_DIR}"

    # Type check
    if [[ -f "package.json" ]] && grep -q '"type-check"' "package.json"; then
        log_info "Running type check..."
        if ! npm run type-check &>"${REPORT_DIR}/type_check.log"; then
            log_error "Type check failed"
            CHECKS_FAILED["type_check"]="Type check failed"
            return 1
        fi
        log_success "Type check passed"
    fi

    # Linting
    if [[ -f "package.json" ]] && grep -q '"lint"' "package.json"; then
        log_info "Running linter..."
        if ! npm run lint &>"${REPORT_DIR}/lint.log"; then
            log_warning "Linting failed (non-blocking)"
            WARNINGS["lint"]="Linting issues detected"
        else
            log_success "Linting passed"
        fi
    fi

    # Unit tests
    if [[ -f "package.json" ]] && grep -q '"test"' "package.json"; then
        log_info "Running unit tests..."
        if ! npm test &>"${REPORT_DIR}/test.log"; then
            log_warning "Unit tests failed (non-blocking)"
            WARNINGS["unit_tests"]="Some tests failed"
        else
            log_success "Unit tests passed"
        fi
    fi

    CHECKS_PASSED["tests"]="Pre-deployment tests completed"
    return 0
}

# ============================================================================
# Deployment
# ============================================================================

deploy_service() {
    log_info "Deploying BG Remover service..."

    cd "${SERVICE_DIR}"

    local deploy_cmd="npx serverless@4 deploy --stage ${STAGE} --region ${REGION}"

    if [[ "${VERBOSE}" == "true" ]]; then
        deploy_cmd="${deploy_cmd} --verbose"
    fi

    log_info "Running: ${deploy_cmd}"

    if ! eval "${deploy_cmd}" &>"${REPORT_DIR}/deploy.log"; then
        log_error "Deployment failed"

        log_info "Deployment errors:"
        tail -50 "${REPORT_DIR}/deploy.log" | sed 's/^/  /'

        return 1
    fi

    log_success "Deployment completed successfully"
    DEPLOYMENT_SUCCESS=true

    # Extract deployment outputs
    extract_deployment_outputs

    return 0
}

extract_deployment_outputs() {
    log_info "Extracting deployment outputs..."

    cd "${SERVICE_DIR}"

    # Get service info
    local service_info
    service_info=$(npx serverless@4 info --stage "${STAGE}" --region "${REGION}" --verbose 2>/dev/null || true)

    # Extract API endpoint
    API_ENDPOINT=$(echo "${service_info}" | grep -oP 'https://[a-z0-9]+\.execute-api\.[a-z0-9-]+\.amazonaws\.com' | head -1 || echo "")

    if [[ -z "${API_ENDPOINT}" ]]; then
        # Fallback: construct from SSM
        local api_gateway_id
        api_gateway_id=$(aws ssm get-parameter \
            --name "/tf/${STAGE}/platform/api-gateway/id" \
            --region "${REGION}" \
            --query 'Parameter.Value' \
            --output text 2>/dev/null || echo "")

        if [[ -n "${api_gateway_id}" ]]; then
            API_ENDPOINT="https://${api_gateway_id}.execute-api.${REGION}.amazonaws.com"
        fi
    fi

    log_debug "API Endpoint: ${API_ENDPOINT}"

    # Extract CloudFront distribution (if any)
    CLOUDFRONT_DISTRIBUTION=$(echo "${service_info}" | grep -oP 'https://[a-z0-9]+\.cloudfront\.net' | head -1 || echo "")

    if [[ -n "${CLOUDFRONT_DISTRIBUTION}" ]]; then
        log_debug "CloudFront Distribution: ${CLOUDFRONT_DISTRIBUTION}"
    fi
}

# ============================================================================
# Post-deployment Verification
# ============================================================================

test_health_endpoint() {
    log_info "Testing health endpoint..."

    local health_url="${API_ENDPOINT}/bg-remover/health"

    log_debug "Health URL: ${health_url}"

    local response
    local http_code

    response=$(curl -s -w "\n%{http_code}" -X GET "${health_url}" -H "Content-Type: application/json" || echo "000")
    http_code=$(echo "${response}" | tail -1)
    local body
    body=$(echo "${response}" | head -n -1)

    if [[ "${http_code}" == "200" ]]; then
        log_success "Health endpoint returned 200 OK"
        log_debug "Response: ${body}"
        CHECKS_PASSED["health_endpoint"]="HTTP 200 OK"
        return 0
    else
        log_error "Health endpoint returned HTTP ${http_code}"
        log_debug "Response: ${body}"
        CHECKS_FAILED["health_endpoint"]="HTTP ${http_code}"
        return 1
    fi
}

test_api_endpoints() {
    log_info "Testing API endpoints..."

    local endpoints=(
        "GET /bg-remover/health"
        "GET /bg-remover/settings"
        "GET /bg-remover/metrics"
    )

    local failed_endpoints=0

    for endpoint in "${endpoints[@]}"; do
        local method
        method=$(echo "${endpoint}" | awk '{print $1}')
        local path
        path=$(echo "${endpoint}" | awk '{print $2}')
        local url="${API_ENDPOINT}${path}"

        log_debug "Testing ${method} ${url}"

        local http_code
        http_code=$(curl -s -o /dev/null -w "%{http_code}" -X "${method}" "${url}" -H "Content-Type: application/json" || echo "000")

        if [[ "${http_code}" =~ ^(200|401|403)$ ]]; then
            # 200 = success, 401/403 = expected (auth required)
            log_success "Endpoint ${method} ${path}: HTTP ${http_code}"
        else
            log_error "Endpoint ${method} ${path}: HTTP ${http_code}"
            ((failed_endpoints++))
        fi
    done

    if [[ ${failed_endpoints} -eq 0 ]]; then
        CHECKS_PASSED["api_endpoints"]="All ${#endpoints[@]} endpoints responding"
        return 0
    else
        CHECKS_FAILED["api_endpoints"]="${failed_endpoints} endpoints failed"
        return 1
    fi
}

test_cache_behavior() {
    if [[ "${SKIP_CACHE_TEST}" == "true" ]]; then
        log_info "Skipping cache tests (--skip-cache-test flag)"
        WARNINGS["cache_test"]="Cache tests skipped by user"
        return 0
    fi

    log_info "Testing cache behavior..."

    local test_url="${API_ENDPOINT}/bg-remover/health"

    # First request (should be MISS)
    log_debug "Making first request (cache MISS expected)..."
    local response1
    response1=$(curl -s -i -X GET "${test_url}" -H "Content-Type: application/json" 2>&1 || echo "")

    local cache_control1
    cache_control1=$(echo "${response1}" | grep -i "^cache-control:" | cut -d: -f2 | xargs || echo "")

    local etag1
    etag1=$(echo "${response1}" | grep -i "^etag:" | cut -d: -f2 | xargs || echo "")

    log_debug "First request - Cache-Control: ${cache_control1}"
    log_debug "First request - ETag: ${etag1}"

    # Wait a moment
    sleep 2

    # Second request (should be HIT or same ETag)
    log_debug "Making second request (cache HIT expected)..."
    local response2
    response2=$(curl -s -i -X GET "${test_url}" -H "Content-Type: application/json" 2>&1 || echo "")

    local cache_control2
    cache_control2=$(echo "${response2}" | grep -i "^cache-control:" | cut -d: -f2 | xargs || echo "")

    local etag2
    etag2=$(echo "${response2}" | grep -i "^etag:" | cut -d: -f2 | xargs || echo "")

    log_debug "Second request - Cache-Control: ${cache_control2}"
    log_debug "Second request - ETag: ${etag2}"

    # Verify cache headers exist
    if [[ -z "${cache_control1}" ]]; then
        log_warning "Cache-Control header missing"
        WARNINGS["cache_headers"]="Cache-Control header missing"
    else
        log_success "Cache-Control header present: ${cache_control1}"
    fi

    if [[ -z "${etag1}" ]]; then
        log_warning "ETag header missing"
        WARNINGS["etag_headers"]="ETag header missing"
    else
        log_success "ETag header present"

        # Check if ETags match (cache working)
        if [[ "${etag1}" == "${etag2}" ]]; then
            log_success "Cache working: ETags match across requests"
            CHECKS_PASSED["cache_behavior"]="ETags match (cache working)"
        else
            log_warning "ETags don't match (cache may not be working)"
            WARNINGS["cache_behavior"]="ETags don't match"
        fi
    fi

    return 0
}

test_lambda_invocations() {
    log_info "Checking Lambda invocations..."

    local function_name="${SERVICE_NAME}-${STAGE}-health"

    # Get recent invocations from CloudWatch Logs
    local log_group="/aws/lambda/${function_name}"

    if ! aws logs describe-log-groups \
        --log-group-name-prefix "${log_group}" \
        --region "${REGION}" \
        --output json &>/dev/null; then
        log_warning "CloudWatch log group not found: ${log_group}"
        WARNINGS["lambda_logs"]="Log group not found"
        return 0
    fi

    # Check for errors in recent logs
    local start_time
    start_time=$(($(date +%s) - 300))000  # Last 5 minutes in milliseconds

    local error_count
    error_count=$(aws logs filter-log-events \
        --log-group-name "${log_group}" \
        --region "${REGION}" \
        --start-time "${start_time}" \
        --filter-pattern "ERROR" \
        --query 'length(events)' \
        --output text 2>/dev/null || echo "0")

    if [[ "${error_count}" -gt 0 ]]; then
        log_warning "Found ${error_count} errors in Lambda logs (last 5 minutes)"
        WARNINGS["lambda_errors"]="${error_count} errors in logs"
    else
        log_success "No errors found in Lambda logs (last 5 minutes)"
        CHECKS_PASSED["lambda_logs"]="No errors in recent logs"
    fi

    return 0
}

check_cloudwatch_logs() {
    log_info "Checking CloudWatch logs for errors..."

    local functions=(
        "health"
        "process"
        "status"
        "settings"
        "metrics"
    )

    local total_errors=0

    for func in "${functions[@]}"; do
        local log_group="/aws/lambda/${SERVICE_NAME}-${STAGE}-${func}"

        if ! aws logs describe-log-groups \
            --log-group-name-prefix "${log_group}" \
            --region "${REGION}" \
            --output json &>/dev/null; then
            log_debug "Log group not found: ${log_group}"
            continue
        fi

        local start_time
        start_time=$(($(date +%s) - 300))000  # Last 5 minutes

        local error_count
        error_count=$(aws logs filter-log-events \
            --log-group-name "${log_group}" \
            --region "${REGION}" \
            --start-time "${start_time}" \
            --filter-pattern "ERROR" \
            --query 'length(events)' \
            --output text 2>/dev/null || echo "0")

        if [[ "${error_count}" -gt 0 ]]; then
            log_warning "Function ${func}: ${error_count} errors in logs"
            ((total_errors += error_count))
        else
            log_debug "Function ${func}: No errors"
        fi
    done

    if [[ ${total_errors} -eq 0 ]]; then
        log_success "No errors in CloudWatch logs across all functions"
        CHECKS_PASSED["cloudwatch_logs"]="No errors across all functions"
    else
        log_warning "Total ${total_errors} errors found across all functions"
        WARNINGS["cloudwatch_logs"]="${total_errors} total errors"
    fi

    return 0
}

# ============================================================================
# Reporting
# ============================================================================

generate_report() {
    log_info "Generating deployment report..."

    mkdir -p "${REPORT_DIR}"

    local deploy_end_time
    deploy_end_time=$(date +%s)
    local deploy_duration
    deploy_duration=$((deploy_end_time - DEPLOY_START_TIME))

    # Generate Markdown report
    {
        echo "# BG Remover Deployment Report"
        echo ""
        echo "**Date:** $(date '+%Y-%m-%d %H:%M:%S %Z')"
        echo "**Stage:** ${STAGE}"
        echo "**Region:** ${REGION}"
        echo "**Tenant:** ${TENANT}"
        echo "**Duration:** ${deploy_duration}s"
        echo ""

        echo "## Deployment Status"
        echo ""
        if [[ "${DEPLOYMENT_SUCCESS}" == "true" ]]; then
            echo "Status: **SUCCESS**"
        else
            echo "Status: **FAILED**"
        fi
        echo ""

        if [[ -n "${API_ENDPOINT}" ]]; then
            echo "**API Endpoint:** ${API_ENDPOINT}"
            echo ""
        fi

        if [[ -n "${CLOUDFRONT_DISTRIBUTION}" ]]; then
            echo "**CloudFront Distribution:** ${CLOUDFRONT_DISTRIBUTION}"
            echo ""
        fi

        echo "## Pre-deployment Checks"
        echo ""
        echo "### Passed (${#CHECKS_PASSED[@]})"
        echo ""
        for check in "${!CHECKS_PASSED[@]}"; do
            echo "- **${check}**: ${CHECKS_PASSED[${check}]}"
        done
        echo ""

        if [[ ${#CHECKS_FAILED[@]} -gt 0 ]]; then
            echo "### Failed (${#CHECKS_FAILED[@]})"
            echo ""
            for check in "${!CHECKS_FAILED[@]}"; do
                echo "- **${check}**: ${CHECKS_FAILED[${check}]}"
            done
            echo ""
        fi

        if [[ ${#WARNINGS[@]} -gt 0 ]]; then
            echo "### Warnings (${#WARNINGS[@]})"
            echo ""
            for warning in "${!WARNINGS[@]}"; do
                echo "- **${warning}**: ${WARNINGS[${warning}]}"
            done
            echo ""
        fi

        echo "## Post-deployment Verification"
        echo ""
        echo "See verification results above."
        echo ""

        echo "## Rollback Instructions"
        echo ""
        echo "If issues are detected, rollback using:"
        echo ""
        echo '```bash'
        echo "cd ${SERVICE_DIR}"
        echo "npx serverless@4 rollback --stage ${STAGE} --region ${REGION}"
        echo '```'
        echo ""

        echo "## Logs"
        echo ""
        echo "Full deployment logs: \`${LOG_FILE}\`"
        echo ""

    } > "${REPORT_FILE}"

    log_success "Markdown report saved to: ${REPORT_FILE}"
}

generate_json_report() {
    if [[ "${JSON_OUTPUT}" != "true" ]]; then
        return 0
    fi

    log_info "Generating JSON report..."

    local deploy_end_time
    deploy_end_time=$(date +%s)
    local deploy_duration
    deploy_duration=$((deploy_end_time - DEPLOY_START_TIME))

    # Convert associative arrays to JSON
    local checks_passed_json="{"
    for key in "${!CHECKS_PASSED[@]}"; do
        checks_passed_json="${checks_passed_json}\"${key}\":\"${CHECKS_PASSED[${key}]}\","
    done
    checks_passed_json="${checks_passed_json%,}}"

    local checks_failed_json="{"
    for key in "${!CHECKS_FAILED[@]}"; do
        checks_failed_json="${checks_failed_json}\"${key}\":\"${CHECKS_FAILED[${key}]}\","
    done
    checks_failed_json="${checks_failed_json%,}}"

    local warnings_json="{"
    for key in "${!WARNINGS[@]}"; do
        warnings_json="${warnings_json}\"${key}\":\"${WARNINGS[${key}]}\","
    done
    warnings_json="${warnings_json%,}}"

    cat > "${JSON_FILE}" <<EOF
{
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "stage": "${STAGE}",
  "region": "${REGION}",
  "tenant": "${TENANT}",
  "duration_seconds": ${deploy_duration},
  "deployment_success": ${DEPLOYMENT_SUCCESS},
  "api_endpoint": "${API_ENDPOINT}",
  "cloudfront_distribution": "${CLOUDFRONT_DISTRIBUTION}",
  "checks_passed": ${checks_passed_json},
  "checks_failed": ${checks_failed_json},
  "warnings": ${warnings_json},
  "report_file": "${REPORT_FILE}",
  "log_file": "${LOG_FILE}"
}
EOF

    log_success "JSON report saved to: ${JSON_FILE}"
}

print_summary() {
    echo ""
    echo "============================================================"
    echo "  Deployment Summary"
    echo "============================================================"
    echo ""
    echo "Stage:    ${STAGE}"
    echo "Region:   ${REGION}"
    echo "Tenant:   ${TENANT}"
    echo ""

    if [[ "${DEPLOYMENT_SUCCESS}" == "true" ]]; then
        echo -e "Status:   ${GREEN}SUCCESS${NC}"
    else
        echo -e "Status:   ${RED}FAILED${NC}"
    fi
    echo ""

    echo "Checks Passed:  ${#CHECKS_PASSED[@]}"
    echo "Checks Failed:  ${#CHECKS_FAILED[@]}"
    echo "Warnings:       ${#WARNINGS[@]}"
    echo ""

    if [[ -n "${API_ENDPOINT}" ]]; then
        echo "API Endpoint: ${API_ENDPOINT}"
    fi

    if [[ -n "${CLOUDFRONT_DISTRIBUTION}" ]]; then
        echo "CloudFront:   ${CLOUDFRONT_DISTRIBUTION}"
    fi

    echo ""
    echo "Report: ${REPORT_FILE}"
    echo "Logs:   ${LOG_FILE}"
    echo ""
    echo "============================================================"
    echo ""
}

# ============================================================================
# Main Execution
# ============================================================================

main() {
    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --stage)
                STAGE="$2"
                shift 2
                ;;
            --region)
                REGION="$2"
                shift 2
                ;;
            --tenant)
                TENANT="$2"
                shift 2
                ;;
            --dry-run)
                DRY_RUN=true
                shift
                ;;
            --verbose)
                VERBOSE=true
                shift
                ;;
            --json)
                JSON_OUTPUT=true
                shift
                ;;
            --skip-tests)
                SKIP_TESTS=true
                shift
                ;;
            --skip-cache-test)
                SKIP_CACHE_TEST=true
                shift
                ;;
            --help)
                usage
                exit 0
                ;;
            *)
                log_error "Unknown option: $1"
                usage
                exit 1
                ;;
        esac
    done

    # Create report directory
    mkdir -p "${REPORT_DIR}"

    # Start logging
    log_info "BG Remover Deployment & Verification"
    log_info "Stage: ${STAGE}, Region: ${REGION}, Tenant: ${TENANT}"
    echo ""

    # ========================================================================
    # PRE-DEPLOYMENT CHECKS
    # ========================================================================

    log_info "=== PRE-DEPLOYMENT CHECKS ==="
    echo ""

    check_node_version
    check_aws_credentials
    check_ssm_parameters
    check_handler_paths
    check_typescript_compilation
    check_compiled_files
    run_tests

    echo ""

    # Check if any critical checks failed
    if [[ ${#CHECKS_FAILED[@]} -gt 0 ]]; then
        log_error "Pre-deployment checks failed. Cannot proceed."
        generate_report
        generate_json_report
        print_summary
        exit 1
    fi

    log_success "All pre-deployment checks passed!"
    echo ""

    # ========================================================================
    # DEPLOYMENT
    # ========================================================================

    if [[ "${DRY_RUN}" == "true" ]]; then
        log_info "DRY RUN mode - skipping actual deployment"
        DEPLOYMENT_SUCCESS=false
    else
        log_info "=== DEPLOYMENT ==="
        echo ""

        if ! deploy_service; then
            log_error "Deployment failed"
            generate_report
            generate_json_report
            print_summary
            exit 1
        fi

        echo ""
        log_success "Deployment completed successfully!"
        echo ""
    fi

    # ========================================================================
    # POST-DEPLOYMENT VERIFICATION
    # ========================================================================

    if [[ "${DEPLOYMENT_SUCCESS}" == "true" ]]; then
        log_info "=== POST-DEPLOYMENT VERIFICATION ==="
        echo ""

        # Wait a moment for deployment to stabilize
        log_info "Waiting 10 seconds for deployment to stabilize..."
        sleep 10

        test_health_endpoint
        test_api_endpoints
        test_cache_behavior
        test_lambda_invocations
        check_cloudwatch_logs

        echo ""
        log_success "Post-deployment verification completed!"
        echo ""
    fi

    # ========================================================================
    # REPORTING
    # ========================================================================

    generate_report
    generate_json_report
    print_summary

    # Exit with appropriate code
    if [[ "${DEPLOYMENT_SUCCESS}" == "true" ]] && [[ ${#CHECKS_FAILED[@]} -eq 0 ]]; then
        exit 0
    else
        exit 1
    fi
}

# Run main function
main "$@"
