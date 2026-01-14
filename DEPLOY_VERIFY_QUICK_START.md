# BG Remover Deploy & Verify - Quick Start

Comprehensive deployment verification script with pre-flight checks, deployment execution, and post-deployment testing.

## Quick Commands

```bash
# Standard dev deployment
cd /Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover
./scripts/deploy-and-verify.sh

# Production deployment
./scripts/deploy-and-verify.sh --stage prod --tenant carousel-labs

# Dry run (checks only)
./scripts/deploy-and-verify.sh --dry-run

# Full deployment with JSON report
./scripts/deploy-and-verify.sh --verbose --json
```

## What It Does

### 1. Pre-deployment Checks (7 checks)

- Node.js version >=22.0.0
- AWS credentials valid
- SSM parameters exist (API Gateway, Cognito, cache key secret)
- Handler paths use `dist/` not `src/`
- TypeScript compiles successfully
- All compiled files exist in `dist/`
- Tests pass (type-check, lint, unit tests)

### 2. Deployment

- Deploy using Serverless Framework 4
- Capture API endpoint and CloudFront distribution
- Save deployment metadata

### 3. Post-deployment Verification (5 checks)

- Health endpoint returns 200 OK
- All API endpoints respond correctly
- Cache headers present (`Cache-Control`, `ETag`)
- Cache behavior working (ETags match across requests)
- No errors in CloudWatch logs

### 4. Reporting

- Markdown report with timestamps
- JSON report (optional with `--json`)
- Complete deployment logs
- Rollback instructions

## Verification Tests

### Cache Testing

The script tests cache behavior by making 2 identical requests and verifying:

1. First request has `Cache-Control` header
2. First request has `ETag` header
3. Second request has same `ETag` (cache hit)

**Expected Headers:**
```
Cache-Control: max-age=300
ETag: "abc123"
```

### API Endpoint Testing

Tests these endpoints:

- `GET /bg-remover/health` - should return 200
- `GET /bg-remover/settings` - should return 200/401
- `GET /bg-remover/metrics` - should return 200

### CloudWatch Logs Testing

Scans last 5 minutes of logs for all functions:
- health
- process
- status
- settings
- metrics

## Output Files

All files saved to `.serverless/reports/deployment_{timestamp}.*`:

- `deployment_{timestamp}.md` - Markdown report
- `deployment_{timestamp}.json` - JSON report (with `--json`)
- `deployment_{timestamp}.log` - Full deployment log
- `typescript_build.log` - TypeScript compilation log
- `deploy.log` - Serverless deployment log

## Common Flags

| Flag | Description |
|------|-------------|
| `--stage dev` | Deploy to dev (default) |
| `--stage prod` | Deploy to prod |
| `--dry-run` | Checks only, no deployment |
| `--verbose` | Detailed output |
| `--json` | Generate JSON report |
| `--skip-tests` | Skip pre-deployment tests |
| `--skip-cache-test` | Skip cache verification |

## Example Output

```
[INFO] BG Remover Deployment & Verification
[INFO] Stage: dev, Region: eu-west-1, Tenant: carousel-labs

=== PRE-DEPLOYMENT CHECKS ===

[SUCCESS] Node.js version 22.11.0 meets requirements (>=22.0.0)
[SUCCESS] AWS credentials valid: Account 123456789012
[SUCCESS] All 4 SSM parameters exist
[SUCCESS] All handler paths use dist/ (correct)
[SUCCESS] TypeScript compilation successful
[SUCCESS] All 7 required compiled files exist
[SUCCESS] All pre-deployment checks passed!

=== DEPLOYMENT ===

[SUCCESS] Deployment completed successfully

=== POST-DEPLOYMENT VERIFICATION ===

[SUCCESS] Health endpoint returned 200 OK
[SUCCESS] All 3 endpoints responding
[SUCCESS] Cache-Control header present: max-age=300
[SUCCESS] ETag header present
[SUCCESS] Cache working: ETags match across requests
[SUCCESS] No errors in CloudWatch logs across all functions

============================================================
  Deployment Summary
============================================================

Stage:    dev
Status:   SUCCESS
Checks Passed:  10
Checks Failed:  0
Warnings:       0

API Endpoint: https://6b3bf1bqk3.execute-api.eu-west-1.amazonaws.com

Report: .serverless/reports/deployment_20260102_150530.md
============================================================
```

## Rollback

If deployment fails, rollback using:

```bash
cd /Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover
npx serverless@4 rollback --stage dev --region eu-west-1
```

## Troubleshooting

### Node.js Version Error

```
[ERROR] Node.js version 18.0.0 is too old. Required: >=22.0.0
```

**Fix:** Upgrade Node.js to version 22+

### Missing SSM Parameters

```
[ERROR] SSM parameter missing: /tf/dev/platform/api-gateway/id
```

**Fix:** Create missing SSM parameters before deployment

### Handler Path Errors

```
[ERROR] Found src/ handler paths in serverless.yml (should be dist/)
```

**Fix:** Update `serverless.yml` to use `dist/` paths, run `npm run build:handler`

### TypeScript Compilation Errors

```
[ERROR] TypeScript compilation failed
```

**Fix:** Check `.serverless/reports/typescript_build.log` for errors

### Health Endpoint Fails

```
[ERROR] Health endpoint returned HTTP 500
```

**Fix:** Check Lambda logs:
```bash
aws logs tail /aws/lambda/bg-remover-dev-health --follow
```

### Cache Headers Missing

```
[WARNING] Cache-Control header missing
```

**Fix:** Verify CloudFront cache policy in `serverless.yml`

## CI/CD Integration

```yaml
# GitHub Actions
- name: Deploy and Verify
  run: |
    cd services/bg-remover
    ./scripts/deploy-and-verify.sh --stage dev --json
```

## Complete Documentation

See full documentation: `scripts/README_DEPLOY_VERIFY.md`

## Exit Codes

- `0` - Success (deployment and all checks passed)
- `1` - Failure (deployment failed or critical checks failed)

## Best Practices

1. Always run `--dry-run` first for prod deployments
2. Review logs after deployment for warnings
3. Test cache behavior after CloudFront changes
4. Monitor CloudWatch logs for errors
5. Keep deployment reports for audit trail
