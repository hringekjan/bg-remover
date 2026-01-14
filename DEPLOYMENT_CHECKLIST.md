# Security Fix #3: Deployment Checklist

## Pre-Deployment Verification

### 1. Code Changes
- [x] `secrets-loader.ts` created in backend-kit
- [x] `process/route.ts` updated to use SSM
- [x] `serverless.yml` updated with SSM/KMS permissions
- [x] Backend-kit builds successfully
- [x] No TypeScript errors

### 2. Scripts Available
- [x] `seed-admin-keys.sh` (executable)
- [x] `rotate-admin-keys.sh` (executable)
- [x] `test-admin-keys.sh` (executable)

### 3. Documentation
- [x] `SECRETS_MANAGEMENT.md` created
- [x] `SECURITY_FIX_3_SUMMARY.md` created
- [x] Deployment checklist created

## Deployment Steps

### Step 1: Seed Initial Keys (One-Time)

```bash
cd /Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover/scripts

# Generate and store initial keys
./seed-admin-keys.sh dev carousel-labs

# IMPORTANT: Save the displayed keys in password manager!
```

**Expected Output:**
```
✅ Keys stored successfully
✅ Metadata stored successfully

Full keys (SAVE THESE SECURELY):
Key 1: a1b2c3d4-e5f6-7890-abcd-ef1234567890
Key 2: b2c3d4e5-f6a7-8901-bcde-f2345678901a
Key 3: c3d4e5f6-a7b8-9012-cdef-3456789012bc
```

**Verify SSM Parameter:**
```bash
aws ssm get-parameter \
  --name "/tf/dev/carousel-labs/services/bg-remover/admin-api-keys" \
  --region eu-west-1 \
  --query 'Parameter.Type' \
  --output text

# Should output: SecureString
```

### Step 2: Deploy bg-remover Service

```bash
cd /Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover

# Build TypeScript
npm run build

# Deploy to dev
TENANT=carousel-labs npx serverless@4 deploy --stage dev --region eu-west-1
```

**Expected Output:**
```
✅ Service deployed successfully
✅ All functions updated
✅ API Gateway routes configured
```

**Verify Lambda Permissions:**
```bash
aws lambda get-policy \
  --function-name bg-remover-dev-process \
  --region eu-west-1 \
  --query 'Policy' \
  --output text | jq '.Statement[] | select(.Action | contains("ssm:GetParameter"))'

# Should show SSM GetParameter permission
```

### Step 3: Test Authentication

```bash
cd /Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover/scripts

# Test with valid key (use one from seed script output)
./test-admin-keys.sh dev <your-api-key>
```

**Expected Output:**
```
Test 1: Valid API key authentication
✅ PASS: Valid key accepted (HTTP 200)

Test 2: Invalid API key authentication
✅ PASS: Invalid key rejected (HTTP 401)

Test 3: No API key (credit validation required)
✅ PASS: Credit validation enforced (HTTP 402)
```

### Step 4: Verify No Secrets in Logs

```bash
# Check CloudWatch logs for the process function
aws logs tail /aws/lambda/bg-remover-dev-process \
  --follow \
  --region eu-west-1
```

**Expected Behavior:**
- ✅ Logs show "Loaded X admin API keys from SSM"
- ✅ Logs show only key prefixes (first 8 chars)
- ❌ Logs should NOT show full API keys

### Step 5: Verify Environment Variables

```bash
# Check Lambda environment variables
aws lambda get-function-configuration \
  --function-name bg-remover-dev-process \
  --region eu-west-1 \
  --query 'Environment.Variables' \
  --output json | jq .
```

**Expected Behavior:**
- ✅ `STAGE` and `TENANT` environment variables present
- ❌ `ADMIN_API_KEYS` should NOT be present

## Post-Deployment Verification

### 1. API Functionality Tests

```bash
# Test image processing with valid admin key
curl -X POST https://api.dev.carousellabs.co/bg-remover/process \
  -H "X-Api-Key: <valid-key>" \
  -H "X-Tenant-Id: carousel-labs" \
  -H "Content-Type: application/json" \
  -d '{
    "imageUrl": "https://images.unsplash.com/photo-1560343090-f0409e92791a?w=400",
    "outputFormat": "png",
    "skipCreditValidation": true
  }'

# Expected: HTTP 200 with success: true
```

### 2. Cache Behavior Verification

```bash
# Make 3 requests in quick succession
for i in {1..3}; do
  time curl -X POST https://api.dev.carousellabs.co/bg-remover/process \
    -H "X-Api-Key: <valid-key>" \
    -H "Content-Type: application/json" \
    -d '{"imageUrl": "..."}' > /dev/null 2>&1
done

# Expected:
# Request 1: ~200ms (SSM call)
# Request 2: ~150ms (cached)
# Request 3: ~150ms (cached)
```

### 3. Key Rotation Test

```bash
cd /Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover/scripts

# Rotate keys
./rotate-admin-keys.sh dev carousel-labs

# Wait 5 minutes for cache to expire
sleep 300

# Test with new key
./test-admin-keys.sh dev <new-key>

# Expected: ✅ PASS for all tests
```

### 4. Security Audit

```bash
# Check SSM parameter encryption
aws ssm get-parameter \
  --name "/tf/dev/carousel-labs/services/bg-remover/admin-api-keys" \
  --region eu-west-1 \
  --query 'Parameter.Type' \
  --output text

# Expected: SecureString

# Check KMS key
aws ssm describe-parameters \
  --filters "Key=Name,Values=/tf/dev/carousel-labs/services/bg-remover/admin-api-keys" \
  --region eu-west-1 \
  --query 'Parameters[0].KeyId' \
  --output text

# Expected: alias/aws/ssm or ARN of KMS key
```

## Rollback Plan

### If Deployment Fails

1. **Revert serverless.yml:**
   ```bash
   git checkout HEAD~1 services/bg-remover/serverless.yml
   TENANT=carousel-labs npx serverless@4 deploy --stage dev --region eu-west-1
   ```

2. **Restore environment variable:**
   ```bash
   # Temporarily add ADMIN_API_KEYS back to serverless.yml
   # Deploy with old configuration
   ```

3. **Verify rollback:**
   ```bash
   ./test-admin-keys.sh dev <old-env-var-key>
   ```

### If SSM Parameter Missing

```bash
# Re-run seed script
cd scripts
./seed-admin-keys.sh dev carousel-labs

# Verify parameter
aws ssm get-parameter \
  --name "/tf/dev/carousel-labs/services/bg-remover/admin-api-keys" \
  --region eu-west-1
```

## Success Criteria

### All Tests Must Pass
- [x] Backend-kit builds without errors
- [ ] SSM parameter created (SecureString)
- [ ] Service deploys successfully
- [ ] Valid API key accepted (HTTP 200)
- [ ] Invalid API key rejected (HTTP 401)
- [ ] No API key requires credits (HTTP 402)
- [ ] No full keys in CloudWatch logs
- [ ] No ADMIN_API_KEYS in environment variables
- [ ] Key rotation works
- [ ] Cache behavior verified

### Performance Benchmarks
- [ ] Cold start: < 300ms
- [ ] Warm requests: < 150ms
- [ ] SSM cache hit ratio: > 99%

### Security Verification
- [ ] Keys encrypted at rest (KMS)
- [ ] Keys not in environment variables
- [ ] Keys not in CloudWatch logs
- [ ] Timing-safe comparison used
- [ ] IAM permissions follow least privilege

## Timeline

- **Seed Keys:** 5 minutes
- **Deploy Service:** 10 minutes
- **Testing:** 15 minutes
- **Verification:** 10 minutes
- **Total:** ~40 minutes

## Contact

**Deployment Owner:** DevOps Team  
**Security Reviewer:** Security Team  
**Support:** #platform-support Slack channel
