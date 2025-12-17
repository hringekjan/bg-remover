# BG-Remover Authentication Implementation

**Status:** 🟡 **PARTIAL** - JWT validation code created, dependency installation pending
**Security Level:** ⚠️ **OPEN** - Service currently has NO authentication
**Date:** 2025-12-09

---

## Current State

### ❌ Issues

1. **No Authentication** - bg-remover endpoints are publicly accessible
2. **Security Risk** - Anyone can call `/bg-remover/process` and consume AWS Bedrock credits
3. **No Authorization** - No tenant isolation or access control

### ✅ What's Implemented

1. **JWT Validation Module** - `src/lib/auth/jwt-validator.ts` created with:
   - Cognito JWT signature verification using JWKS
   - Token extraction from Authorization header
   - User info extraction (userId, email, groups)
   - Optional authentication (dev mode)

2. **Frontend Authentication** - `carousel-frontend` already has:
   - JWT token retrieval via `getJwtToken()`
   - Tenant-aware API headers
   - API key fallback for local development

3. **Platform Infrastructure** - Already exists:
   - Cognito User Pool: `eu-west-1_SfkX8eTc3`
   - Issuer URL: `https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_SfkX8eTc3`
   - Multiple web clients for authentication

---

## Implementation Plan

### Phase 1: Lambda-Level Authentication (IMMEDIATE)

#### Step 1: Install Dependencies

```bash
cd /Users/davideagle/git/CarouselLabs/enterprise-packages/services/bg-remover

# Login to CodeArtifact
aws-vault exec carousel-labs-dev-admin -- aws codeartifact login \
  --tool npm \
  --domain carousel-labs-artifacts \
  --domain-owner 516300428521 \
  --repository carousel-labs-dev-npm \
  --region eu-west-1

# Install jose for JWT validation
npm install jose

# Update package.json
```

**Add to `package.json`:**
```json
{
  "dependencies": {
    "jose": "^5.0.0"
  }
}
```

#### Step 2: Update Handler with JWT Validation

**Modify `src/handler.ts`:**

```typescript
import { validateJWTFromEvent } from './lib/auth/jwt-validator';

// In the process handler (around line 102)
exports.process = async (event: any) => {
  console.log('Process function called with event:', JSON.stringify(event, null, 2));

  // Handle OPTIONS
  const httpMethod = event.requestContext?.http?.method || event.httpMethod;
  if (httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Tenant-Id',
      },
      body: '',
    };
  }

  // ===== ADD JWT AUTHENTICATION HERE =====
  // Validate JWT token (optional in dev mode)
  const stage = global.process.env.STAGE || 'dev';
  const requireAuth = stage === 'prod' || global.process.env.REQUIRE_AUTH === 'true';

  const authResult = await validateJWTFromEvent(event, undefined, {
    required: requireAuth
  });

  if (!authResult.isValid && requireAuth) {
    console.warn('Authentication failed', {
      error: authResult.error,
      stage,
      path: event.requestContext?.http?.path,
    });

    return {
      statusCode: 401,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'WWW-Authenticate': 'Bearer realm="bg-remover", error="invalid_token"',
      },
      body: JSON.stringify({
        error: 'Unauthorized',
        message: 'Valid JWT token required',
        details: authResult.error,
      }),
    };
  }

  if (authResult.isValid && authResult.userId) {
    console.info('Authenticated request', {
      userId: authResult.userId,
      email: authResult.email,
      groups: authResult.groups,
    });
  } else {
    console.info('Unauthenticated request (dev mode)', {
      stage,
      path: event.requestContext?.http?.path,
    });
  }
  // ===== END JWT AUTHENTICATION =====

  // ... rest of handler code
};
```

#### Step 3: Update Environment Configuration

**Modify `serverless.yml`:**

```yaml
provider:
  environment:
    STAGE: ${self:provider.stage}
    NODE_OPTIONS: '--enable-source-maps'

    # Cognito JWT Configuration
    COGNITO_USER_POOL_ID: ${ssm:/tf/${sls:stage}/platform/cognito/user-pool-id}
    COGNITO_ISSUER_URL: ${ssm:/tf/${sls:stage}/platform/cognito/issuer-url}
    AWS_REGION: ${self:provider.region}

    # Authentication mode
    REQUIRE_AUTH: ${env:REQUIRE_AUTH, 'false'}  # Set to 'true' for production
```

#### Step 4: Deploy with Authentication

```bash
# Build handler
npm run build:handler

# Deploy to dev (auth optional)
TENANT=carousel-labs REQUIRE_AUTH=false \
  aws-vault exec carousel-labs-dev-admin -- \
  npx serverless@4 deploy --stage dev --region eu-west-1

# Deploy to prod (auth required)
TENANT=carousel-labs REQUIRE_AUTH=true \
  aws-vault exec carousel-labs-dev-admin -- \
  npx serverless@4 deploy --stage prod --region eu-west-1
```

---

### Phase 2: API Gateway-Level Authorization (RECOMMENDED)

API Gateway-level authorization provides better performance and security by rejecting unauthorized requests before they reach the Lambda.

#### Option A: JWT Authorizer (Cognito)

**Create JWT Authorizer in Shared Gateway:**

```bash
# Create JWT authorizer for Cognito
aws-vault exec carousel-labs-dev-admin -- aws apigatewayv2 create-authorizer \
  --api-id 6b3bf1bqk3 \
  --authorizer-type JWT \
  --identity-source '$request.header.Authorization' \
  --name cognito-jwt-authorizer \
  --jwt-configuration '{
    "Audience": ["44na9pkdt2qst88f89v19a024j", "4gesllg1saibu4t1l1flvtg25t"],
    "Issuer": "https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_SfkX8eTc3"
  }' \
  --region eu-west-1

# Save the authorizer ID (e.g., abc123)
aws ssm put-parameter \
  --name "/tf/dev/platform/api-gateway/cognito-authorizer-id" \
  --value "abc123" \
  --type String \
  --region eu-west-1
```

**Update `serverless.yml` to use authorizer:**

```yaml
# NOTE: Per CLAUDE.md, this should be managed centrally
# DO NOT add authorizers in individual services
# This configuration is for platform team reference only

# Platform team should configure routes with authorizer:
# POST /bg-remover/process -> cognito-jwt-authorizer
# GET  /bg-remover/status/{jobId} -> cognito-jwt-authorizer
# DELETE /bg-remover/status/{jobId} -> cognito-jwt-authorizer

# Health endpoint should remain unauthenticated:
# ANY /bg-remover/health -> no authorizer
```

#### Option B: Request Authorizer (Lambda)

If you need custom authorization logic (e.g., role-based access, tenant validation):

```bash
# Use existing webhook-authorizer or create custom authorizer
# See: /services/webhook-authorizer/serverless.yml

# Configure routes to use request authorizer
aws apigatewayv2 update-route \
  --api-id 6b3bf1bqk3 \
  --route-id <route-id> \
  --authorization-type CUSTOM \
  --authorizer-id zeixc1 \  # webhook-authorizer ID
  --region eu-west-1
```

---

## Testing Authentication

### 1. Get JWT Token from Cognito

```bash
# Login to Cognito and get JWT token
# Use carousel-frontend login flow or:

# Direct Cognito authentication
aws cognito-idp initiate-auth \
  --auth-flow USER_PASSWORD_AUTH \
  --client-id 44na9pkdt2qst88f89v19a024j \
  --auth-parameters USERNAME=user@example.com,PASSWORD=password \
  --region eu-west-1

# Extract idToken from response
```

### 2. Test Authenticated Request

```bash
# With JWT token
curl -X POST "https://6b3bf1bqk3.execute-api.eu-west-1.amazonaws.com/bg-remover/process" \
  -H "Authorization: Bearer eyJraWQ...." \
  -H "Content-Type: application/json" \
  -H "X-Tenant-Id: carousel-labs" \
  -d '{
    "imageBase64": "iVBORw0KGgoAAAANSUhEUg...",
    "outputFormat": "png",
    "quality": 95
  }'

# Expected: 200 OK with processed image
```

### 3. Test Unauthenticated Request

```bash
# Without JWT token (should fail in prod mode)
curl -X POST "https://6b3bf1bqk3.execute-api.eu-west-1.amazonaws.com/bg-remover/process" \
  -H "Content-Type: application/json" \
  -H "X-Tenant-Id: carousel-labs" \
  -d '{
    "imageBase64": "iVBORw0KGgoAAAANSUhEUg...",
    "outputFormat": "png",
    "quality": 95
  }'

# Expected in prod: 401 Unauthorized
# Expected in dev (REQUIRE_AUTH=false): 200 OK
```

---

## Security Considerations

### ✅ Best Practices

1. **JWT Validation**
   - Validates signature using JWKS from Cognito
   - Verifies issuer claim
   - Checks token expiration
   - Validates audience (client ID)

2. **Tenant Isolation**
   - Extract tenant from `X-Tenant-Id` header
   - Validate tenant against Cognito groups
   - Ensure users can only access their tenant's data

3. **Role-Based Access Control** (Future)
   - Check `cognito:groups` claim for roles
   - Admin users: full access
   - Staff users: process endpoint only
   - Viewer users: status endpoint only

4. **Rate Limiting** (Future)
   - Implement per-user rate limiting
   - Use API Gateway usage plans
   - Track requests per tenant

### ⚠️ Security Gaps (Current)

1. **No Authentication** - Endpoints are publicly accessible
2. **No Rate Limiting** - Open to abuse
3. **No Cost Control** - Anyone can consume Bedrock credits
4. **No Audit Logging** - No record of who accessed what

---

## Cost Impact

### Without Authentication
- **Risk:** Anyone can call endpoints and consume AWS Bedrock credits
- **Monthly Cost:** Unpredictable (could be $100s if abused)

### With Lambda-Level Authentication
- **Added Cost:** ~$0.01/month (JWT validation overhead)
- **Savings:** Prevents unauthorized usage
- **Latency:** +20-50ms per request

### With API Gateway-Level Authorization
- **Added Cost:** $0.00/month (included in API Gateway pricing)
- **Savings:** Rejects unauthorized requests before Lambda invocation
- **Latency:** +10-20ms per request
- **Efficiency:** Best option for production

---

## Migration Path

### Immediate (This Week)
1. ✅ Create JWT validation module (`jwt-validator.ts`)
2. ⏳ Install `jose` dependency
3. ⏳ Update handler with JWT validation
4. ⏳ Deploy to dev with `REQUIRE_AUTH=false`
5. ⏳ Test authenticated and unauthenticated flows

### Short Term (Next Sprint)
1. Configure API Gateway JWT authorizer (platform team)
2. Update route configurations to use authorizer
3. Deploy to prod with `REQUIRE_AUTH=true`
4. Monitor authentication failures in CloudWatch

### Long Term (Future)
1. Implement role-based access control
2. Add per-user rate limiting
3. Set up comprehensive audit logging
4. Configure tenant isolation validation

---

##  Reference

### Files Created
- `src/lib/auth/jwt-validator.ts` - JWT validation module

### Files to Modify
- `src/handler.ts` - Add JWT validation to process/status handlers
- `serverless.yml` - Add Cognito environment variables
- `package.json` - Add `jose` dependency

### Platform Configuration (SSM)
- `/tf/dev/platform/cognito/user-pool-id` → `eu-west-1_SfkX8eTc3`
- `/tf/dev/platform/cognito/issuer-url` → `https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_SfkX8eTc3`
- `/tf/dev/platform/api-gateway/id` → `6b3bf1bqk3`
- `/tf/dev/platform/api-gateway/cognito-authorizer-id` → (to be created)

### Cognito Web Clients
- `44na9pkdt2qst88f89v19a024j` - platform-api-dev
- `4gesllg1saibu4t1l1flvtg25t` - carousel-labs-frontend-web-client
- `536dg9bl9hl6gb8s02pgj75ehg` - carousel-labs-dev-frontend-web-client

---

## Questions?

Contact the platform team for:
- API Gateway authorizer configuration
- Cognito user pool management
- SSM parameter access
- Production deployment

---

**Next Steps:**
1. Install `jose` dependency (requires CodeArtifact authentication)
2. Integrate JWT validation in handler.ts
3. Test authentication flows
4. Deploy to dev environment
5. Coordinate with platform team for API Gateway authorization
