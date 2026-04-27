---
title: "BG-Remover UI Deletion Timeline"
---

# BG-Remover UI Deletion Timeline

## Discovery

The bg-remover UI **was built and then deleted on the same day** (December 16, 2025).

---

## Timeline of Events

### Commit 1: `aecde80d` (Dec 16, 2025 20:48:04)
**Title:** "Deploy Product Identity system and code review fixes"

**Added bg-remover UI to carousel-frontend:**
```
services/carousel-frontend/app/staff/connectors/bg-remover/
├── page.tsx                                    # Main UI page
├── components/
│   ├── BulkUploadWizard.tsx                   # 2,435 lines - full upload UI
│   └── GroupPreviewPanel.tsx                  # Product clustering preview
├── hooks/
│   ├── useProductClustering.ts
│   └── useProductIdentityClustering.ts
├── __tests__/
│   └── validation/
│       ├── accuracy-test.ts
│       ├── cost-validation.ts
│       └── performance-benchmark.ts
└── docs/
    ├── OPERATIONAL_RUNBOOK.md
    ├── TECHNICAL_DOCUMENTATION.md
    └── USER_GUIDE.md
```

**Also moved old location:**
- ❌ Deleted: `app/staff/bg-remover/page.tsx`
- ❌ Deleted: `app/staff/bg-remover/components/BulkUploadWizard.tsx`
- ✅ Moved to: `app/staff/connectors/bg-remover/` (new connector pattern)

---

### Commit 2: `d71bcb3f` (Dec 16, 2025 20:56:38) **← CURRENT HEAD**
**Title:** "feat: implement code review fixes and Product Identity system"

**DELETED ALL bg-remover UI from carousel-frontend:**
```diff
- services/carousel-frontend/app/staff/connectors/bg-remover/page.tsx
- services/carousel-frontend/app/staff/connectors/bg-remover/components/BulkUploadWizard.tsx
- services/carousel-frontend/app/staff/connectors/bg-remover/components/GroupPreviewPanel.tsx
- services/carousel-frontend/app/staff/connectors/bg-remover/hooks/useProductClustering.ts
- services/carousel-frontend/app/staff/connectors/bg-remover/hooks/useProductIdentityClustering.ts
- services/carousel-frontend/app/staff/connectors/bg-remover/__tests__/ (all test files)
- services/carousel-frontend/app/staff/connectors/bg-remover/docs/ (all docs)
- services/carousel-frontend/app/api/bg-remover/ (all API routes)
- services/carousel-frontend/app/api/connectors/bg-remover/ (all connector routes)
```

**Also deleted supporting documentation:**
```diff
- .taskmaster/docs/bg-remover-product-identity-prd.md
- bg-remover.txt
- docs/carousel-analysis/bg-remover-analysis.md
- docs/carousel-analysis/bg-remover-connector-ui-spec.md
- docs/carousel-analysis/mem0-archivematrix-bg-remover-analysis.md
```

**Total:** ~40+ files deleted, including complete UI implementation

---

## Current State (as of commit d71bcb3f)

### ✅ What Still Exists

**1. bg-remover Lambda Backend (services/bg-remover/)**
- ✅ Deployed and operational
- ✅ Endpoints: `/dev/bg-remover/health`, `/process`, `/status/{jobId}`, `/settings`
- ✅ Product Identity Detection algorithm implemented
- ✅ Settings persistence to SSM Parameter Store

**2. bg-remover Frontend Stub (services/bg-remover/app/)**
- ⚠️ Next.js files exist but **NOT deployed**
- ⚠️ `serverless.yml` only deploys Lambda functions, not Next.js UI
- ⚠️ Files are orphaned (not accessible anywhere)

**3. carousel-frontend bg-remover connector directory**
- 📁 `services/carousel-frontend/app/staff/connectors/bg-remover/` exists
- ⚠️ Only contains `docs/` and `__tests__/` subdirectories
- ❌ No `page.tsx`, no components, no hooks
- ❌ Empty shell with no functional UI

---

### ❌ What Was Deleted

1. **Complete UI Implementation** (~2,500 lines)
   - Main page component
   - Bulk upload wizard
   - Product clustering preview
   - React hooks for state management

2. **API Routes** (Next.js backend)
   - `/api/bg-remover/process` routes
   - `/api/connectors/bg-remover/*` routes
   - Product Identity settings endpoints

3. **Testing Infrastructure**
   - Accuracy tests
   - Cost validation
   - Performance benchmarks
   - Test fixtures and datasets

4. **Documentation**
   - User guides
   - Operational runbooks
   - Technical documentation
   - Deployment checklists

---

## Why Was It Deleted?

**Hypothesis 1:** Code review cleanup
- Commit message mentions "code review fixes"
- Possibly removed incomplete or non-functional code

**Hypothesis 2:** Architecture decision
- Chose to use SSM-only approach (no UI needed)
- Deferred UI development to future phase

**Hypothesis 3:** Duplicate code elimination
- bg-remover service already has `app/` directory with UI files
- May have decided against carousel-frontend integration

**Hypothesis 4:** Incomplete implementation
- UI may have been non-functional or had blocking issues
- Removed to avoid confusion/tech debt

---

## What This Means

### For bg-remover UI Architecture Decision

The team **DID attempt carousel-frontend integration** but then removed it. This suggests:

1. ✅ **carousel-frontend integration was tried** - The code existed briefly
2. ❌ **Something went wrong** - It was deleted same day
3. ⚠️ **Decision unclear** - No clear documentation of why it was removed

### Recommended Next Steps

**Option A: Investigate why it was deleted**
```bash
# Review the full commit to understand why
git show d71bcb3f

# Check if there's a related PR or issue
gh pr list --search "bg-remover" --state all
gh issue list --search "bg-remover" --state all
```

**Option B: Recover the deleted UI**
```bash
# Checkout the deleted files from aecde80d
git checkout aecde80d -- services/carousel-frontend/app/staff/connectors/bg-remover/

# Review and test
# Commit if decision is to keep carousel-frontend integration
```

**Option C: Stick with current architecture**
- Use SSM-only for configuration (Option 1 from architecture decision doc)
- Delete orphaned files in `services/bg-remover/app/`
- Focus on Lambda backend only

---

## Files Available for Recovery

If you want to restore the deleted UI:

```bash
# Restore main page
git checkout aecde80d -- services/carousel-frontend/app/staff/connectors/bg-remover/page.tsx

# Restore bulk upload wizard
git checkout aecde80d -- services/carousel-frontend/app/staff/connectors/bg-remover/components/BulkUploadWizard.tsx

# Restore all bg-remover connector files
git checkout aecde80d -- services/carousel-frontend/app/staff/connectors/bg-remover/

# Restore API routes
git checkout aecde80d -- services/carousel-frontend/app/api/bg-remover/
git checkout aecde80d -- services/carousel-frontend/app/api/connectors/bg-remover/
```

---

## Questions to Answer

1. **Why was the UI deleted?**
   - Was it non-functional?
   - Was there a strategic decision to go SSM-only?
   - Was it incomplete/buggy?

2. **Should we restore it?**
   - If carousel-frontend integration is desired
   - If UI is still needed for non-technical users
   - If the code was actually functional

3. **What's the long-term plan?**
   - SSM-only (no UI ever)?
   - Standalone bg-remover UI service?
   - carousel-frontend integration (retry)?

---

## Summary

**TL;DR:**
- bg-remover UI **was built** in carousel-frontend on Dec 16
- bg-remover UI **was deleted** same day on Dec 16 (8 minutes later!)
- Current state: Lambda backend works, no UI anywhere
- Deleted code is recoverable from commit `aecde80d`
- Need to decide: restore, rebuild, or abandon UI entirely

**Next Action:** Determine why it was deleted before deciding whether to restore or rebuild.
