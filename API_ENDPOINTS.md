# BG-Remover API Endpoints Reference

## ✅ Correct URL Format

**Base URL:** `https://api.dev.hringekjan.is`

**⚠️ IMPORTANT:** Backend APIs use `api.dev.hringekjan.is` subdomain!

```
❌ WRONG:  https://carousel.dev.hringekjan.is/api/bg-remover/upload-urls
✅ CORRECT: https://api.dev.hringekjan.is/bg-remover/upload-urls
```

**URL Pattern:**
```
https://api.{stage}.{tenant}.is/bg-remover/{endpoint}

Examples:
- Dev + Hringekjan:  https://api.dev.hringekjan.is/bg-remover/upload-urls
- Prod + Hringekjan: https://api.prod.hringekjan.is/bg-remover/upload-urls
- Dev + Other tenant: https://api.dev.{tenant}.is/bg-remover/upload-urls
```

---

## 🔐 Authentication

All protected endpoints require:

```http
Authorization: Bearer <your-jwt-token>
Content-Type: application/json
```

Optional (but recommended):
```http
x-tenant-id: hringekjan
```

---

## 📝 Endpoints

### Upload URLs
Generate pre-signed S3 URLs for uploading images.

```http
POST /bg-remover/upload-urls
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "files": [
    {
      "photoId": "photo-123",
      "filename": "image.jpg",
      "contentType": "image/jpeg"
    }
  ]
}
```

**Response:**
```json
{
  "files": [
    {
      "photoId": "photo-123",
      "uploadUrl": "https://s3.amazonaws.com/...",
      "s3Key": "temp/hringekjan/uploads/...",
      "s3Bucket": "bg-remover-temp-images-dev"
    }
  ],
  "expiresIn": 900
}
```

---

### Process Image
Remove background from uploaded image.

```http
POST /bg-remover/process
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "imageUrl": "https://...",
  "options": {
    "outputFormat": "png",
    "quality": "high"
  }
}
```

---

### Group Images
Group similar images together.

```http
POST /bg-remover/group-images
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "photoIds": ["photo-1", "photo-2", "photo-3"]
}
```

---

### Create Products
Create products from processed images.

```http
POST /bg-remover/create-products
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "products": [
    {
      "name": "Product Name",
      "images": ["https://..."],
      "metadata": {...}
    }
  ]
}
```

---

### Process Groups
Process multiple image groups.

```http
POST /bg-remover/process-groups
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "groups": [
    {
      "groupId": "group-1",
      "photoIds": ["photo-1", "photo-2"]
    }
  ]
}
```

---

### Pricing Calculator
Calculate pricing for products.

```http
POST /bg-remover/pricing/calculate
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "productId": "product-123",
  "category": "electronics"
}
```

---

### Metadata Approval
Approve or reject product metadata.

```http
POST /bg-remover/metadata-approval
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "productId": "product-123",
  "approved": true,
  "metadata": {...}
}
```

---

### Job Status
Get status of a background job.

```http
GET /bg-remover/status/{jobId}
Authorization: Bearer <jwt>
```

**Response:**
```json
{
  "jobId": "job-123",
  "status": "completed",
  "progress": 100,
  "result": {...}
}
```

---

### Group Status
Get status of an image grouping job.

```http
GET /bg-remover/group-status/{jobId}
Authorization: Bearer <jwt>
```

---

### Settings
Get or update service settings.

```http
GET /bg-remover/settings
Authorization: Bearer <jwt>
```

```http
PUT /bg-remover/settings
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "similarityThreshold": 0.85,
  "autoApprove": false
}
```

---

### Metrics
Get service metrics and statistics.

```http
GET /bg-remover/metrics
Authorization: Bearer <jwt>
```

---

### Health Check
Check service health (no auth required).

```http
GET /bg-remover/health
```

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2026-02-03T...",
  "version": "1.0.0"
}
```

---

### Stats
Get public statistics (no auth required).

```http
GET /bg-remover/stats
```

---

## 🧪 Testing with cURL

### Get JWT Token
```bash
# Get token from Cognito (replace with your credentials)
JWT_TOKEN=$(aws cognito-idp initiate-auth \
  --auth-flow USER_PASSWORD_AUTH \
  --client-id <your-client-id> \
  --auth-parameters USERNAME=<username>,PASSWORD=<password> \
  --query 'AuthenticationResult.AccessToken' \
  --output text)
```

### Test Upload URLs
```bash
curl -X POST https://api.dev.hringekjan.is/bg-remover/upload-urls \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "files": [
      {
        "photoId": "test-123",
        "filename": "test.jpg",
        "contentType": "image/jpeg"
      }
    ]
  }'
```

### Test Health Check (no auth)
```bash
curl https://api.dev.hringekjan.is/bg-remover/health
```

---

## 🐛 Troubleshooting

### 403 Forbidden Error

**Symptoms:**
```
POST https://carousel.dev.hringekjan.is/api/bg-remover/upload-urls
Status: 403 Forbidden
```

**Causes:**
1. Wrong subdomain (`carousel.dev` instead of `api.dev`)
2. Extra `/api/` prefix in path

**Fix:** Use correct backend URL:
```diff
- POST https://carousel.dev.hringekjan.is/api/bg-remover/upload-urls
+ POST https://api.dev.hringekjan.is/bg-remover/upload-urls
```

**Key differences:**
- Subdomain: `api.dev.hringekjan.is` (NOT `carousel.dev.hringekjan.is`)
- Path: `/bg-remover/upload-urls` (NO `/api/` prefix)

---

### 401 Unauthorized Error

**Symptoms:**
```json
{
  "error": "Valid JWT token required"
}
```

**Causes:**
1. Missing `Authorization` header
2. Invalid/expired JWT token
3. Wrong Cognito User Pool

**Fix:**
```bash
# Ensure Authorization header is set
curl -H "Authorization: Bearer $JWT_TOKEN" ...

# Verify token is not expired
jwt decode $JWT_TOKEN
```

---

### CORS Errors

**Symptoms:**
```
Access-Control-Allow-Origin error in browser console
```

**Cause:** Missing OPTIONS preflight or wrong origin.

**Fix:** Ensure your client sends proper CORS preflight:
```javascript
fetch('/bg-remover/upload-urls', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({...})
})
```

---

## 📊 CloudWatch Logs

View logs for debugging:

```bash
# Upload URLs function
aws-vault exec carousel-labs-dev-admin -- \
  aws logs tail /aws/lambda/bg-remover-dev-uploadUrls --follow

# Process function
aws-vault exec carousel-labs-dev-admin -- \
  aws logs tail /aws/lambda/bg-remover-dev-process --follow

# All bg-remover functions
aws-vault exec carousel-labs-dev-admin -- \
  aws logs tail /aws/lambda/bg-remover-dev- --follow
```

---

## 🔧 API Gateway Info

- **API Gateway ID:** 6b3bf1bqk3
- **Authorizer ID:** z5vy51 (multi-tenant-jwt-authorizer)
- **Authorizer Type:** CUSTOM (Lambda authorizer)
- **Stage:** dev
- **Region:** eu-west-1

---

## 📚 Related Documentation

- [Serverless Configuration](./serverless.yml)
- [Upload URLs Handler](./src/handlers/upload-urls-handler.ts)
- [JWT Validator](./src/lib/auth/jwt-validator.ts)
- [E2E Tests](./tests/e2e/)
- [Deployment Script](./scripts/attach-authorizer.js)

---

## ✅ Verification

After deployment, verify endpoints work:

```bash
# Run e2e tests
npm test

# Test all endpoints with script
./scripts/test-endpoints.sh

# Manual curl test
curl https://carousel.dev.hringekjan.is/bg-remover/health
```

---

**Last Updated:** 2026-02-03
**Version:** 1.0.0
