# Secrets Management - Admin API Keys

## Overview

Admin API keys for the bg-remover service are stored in **AWS Systems Manager Parameter Store** as **SecureString** parameters with **KMS encryption**. This ensures zero secrets in environment variables, CloudWatch logs, or Lambda console.

## Security Architecture

### Storage
- **SSM Parameter Store**: SecureString with KMS encryption
- **Parameter Path**: `/tf/{stage}/{tenant}/services/bg-remover/admin-api-keys`
- **Encryption**: AWS KMS (alias/aws/ssm)
- **Format**: Comma-separated UUIDs (3 keys in rotation)

### Key Rotation
- **Rotation Schedule**: 30 days
- **Active Keys**: 3 keys at all times (zero-downtime rotation)
- **Grace Period**: Old keys remain valid until next rotation
- **Automated Rotation**: EventBridge scheduled rule triggers Lambda

### Caching
- **Cache Location**: Lambda memory (singleton map)
- **Cache TTL**: 5 minutes (configurable via `CONFIG_CACHE_TTL`)
- **Cache Key**: SSM parameter path
- **Cache Strategy**: In-memory with expiration

### Access Control
- **IAM Policy**: Lambda execution role has SSM GetParameter permission
- **KMS Policy**: Lambda execution role has KMS Decrypt permission
- **Resource ARN**: Scoped to specific parameter path only

## API Usage

### Loading Keys (Backend)

```typescript
import { loadAdminApiKeys } from '@carousellabs/backend-kit/secrets-loader';

// Load keys from SSM (cached for 5 minutes)
const keys = await loadAdminApiKeys('dev', 'carousel-labs');
// ['key1-uuid', 'key2-uuid', 'key3-uuid']
```

### Validating Keys (API Route)

```typescript
import { loadAdminApiKeys } from '@carousellabs/backend-kit/secrets-loader';
import { timingSafeEqual } from 'crypto';

async function isValidAdminApiKey(apiKey: string): Promise<boolean> {
  const adminKeys = await loadAdminApiKeys(stage, tenant);

  // Timing-safe comparison (prevents timing attacks)
  let isValid = false;
  for (const adminKey of adminKeys) {
    if (timingSafeEqual(Buffer.from(apiKey), Buffer.from(adminKey))) {
      isValid = true;
      // Continue loop to maintain constant time
    }
  }
  return isValid;
}
```

## Deployment Scripts

### 1. Initial Setup (One-Time)

```bash
cd /services/bg-remover/scripts
./seed-admin-keys.sh dev carousel-labs
```

**Output:**
- Creates 3 initial keys in SSM
- Displays keys in terminal (save these!)
- Creates metadata parameter
- Keys are immediately available to Lambda

### 2. Key Rotation (Every 30 Days)

```bash
cd /services/bg-remover/scripts
./rotate-admin-keys.sh dev carousel-labs
```

**Output:**
- Generates new key
- Adds to beginning of key list
- Removes oldest key (keeps 3 total)
- Updates metadata with rotation timestamp
- Lambda picks up new keys within 5 minutes

### 3. Testing Authentication

```bash
cd /services/bg-remover/scripts

# Test with valid key
./test-admin-keys.sh dev <your-api-key>

# Test without key (should fail)
./test-admin-keys.sh dev
```

## IAM Permissions

### Lambda Execution Role

```yaml
- Effect: Allow
  Action:
    - ssm:GetParameter
    - ssm:GetParameters
  Resource:
    - "arn:aws:ssm:${region}:${account}:parameter/tf/${stage}/*/services/bg-remover/admin-api-keys"

- Effect: Allow
  Action:
    - kms:Decrypt
  Resource:
    - "arn:aws:kms:${region}:${account}:alias/aws/ssm"
```

### Rotation Lambda Role (Future)

```yaml
- Effect: Allow
  Action:
    - ssm:PutParameter
    - ssm:GetParameter
  Resource:
    - "arn:aws:ssm:${region}:${account}:parameter/tf/${stage}/*/services/bg-remover/admin-api-keys"
    - "arn:aws:ssm:${region}:${account}:parameter/tf/${stage}/*/services/bg-remover/admin-api-keys-metadata"
```

## SSM Parameter Structure

### Admin API Keys (SecureString)

**Path:** `/tf/dev/carousel-labs/services/bg-remover/admin-api-keys`

**Value:** (encrypted)
```
a1b2c3d4-e5f6-7890-abcd-ef1234567890,b2c3d4e5-f6a7-8901-bcde-f2345678901a,c3d4e5f6-a7b8-9012-cdef-3456789012bc
```

**Type:** SecureString
**KMS Key:** alias/aws/ssm
**Tags:**
- Service: bg-remover
- Environment: dev
- Tenant: carousel-labs

### Key Metadata (String)

**Path:** `/tf/dev/carousel-labs/services/bg-remover/admin-api-keys-metadata`

**Value:**
```json
{
  "keys": [
    {
      "id": "key1",
      "createdAt": "2026-01-02T12:00:00Z",
      "status": "active",
      "keyPrefix": "a1b2c3d4"
    },
    {
      "id": "key2",
      "createdAt": "2025-12-03T12:00:00Z",
      "status": "active",
      "keyPrefix": "b2c3d4e5"
    },
    {
      "id": "key3",
      "createdAt": "2025-11-03T12:00:00Z",
      "status": "active",
      "keyPrefix": "c3d4e5f6"
    }
  ],
  "rotationSchedule": "30d",
  "lastRotation": "2026-01-02T12:00:00Z",
  "createdAt": "2025-10-03T12:00:00Z"
}
```

## Security Best Practices

### ✅ DO

- Store keys in SSM SecureString with KMS encryption
- Use timing-safe comparison for key validation
- Cache decrypted keys in memory (short TTL)
- Rotate keys every 30 days
- Log key validation attempts (without exposing keys)
- Maintain 3 keys in rotation for zero-downtime

### ❌ DON'T

- Store keys in environment variables
- Log keys in CloudWatch
- Hardcode keys in code
- Share keys in Slack/email
- Store keys in git
- Use single key (no rotation)

## Monitoring

### CloudWatch Metrics

- **Metric:** `bg-remover/auth/InvalidApiKey`
- **Namespace:** CarouselLabs/Security
- **Dimensions:** `{ tenant, stage }`
- **Alarm Threshold:** > 10 invalid attempts in 5 minutes

### CloudWatch Logs

```json
{
  "event": "admin_api_key_validation",
  "result": "success",
  "keyPrefix": "a1b2c3d4",
  "tenant": "carousel-labs",
  "timestamp": "2026-01-02T12:00:00Z"
}
```

**Note:** Never log full keys, only first 8 characters.

## Troubleshooting

### Issue: Lambda can't load keys

**Symptoms:**
- 500 errors from API
- CloudWatch logs show "SSM parameter not found"

**Solution:**
```bash
# Verify parameter exists
aws ssm get-parameter \
  --name "/tf/dev/carousel-labs/services/bg-remover/admin-api-keys" \
  --region eu-west-1

# If missing, seed initial keys
./scripts/seed-admin-keys.sh dev carousel-labs
```

### Issue: Valid key rejected

**Symptoms:**
- 401 errors with valid key
- CloudWatch logs show "Invalid API key"

**Solution:**
```bash
# Clear Lambda cache by forcing redeployment
cd services/bg-remover
TENANT=carousel-labs npx serverless@4 deploy --stage dev --region eu-west-1 --force

# Or wait 5 minutes for cache to expire
```

### Issue: Keys not rotating

**Symptoms:**
- Metadata shows old rotation date
- Same keys used for > 30 days

**Solution:**
```bash
# Manually trigger rotation
./scripts/rotate-admin-keys.sh dev carousel-labs

# Verify rotation
aws ssm get-parameter \
  --name "/tf/dev/carousel-labs/services/bg-remover/admin-api-keys-metadata" \
  --region eu-west-1 \
  --query 'Parameter.Value' \
  --output text | jq .
```

## Cost Estimation

### SSM Parameter Store
- **Free Tier:** 10,000 API calls/month
- **SecureString Storage:** $0.05 per parameter/month
- **Estimated Cost:** ~$0.10/month (2 parameters)

### KMS
- **Free Tier:** 20,000 requests/month
- **Per Request:** $0.03 per 10,000 requests
- **Estimated Cost:** ~$0.00/month (well within free tier)

### Total Monthly Cost
- **SSM + KMS:** ~$0.10/month
- **CloudWatch Logs:** ~$0.50/month (5GB ingestion)
- **Total:** ~$0.60/month

## Migration Checklist

- [x] Create `secrets-loader.ts` in `@carousellabs/backend-kit`
- [x] Update `process/route.ts` to use SSM keys
- [x] Update `serverless.yml` with SSM/KMS permissions
- [x] Create `seed-admin-keys.sh` script
- [x] Create `rotate-admin-keys.sh` script
- [x] Create `test-admin-keys.sh` script
- [ ] Run `seed-admin-keys.sh` to create initial keys
- [ ] Deploy service with updated code
- [ ] Test API with valid/invalid keys
- [ ] Schedule 30-day rotation in EventBridge
- [ ] Remove `.env` files from git history
- [ ] Update client applications with new keys
- [ ] Archive old environment variables

## References

- [AWS SSM Parameter Store](https://docs.aws.amazon.com/systems-manager/latest/userguide/systems-manager-parameter-store.html)
- [AWS KMS Encryption](https://docs.aws.amazon.com/kms/latest/developerguide/overview.html)
- [Timing Attack Prevention](https://en.wikipedia.org/wiki/Timing_attack)
- [OWASP Key Management](https://cheatsheetseries.owasp.org/cheatsheets/Key_Management_Cheat_Sheet.html)
