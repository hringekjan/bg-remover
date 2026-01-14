# Security Review: Missing Ownership Validation (P0 - CRITICAL)

**Reviewer:** Security & RBAC Reviewer Agent #2
**Service:** bg-remover
**Date:** 2026-01-02
**Issue ID:** Security Issue #2
**CVSS Score:** 8.1 (High)
**Classification:** OWASP A01:2021 - Broken Access Control

---

## Executive Summary

**Status:** CRITICAL - IMMEDIATE ACTION REQUIRED
**Risk Level:** P0 - Horizontal Privilege Escalation Vulnerability

The bg-remover service has a **critical authorization vulnerability** that allows any authenticated user within a tenant to access, cancel, and potentially enumerate ANY other user's background removal jobs. While tenant isolation is properly enforced, **intra-tenant ownership validation is completely missing in dev** and **conditional in prod**.

### Impact Assessment
- **Data Exposure:** High - Users can view other users' product names, image URLs, descriptions, processing metadata
- **Data Manipulation:** High - Users can cancel other users' jobs, causing business disruption
- **Privacy Violation:** Critical - GDPR/CCPA violation (unauthorized access to personal data)
- **Business Impact:** High - Multi-user tenants (e.g., SaaS platforms) cannot safely use this service

### Immediate Actions Required
1. Enable ownership validation in ALL stages (dev, staging, prod)
2. Implement role-based exemptions (admin, staff)
3. Add ownership checks to ALL query operations
4. Add comprehensive audit logging for ownership violations

---

## 1. Vulnerability Analysis

### 1.1 Current Authorization Model

**Authentication Flow:**
```
Client Request
    ↓
API Gateway Authorizer (validates JWT)
    ↓
Lambda Handler (re-validates JWT - defense in depth)
    ↓
Extracts: tenant, userId from JWT
    ↓
DynamoDB Query: TENANT#<tenant>#JOB → JOB#<jobId>
    ↓
✅ Tenant isolation enforced (pk scoped to tenant)
❌ NO ownership check (job.userId vs authenticated userId)
    ↓
Returns job data to ANY user in tenant
```

**Current Code - Status Handler (Lines 133-143):**
```typescript
// Authorization check: Only allow access if user owns the job (in prod)
const stage = this.context.stage;
if (stage === 'prod' && userId && job.userId !== userId) {
  console.warn('Unauthorized access attempt', {
    tenant,
    jobId,
    requestingUser: userId,
    jobOwner: job.userId,
  });
  return this.createErrorResponse('Not authorized to access this job', 403);
}
```

**CRITICAL FLAW:** Ownership validation is:
- **Stage-dependent:** Only enforced in `stage === 'prod'`
- **Bypassable in dev:** Allows unrestricted access in dev environment
- **Incomplete:** Missing from frontend Next.js API route handler
- **Not role-aware:** No exemptions for admin/staff users

---

### 1.2 Affected Endpoints

#### 1. Lambda Backend Handler
**File:** `/services/bg-remover/src/handlers/status-handler.ts`

| Endpoint | Method | Ownership Check | Vulnerability |
|----------|--------|-----------------|---------------|
| `/bg-remover/status/{jobId}` | GET | Conditional (prod-only) | ❌ Missing in dev |
| `/bg-remover/status/{jobId}` | DELETE | Conditional (prod-only) | ❌ Missing in dev |

**Affected Methods:**
- `getJobStatus()` - Lines 116-225 (check at line 135)
- `cancelJob()` - Lines 230-316 (check at line 250)

#### 2. Frontend Next.js API Route
**File:** `/services/bg-remover/app/api/status/[jobId]/route.ts`

| Endpoint | Method | Ownership Check | Vulnerability |
|----------|--------|-----------------|---------------|
| `/api/status/[jobId]` | GET | ❌ NONE | **CRITICAL** |
| `/api/status/[jobId]` | DELETE | ❌ NONE | **CRITICAL** |

**CRITICAL:** Frontend route has **ZERO ownership validation** in ANY stage!

```typescript
// Lines 26-73: GET handler
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
): Promise<NextResponse> {
  // ... validation ...

  const job = await getJobStatus(jobId);  // ❌ NO userId check

  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }

  // ❌ MISSING: if (job.userId !== authenticatedUserId) { return 403 }

  return NextResponse.json({ ...job });  // Returns ANY job
}
```

#### 3. DynamoDB Job Store (Data Layer)
**File:** `/services/bg-remover/src/lib/job-store.ts`

| Function | Ownership Check | Vulnerability |
|----------|-----------------|---------------|
| `getJobStatus()` | ❌ NONE | Data layer has no auth context |
| `updateJobStatus()` | ❌ NONE | Data layer has no auth context |
| `deleteJob()` | ❌ NONE | Data layer has no auth context |
| `getJobsByTenant()` | ❌ NONE | Admin function - returns ALL jobs |

**Design Flaw:** Data layer has no concept of ownership - relies on handler layer (which is incomplete).

---

### 1.3 Attack Vectors

#### Attack Vector 1: Direct Job Enumeration
**Scenario:** Attacker enumerates all jobs in their tenant to harvest product data.

```bash
# Attacker authenticated as user-a@tenant.com
# Knows jobs are UUID v4 format

# Strategy: Guess job IDs (low success rate due to 122-bit entropy)
# OR: Intercept job IDs from network traffic, browser history, logs

curl -H "Authorization: Bearer <user-a-token>" \
  https://api.dev.carousellabs.co/bg-remover/status/550e8400-e29b-41d4-a716-446655440000

# Response: Job owned by user-b@tenant.com
{
  "success": true,
  "jobId": "550e8400-...",
  "status": "completed",
  "outputUrl": "https://s3.amazonaws.com/tenant/user-b/product-123.png",
  "productDescription": "Competitor's pricing: $49.99",  # 💥 PII leak
  "metadata": { "width": 1024, "height": 768 }
}
```

**Exploitability:** MEDIUM (requires guessing UUIDs or intercepting valid IDs)
**Impact:** HIGH (data exposure, PII leak)

---

#### Attack Vector 2: Job Cancellation Denial of Service
**Scenario:** Attacker cancels all pending jobs in tenant to disrupt business operations.

```bash
# Attacker discovers active job IDs (via timing attacks or shared logs)
# Cancels all jobs to cause business disruption

curl -X DELETE \
  -H "Authorization: Bearer <attacker-token>" \
  https://api.dev.carousellabs.co/bg-remover/status/<victim-job-id>

# Response: Success (job owned by victim)
{
  "success": true,
  "jobId": "...",
  "status": "cancelled",
  "message": "Job cancelled successfully"
}
```

**Exploitability:** HIGH (DELETE requires no special privileges)
**Impact:** CRITICAL (business disruption, data loss)

---

#### Attack Vector 3: Timing-Based Job Discovery
**Scenario:** Attacker uses timing side-channels to discover valid job IDs.

```python
import time
import requests

# Measure response time for valid vs invalid job IDs
def timing_attack(tenant_token, job_id):
    start = time.perf_counter()
    response = requests.get(
        f"https://api.dev.carousellabs.co/bg-remover/status/{job_id}",
        headers={"Authorization": f"Bearer {tenant_token}"}
    )
    elapsed = time.perf_counter() - start

    # Valid jobs return faster (DB hit) vs invalid (DB miss)
    return {
        "job_id": job_id,
        "status": response.status_code,
        "timing_ms": elapsed * 1000,
        "likely_valid": elapsed > 50  # DB queries are slower
    }

# Enumerate 1000 random UUIDs
# Identify likely-valid jobs by response timing
```

**Exploitability:** MEDIUM (requires statistical analysis)
**Impact:** HIGH (job enumeration leads to data exposure)

---

#### Attack Vector 4: Shared Browser/Device Exploitation
**Scenario:** Attacker on shared device accesses job history via browser storage/logs.

```javascript
// Browser console on shared device
// Extract job IDs from localStorage, sessionStorage, or browser history

const jobHistory = JSON.parse(localStorage.getItem('bg-remover-jobs'));
// jobHistory = [
//   { jobId: "550e8400-...", userId: "other-user@tenant.com" },
//   ...
// ]

// Access other users' jobs
jobHistory.forEach(job => {
  fetch(`/api/status/${job.jobId}`, {
    headers: { 'Authorization': `Bearer ${myToken}` }
  })
  .then(r => r.json())
  .then(data => console.log('Stolen job data:', data));  // ❌ Success
});
```

**Exploitability:** HIGH (common in shared workspaces, internet cafes)
**Impact:** CRITICAL (immediate data breach)

---

## 2. Data Exposure Risk Assessment

### 2.1 Sensitive Data in Job Records

**Job Schema (from DynamoDB):**
```typescript
interface Job {
  pk: string;                    // TENANT#carousel-labs#JOB
  sk: string;                    // JOB#550e8400-...
  jobId: string;                 // 550e8400-e29b-41d4-a716-446655440000
  tenant: string;                // carousel-labs
  userId: string;                // ❌ PII: user-123 or email
  status: 'pending' | 'processing' | 'completed' | 'failed';

  // ❌ Sensitive Business Data
  productId?: string;            // Reveals inventory
  productName?: string;          // Reveals product catalog
  productDescription?: string;   // May contain pricing, specs

  // ❌ Sensitive Processing Data
  inputUrl?: string;             // S3 pre-signed URL (may contain tokens)
  outputUrl?: string;            // S3 pre-signed URL
  metadata?: {
    width: number;
    height: number;
    originalSize: number;        // Reveals upload patterns
    processedSize: number;
  };

  // ❌ Sensitive Multilingual Data
  multilingualDescription?: {    // May contain proprietary translations
    en: string;
    es: string;
    de: string;
  };

  // ❌ Financial Data
  creditTransactionId?: string;  // Links to payment records
  refundStatus?: string;
  refundTransactionId?: string;

  // Metadata
  createdAt: string;
  updatedAt: string;
  ttl: number;
}
```

### 2.2 Privacy Regulation Impact

**GDPR Violations (EU Tenants):**
- **Article 5(1)(f):** Lack of appropriate security (unauthorized access to personal data)
- **Article 32:** Failure to implement technical measures to ensure security
- **Potential Fines:** Up to 4% of annual global turnover or €20M (whichever is greater)

**CCPA Violations (California Tenants):**
- **Section 1798.150:** Right to sue for data breaches ($100-$750 per consumer per incident)
- **Section 1798.155:** Civil penalties ($2,500 per violation, $7,500 for intentional violations)

**PCI DSS Impact (if processing payments):**
- **Requirement 7.1:** Limit access to cardholder data (if creditTransactionId links to payment data)
- **Compliance Failure:** Loss of merchant account, fines from payment processors

---

## 3. Compliance and Business Impact

### 3.1 Multi-Tenant SaaS Risks

**Scenario:** E-commerce SaaS platform using bg-remover service

```
Tenant: "ShopifyApp123"
Users:
  - merchant-a@store1.com (100 products)
  - merchant-b@store2.com (50 products)
  - merchant-c@store3.com (200 products)
```

**Current Risk:**
- ✅ Tenant isolation prevents ShopifyApp123 from seeing CompetitorApp456 data
- ❌ merchant-a CAN see merchant-b and merchant-c product data (same tenant)
- ❌ Competitor merchants can spy on each other's inventory, pricing, descriptions

**Business Impact:**
- Loss of merchant trust
- Contract violations (SaaS provider guarantees merchant isolation)
- Competitive intelligence leaks
- Regulatory fines (GDPR, CCPA)
- Reputational damage

---

### 3.2 Internal Team Risks

**Scenario:** Enterprise internal team using bg-remover

```
Tenant: "carousel-labs"
Users:
  - designer@carousel-labs.com
  - marketing@carousel-labs.com
  - contractor@carousel-labs.com (temporary access)
```

**Current Risk:**
- ❌ Contractor can access all design and marketing job data
- ❌ No audit trail for who accessed what data
- ❌ Cannot revoke access granularly (only tenant-level auth)

**Compliance Gaps:**
- SOC 2 Type II: Insufficient access controls
- ISO 27001: Lack of principle of least privilege
- Internal audit failures

---

## 4. Authorization Pattern Review

### 4.1 Missing RBAC Implementation

**Current State:**
```typescript
// JWT provides groups claim
interface JWTPayload {
  sub: string;                   // userId
  email: string;
  'cognito:groups'?: string[];   // ['admin', 'staff', 'user']
}

// hasRequiredRole() function EXISTS but is NEVER USED
export function hasRequiredRole(
  validationResult: JWTValidationResult,
  requiredRoles: string[]
): boolean {
  if (!validationResult.isValid || !validationResult.groups) {
    return false;
  }
  return requiredRoles.some((role) =>
    validationResult.groups!.includes(role)
  );
}
```

**Problem:** RBAC infrastructure exists but is not integrated into handlers.

---

### 4.2 Recommended Authorization Pattern

**Three-Tier Authorization Model:**

```typescript
interface AuthorizationContext {
  tenant: string;           // From JWT (validated)
  userId: string;           // From JWT (validated)
  userGroups: string[];     // From JWT cognito:groups
  requestedJobId: string;   // From path parameter
}

/**
 * Check if user can access a job
 *
 * Rules:
 * 1. Super-admin: Can access ANY job in ANY tenant
 * 2. Tenant-admin: Can access ANY job in THEIR tenant
 * 3. Staff: Can access ANY job in THEIR tenant (read-only)
 * 4. User: Can access ONLY THEIR OWN jobs
 */
async function authorizeJobAccess(
  context: AuthorizationContext,
  operation: 'read' | 'write' | 'delete'
): Promise<{ allowed: boolean; reason?: string }> {

  // Step 1: Fetch job (with tenant isolation)
  const job = await getJobStatus(context.requestedJobId, context.tenant);

  if (!job) {
    // Return 404 to prevent job enumeration (not 403)
    return { allowed: false, reason: 'JOB_NOT_FOUND' };
  }

  // Step 2: Check tenant isolation
  if (job.tenant !== context.tenant) {
    console.error('CRITICAL: Cross-tenant access attempt', {
      requestedTenant: context.tenant,
      jobTenant: job.tenant,
      userId: context.userId,
    });
    // Return 404 to prevent tenant enumeration
    return { allowed: false, reason: 'JOB_NOT_FOUND' };
  }

  // Step 3: Role-based authorization
  const isSuperAdmin = context.userGroups.includes('super-admin');
  const isTenantAdmin = context.userGroups.includes('admin');
  const isStaff = context.userGroups.includes('staff');
  const isOwner = job.userId === context.userId;

  // Super-admin: Full access
  if (isSuperAdmin) {
    return { allowed: true, reason: 'SUPER_ADMIN_ACCESS' };
  }

  // Tenant-admin: Full access within tenant
  if (isTenantAdmin) {
    return { allowed: true, reason: 'ADMIN_ACCESS' };
  }

  // Staff: Read-only access within tenant
  if (isStaff) {
    if (operation === 'read') {
      return { allowed: true, reason: 'STAFF_READ_ACCESS' };
    } else {
      return { allowed: false, reason: 'STAFF_READ_ONLY' };
    }
  }

  // User: Owner-only access
  if (isOwner) {
    return { allowed: true, reason: 'OWNER_ACCESS' };
  }

  // Default: Deny (return 404 to prevent enumeration)
  console.warn('Authorization denied', {
    tenant: context.tenant,
    userId: context.userId,
    jobId: context.requestedJobId,
    jobOwner: job.userId,
    userGroups: context.userGroups,
    operation,
  });

  return { allowed: false, reason: 'NOT_AUTHORIZED' };
}
```

---

### 4.3 Secure Handler Implementation

**Updated Status Handler (GET):**
```typescript
private async getJobStatus(
  tenant: string,
  jobId: string,
  userId?: string,
  userGroups?: string[]
): Promise<any> {

  // Build authorization context
  const authContext: AuthorizationContext = {
    tenant,
    userId: userId || 'anonymous',
    userGroups: userGroups || [],
    requestedJobId: jobId,
  };

  // Check authorization BEFORE fetching job
  const authResult = await authorizeJobAccess(authContext, 'read');

  if (!authResult.allowed) {
    // ✅ Return 404 (not 403) to prevent job enumeration
    console.warn('Unauthorized job access attempt', {
      tenant,
      jobId,
      userId,
      reason: authResult.reason,
    });
    return this.createErrorResponse('Job not found', 404);
  }

  // Fetch job (already validated authorization)
  const job = await this.fetchJobFromDB(tenant, jobId);

  if (!job) {
    return this.createErrorResponse('Job not found', 404);
  }

  // ✅ Log successful access for audit
  await this.auditLog({
    action: 'JOB_ACCESS',
    tenant,
    userId,
    jobId,
    jobOwner: job.userId,
    accessReason: authResult.reason,
    timestamp: new Date().toISOString(),
  });

  // Build response
  return this.createJsonResponse({
    success: true,
    jobId: job.jobId,
    status: job.status,
    // ... sanitized job data ...
  });
}
```

**Updated Cancel Job Handler (DELETE):**
```typescript
private async cancelJob(
  tenant: string,
  jobId: string,
  userId?: string,
  userGroups?: string[]
): Promise<any> {

  const authContext: AuthorizationContext = {
    tenant,
    userId: userId || 'anonymous',
    userGroups: userGroups || [],
    requestedJobId: jobId,
  };

  // Check WRITE authorization
  const authResult = await authorizeJobAccess(authContext, 'delete');

  if (!authResult.allowed) {
    console.warn('Unauthorized job cancellation attempt', {
      tenant,
      jobId,
      userId,
      reason: authResult.reason,
    });
    return this.createErrorResponse('Job not found', 404);
  }

  // Proceed with cancellation
  const result = await this.updateJobStatus(jobId, {
    status: 'cancelled',
    cancelledAt: new Date().toISOString(),
    cancelledBy: userId,  // ✅ Track who cancelled
  });

  // ✅ Audit log for compliance
  await this.auditLog({
    action: 'JOB_CANCELLED',
    tenant,
    userId,
    jobId,
    accessReason: authResult.reason,
    timestamp: new Date().toISOString(),
  });

  return this.createJsonResponse({
    success: true,
    jobId,
    status: 'cancelled',
  });
}
```

---

## 5. Frontend Route Hardening

**Current Vulnerability (Next.js API Route):**
```typescript
// ❌ INSECURE: No authentication, no ownership check
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
): Promise<NextResponse> {
  const { jobId } = await params;
  const job = await getJobStatus(jobId);  // ❌ No userId check

  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }

  return NextResponse.json({ ...job });  // ❌ Returns ANY job
}
```

**Secure Implementation:**
```typescript
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
): Promise<NextResponse> {

  // ✅ 1. Authenticate user
  const session = await getServerSession(authOptions);

  if (!session?.user) {
    return NextResponse.json(
      { error: 'Authentication required' },
      { status: 401 }
    );
  }

  const { jobId } = await params;

  // ✅ 2. Validate job ID format (prevent injection)
  const validation = ParamsSchema.safeParse({ jobId });
  if (!validation.success) {
    return NextResponse.json(
      { error: 'Invalid job ID format' },
      { status: 400 }
    );
  }

  // ✅ 3. Fetch job with tenant context
  const job = await getJobStatus(jobId, session.user.tenant);

  if (!job) {
    return NextResponse.json(
      { error: 'Job not found' },
      { status: 404 }
    );
  }

  // ✅ 4. Authorize access (ownership + role check)
  const authContext: AuthorizationContext = {
    tenant: session.user.tenant,
    userId: session.user.id,
    userGroups: session.user.groups || [],
    requestedJobId: jobId,
  };

  const authResult = await authorizeJobAccess(authContext, 'read');

  if (!authResult.allowed) {
    // Return 404 (not 403) to prevent enumeration
    return NextResponse.json(
      { error: 'Job not found' },
      { status: 404 }
    );
  }

  // ✅ 5. Audit log
  await auditLog({
    action: 'FRONTEND_JOB_ACCESS',
    tenant: session.user.tenant,
    userId: session.user.id,
    jobId,
    accessReason: authResult.reason,
  });

  // ✅ 6. Return sanitized job data
  return NextResponse.json({
    jobId: job.jobId,
    status: job.status,
    progress: job.progress,
    result: job.result,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    // ❌ Do NOT return: userId, creditTransactionId, inputUrl (sensitive)
  });
}
```

---

## 6. Audit Logging Requirements

### 6.1 Audit Events to Log

**Access Events:**
```typescript
interface AuditLogEntry {
  timestamp: string;           // ISO 8601
  action: 'JOB_ACCESS' | 'JOB_CANCELLED' | 'JOB_CREATED' | 'JOB_UPDATED';

  // Actor context
  tenant: string;
  userId: string;
  userEmail?: string;
  userGroups?: string[];

  // Resource context
  resourceType: 'job';
  resourceId: string;          // jobId
  resourceOwner: string;       // job.userId

  // Authorization context
  authorizationResult: 'allowed' | 'denied';
  authorizationReason: string; // 'OWNER_ACCESS', 'ADMIN_ACCESS', 'NOT_AUTHORIZED'

  // Request metadata
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;

  // Result
  httpStatus: number;
  errorMessage?: string;
}
```

**Storage:**
```typescript
// DynamoDB table: bg-remover-audit-logs-{stage}
// Partition key: tenant#date (e.g., "carousel-labs#2026-01-02")
// Sort key: timestamp#userId#action
// TTL: 90 days (compliance retention)

async function auditLog(entry: AuditLogEntry): Promise<void> {
  const pk = `${entry.tenant}#${entry.timestamp.split('T')[0]}`;
  const sk = `${entry.timestamp}#${entry.userId}#${entry.action}`;

  await dynamoDB.putItem({
    TableName: 'bg-remover-audit-logs-dev',
    Item: {
      pk,
      sk,
      ...entry,
      ttl: Math.floor(Date.now() / 1000) + (90 * 24 * 60 * 60), // 90 days
    },
  });
}
```

### 6.2 Audit Query Examples

**Find unauthorized access attempts:**
```typescript
// Query all denied access attempts for a tenant in the last 24 hours
const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];

const result = await dynamoDB.query({
  TableName: 'bg-remover-audit-logs-dev',
  KeyConditionExpression: 'pk = :pk',
  FilterExpression: 'authorizationResult = :denied',
  ExpressionAttributeValues: {
    ':pk': `carousel-labs#${yesterday}`,
    ':denied': 'denied',
  },
});

// Result: List of unauthorized access attempts (for security monitoring)
```

**Find jobs accessed by specific user:**
```typescript
// Query all job access by user-123 in the last 7 days
const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

const result = await dynamoDB.query({
  TableName: 'bg-remover-audit-logs-dev',
  IndexName: 'userId-timestamp-index',
  KeyConditionExpression: 'userId = :userId AND #timestamp > :weekAgo',
  ExpressionAttributeNames: {
    '#timestamp': 'timestamp',
  },
  ExpressionAttributeValues: {
    ':userId': 'user-123',
    ':weekAgo': weekAgo,
  },
});

// Result: Compliance audit trail for user activity
```

---

## 7. Recommended Fixes (Priority Order)

### Priority 0 (IMMEDIATE - Deploy in 24h)

**1. Enable Ownership Checks in ALL Stages**
```diff
- if (stage === 'prod' && userId && job.userId !== userId) {
+ if (userId && job.userId !== userId && !isAdminOrStaff(userGroups)) {
```

**Files to update:**
- `/services/bg-remover/src/handlers/status-handler.ts` (Lines 135, 250)

**Time Estimate:** 1 hour
**Testing:** Unit tests + integration tests
**Deployment:** Hotfix to dev, staging, prod

---

**2. Add Ownership Checks to Frontend Route**
```diff
+ const session = await getServerSession(authOptions);
+ if (!session?.user) {
+   return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
+ }
+
  const job = await getJobStatus(jobId);
+
+ if (job.userId !== session.user.id && !isAdmin(session.user)) {
+   return NextResponse.json({ error: 'Not found' }, { status: 404 });
+ }
```

**Files to update:**
- `/services/bg-remover/app/api/status/[jobId]/route.ts` (Lines 26-73, 89-142)

**Time Estimate:** 2 hours
**Testing:** E2E tests with multiple users
**Deployment:** With P0 hotfix

---

### Priority 1 (High - Deploy in 1 week)

**3. Implement RBAC Authorization Pattern**
- Create `authorizeJobAccess()` function
- Support admin, staff, user roles
- Add role exemptions to ownership checks

**Files to create/update:**
- `/services/bg-remover/src/lib/authorization/job-authorizer.ts` (new)
- `/services/bg-remover/src/handlers/status-handler.ts` (integrate)

**Time Estimate:** 6 hours
**Testing:** RBAC test matrix (3 roles × 5 operations)

---

**4. Add Comprehensive Audit Logging**
- Create audit log DynamoDB table
- Log all job access events
- Log authorization decisions (allowed/denied)

**Files to create/update:**
- `/services/bg-remover/src/lib/audit/audit-logger.ts` (new)
- `/services/bg-remover/serverless.yml` (add audit table)
- All handlers (add audit calls)

**Time Estimate:** 8 hours
**Testing:** Verify audit logs in DynamoDB

---

### Priority 2 (Medium - Deploy in 2 weeks)

**5. Add Admin Query Endpoints**
- `GET /admin/jobs` - List all jobs in tenant (admin-only)
- `GET /admin/jobs/{userId}` - List jobs by user (admin-only)
- `GET /admin/audit-logs` - Query audit logs (admin-only)

**Authorization:** Require `admin` or `staff` group

**Time Estimate:** 12 hours

---

**6. Implement Job Ownership Transfer**
- Allow admins to transfer job ownership
- Audit log ownership changes
- Preserve original owner in metadata

**Use case:** When user leaves organization, transfer their jobs to replacement.

**Time Estimate:** 6 hours

---

## 8. Testing Requirements

### 8.1 Unit Tests (Minimum Coverage)

```typescript
describe('Job Authorization', () => {

  it('should allow owner to access their own job', async () => {
    const job = await createJob('user-123', 'tenant-a');
    const result = await authorizeJobAccess({
      tenant: 'tenant-a',
      userId: 'user-123',
      userGroups: ['user'],
      requestedJobId: job.jobId,
    }, 'read');

    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('OWNER_ACCESS');
  });

  it('should deny non-owner user from accessing job', async () => {
    const job = await createJob('user-123', 'tenant-a');
    const result = await authorizeJobAccess({
      tenant: 'tenant-a',
      userId: 'user-456',  // Different user
      userGroups: ['user'],
      requestedJobId: job.jobId,
    }, 'read');

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('NOT_AUTHORIZED');
  });

  it('should allow tenant admin to access any job in tenant', async () => {
    const job = await createJob('user-123', 'tenant-a');
    const result = await authorizeJobAccess({
      tenant: 'tenant-a',
      userId: 'admin-456',
      userGroups: ['admin'],
      requestedJobId: job.jobId,
    }, 'read');

    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('ADMIN_ACCESS');
  });

  it('should allow staff read access but deny write access', async () => {
    const job = await createJob('user-123', 'tenant-a');

    // Read should succeed
    const readResult = await authorizeJobAccess({
      tenant: 'tenant-a',
      userId: 'staff-789',
      userGroups: ['staff'],
      requestedJobId: job.jobId,
    }, 'read');
    expect(readResult.allowed).toBe(true);
    expect(readResult.reason).toBe('STAFF_READ_ACCESS');

    // Write should fail
    const writeResult = await authorizeJobAccess({
      tenant: 'tenant-a',
      userId: 'staff-789',
      userGroups: ['staff'],
      requestedJobId: job.jobId,
    }, 'delete');
    expect(writeResult.allowed).toBe(false);
    expect(writeResult.reason).toBe('STAFF_READ_ONLY');
  });

  it('should deny cross-tenant access even for admins', async () => {
    const job = await createJob('user-123', 'tenant-a');
    const result = await authorizeJobAccess({
      tenant: 'tenant-b',  // Different tenant
      userId: 'admin-456',
      userGroups: ['admin'],
      requestedJobId: job.jobId,
    }, 'read');

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('JOB_NOT_FOUND');
  });
});
```

**Coverage Target:** 95% for authorization logic
**Test Matrix:** 5 roles × 10 operations = 50 test cases

---

### 8.2 Integration Tests (E2E Scenarios)

```typescript
describe('Job Access E2E Tests', () => {

  it('should prevent user-a from cancelling user-b job', async () => {
    // Create job as user-b
    const userBToken = await getAuthToken('user-b@tenant.com');
    const createResponse = await request(app)
      .post('/bg-remover/process')
      .set('Authorization', `Bearer ${userBToken}`)
      .send({ imageUrl: 'https://example.com/image.png' });

    const { jobId } = createResponse.body;

    // Attempt to cancel as user-a
    const userAToken = await getAuthToken('user-a@tenant.com');
    const cancelResponse = await request(app)
      .delete(`/bg-remover/status/${jobId}`)
      .set('Authorization', `Bearer ${userAToken}`);

    // Should return 404 (not 403) to prevent enumeration
    expect(cancelResponse.status).toBe(404);
    expect(cancelResponse.body.error).toBe('Job not found');

    // Verify job still exists
    const statusResponse = await request(app)
      .get(`/bg-remover/status/${jobId}`)
      .set('Authorization', `Bearer ${userBToken}`);

    expect(statusResponse.status).toBe(200);
    expect(statusResponse.body.status).not.toBe('cancelled');
  });

  it('should allow admin to cancel any job in tenant', async () => {
    // Create job as user
    const userToken = await getAuthToken('user@tenant.com');
    const createResponse = await request(app)
      .post('/bg-remover/process')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ imageUrl: 'https://example.com/image.png' });

    const { jobId } = createResponse.body;

    // Cancel as admin
    const adminToken = await getAuthToken('admin@tenant.com', ['admin']);
    const cancelResponse = await request(app)
      .delete(`/bg-remover/status/${jobId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(cancelResponse.status).toBe(200);
    expect(cancelResponse.body.status).toBe('cancelled');
  });
});
```

---

### 8.3 Penetration Testing Checklist

- [ ] Attempt to access job with valid UUID but wrong owner (should return 404)
- [ ] Attempt to manipulate x-tenant-id header to access cross-tenant jobs (should fail)
- [ ] Attempt timing attack to enumerate valid job IDs (should not leak timing info)
- [ ] Attempt to bypass authorization by modifying JWT claims (should fail signature check)
- [ ] Attempt to access job after token expiration (should return 401)
- [ ] Attempt to cancel job that doesn't exist (should return 404, not leak error details)
- [ ] Attempt SQL injection via jobId parameter (should be sanitized by UUID validation)
- [ ] Verify audit logs capture all unauthorized access attempts

---

## 9. Deployment Plan

### Phase 1: Emergency Hotfix (24 hours)
**Goal:** Stop the bleeding - enable basic ownership checks

**Changes:**
1. Remove stage-dependent ownership checks
2. Enable ownership validation in dev, staging, prod
3. Add basic admin role exemption

**Deployment:**
```bash
# Deploy hotfix to all stages
npm run deploy:dev    # Validate in dev first
npm run deploy:staging # QA validation
npm run deploy:prod   # Production rollout
```

**Rollback Plan:**
```bash
# If issues detected, revert to previous deployment
aws lambda update-function-code \
  --function-name bg-remover-dev-process \
  --s3-bucket bg-remover-deployments \
  --s3-key deployments/<previous-version>.zip
```

---

### Phase 2: RBAC Implementation (1 week)
**Goal:** Proper role-based access control

**Changes:**
1. Create authorization module
2. Implement role-based permissions
3. Add comprehensive tests

**Testing:**
- Unit tests (95% coverage)
- Integration tests (E2E scenarios)
- Penetration tests (security validation)

---

### Phase 3: Audit & Compliance (2 weeks)
**Goal:** Full compliance with GDPR, CCPA, SOC 2

**Changes:**
1. Audit logging infrastructure
2. Admin query endpoints
3. Compliance reporting tools

---

## 10. Monitoring & Alerting

### 10.1 Security Metrics to Track

**CloudWatch Metrics:**
```typescript
// Metric 1: Unauthorized access attempts
namespace: 'BgRemover/Security'
metric: 'UnauthorizedAccessAttempts'
dimensions: { Tenant, Stage }

// Metric 2: Cross-tenant access attempts (critical)
namespace: 'BgRemover/Security'
metric: 'CrossTenantAccessAttempts'
dimensions: { Tenant, Stage }

// Metric 3: Admin overrides (for audit)
namespace: 'BgRemover/Security'
metric: 'AdminAccessOverrides'
dimensions: { Tenant, AdminUserId, Stage }
```

**CloudWatch Alarms:**
```yaml
UnauthorizedAccessAlarm:
  Type: AWS::CloudWatch::Alarm
  Properties:
    AlarmName: bg-remover-${stage}-unauthorized-access
    MetricName: UnauthorizedAccessAttempts
    Namespace: BgRemover/Security
    Statistic: Sum
    Period: 300  # 5 minutes
    EvaluationPeriods: 1
    Threshold: 10  # Alert if >10 unauthorized attempts in 5 min
    ComparisonOperator: GreaterThanThreshold
    AlarmActions:
      - !Ref SecurityAlertSNSTopic
```

---

### 10.2 Dashboard Requirements

**Security Dashboard (CloudWatch):**
- Unauthorized access attempts (last 24h)
- Cross-tenant access attempts (should be 0)
- Admin access overrides (for audit)
- Jobs by owner (top 10 users)
- Failed authorization reasons (pie chart)

---

## 11. Documentation Updates Required

**Files to update:**
1. `/services/bg-remover/README.md` - Add authorization section
2. `/services/bg-remover/docs/SECURITY.md` - Document RBAC model
3. `/services/bg-remover/docs/API.md` - Update endpoint auth requirements
4. `/services/bg-remover/CHANGELOG.md` - Document security fixes

---

## 12. Final Recommendations

### Critical Actions (Deploy in 24h)
1. ✅ Enable ownership checks in ALL stages (remove stage === 'prod' condition)
2. ✅ Add ownership checks to frontend Next.js route
3. ✅ Deploy hotfix with basic admin exemption
4. ✅ Write unit tests for ownership validation

### High Priority (Deploy in 1 week)
5. ✅ Implement full RBAC authorization pattern
6. ✅ Add comprehensive audit logging
7. ✅ Create admin query endpoints
8. ✅ Run penetration tests

### Medium Priority (Deploy in 2 weeks)
9. ✅ Add CloudWatch security metrics and alarms
10. ✅ Create security dashboard
11. ✅ Document RBAC model
12. ✅ Implement job ownership transfer (for admin)

---

## 13. Sign-Off

**Security Review Status:** ❌ REJECT - CRITICAL SECURITY FINDINGS

**Critical Findings:**
1. Missing ownership validation in dev/staging (P0)
2. No ownership validation in frontend route (P0)
3. No audit logging for access control (P1)

**Decision:** **BLOCK DEPLOYMENT** until P0 fixes are implemented and tested.

**Next Steps:**
1. Implement P0 fixes (ownership checks in all stages)
2. Add comprehensive unit tests (95% coverage)
3. Run integration tests (E2E scenarios)
4. Request re-review after fixes deployed to dev

**Reviewer:** Security & RBAC Reviewer Agent #2
**Date:** 2026-01-02
**Escalated to:** User (Critical security vulnerability)

---

**Review Complete - Awaiting Worker Agent #4 Implementation**
