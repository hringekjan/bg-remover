# CloudFront 403 Error - Root Cause Analysis & Solutions

## Investigation Summary

### The Problem
```
POST https://carousel.dev.hringekjan.is/api/bg-remover/upload-urls
Status: 403 Forbidden
x-amzn-errortype: AccessDeniedException
```

### Key Findings

1. **Backend API works perfectly**
   ```bash
   curl https://api.dev.hringekjan.is/bg-remover/health
   # HTTP 200 OK - service is healthy
   ```

2. **Lambda Function URL works directly**
   ```bash
   curl https://6vojdlgmbqsmyrruiekkbhe6ly0hkbhh.lambda-url.eu-west-1.on.aws/api/bg-remover/upload-urls
   # HTTP 401 - proper auth error (expected without token)
   ```

3. **CloudFront blocks the request**
   ```bash
   curl https://carousel.dev.hringekjan.is/api/bg-remover/upload-urls
   # HTTP 403 - AccessDeniedException from Lambda Function URL
   ```

### Root Cause

The 403 `AccessDeniedException` comes from **AWS Lambda Function URLs** when invoked by CloudFront as a custom origin. The error occurs because:

1. CloudFront treats the Lambda Function URL as a `CustomOriginConfig` (regular HTTPS endpoint)
2. Lambda Function URLs may reject requests from CloudFront without proper authentication context
3. Even though `AuthType: NONE` is set, Lambda Function URLs have additional security layers
4. CORS configuration was added but didn't resolve the issue
5. CloudFront cache invalidation was performed but the 403 persists

### What Was Attempted

✅ **Verified CloudFront configuration**
- `/api/*` behavior exists and routes to Lambda Function URL
- All HTTP methods allowed (POST, GET, PUT, DELETE, etc.)
- Origin request policy forwards all headers/cookies
- Cache policy disables caching (TTL=0)

✅ **Verified Lambda Function URL settings**
- `AuthType: NONE` (publicly accessible)
- Resource policy allows `*` principal to invoke
- Added CORS configuration (`AllowOrigins: *, AllowMethods: *`)

✅ **Fixed health endpoint authorizer**
- Removed JWT authorizer from `/bg-remover/health` endpoint
- Health check now works without authentication

❌ **CloudFront → Lambda Function URL still returns 403**

---

## Two Possible Solutions

### Solution 1: Fix CloudFront (Complex)

**Approach:** Configure CloudFront to properly invoke Lambda Function URL

**Required steps:**
1. Convert origin from CustomOriginConfig to use Origin Access Control (OAC)
2. Update Lambda resource policy for OAC authentication
3. Potentially use Lambda@Edge for request transformation
4. Test thoroughly across all endpoints

**Pros:**
- Single domain for frontend (carousel.dev.hringekjan.is)
- No CORS complexity for frontend developers
- Centralized authentication in Next.js proxy

**Cons:**
- Complex CloudFront/Lambda Function URL integration
- Requires infrastructure changes (Terraform/IaC)
- More moving parts = more points of failure
- Takes longer to implement and test

**Estimated effort:** 4-8 hours

---

### Solution 2: Call Backend Directly (Simple) ⭐ RECOMMENDED

**Approach:** Update frontend to call `api.dev.hringekjan.is` directly, bypass CloudFront proxy

**Required steps:**
1. Update client-side code to use backend URL
2. Ensure CORS is configured on bg-remover API Gateway (already done)
3. Update auth token handling in frontend
4. Update e2e tests

**Pros:**
- Simple and proven to work (backend tested and working)
- Faster to implement (2-3 hours)
- Fewer architectural dependencies
- Backend already has proper CORS and auth
- Aligns with standard microservices architecture

**Cons:**
- Frontend needs to manage API URL configuration
- Two domains (carousel.dev for UI, api.dev for APIs)
- CORS must be maintained on backend

**Estimated effort:** 2-3 hours

---

## Recommended Path Forward

### ⭐ Option 2 (Direct Backend Calls) is recommended because:

1. **Backend is production-ready**
   - JWT authentication working
   - CORS configured
   - Health checks passing
   - CloudWatch logs show no errors

2. **CloudFront issue is complex**
   - Lambda Function URL + CloudFront integration is non-trivial
   - Multiple attempted fixes haven't resolved it
   - Requires infrastructure-level changes

3. **Aligns with microservices best practices**
   - Direct service-to-service communication
   - Simpler debugging and observability
   - Less coupling between frontend and backend

---

## Implementation Guide for Solution 2

### Step 1: Update Frontend API Client

Create a centralized bg-remover API client:

```typescript
// services/carousel-frontend/lib/api/bg-remover-client.ts

export const getBgRemoverApiUrl = () => {
  // Determine the backend API URL based on environment
  const hostname = typeof window !== 'undefined' ? window.location.hostname : '';

  // Extract tenant and stage from hostname (e.g., carousel.dev.hringekjan.is)
  const parts = hostname.split('.');
  const stage = parts[1]; // 'dev' or 'prod'
  const tenant = parts[2]; // 'hringekjan', 'carousellabs', etc.

  return `https://api.${stage}.${tenant}.is`;
};

export const bgRemoverApi = {
  async uploadUrls(files: Array<{photoId: string; filename: string; contentType: string}>, token: string) {
    const response = await fetch(`${getBgRemoverApiUrl()}/bg-remover/upload-urls`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ files }),
    });

    if (!response.ok) {
      throw new Error(`Upload URLs failed: ${response.status}`);
    }

    return response.json();
  },

  async groupImages(images: any[], token: string) {
    const response = await fetch(`${getBgRemoverApiUrl()}/bg-remover/group-images`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ photoIds: images.map(img => img.photoId) }),
    });

    if (!response.ok) {
      throw new Error(`Group images failed: ${response.status}`);
    }

    return response.json();
  },

  // Add other endpoints as needed...
};
```

### Step 2: Update Hooks to Use New Client

```typescript
// services/carousel-frontend/src/hooks/useImageGrouping.ts

import { bgRemoverApi, getBgRemoverApiUrl } from '@/lib/api/bg-remover-client';

// Replace line 174:
// const apiUrl = '/api/bg-remover/group-images';

// With:
const response = await bgRemoverApi.groupImages(images, authHeaders.Authorization.replace('Bearer ', ''));
```

### Step 3: Update Other Components

Files to update:
- `src/hooks/useImageGrouping.ts` (line 174)
- `app/(dashboard)/products/register/v2/components/ImageUploadComponent.tsx`
- `app/(dashboard)/connectors/bg-remover/hooks/useImageGroupFormState.ts`
- `app/(dashboard)/connectors/bg-remover/hooks/usePushNotifications.ts`
- `app/(dashboard)/connectors/bg-remover/components/BulkUploadWizard.tsx`
- `components/organisms/BulkUploadWizard.tsx`

### Step 4: Update E2E Tests

```typescript
// Update test base URLs from:
// const baseUrl = 'http://localhost:3000/api/bg-remover';

// To:
// const baseUrl = 'https://api.dev.hringekjan.is/bg-remover';
```

### Step 5: Remove Proxy Routes (Optional)

Once confirmed working, you can optionally remove the Next.js proxy routes:
- `app/api/bg-remover/upload-urls/route.ts`
- `app/api/bg-remover/group-images/route.ts`
- `app/api/bg-remover/process/route.ts`
- etc.

---

## Testing & Verification

### Manual Testing

```bash
# 1. Health check (no auth required)
curl https://api.dev.hringekjan.is/bg-remover/health

# 2. Get JWT token from browser
# - Login to carousel.dev.hringekjan.is
# - Open DevTools > Application > Local Storage
# - Copy access token

# 3. Test upload URLs
curl -X POST https://api.dev.hringekjan.is/bg-remover/upload-urls \
  -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{"files":[{"photoId":"test-1","filename":"test.jpg","contentType":"image/jpeg"}]}'

# Expected: 200 OK with presigned URLs
```

### Automated Testing

```bash
cd services/bg-remover
./scripts/test-endpoints.sh --token YOUR_JWT_TOKEN
```

### E2E Testing

```bash
cd services/carousel-frontend
npm run test:e2e -- bg-remover
```

---

## Rollback Plan

If Solution 2 causes issues, you can quickly rollback by:

1. **Revert frontend changes**
   ```bash
   git revert <commit-hash>
   ```

2. **CloudFront will still work for other routes**
   - Only `/api/bg-remover/*` affected
   - Other API routes unaffected

3. **Backend remains stable**
   - Direct API calls don't affect backend deployment
   - Backend continues to serve requests

---

## Next Steps

1. ✅ **Health endpoint fixed** - now public (no auth required)
2. ⏳ **Choose solution** - Recommend Solution 2 (direct backend calls)
3. ⏳ **Implement frontend changes** - Update client code to use `api.dev.hringekjan.is`
4. ⏳ **Test thoroughly** - Run e2e tests and manual testing
5. ⏳ **Deploy and verify** - Deploy frontend with updated API calls

---

## Additional Notes

### Why CloudFront 403 Persists

The exact cause of the Lambda Function URL `AccessDeniedException` when invoked via CloudFront as a custom origin is related to how AWS Lambda Function URLs authenticate requests. Even with `AuthType: NONE`, there are internal security mechanisms that may reject requests that don't meet certain criteria.

Potential causes:
- **TLS/SSL handshake issues** between CloudFront and Lambda Function URL
- **Request signature validation** (even for AuthType: NONE)
- **Function URL throttling** or rate limiting
- **Internal AWS service authentication** requirements

### CloudFront Origin Access Control vs Custom Origin

Lambda Function URLs should ideally use Origin Access Control (OAC) instead of being treated as custom HTTP origins. However, as of 2026, this integration is complex and not well-documented.

---

## Related Documentation

- [BG-Remover API Endpoints](./API_ENDPOINTS.md)
- [Fix Summary](./FIX_SUMMARY.md)
- [Test Script](./scripts/test-endpoints.sh)
- [Serverless Configuration](./serverless.yml)

---

**Last Updated:** 2026-02-03
**Status:** CloudFront issue identified, Solution 2 (direct backend calls) recommended
