# BG-Remover 403 Error - Root Cause & Fix Summary

## 🔍 Root Cause: Wrong URL Pattern

### The Problem
```
❌ WRONG: https://carousel.dev.hringekjan.is/api/bg-remover/upload-urls
✅ CORRECT: https://api.dev.hringekjan.is/bg-remover/upload-urls
```

### Two Mistakes
1. **Wrong subdomain:** `carousel.dev` → should be `api.dev`
2. **Extra `/api/` prefix:** `/api/bg-remover` → should be `/bg-remover`

### Evidence (CloudWatch Logs)
```
✅ Tenant resolved from host: api.dev.hringekjan.is -> hringekjan
✅ JWT validated successfully
✅ NO 403 errors in Lambda logs
```

**Conclusion:** Backend is working perfectly. Client is using wrong URL.

---

## ✅ Correct URL Pattern

```
https://api.{stage}.{tenant}.is/{service}/{endpoint}

Examples:
- Dev:  https://api.dev.hringekjan.is/bg-remover/upload-urls
- Prod: https://api.prod.hringekjan.is/bg-remover/upload-urls
```

---

## 🔧 How to Fix

### 1. Find Client Code
```bash
grep -rn "carousel.dev.*bg-remover" . --exclude-dir=node_modules
grep -rn "/api/bg-remover" . --exclude-dir=node_modules
```

### 2. Fix URLs
```diff
- const url = 'https://carousel.dev.hringekjan.is/api/bg-remover/upload-urls';
+ const url = 'https://api.dev.hringekjan.is/bg-remover/upload-urls';
```

### 3. Verify
```bash
# Test with curl
curl -X POST https://api.dev.hringekjan.is/bg-remover/upload-urls \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"files":[...]}'

# Or run test script
./scripts/test-endpoints.sh --token $JWT_TOKEN
```

---

## 📚 Created Resources

1. **API_ENDPOINTS.md** - Full endpoint documentation
2. **scripts/test-endpoints.sh** - E2E test script
3. **scripts/attach-authorizer.js** - Auto-attach authorizers
4. **This file** - Quick fix guide

---

**Next:** Update client code to use `https://api.dev.hringekjan.is/bg-remover/*`
