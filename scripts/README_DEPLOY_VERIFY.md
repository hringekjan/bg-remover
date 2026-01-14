# BG Remover Deployment & Verification Script

Comprehensive deployment script with pre-flight checks, deployment execution, and post-deployment verification including cache testing.

## Location

```bash
/Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover/scripts/deploy-and-verify.sh
```

## Features

### Pre-deployment Checks

1. **Node.js Version** - Verify Node.js >=22.0.0
2. **AWS Credentials** - Validate AWS credentials and account access
3. **SSM Parameters** - Verify all required SSM parameters exist:
   - `/tf/{stage}/platform/api-gateway/id`
   - `/tf/{stage}/platform/cognito/user-pool-id`
   - `/tf/{stage}/platform/cognito/issuer-url`
   - `/tf/{stage}/{tenant}/services/bg-remover/cache-key-secret`
4. **Handler Paths** - Ensure handlers use `dist/` not `src/`
5. **TypeScript Compilation** - Run `npm run build:handler`
6. **Compiled Files** - Verify all compiled files exist in `dist/`
7. **Tests** - Run type-check, lint, and unit tests

### Deployment

- Deploy using Serverless Framework 4
- Capture deployment outputs (API endpoint, CloudFront distribution)
- Save deployment metadata

### Post-deployment Verification

1. **Health Endpoint** - Test `/bg-remover/health` returns 200 OK
2. **API Endpoints** - Test all endpoints respond correctly:
   - `GET /bg-remover/health`
   - `GET /bg-remover/settings`
   - `GET /bg-remover/metrics`
3. **Cache Behavior** - Test cache headers and cache hit behavior:
   - Verify `Cache-Control` headers present
   - Verify `ETag` headers present
   - Make 2 identical requests, verify ETags match
4. **Lambda Invocations** - Check CloudWatch logs for errors
5. **CloudWatch Logs** - Scan all function logs for errors (last 5 minutes)

### Reporting

- Generate Markdown report with timestamps
- Generate JSON report (with `--json` flag)
- Include cache hit rate metrics
- List warnings and errors
- Provide rollback instructions

## Usage

### Basic Usage

```bash
# Deploy to dev
cd /Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover
./scripts/deploy-and-verify.sh

# Deploy to prod
./scripts/deploy-and-verify.sh --stage prod --tenant carousel-labs

# Dry run (checks only, no deployment)
./scripts/deploy-and-verify.sh --stage dev --dry-run
```

### Advanced Usage

```bash
# Deploy with verbose output and JSON report
./scripts/deploy-and-verify.sh --stage dev --verbose --json

# Skip tests (faster deployment)
./scripts/deploy-and-verify.sh --stage dev --skip-tests

# Skip cache verification
./scripts/deploy-and-verify.sh --stage dev --skip-cache-test

# Custom region
./scripts/deploy-and-verify.sh --stage dev --region us-east-1
```

## Options

| Option | Description | Default |
|--------|-------------|---------|
| `--stage <dev\|prod>` | Deployment stage | `dev` |
| `--region <region>` | AWS region | `eu-west-1` |
| `--tenant <tenant>` | Tenant identifier | `carousel-labs` |
| `--dry-run` | Run checks but skip deployment | `false` |
| `--verbose` | Enable verbose output | `false` |
| `--json` | Generate JSON report | `false` |
| `--skip-tests` | Skip pre-deployment tests | `false` |
| `--skip-cache-test` | Skip cache verification | `false` |
| `--help` | Show help message | - |

## Output Files

All output files are saved to `.serverless/reports/`:

- **Markdown Report**: `deployment_{timestamp}.md`
- **JSON Report**: `deployment_{timestamp}.json` (with `--json` flag)
- **Log File**: `deployment_{timestamp}.log`
- **Build Logs**: `typescript_build.log`, `type_check.log`, `lint.log`, `test.log`
- **Deployment Log**: `deploy.log`

## Exit Codes

- `0` - Deployment successful, all checks passed
- `1` - Deployment failed or critical checks failed

## Examples

### Example 1: Standard Deployment

```bash
./scripts/deploy-and-verify.sh --stage dev --tenant carousel-labs
```

**Output:**
```
[INFO] BG Remover Deployment & Verification
[INFO] Stage: dev, Region: eu-west-1, Tenant: carousel-labs

=== PRE-DEPLOYMENT CHECKS ===

[INFO] Checking Node.js version...
[SUCCESS] Node.js version 22.11.0 meets requirements (>=22.0.0)

[INFO] Checking AWS credentials...
[SUCCESS] AWS credentials valid: arn:aws:iam::123456789012:user/deploy (Account: 123456789012)

[INFO] Checking required SSM parameters...
[SUCCESS] SSM parameter exists: /tf/dev/platform/api-gateway/id
[SUCCESS] SSM parameter exists: /tf/dev/platform/cognito/user-pool-id
[SUCCESS] All 4 parameters exist

[INFO] Checking handler paths (dist/ not src/)...
[SUCCESS] All handler paths use dist/ (correct)

[INFO] Running TypeScript compilation...
[SUCCESS] TypeScript compilation successful

[INFO] Verifying compiled files exist in dist/...
[SUCCESS] All 7 required compiled files exist

[SUCCESS] All pre-deployment checks passed!

=== DEPLOYMENT ===

[INFO] Deploying BG Remover service...
[SUCCESS] Deployment completed successfully

=== POST-DEPLOYMENT VERIFICATION ===

[INFO] Testing health endpoint...
[SUCCESS] Health endpoint returned 200 OK

[INFO] Testing API endpoints...
[SUCCESS] Endpoint GET /bg-remover/health: HTTP 200
[SUCCESS] Endpoint GET /bg-remover/settings: HTTP 401
[SUCCESS] Endpoint GET /bg-remover/metrics: HTTP 200

[INFO] Testing cache behavior...
[SUCCESS] Cache-Control header present: max-age=300
[SUCCESS] ETag header present
[SUCCESS] Cache working: ETags match across requests

[INFO] Checking CloudWatch logs for errors...
[SUCCESS] No errors in CloudWatch logs across all functions

[SUCCESS] Post-deployment verification completed!

============================================================
  Deployment Summary
============================================================

Stage:    dev
Region:   eu-west-1
Tenant:   carousel-labs

Status:   SUCCESS

Checks Passed:  10
Checks Failed:  0
Warnings:       0

API Endpoint: https://6b3bf1bqk3.execute-api.eu-west-1.amazonaws.com

Report: .serverless/reports/deployment_20260102_150530.md
Logs:   .serverless/reports/deployment_20260102_150530.log

============================================================
```

### Example 2: Dry Run

```bash
./scripts/deploy-and-verify.sh --stage prod --dry-run
```

**Output:**
```
[INFO] BG Remover Deployment & Verification
[INFO] Stage: prod, Region: eu-west-1, Tenant: carousel-labs

=== PRE-DEPLOYMENT CHECKS ===

[INFO] Checking Node.js version...
[SUCCESS] Node.js version 22.11.0 meets requirements (>=22.0.0)

[INFO] Checking AWS credentials...
[SUCCESS] AWS credentials valid

[INFO] DRY RUN mode - skipping actual deployment

============================================================
  Deployment Summary
============================================================

Stage:    prod
Region:   eu-west-1
Tenant:   carousel-labs

Status:   FAILED

Checks Passed:  6
Checks Failed:  0
Warnings:       0

Report: .serverless/reports/deployment_20260102_150645.md

============================================================
```

### Example 3: JSON Output

```bash
./scripts/deploy-and-verify.sh --stage dev --json
```

**JSON Report** (`deployment_20260102_150530.json`):
```json
{
  "timestamp": "2026-01-02T15:05:30Z",
  "stage": "dev",
  "region": "eu-west-1",
  "tenant": "carousel-labs",
  "duration_seconds": 120,
  "deployment_success": true,
  "api_endpoint": "https://6b3bf1bqk3.execute-api.eu-west-1.amazonaws.com",
  "cloudfront_distribution": "",
  "checks_passed": {
    "node_version": "Node.js 22.11.0",
    "aws_credentials": "Account 123456789012",
    "ssm_parameters": "All 4 parameters exist",
    "handler_paths": "All handlers use dist/",
    "typescript": "Compilation successful",
    "compiled_files": "All 7 files exist",
    "tests": "Pre-deployment tests completed",
    "health_endpoint": "HTTP 200 OK",
    "api_endpoints": "All 3 endpoints responding",
    "cache_behavior": "ETags match (cache working)",
    "lambda_logs": "No errors in recent logs",
    "cloudwatch_logs": "No errors across all functions"
  },
  "checks_failed": {},
  "warnings": {},
  "report_file": ".serverless/reports/deployment_20260102_150530.md",
  "log_file": ".serverless/reports/deployment_20260102_150530.log"
}
```

## Report Format

### Markdown Report

```markdown
# BG Remover Deployment Report

**Date:** 2026-01-02 15:05:30 GMT
**Stage:** dev
**Region:** eu-west-1
**Tenant:** carousel-labs
**Duration:** 120s

## Deployment Status

Status: **SUCCESS**

**API Endpoint:** https://6b3bf1bqk3.execute-api.eu-west-1.amazonaws.com

## Pre-deployment Checks

### Passed (10)

- **node_version**: Node.js 22.11.0
- **aws_credentials**: Account 123456789012
- **ssm_parameters**: All 4 parameters exist
- **handler_paths**: All handlers use dist/
- **typescript**: Compilation successful
- **compiled_files**: All 7 files exist
- **tests**: Pre-deployment tests completed
- **health_endpoint**: HTTP 200 OK
- **api_endpoints**: All 3 endpoints responding
- **cache_behavior**: ETags match (cache working)

### Warnings (0)

## Post-deployment Verification

See verification results above.

## Rollback Instructions

If issues are detected, rollback using:

\`\`\`bash
cd /Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover
npx serverless@4 rollback --stage dev --region eu-west-1
\`\`\`

## Logs

Full deployment logs: `.serverless/reports/deployment_20260102_150530.log`
```

## Cache Testing Details

The script tests cache behavior by:

1. Making a first request to `/bg-remover/health`
2. Extracting `Cache-Control` and `ETag` headers
3. Waiting 2 seconds
4. Making a second identical request
5. Comparing ETags between requests
6. Verifying cache headers are present

**Expected Behavior:**
- Both requests should return `Cache-Control: max-age=300`
- Both requests should have the same `ETag` value
- This confirms CloudFront caching is working correctly

## Troubleshooting

### Pre-deployment Checks Failed

**Node.js version too old:**
```bash
[ERROR] Node.js version 18.0.0 is too old. Required: >=22.0.0
```

**Solution:** Upgrade Node.js to version 22 or higher.

**Missing SSM parameters:**
```bash
[ERROR] SSM parameter missing: /tf/dev/platform/api-gateway/id
```

**Solution:** Create missing SSM parameters before deployment.

**Handler paths incorrect:**
```bash
[ERROR] Found src/ handler paths in serverless.yml (should be dist/)
```

**Solution:** Update `serverless.yml` to use `dist/` paths, run `npm run build:handler`.

### Deployment Failed

**CloudFormation errors:**
```bash
[ERROR] Deployment failed
```

**Solution:** Check `.serverless/reports/deploy.log` for detailed CloudFormation errors.

### Post-deployment Verification Failed

**Health endpoint returns 500:**
```bash
[ERROR] Health endpoint returned HTTP 500
```

**Solution:** Check Lambda logs for runtime errors:
```bash
aws logs tail /aws/lambda/bg-remover-dev-health --follow
```

**Cache headers missing:**
```bash
[WARNING] Cache-Control header missing
```

**Solution:** Verify CloudFront cache policy is configured correctly in `serverless.yml`.

## Integration with CI/CD

### GitHub Actions Example

```yaml
name: Deploy BG Remover

on:
  push:
    branches:
      - develop
      - main

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - uses: actions/setup-node@v3
        with:
          node-version: '22'

      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@v2
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: eu-west-1

      - name: Deploy and Verify
        run: |
          cd services/bg-remover
          ./scripts/deploy-and-verify.sh \
            --stage ${{ github.ref == 'refs/heads/main' && 'prod' || 'dev' }} \
            --tenant carousel-labs \
            --json

      - name: Upload Reports
        if: always()
        uses: actions/upload-artifact@v3
        with:
          name: deployment-reports
          path: services/bg-remover/.serverless/reports/
```

## Best Practices

1. **Always run dry-run first** for production deployments
2. **Review logs** after deployment for warnings
3. **Test cache behavior** after CloudFront changes
4. **Monitor CloudWatch logs** for errors after deployment
5. **Keep reports** for audit trail and debugging

## Rollback Procedure

If deployment verification fails:

1. Check the deployment report for specific failures
2. Review CloudWatch logs for error details
3. Rollback to previous version:

```bash
cd /Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover
npx serverless@4 rollback --stage dev --region eu-west-1
```

4. Fix issues locally and re-deploy:

```bash
./scripts/deploy-and-verify.sh --stage dev
```

## Support

For issues or questions:
- Check `.serverless/reports/` for detailed logs
- Review CloudWatch logs for Lambda errors
- Contact DevOps team for SSM parameter issues
