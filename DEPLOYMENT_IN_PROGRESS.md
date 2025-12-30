# Product Review Workflow - Deployment In Progress

**Date:** 2025-12-30
**Status:** 🚀 DEPLOYING TO DEV
**Deployment Method:** Official carousel-frontend deployment script

---

## Deployment Command

```bash
cd /Users/davideagle/git/CarouselLabs/enterprise-packages/services/carousel-frontend
bash scripts/deploy-carousel-frontend.sh dev
```

## Deployment Steps (6 Total)

### ✅ Step 1/6: Cleaning previous build artifacts
- Removed `.open-next` and `.next/cache` directories
- **Status:** Complete

### 🔄 Step 2/6: Building Next.js app with open-next
- Running: `SKIP_ENV_VALIDATION=1 npx open-next@latest build`
- **Status:** In Progress
- **Note:** This step typically takes 2-5 minutes

### ⏳ Step 3/6: Packaging Lambda functions (Pending)
- Will package server-function from `.open-next/server-functions/default/`
- Creates `server-function.zip`

### ⏳ Step 4/6: Deploying Lambda via serverless (Pending)
- Command: `TENANT=carousel-labs aws-vault exec carousel-labs-dev-admin -- npx serverless@4 deploy --stage dev --region eu-west-1`
- Deploys Lambda functions

### ⏳ Step 5/6: Syncing static assets to S3 (Pending)
- Syncs `.open-next/assets/` to `s3://carousel.dev.carousellabs.co/`
- Sets cache-control headers for immutability

### ⏳ Step 6/6: Invalidating CloudFront cache (Pending)
- Distribution: `E1MDGCKX8MLW78`
- Invalidates `/*` paths
- Propagation: 1-2 minutes

---

## Configuration

**Stage:** dev
**Tenant:** carousel-labs
**AWS Profile:** carousel-labs-dev-admin
**AWS Region:** eu-west-1
**S3 Bucket:** carousel.dev.carousellabs.co
**CloudFront ID:** E1MDGCKX8MLW78

**Domains Served:**
- https://carousel.dev.carousellabs.co
- https://carousel.dev.hringekjan.is

---

## Changes Being Deployed

### 1. Product Type Schema (`lib/types/product.ts`)
- Added review workflow fields: `status`, `booking_id`, `rejection_reason`, etc.

### 2. BookingSearchDialog Component (NEW)
- New file: `app/(dashboard)/connectors/bg-remover/components/BookingSearchDialog.tsx`
- Search bookings by email or name
- Real-time debounced search

### 3. BulkUploadWizard Component
- **State Management:** 5 new state variables
- **Handler Functions:** 6 new handlers (approve, reject, associate, bulk operations)
- **UI Enhancements:**
  - Booking search section with BookingSearchDialog
  - Bulk operations bar (approve/reject/associate selected)
  - Product card checkboxes for selection
  - Approve/Reject buttons on each card

---

## Post-Deployment Verification

Once deployment completes, verify:

1. **Health Check:**
   ```bash
   curl -I https://carousel.dev.hringekjan.is/auth/login
   # Expected: HTTP 200
   ```

2. **BG Remover Connector:**
   - Navigate to: https://carousel.dev.hringekjan.is/connectors/bg-remover
   - Upload images → Group → Process
   - Verify new features in Results step:
     - ✅ "Search Booking" button appears
     - ✅ BookingSearchDialog opens
     - ✅ Selected booking displays correctly
     - ✅ Approve/Reject buttons on each card
     - ✅ Bulk operations bar when products selected
     - ✅ Checkboxes for product selection

3. **API Endpoints:**
   ```bash
   # Products API
   curl https://api.dev.hringekjan.is/carousel-api/products

   # Bookings API
   curl https://api.dev.hringekjan.is/carousel-api/bookings
   ```

---

## Monitoring Deployment

**Background Task ID:** b278f2b
**Output File:** `/tmp/claude/-Users-davideagle-git-CarouselLabs-enterprise-packages/tasks/b278f2b.output`

**Monitor Progress:**
```bash
tail -f /tmp/claude/-Users-davideagle-git-CarouselLabs-enterprise-packages/tasks/b278f2b.output
```

---

## Estimated Timeline

- **Step 1:** Clean (instant) ✅
- **Step 2:** Build (~2-5 min) 🔄
- **Step 3:** Package (~10 sec) ⏳
- **Step 4:** Deploy (~2-3 min) ⏳
- **Step 5:** S3 Sync (~30 sec) ⏳
- **Step 6:** CloudFront (~10 sec) ⏳

**Total Estimated Time:** 5-10 minutes

---

## Rollback Plan

If deployment fails or issues arise:

```bash
cd /Users/davideagle/git/CarouselLabs/enterprise-packages/services/carousel-frontend
TENANT=carousel-labs aws-vault exec carousel-labs-dev-admin --no-session -- \
  npx serverless@4 rollback --stage dev --region eu-west-1
```

---

**Status:** Deployment in progress, monitoring output...
**Next Update:** After build completes (Step 2/6)
