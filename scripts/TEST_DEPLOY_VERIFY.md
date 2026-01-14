# Testing deploy-and-verify.sh

Quick verification checklist for the deployment verification script.

## Pre-Test Checklist

Before running the script, verify:

- [ ] Node.js version 22+ installed
- [ ] AWS credentials configured
- [ ] In bg-remover service directory
- [ ] Script has execute permissions

## Syntax Check

```bash
bash -n scripts/deploy-and-verify.sh
# Should return no errors
```

## Dry Run Test

Test all pre-flight checks without deploying:

```bash
cd /Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover
./scripts/deploy-and-verify.sh --dry-run --verbose
```

**Expected Output:**
- All pre-flight checks run
- No deployment executed
- Report generated in `.serverless/reports/`

## Help Test

Verify help message displays correctly:

```bash
./scripts/deploy-and-verify.sh --help
```

**Expected Output:**
- Usage instructions
- All command-line options
- Examples section

## Dev Deployment Test

Full deployment to dev environment:

```bash
./scripts/deploy-and-verify.sh --stage dev --verbose
```

**Expected Output:**
- All pre-flight checks pass
- Deployment succeeds
- All post-deployment checks pass
- Report generated

## JSON Output Test

Verify JSON report generation:

```bash
./scripts/deploy-and-verify.sh --stage dev --json
```

**Expected Output:**
- Markdown report generated
- JSON report generated
- JSON is valid (can be parsed with `jq`)

## Verify JSON Report

```bash
# Find latest JSON report
latest_json=$(ls -t .serverless/reports/deployment_*.json | head -1)

# Verify JSON is valid
jq . "$latest_json"

# Check required fields
jq '.timestamp, .stage, .region, .deployment_success' "$latest_json"
```

## Cache Test Verification

Verify cache testing works:

```bash
./scripts/deploy-and-verify.sh --stage dev --verbose 2>&1 | grep -A 5 "Testing cache behavior"
```

**Expected Output:**
```
[INFO] Testing cache behavior...
[DEBUG] Making first request (cache MISS expected)...
[DEBUG] First request - Cache-Control: max-age=300
[DEBUG] First request - ETag: "abc123"
[DEBUG] Making second request (cache HIT expected)...
[SUCCESS] Cache working: ETags match across requests
```

## Skip Tests Flag

Verify --skip-tests flag works:

```bash
./scripts/deploy-and-verify.sh --stage dev --skip-tests --verbose 2>&1 | grep "Skipping tests"
```

**Expected Output:**
```
[INFO] Skipping tests (--skip-tests flag)
```

## Skip Cache Test Flag

Verify --skip-cache-test flag works:

```bash
./scripts/deploy-and-verify.sh --stage dev --skip-cache-test --verbose 2>&1 | grep "Skipping cache"
```

**Expected Output:**
```
[INFO] Skipping cache tests (--skip-cache-test flag)
```

## Error Handling Test

Test Node.js version check failure (simulate):

```bash
# Temporarily rename node binary (not recommended)
# Better: Check the error message in the code

# Check error message exists in script
grep "Node.js version.*is too old" scripts/deploy-and-verify.sh
```

## Report Files Test

Verify all report files are created:

```bash
ls -lh .serverless/reports/deployment_*.md
ls -lh .serverless/reports/deployment_*.json
ls -lh .serverless/reports/deployment_*.log
```

## Exit Code Test

Verify script returns correct exit codes:

```bash
# Success case
./scripts/deploy-and-verify.sh --dry-run && echo "Exit code: 0 (success)"

# Check exit code
echo $?  # Should be 0 for success
```

## Color Output Test

Verify colorized output:

```bash
./scripts/deploy-and-verify.sh --dry-run --verbose | grep -E "\[SUCCESS\]|\[ERROR\]|\[WARNING\]|\[INFO\]"
```

**Expected Output:**
- Green [SUCCESS] messages
- Red [ERROR] messages
- Yellow [WARNING] messages
- Blue [INFO] messages

## Log File Test

Verify log file contains all output:

```bash
latest_log=$(ls -t .serverless/reports/deployment_*.log | head -1)
wc -l "$latest_log"
# Should have significant number of lines
```

## Test Checklist

- [ ] Syntax check passes (`bash -n`)
- [ ] Help message displays correctly
- [ ] Dry run completes without errors
- [ ] Dev deployment succeeds
- [ ] All pre-flight checks execute
- [ ] All post-deployment checks execute
- [ ] Markdown report generated
- [ ] JSON report generated (with --json)
- [ ] Log file created
- [ ] Cache testing works
- [ ] --skip-tests flag works
- [ ] --skip-cache-test flag works
- [ ] Exit code is 0 on success
- [ ] Exit code is 1 on failure
- [ ] Color output works
- [ ] Verbose output shows debug messages

## Troubleshooting Tests

### Test Missing SSM Parameter

```bash
# Check SSM parameter exists
aws ssm get-parameter \
  --name "/tf/dev/platform/api-gateway/id" \
  --region eu-west-1

# Script should detect if missing
```

### Test Handler Path Check

```bash
# Check handlers use dist/ not src/
grep "handler: dist/" serverless.yml
# Should show all handler paths

# Check for incorrect src/ paths
grep "handler: src/" serverless.yml
# Should return nothing (or script will fail)
```

### Test TypeScript Compilation

```bash
# Run build manually
npm run build:handler

# Check dist/ files exist
ls -lh dist/handler.js
ls -lh dist/handlers/
```

## Performance Test

Measure script execution time:

```bash
time ./scripts/deploy-and-verify.sh --dry-run --verbose
```

**Expected Duration:**
- Dry run: ~30-60 seconds
- Full deployment: ~2-5 minutes

## Integration Test

Test with actual deployment:

```bash
# Full deployment with all checks
./scripts/deploy-and-verify.sh \
  --stage dev \
  --tenant carousel-labs \
  --verbose \
  --json

# Verify deployment succeeded
echo "Exit code: $?"

# Check reports
ls -lh .serverless/reports/deployment_*.md
cat .serverless/reports/deployment_*.md

# Check JSON report
jq . .serverless/reports/deployment_*.json
```

## Cleanup

After testing, clean up old reports:

```bash
# Keep last 5 reports
cd .serverless/reports
ls -t deployment_*.md | tail -n +6 | xargs rm -f
ls -t deployment_*.json | tail -n +6 | xargs rm -f
ls -t deployment_*.log | tail -n +6 | xargs rm -f
```

## Success Criteria

The script passes testing if:

1. All syntax checks pass
2. Dry run completes without errors
3. Full deployment succeeds
4. All pre-flight checks execute correctly
5. All post-deployment checks execute correctly
6. Reports are generated correctly (Markdown + JSON)
7. Exit codes are correct (0 = success, 1 = failure)
8. Error messages are clear and helpful
9. Color output works correctly
10. Flags (--dry-run, --skip-tests, etc.) work as expected

## Known Issues

None at this time.

## Future Improvements

1. Add parallel endpoint testing
2. Add support for custom health endpoints
3. Add support for Slack notifications
4. Add deployment metrics collection
5. Add automated rollback on failure
