# Security Issue #3: Admin Keys - Quick Reference

**Status:** CRITICAL - REQUIRES IMMEDIATE ACTION
**CVSS Score:** 9.1/10
**Priority:** P0 (Address within 24 hours)

---

## The Problem (60 seconds)

Admin API keys are stored in **plaintext environment variables**, making them visible to:
- Anyone with AWS Lambda Console access
- CloudFormation stack history
- Serverless deployment logs
- Potentially CloudWatch error logs

**Impact:** Complete authentication bypass, unlimited free API usage

---

## Critical Gap

The service has a **key rotation mechanism** that writes to SSM Parameter Store, but the **process handler reads from environment variables**. These are NOT connected!

```typescript
// rotate-keys-handler.ts writes to SSM:
/tf/${stage}/${tenant}/api-keys/carousel  ✅

// app/api/process/route.ts reads from env:
process.env.ADMIN_API_KEYS  ❌

// Result: Keys NEVER rotated in practice!
```

---

## Immediate Fix (4 hours)

### 1. Update Process Handler
```typescript
// Replace this:
const ADMIN_API_KEYS = (process.env.ADMIN_API_KEYS || '').split(',').filter(Boolean);

// With this:
async function getAdminKeys(tenant: string, stage: string): Promise<string[]> {
  const cached = keyCache.get(`${tenant}:${stage}`);
  if (cached && cached.expires > Date.now()) {
    return cached.keys;
  }

  const ssmPath = `/tf/${stage}/${tenant}/api-keys/carousel`;
  const response = await ssmClient.send(new GetParameterCommand({
    Name: ssmPath,
    WithDecryption: true,
  }));

  const parsed = JSON.parse(response.Parameter!.Value!);
  const keys = [parsed.current, parsed.previous].filter(Boolean);

  keyCache.set(`${tenant}:${stage}`, {
    keys,
    expires: Date.now() + 300000, // 5-minute cache
  });

  return keys;
}
```

### 2. Update IAM Permissions
```yaml
# serverless.yml
- Effect: Allow
  Action:
    - ssm:GetParameter
  Resource:
    - "arn:aws:ssm:${aws:region}:${aws:accountId}:parameter/tf/${self:provider.stage}/*/api-keys/carousel"
```

### 3. Remove Environment Variable
```yaml
# serverless.yml - DELETE this line:
# ADMIN_API_KEYS: ${env:ADMIN_API_KEYS}
```

### 4. Deploy
```bash
TENANT=carousel-labs npx serverless@4 deploy --stage dev --region eu-west-1
```

---

## Verification (5 minutes)

```bash
# 1. Verify env var removed
aws lambda get-function-configuration \
  --function-name bg-remover-dev-process \
  --region eu-west-1 | jq '.Environment.Variables | has("ADMIN_API_KEYS")'
# Expected: false ✅

# 2. Test admin key works
curl -X POST https://api.dev.carousellabs.co/bg-remover/process \
  -H "x-api-key: $(aws ssm get-parameter --name /tf/dev/carousel-labs/api-keys/carousel --with-decryption --query 'Parameter.Value' --output text | jq -r '.current')" \
  -H "Content-Type: application/json" \
  -d '{"imageUrl":"https://example.com/test.jpg"}'
# Expected: 200 OK ✅
```

---

## Exposure Vectors

| Vector | Severity | Mitigation |
|--------|----------|------------|
| Lambda Console | CRITICAL | Migrate to SSM |
| CloudFormation | MEDIUM | Migrate to SSM |
| Deployment Logs | HIGH | Migrate to SSM + scrub logs |
| CloudWatch Logs | HIGH | Never log keys |
| Git History | VERIFIED CLEAN | N/A |

---

## Files to Modify

1. `/services/bg-remover/app/api/process/route.ts` - Lines 29, 60-71, 111-130
2. `/services/bg-remover/serverless.yml` - Add IAM permission, remove env var
3. Create: `/services/bg-remover/src/lib/admin-key-loader.ts` (new file)

---

## Cost Impact

- SSM API calls: $0.05 per 10,000 requests
- With 5-minute cache: ~2,880 calls/day
- Monthly cost: $0.42
- **ACCEPTABLE** for critical security fix

---

## Performance Impact

- Cold start: +50ms (one-time SSM call)
- Warm requests: <1ms (cache hit)
- **NEGLIGIBLE** impact on user experience

---

## Rollback Plan

```bash
# If SSM integration fails:
git revert HEAD
TENANT=carousel-labs npx serverless@4 deploy --stage dev --region eu-west-1
```

---

## Next Steps After Fix

1. **Add audit logging** (P1 - 1 week)
   - Log all admin key usage
   - CloudWatch alarms for abnormal usage

2. **Implement key expiry** (P1 - 1 week)
   - Enforce 24-hour grace period
   - Auto-cleanup of expired keys

3. **Migrate to IAM roles** (P2 - 1 month)
   - Eliminate static keys entirely
   - Use temporary IAM credentials

---

## References

- Full Review: `SECURITY_ISSUE_3_HARDCODED_ADMIN_KEYS_REVIEW.md`
- Implementation Code: Lines referenced above
- Existing Rotation: `src/handlers/rotate-keys-handler.ts` (not connected!)
- SSM Parameter: `/tf/${stage}/${tenant}/api-keys/carousel`

---

**Action Required:** Deploy immediate fix within 24 hours
**Owner:** Worker Agent #4 (RBAC & Security Specialist)
**Reviewer:** Reviewer Agent #2 (Security & RBAC Reviewer)
