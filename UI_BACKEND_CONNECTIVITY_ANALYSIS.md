# BG-Remover UI/Backend Connectivity Analysis

## 🚨 **CRITICAL FINDING: Dual Architecture - Disconnected Systems**

The bg-remover service has **TWO separate implementations** that are NOT connected:

### 1️⃣ **Lambda Backend** (Deployed to AWS)
- **Location**: `src/handler.ts`
- **Deployment**: Serverless Framework → AWS Lambda
- **Endpoints**: `/dev/bg-remover/*` via API Gateway
- **Status**: ✅ **DEPLOYED and OPERATIONAL**

### 2️⃣ **Next.js Frontend** (Local Dev Only)
- **Location**: `app/` directory
- **Runtime**: Next.js API routes + React UI
- **Endpoints**: `/api/*` (local development server)
- **Status**: ⚠️ **NOT DEPLOYED - Local dev only**

---

## 📊 Backend Endpoints Comparison

### Lambda Endpoints (Deployed - Production)

| Endpoint | Handler | Status | Auth Required | Purpose |
|----------|---------|--------|---------------|---------|
| `GET /dev/bg-remover/health` | `dist/handler.health` | ✅ Working | No | Health check |
| `POST /dev/bg-remover/process` | `dist/handler.process` | ✅ Deployed | Yes (JWT) | Single image processing |
| `GET /dev/bg-remover/status/{jobId}` | `dist/handler.status` | ✅ Deployed | No | Job status lookup |
| `DELETE /dev/bg-remover/status/{jobId}` | `dist/handler.status` | ✅ Deployed | No | Cancel job |
| `GET /dev/bg-remover/settings` | `dist/handler.settings` | ✅ Working | Yes (JWT) | Get settings |
| `PUT /dev/bg-remover/settings` | `dist/handler.settings` | ✅ Working | Yes (JWT) | Update settings |

**Settings Schema** (Unified - Legacy + Product Identity):
```json
{
  "detectDuplicates": true,
  "groupByColor": true,
  "duplicateThreshold": 0.85,
  "colorGroups": 3,
  "maxImagesPerGroup": 10,
  "productIdentity": {
    "enabled": true,
    "threshold": 0.70,
    "minGroupSize": 1,
    "maxGroupSize": 6,
    "useRekognition": true,
    "signalWeights": {
      "spatial": 0.40,
      "feature": 0.35,
      "semantic": 0.15,
      "composition": 0.05,
      "background": 0.05
    }
  }
}
```

### Next.js API Routes (Local Dev Only)

| Route | File | Status | Connected to Lambda? | Purpose |
|-------|------|--------|---------------------|---------|
| `GET /api/health` | `app/api/health/route.ts` | ✅ Working | ❌ NO - Standalone | Health check (local) |
| `POST /api/process` | `app/api/process/route.ts` | ✅ Working | ❌ NO - Standalone | Image processing (local) |
| `GET /api/status/{jobId}` | `app/api/status/[jobId]/route.ts` | ✅ Exists | ❌ NO | Job status (local) |
| `POST /api/batch` | `app/api/batch/route.ts` | ✅ Exists | ❌ NO | Batch processing (local) |
| `POST /api/cluster` | `app/api/cluster/route.ts` | ✅ Exists | ❌ NO | Legacy clustering (NOT Product Identity) |
| `GET/PUT /api/settings` | `app/api/settings/route.ts` | ✅ Exists | ❌ NO - In-memory only | Settings (NOT using SSM) |

---

## 🎨 UI Components Status

### Current UI (`app/page.tsx`)
```typescript
// Calls LOCAL Next.js route, NOT Lambda backend
const response = await fetch('/api/process', {
  method: 'POST',
  body: JSON.stringify({
    imageUrl,
    outputFormat: 'png',
    quality: 95,
    tenant: 'carousel-labs',
  }),
});
```

**Status**: ✅ Works in local dev, ❌ **NOT connected to deployed Lambda backend**

### Product Identity Detection UI
**Status**: ❌ **NOT IMPLEMENTED**

Created files (not integrated):
- ✅ `types/product-identity-settings.ts` - Type definitions
- ✅ `utils/ImageFeatureExtractor.ts` - Feature extraction
- ✅ `services/ProductIdentityService.ts` - Multi-signal detection
- ✅ `hooks/useProductIdentityClustering.ts` - React hook
- ❌ **No UI component uses these files**
- ❌ **No page displays product groups**
- ❌ **No settings page for configuration**

---

## 🔌 Connection Issues

### Issue 1: UI Calls Local Routes, Not Lambda
**Problem**: The UI at `app/page.tsx` calls `/api/process` which is a Next.js API route running locally, NOT the deployed Lambda at `/dev/bg-remover/process`.

**Impact**:
- ❌ Local development works
- ❌ **Deployed version would fail** (no Next.js server in Lambda deployment)
- ❌ Settings changes in UI don't persist to SSM Parameter Store
- ❌ Credit validation happens locally, not via Lambda

**Fix Required**:
```typescript
// Option A: Proxy through Next.js API route
// app/api/process/route.ts
const lambdaResponse = await fetch(
  'https://6b3bf1bqk3.execute-api.eu-west-1.amazonaws.com/dev/bg-remover/process',
  { method: 'POST', body: JSON.stringify(request) }
);

// Option B: Call Lambda directly from client
// app/page.tsx
const response = await fetch(
  'https://6b3bf1bqk3.execute-api.eu-west-1.amazonaws.com/dev/bg-remover/process',
  { method: 'POST', headers: { Authorization: `Bearer ${token}` } }
);
```

### Issue 2: Settings Not Connected
**Problem**: `app/api/settings/route.ts` uses in-memory storage with 5-minute cache, NOT SSM Parameter Store.

**Current** (Local):
```typescript
let cachedSettings: ProductIdentitySettings = DEFAULT_SETTINGS;
let cacheTimestamp: number = Date.now();
```

**Deployed Lambda** (Production):
```typescript
const ssmClient = new SSMClient({ region: 'eu-west-1' });
const ssmPath = `/tf/${stage}/${tenant}/services/bg-remover/settings`;
const response = await ssmClient.send(new GetParameterCommand({ Name: ssmPath }));
```

**Impact**:
- ❌ Settings changes in UI are lost on page reload
- ❌ Settings don't persist to AWS SSM
- ❌ Different tenants can't have different settings

### Issue 3: Product Identity Detection Not Used
**Problem**: The Product Identity Detection feature is fully implemented but has ZERO UI integration.

**Missing Components**:
1. ❌ Settings page to configure Product Identity
2. ❌ Image clustering UI to visualize groups
3. ❌ Integration with bulk upload workflow
4. ❌ API route to call ProductIdentityService
5. ❌ Display for grouped product images

---

## 📁 File Structure Analysis

### ✅ **Working** (Deployed Lambda Backend)
```
src/
├── handler.ts                    # Lambda handlers (DEPLOYED)
│   ├── health()                 # ✅ Working at /dev/bg-remover/health
│   ├── process()                # ✅ Working at /dev/bg-remover/process
│   ├── status()                 # ✅ Working at /dev/bg-remover/status/{jobId}
│   └── settings()               # ✅ Working at /dev/bg-remover/settings
└── lib/                         # Lambda utilities
    ├── bedrock/                 # AWS Bedrock integration
    ├── credits/                 # Credits service client
    ├── s3/                      # S3 upload client
    └── tenant/                  # Tenant resolver
```

### ⚠️ **Local Only** (Next.js - Not Connected)
```
app/
├── page.tsx                      # UI - calls /api/process (local)
└── api/                         # Next.js API routes (LOCAL DEV ONLY)
    ├── health/route.ts          # ⚠️ Duplicate of Lambda handler
    ├── process/route.ts         # ⚠️ Duplicate of Lambda handler
    ├── status/[jobId]/route.ts  # ⚠️ Duplicate of Lambda handler
    ├── batch/route.ts           # ⚠️ Local only
    ├── cluster/route.ts         # ⚠️ Uses similarity-service (NOT Product Identity)
    └── settings/route.ts        # ⚠️ In-memory, not SSM
```

### ✅ **Implemented** (Not Integrated)
```
types/
└── product-identity-settings.ts  # ✅ Type definitions (unused)

utils/
└── ImageFeatureExtractor.ts      # ✅ Canvas operations (unused)

services/
└── ProductIdentityService.ts     # ✅ Multi-signal detection (unused)

hooks/
└── useProductIdentityClustering.ts # ✅ React hook (unused)
```

---

## 🎯 What Needs to Be Done

### Priority 1: Connect UI to Lambda Backend ⚠️ **CRITICAL**

**Option A: Proxy Pattern** (Recommended for development)
```typescript
// app/api/process/route.ts
export async function POST(request: NextRequest) {
  const body = await request.json();
  const token = request.headers.get('authorization');

  // Proxy to Lambda backend
  const lambdaResponse = await fetch(
    'https://6b3bf1bqk3.execute-api.eu-west-1.amazonaws.com/dev/bg-remover/process',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': token || '',
      },
      body: JSON.stringify(body),
    }
  );

  return NextResponse.json(await lambdaResponse.json());
}
```

**Option B: Direct Client Calls** (Simpler, recommended for production)
```typescript
// app/lib/api-client.ts
export class BGRemoverClient {
  private baseUrl = 'https://6b3bf1bqk3.execute-api.eu-west-1.amazonaws.com/dev/bg-remover';

  async processImage(imageUrl: string, token: string) {
    const response = await fetch(`${this.baseUrl}/process`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ imageUrl }),
    });
    return response.json();
  }

  async getSettings(token: string) {
    const response = await fetch(`${this.baseUrl}/settings`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    return response.json();
  }

  async updateSettings(settings: any, token: string) {
    const response = await fetch(`${this.baseUrl}/settings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ settings }),
    });
    return response.json();
  }
}
```

### Priority 2: Implement Product Identity UI

**2.1 Settings Management Page**
```typescript
// app/settings/page.tsx
'use client';

import { useState, useEffect } from 'react';
import { BGRemoverClient } from '@/lib/api-client';

export default function SettingsPage() {
  const [settings, setSettings] = useState(null);
  const client = new BGRemoverClient();

  useEffect(() => {
    const loadSettings = async () => {
      const token = getAuthToken(); // Get JWT from auth provider
      const data = await client.getSettings(token);
      setSettings(data.settings);
    };
    loadSettings();
  }, []);

  const handleSave = async () => {
    const token = getAuthToken();
    await client.updateSettings(settings, token);
  };

  return (
    <div>
      <h1>BG-Remover Settings</h1>

      {/* Product Identity Detection Settings */}
      <section>
        <h2>Product Identity Detection</h2>
        <label>
          <input
            type="checkbox"
            checked={settings?.productIdentity?.enabled}
            onChange={(e) => setSettings({
              ...settings,
              productIdentity: {
                ...settings.productIdentity,
                enabled: e.target.checked
              }
            })}
          />
          Enable Product Identity Detection
        </label>

        <label>
          Similarity Threshold: {settings?.productIdentity?.threshold}
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={settings?.productIdentity?.threshold}
            onChange={(e) => setSettings({
              ...settings,
              productIdentity: {
                ...settings.productIdentity,
                threshold: parseFloat(e.target.value)
              }
            })}
          />
        </label>

        {/* Signal Weights */}
        <h3>Signal Weights</h3>
        <label>Spatial (layout): {settings?.productIdentity?.signalWeights?.spatial}</label>
        <label>Feature (matching): {settings?.productIdentity?.signalWeights?.feature}</label>
        <label>Semantic (labels): {settings?.productIdentity?.signalWeights?.semantic}</label>
        {/* ... more weight sliders ... */}
      </section>

      <button onClick={handleSave}>Save Settings</button>
    </div>
  );
}
```

**2.2 Product Clustering UI**
```typescript
// app/cluster/page.tsx
'use client';

import { useState } from 'react';
import { useProductIdentityClustering } from '@/hooks/useProductIdentityClustering';

export default function ClusterPage() {
  const [images, setImages] = useState([]);
  const {
    groups,
    ungroupedImages,
    isProcessing,
    triggerClustering,
    splitGroup,
    mergeGroups,
  } = useProductIdentityClustering();

  const handleAnalyze = async () => {
    await triggerClustering(images);
  };

  return (
    <div>
      <h1>Product Identity Clustering</h1>

      {/* Image Upload */}
      <input type="file" multiple onChange={handleImageUpload} />
      <button onClick={handleAnalyze} disabled={isProcessing}>
        {isProcessing ? 'Analyzing...' : 'Analyze Products'}
      </button>

      {/* Display Groups */}
      {groups.map(group => (
        <div key={group.id} className="product-group">
          <h3>{group.name || `Group ${group.id}`}</h3>
          <p>Confidence: {(group.confidence * 100).toFixed(1)}%</p>
          <p>Images: {group.imageIds.length}</p>

          <div className="image-grid">
            {group.imageIds.map(imageId => (
              <img key={imageId} src={images.find(i => i.id === imageId)?.url} />
            ))}
          </div>

          <button onClick={() => splitGroup(group.id)}>Split Group</button>
        </div>
      ))}

      {/* Ungrouped Images */}
      {ungroupedImages.length > 0 && (
        <div className="ungrouped">
          <h3>Ungrouped Images ({ungroupedImages.length})</h3>
          {/* ... display ungrouped ... */}
        </div>
      )}
    </div>
  );
}
```

### Priority 3: Remove Duplicate Code

**Files to Remove** (duplicates of Lambda handlers):
- ❌ `app/api/health/route.ts` - Use Lambda `/dev/bg-remover/health` instead
- ❌ `app/api/process/route.ts` - Use Lambda `/dev/bg-remover/process` instead
- ❌ `app/api/status/[jobId]/route.ts` - Use Lambda `/dev/bg-remover/status/{jobId}` instead
- ⚠️ `app/api/settings/route.ts` - Replace with Lambda client or remove in-memory storage

**Keep**:
- ✅ `app/api/cluster/route.ts` - If using legacy similarity-service
- ✅ `app/api/batch/route.ts` - If batch processing is Next.js specific

---

## 🧪 Testing Checklist

### Backend (Lambda) ✅ **VERIFIED**
- [x] Health endpoint returns 200 OK
- [x] Settings GET requires JWT authentication (401 without token)
- [x] Settings PUT requires JWT authentication (401 without token)
- [x] Settings include both legacy and Product Identity schemas
- [x] Signal weights validation (must sum to 1.0)
- [x] Settings persist to SSM Parameter Store

### Frontend (Next.js) ⚠️ **NEEDS WORK**
- [ ] UI calls Lambda endpoints, not local routes
- [ ] Settings page exists and connects to Lambda
- [ ] Product Identity clustering UI exists
- [ ] JWT authentication flow works end-to-end
- [ ] Multi-tenant settings work correctly
- [ ] Product groups display with metadata

---

## 📋 Summary

### ✅ What's Working
1. **Lambda Backend** - All endpoints deployed and operational
2. **Product Identity Settings** - Integrated into Lambda handler with full validation
3. **SSM Parameter Store** - Settings persist correctly
4. **JWT Authentication** - Required for sensitive endpoints

### ❌ What's Broken
1. **UI/Backend Disconnect** - UI calls local routes instead of Lambda
2. **Settings UI Missing** - No page to configure Product Identity
3. **Product Clustering UI Missing** - No visualization of product groups
4. **Duplicate Code** - Next.js routes duplicate Lambda handlers
5. **In-Memory Settings** - `app/api/settings/route.ts` doesn't use SSM

### 🎯 Next Actions (Priority Order)
1. **Connect UI to Lambda** - Replace local API calls with Lambda client
2. **Implement Settings UI** - Create `/settings` page for configuration
3. **Implement Clustering UI** - Create `/cluster` page for Product Identity
4. **Remove Duplicates** - Delete redundant Next.js API routes
5. **Add Authentication** - Integrate JWT auth provider in UI

---

## 🚀 Deployment Architecture Recommendation

### Current (Broken)
```
User → Next.js UI → Local Next.js API Routes → ❌ (not deployed)
User → ??? → Lambda Backend → ✅ (deployed but not accessible from UI)
```

### Recommended
```
User → Next.js UI → API Client → Lambda Backend (via API Gateway)
                     ↓
              JWT Auth Provider
```

**Implementation**:
1. Create `lib/api-client.ts` with `BGRemoverClient` class
2. Update `app/page.tsx` to use `BGRemoverClient`
3. Remove local Next.js API routes
4. Deploy Next.js app as static site (S3 + CloudFront)
5. All API calls go through API Gateway to Lambda
