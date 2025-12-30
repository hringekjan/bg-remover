# BG-Remover UI Architecture Decision

## Current State Analysis

### What Exists Today

**bg-remover Service:**
- ✅ **Lambda Backend** - Fully deployed and operational
  - Endpoints: `/dev/bg-remover/health`, `/process`, `/status/{jobId}`, `/settings`
  - Authentication: JWT via Cognito
  - Settings storage: SSM Parameter Store (`/tf/${stage}/${tenant}/services/bg-remover/settings`)
  - Product Identity Detection: Multi-signal algorithm implemented

- ⚠️ **Next.js UI Files** - Present but NOT deployed
  - Location: `services/bg-remover/app/`
  - Files: `page.tsx`, `layout.tsx`, `app/api/*`
  - Problem: `serverless.yml` only deploys Lambda functions, not the Next.js frontend
  - Status: **Orphaned code** - exists in repo but not accessible

**carousel-frontend Service:**
- ✅ **Next.js Application** - Appears to be the main admin UI
  - Has `.next`, `.sst`, `.serverless` directories (deployment artifacts)
  - Structure suggests it's deployed somewhere
  - Contains: `app/staff/`, `app/consignor/`, `app/admin/`, etc.

- 📝 **bg-remover Documentation** - Exists but no UI
  - Location: `services/carousel-frontend/app/staff/connectors/bg-remover/docs/`
  - Contains: operational guides, deployment checklists
  - Missing: Actual UI components (`page.tsx`, React components)

---

## Architectural Options

### Option 1: SSM-Only (No UI)

**Approach:** Manage bg-remover settings exclusively via AWS SSM Parameter Store

**Implementation:**
```bash
# Set Product Identity threshold
aws ssm put-parameter \
  --name "/tf/dev/carousel-labs/services/bg-remover/settings" \
  --type "String" \
  --value '{"productIdentity": {"threshold": 0.75}}' \
  --overwrite

# Get current settings
aws ssm get-parameter \
  --name "/tf/dev/carousel-labs/services/bg-remover/settings" \
  --region eu-west-1
```

**Pros:**
- ✅ **Zero development effort** - Already implemented
- ✅ **Works today** - Lambda backend reads from SSM
- ✅ **Infrastructure as Code** - Settings in Terraform/CloudFormation
- ✅ **No UI maintenance** - No frontend code to maintain
- ✅ **Low cost** - No CloudFront, S3, or Lambda@Edge resources

**Cons:**
- ❌ **Developer-only access** - Requires AWS CLI or Console knowledge
- ❌ **No validation feedback** - Must manually ensure signal weights sum to 1.0
- ❌ **No visual clustering preview** - Cannot see grouped products before deployment
- ❌ **Limited discoverability** - Settings not visible to non-technical users

**Best For:**
- Internal developer tools
- Configuration rarely changes
- Small technical team
- Cost-sensitive projects

**Estimated Effort:** 0 hours (already done)

---

### Option 2: Integrate into carousel-frontend

**Approach:** Build bg-remover UI as part of the existing carousel-frontend admin panel

**Implementation:**
1. Create `services/carousel-frontend/app/staff/connectors/bg-remover/page.tsx`
2. Build settings UI components
3. Add clustering preview page
4. Deploy as part of carousel-frontend

**Directory Structure:**
```
services/carousel-frontend/
└── app/
    └── staff/
        └── connectors/
            └── bg-remover/
                ├── page.tsx                          # Main connector page
                ├── settings/
                │   └── page.tsx                      # Settings management UI
                ├── cluster/
                │   └── page.tsx                      # Product clustering preview
                ├── components/
                │   ├── SettingsForm.tsx              # Product Identity controls
                │   ├── ProductGroupPreview.tsx       # Visual grouping display
                │   └── BulkUploadWizard.tsx          # Image upload flow
                └── hooks/
                    └── useProductIdentityClustering.ts
```

**API Client Integration:**
```typescript
// services/carousel-frontend/lib/api/bg-remover-client.ts
export class BGRemoverClient {
  private baseUrl = 'https://api.dev.carousellabs.co/bg-remover';

  async getSettings() {
    return this.request('/settings');
  }

  async updateSettings(settings: ProductIdentitySettings) {
    return this.request('/settings', {
      method: 'PUT',
      body: JSON.stringify({ settings }),
    });
  }
}
```

**Pros:**
- ✅ **Unified admin experience** - All connectors in one place
- ✅ **Shared authentication** - Reuse carousel-frontend auth
- ✅ **Consistent UI/UX** - Matches existing admin panels
- ✅ **Single deployment** - No separate bg-remover frontend deployment
- ✅ **Shared components** - Leverage existing design system
- ✅ **Role-based access** - Use carousel-frontend RBAC

**Cons:**
- ❌ **Tight coupling** - bg-remover UI tied to carousel-frontend releases
- ❌ **Development effort** - Need to build React components (~16 hours)
- ❌ **Deployment dependency** - Must deploy carousel-frontend to update bg-remover UI

**Best For:**
- Multi-connector platforms
- Shared admin panels
- Consistent user experience across services
- Staff/operator-facing tools

**Estimated Effort:** ~16 hours (from TASKS_REMAINING.md)

---

### Option 3: Standalone Next.js Service

**Approach:** Deploy bg-remover UI as a separate Next.js application

**Implementation:**
1. Keep `services/bg-remover/app/` UI files
2. Add serverless-nextjs deployment config
3. Deploy to separate CloudFront distribution
4. URL: `https://bg-remover.dev.carousellabs.co`

**Serverless Configuration:**
```yaml
# services/bg-remover/serverless.yml
plugins:
  - '@carousellabs/serverless-nextjs-frontend-kit'

custom:
  nextjsApp:
    enabled: true
    runtime: nodejs22.x
    domain: bg-remover.${sls:stage}.carousellabs.co
```

**Pros:**
- ✅ **Independent deployment** - UI and backend deploy separately
- ✅ **Focused functionality** - Dedicated to bg-remover operations
- ✅ **Version control** - UI and backend versioned together
- ✅ **Isolated resources** - Own CloudFront, S3, Lambda@Edge

**Cons:**
- ❌ **Duplicate deployment infrastructure** - Separate CloudFront, S3, DNS
- ❌ **Higher cost** - Additional CloudFront distribution (~$1-5/month)
- ❌ **Authentication complexity** - Need separate Cognito integration
- ❌ **Maintenance overhead** - Two services to monitor and update
- ❌ **Fragmented UX** - Users navigate between different apps

**Best For:**
- Public-facing tools
- External customer access
- Independent product lifecycle
- Different authentication requirements

**Estimated Effort:** ~20 hours (includes Next.js deployment setup)

---

## Recommendation

### Short-term (Now): **Option 1 - SSM-Only**

**Rationale:**
- Lambda backend is production-ready
- Settings already persist to SSM
- Zero additional development needed
- Sufficient for technical team configuration

**Quick Start:**
```bash
# Update Product Identity threshold
aws ssm put-parameter \
  --name "/tf/dev/carousel-labs/services/bg-remover/settings" \
  --type "String" \
  --value '{
    "productIdentity": {
      "enabled": true,
      "threshold": 0.70,
      "signalWeights": {
        "spatial": 0.40,
        "feature": 0.35,
        "semantic": 0.15,
        "composition": 0.05,
        "background": 0.05
      }
    }
  }' \
  --overwrite \
  --region eu-west-1
```

---

### Long-term (Future): **Option 2 - Integrate into carousel-frontend**

**Rationale:**
- bg-remover is a "connector" service (like Shopify, Klaviyo)
- Fits naturally into `/staff/connectors/` navigation
- Reuses existing authentication, RBAC, and UI components
- Provides unified admin experience

**When to Build:**
- When non-technical users need to adjust settings
- When visual product clustering preview becomes valuable
- When carousel-frontend has stable connector UI pattern

**Next Steps:**
1. Verify carousel-frontend deployment mechanism (SST, Serverless, etc.)
2. Create connector page template at `app/staff/connectors/bg-remover/page.tsx`
3. Build settings form with validation
4. Add clustering preview components
5. Integrate with Lambda `/settings` and `/process` endpoints

---

## Decision Matrix

| Criteria | SSM-Only | carousel-frontend | Standalone |
|----------|----------|-------------------|------------|
| **Development Effort** | None | ~16 hours | ~20 hours |
| **Maintenance Cost** | Minimal | Low | High |
| **Infrastructure Cost** | $0 | $0 (shared) | $1-5/month |
| **User Experience** | CLI only | Unified admin | Dedicated UI |
| **Access Control** | AWS IAM | carousel RBAC | Separate auth |
| **Time to Market** | Immediate | 2-3 days | 3-4 days |
| **Long-term Scalability** | Low | High | Medium |

---

## Current Status

- ✅ **Lambda backend**: Deployed and operational
- ✅ **SSM settings**: Working with validation
- ✅ **Product Identity algorithm**: Implemented
- ❌ **UI components**: Not built
- ❌ **API client**: Not integrated with carousel-frontend
- ❌ **Deployment**: No frontend deployment mechanism

---

## Action Items

### Immediate (This Sprint)
- [ ] **Use SSM-only approach** - Document parameter structure
- [ ] **Delete orphaned UI files** - Remove `services/bg-remover/app/` (if confirmed not needed)
- [ ] **Update documentation** - SSM configuration guide
- [ ] **Test Lambda endpoints** - Verify settings persistence

### Future (Next Quarter)
- [ ] **Evaluate carousel-frontend integration** - When UI demand arises
- [ ] **Design connector UI pattern** - Standardize `/staff/connectors/*` pages
- [ ] **Build settings management UI** - Product Identity controls
- [ ] **Add clustering preview** - Visual product grouping interface

---

## Questions to Resolve

1. **Is carousel-frontend the primary admin interface?**
   - If yes → Option 2 (integrate)
   - If no → Option 1 (SSM-only)

2. **Who needs to adjust bg-remover settings?**
   - Developers only → Option 1 (SSM-only)
   - Operators/staff → Option 2 (carousel-frontend)
   - External customers → Option 3 (standalone)

3. **How often will settings change?**
   - Rarely (monthly/quarterly) → Option 1 (SSM-only)
   - Frequently (weekly) → Option 2 (carousel-frontend)

4. **Is visual product clustering preview valuable?**
   - No → Option 1 (SSM-only)
   - Yes, for staff → Option 2 (carousel-frontend)
   - Yes, for customers → Option 3 (standalone)

---

## Conclusion

**Recommended Path:**
1. **Now:** Use SSM-only (Option 1) - Zero effort, works today
2. **Later:** Integrate into carousel-frontend (Option 2) - When UI demand justifies development

**Do NOT:**
- Build standalone Next.js service (Option 3) - High cost, low value
- Keep orphaned UI files in `services/bg-remover/app/` - Creates confusion

**Next Step:** Confirm with team whether carousel-frontend is the intended admin UI platform.
