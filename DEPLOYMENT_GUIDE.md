# JWT Security Fix - Deployment Guide

## Prerequisites

Ensure the CACHE_KEY_SECRET parameter exists in SSM Parameter Store for your target stage and tenant.

### Check Parameter Exists
```bash
# Development deployment
aws ssm get-parameter \
  --name /tf/dev/carousel-labs/services/bg-remover/cache-key-secret \
  --region eu-west-1 \
  --with-decryption

# Production deployment
aws ssm get-parameter \
  --name /tf/prod/carousel-labs/services/bg-remover/cache-key-secret \
  --region eu-west-1 \
  --with-decryption
```

### Create Parameter if Missing
```bash
# Generate a secure random secret (32+ characters)
CACHE_KEY_SECRET=$(openssl rand -hex 32)
echo "Generated secret: $CACHE_KEY_SECRET"

# Store in SSM (replace stage and tenant as needed)
aws ssm put-parameter \
  --name /tf/dev/carousel-labs/services/bg-remover/cache-key-secret \
  --value "$CACHE_KEY_SECRET" \
  --type SecureString \
  --region eu-west-1 \
  --overwrite

# Verify storage
aws ssm get-parameter \
  --name /tf/dev/carousel-labs/services/bg-remover/cache-key-secret \
  --region eu-west-1 \
  --with-decryption \
  --query 'Parameter.Value' \
  --output text
```

## Testing Before Deployment

### Run Security Tests Locally
```bash
cd services/bg-remover

# Run JWT validator security tests
npm test -- src/lib/auth/jwt-validator.test.ts

# Expected output: 11/11 tests passing
```

### Verify TypeScript Compilation
```bash
npm run type-check

# jwt-validator.ts should compile without errors
```

### Full Test Suite (Optional)
```bash
npm test

# 178+ tests should pass
# Pre-existing failures in other modules are unrelated to this fix
```

## Deployment Steps

### Development Deployment
```bash
cd services/bg-remover

# Set tenant (if different from default)
export TENANT=carousel-labs

# Deploy to development
TENANT=$TENANT npx serverless@4 deploy \
  --stage dev \
  --region eu-west-1

# Expected: Function deployment successful
```

### Production Deployment
```bash
cd services/bg-remover

# Set tenant for production
export TENANT=carousel-labs

# Deploy to production
TENANT=$TENANT npx serverless@4 deploy \
  --stage prod \
  --region eu-west-1

# Expected: Function deployment successful
```

### Verification After Deployment

#### Check Function Configuration
```bash
# Verify CACHE_KEY_SECRET is configured
aws lambda get-function-configuration \
  --function-name bg-remover-dev-process \
  --region eu-west-1 \
  | jq '.Environment.Variables | keys[]'

# Should output: CACHE_KEY_SECRET (among others)
```

#### Monitor CloudWatch Logs
```bash
# Watch logs for JWT validation cache hits
aws logs tail /aws/lambda/bg-remover-dev-process \
  --region eu-west-1 \
  --follow

# Should see messages like:
# - "JWT validation cache hit" (without tokenHash)
# - "JWT validation result cached" (without tokenHash)
# - No hash values in any log messages
```

#### Test JWT Validation
```bash
# Invoke function with valid JWT
curl -X POST https://api.dev.carousellabs.co/bg-remover/health \
  -H "Authorization: Bearer <your-jwt-token>"

# Expected: 200 response
# Verify in CloudWatch: no token hash in logs
```

## Rollback Procedure

If issues occur after deployment:

### Revert Function Code
```bash
# Use previous version
aws lambda update-function-code \
  --function-name bg-remover-dev-process \
  --s3-bucket <your-deployment-bucket> \
  --s3-key <previous-version-zip>

# Or redeploy previous commit
git checkout <previous-commit>
npm run build:handler
TENANT=carousel-labs npx serverless@4 deploy --stage dev
```

### Verify Rollback
```bash
# Confirm function reverted
aws lambda get-function-configuration \
  --function-name bg-remover-dev-process \
  --query 'LastModified'
```

## Troubleshooting

### Issue: CACHE_KEY_SECRET Not Found
```
Error: Failed to parse CACHE_KEY_SECRET from SSM
```

**Solution**:
1. Verify parameter exists: `aws ssm get-parameter --name /tf/dev/carousel-labs/services/bg-remover/cache-key-secret`
2. Check stage matches (dev vs prod)
3. Check tenant name matches environment variable
4. Verify AWS credentials have SSM read permission

### Issue: JWT Validation Fails After Deployment
```
JWT validation failed error: Invalid token
```

**Possible Causes**:
1. Token using old cache key format (from different secret)
2. CACHE_KEY_SECRET changed mid-deployment
3. Token expired during deployment

**Solution**:
1. Wait for L1 (memory) cache to expire (1 minute)
2. L2 (cache-service) cache expires after 5 minutes
3. Issue fresh JWT token and retry

### Issue: Performance Degradation
```
Increased JWT validation latency after deployment
```

**Expected Behavior**:
- HMAC computation adds < 1ms overhead
- Cache hit rates should remain the same
- First request after cache expiry slightly slower

**If Persistent**:
1. Check CloudWatch metrics for cache hit/miss rates
2. Verify CACHE_KEY_SECRET SSM access not throttled
3. Monitor Lambda cold start times

## Security Checklist

Before production deployment, verify:

- [ ] CACHE_KEY_SECRET exists in SSM Parameter Store
- [ ] Parameter is SecureString type (encrypted)
- [ ] Parameter path matches serverless.yml
- [ ] npm test passes (11/11 JWT tests)
- [ ] TypeScript compiles without errors
- [ ] No hardcoded secrets in code review
- [ ] Function IAM role has SSM read permission
- [ ] CloudWatch logs show no hash values
- [ ] Load testing shows acceptable performance
- [ ] Team notified of security update

## Monitoring & Alerting

### CloudWatch Metrics to Monitor
```bash
# Cache write failures
aws cloudwatch get-metric-statistics \
  --namespace bg-remover/cache \
  --metric-name CacheWriteFailure \
  --start-time 2025-12-28T00:00:00Z \
  --end-time 2025-12-28T23:59:59Z \
  --period 300 \
  --statistics Sum

# JWT validation performance
# Check invocation counts and duration
aws cloudwatch get-metric-statistics \
  --namespace AWS/Lambda \
  --metric-name Duration \
  --dimensions Name=FunctionName,Value=bg-remover-dev-process \
  --start-time 2025-12-28T00:00:00Z \
  --end-time 2025-12-28T23:59:59Z \
  --period 60 \
  --statistics Average,Maximum
```

### Expected Behavior Post-Deployment
- Cache hit rate: > 90% (same as before)
- JWT validation latency: < 10ms (with HMAC)
- No hash values in CloudWatch logs
- No security warnings in logs
- Error rate: < 0.1% (same as before)

## Support & Escalation

If deployment issues persist:

1. Check SECURITY_FIX_VERIFICATION.md for technical details
2. Review CloudWatch logs for specific error messages
3. Verify SSM parameter configuration matches expectations
4. Contact security team if cache poisoning suspected

## References

- Security Fix Documentation: `SECURITY_FIX_VERIFICATION.md`
- JWT Validator: `src/lib/auth/jwt-validator.ts`
- Tests: `src/lib/auth/jwt-validator.test.ts`
- Configuration: `serverless.yml` (lines 47-50)
