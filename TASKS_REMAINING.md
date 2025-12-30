# BG-Remover - Tasks Remaining

## ✅ What's Already Done

### Backend (100% Complete)
- ✅ Lambda handlers deployed and operational
- ✅ Product Identity Detection algorithm implemented (SSIM, feature matching, clustering)
- ✅ Settings endpoint integrated with SSM Parameter Store
- ✅ Unified settings schema (legacy + Product Identity)
- ✅ Comprehensive validation (signal weights must sum to 1.0)
- ✅ JWT authentication on sensitive endpoints
- ✅ All endpoints tested and working:
  - `GET /dev/bg-remover/health` → 200 OK
  - `POST /dev/bg-remover/process` → Requires JWT
  - `GET /dev/bg-remover/settings` → Requires JWT
  - `PUT /dev/bg-remover/settings` → Requires JWT

### Implementation Files (100% Complete)
- ✅ `types/product-identity-settings.ts` - Type definitions with Zod validation
- ✅ `utils/ImageFeatureExtractor.ts` - Canvas operations, edge detection, caching
- ✅ `services/ProductIdentityService.ts` - Multi-signal detection engine
- ✅ `hooks/useProductIdentityClustering.ts` - React state management

---

## ❌ What Needs to Be Built

The **core Product Identity Detection algorithm is complete**, but it has **ZERO UI integration**. The UI also doesn't connect to the deployed Lambda backend.

---

## 🎯 Task List (Priority Order)

### **CRITICAL - Task 1: Connect UI to Lambda Backend**

**Problem**: UI calls local Next.js routes (`/api/process`) instead of deployed Lambda endpoints (`/dev/bg-remover/process`)

**What to Build**:

#### 1.1 Create API Client Wrapper
**File**: `lib/api-client.ts`

```typescript
export class BGRemoverClient {
  private baseUrl: string;
  private token: string | null = null;

  constructor() {
    this.baseUrl = process.env.NEXT_PUBLIC_API_URL ||
      'https://6b3bf1bqk3.execute-api.eu-west-1.amazonaws.com/dev/bg-remover';
  }

  setAuthToken(token: string) {
    this.token = token;
  }

  private async request(path: string, options: RequestInit = {}) {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers,
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  async health() {
    return this.request('/health');
  }

  async processImage(params: {
    imageUrl?: string;
    imageBase64?: string;
    outputFormat?: 'png' | 'jpeg' | 'webp';
    quality?: number;
  }) {
    return this.request('/process', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  async getJobStatus(jobId: string) {
    return this.request(`/status/${jobId}`);
  }

  async getSettings() {
    return this.request('/settings');
  }

  async updateSettings(settings: any) {
    return this.request('/settings', {
      method: 'PUT',
      body: JSON.stringify({ settings }),
    });
  }
}

export const apiClient = new BGRemoverClient();
```

**Estimated Time**: 1 hour

#### 1.2 Update Main UI to Use API Client
**File**: `app/page.tsx`

**Change**:
```typescript
// OLD (calls local route)
const response = await fetch('/api/process', { ... });

// NEW (calls Lambda)
import { apiClient } from '@/lib/api-client';

const result = await apiClient.processImage({
  imageUrl,
  outputFormat: 'png',
  quality: 95,
});
```

**Estimated Time**: 30 minutes

#### 1.3 Add Authentication Flow
**File**: `lib/auth-provider.tsx` (or use existing auth)

```typescript
'use client';
import { createContext, useContext, useState } from 'react';
import { apiClient } from './api-client';

const AuthContext = createContext<{
  token: string | null;
  login: (token: string) => void;
  logout: () => void;
}>(null!);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(null);

  const login = (newToken: string) => {
    setToken(newToken);
    apiClient.setAuthToken(newToken);
    localStorage.setItem('auth_token', newToken);
  };

  const logout = () => {
    setToken(null);
    apiClient.setAuthToken('');
    localStorage.removeItem('auth_token');
  };

  return (
    <AuthContext.Provider value={{ token, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
```

**Estimated Time**: 2 hours (with Cognito integration)

**Total for Task 1**: ~3.5 hours

---

### **Task 2: Build Settings UI Page**

**File**: `app/settings/page.tsx`

**Features**:
1. Load settings from Lambda `/settings` endpoint
2. Display Product Identity Detection controls:
   - Enable/disable toggle
   - Threshold slider (0-1)
   - Min/max group size inputs
   - AWS Rekognition toggle
   - Signal weight sliders (spatial, feature, semantic, composition, background)
   - Real-time validation (weights must sum to 1.0)
3. Save button → PUT to `/settings` endpoint
4. Success/error notifications

**UI Mockup**:
```
╔══════════════════════════════════════════════════╗
║  BG-Remover Settings                             ║
╠══════════════════════════════════════════════════╣
║                                                  ║
║  Product Identity Detection                      ║
║  ┌────────────────────────────────────────────┐ ║
║  │ [✓] Enable Product Identity Detection     │ ║
║  │                                            │ ║
║  │ Similarity Threshold: 0.70                │ ║
║  │ ├────────────────○──────────┤ 0.00 - 1.00 │ ║
║  │                                            │ ║
║  │ Min Group Size: [1]  Max Group Size: [6]  │ ║
║  │                                            │ ║
║  │ [✓] Use AWS Rekognition                   │ ║
║  │                                            │ ║
║  │ Signal Weights (must sum to 1.0):         │ ║
║  │   Spatial (layout):     0.40 ▓▓▓▓▓▓▓▓░░   │ ║
║  │   Feature (matching):   0.35 ▓▓▓▓▓▓▓░░░   │ ║
║  │   Semantic (labels):    0.15 ▓▓▓░░░░░░░   │ ║
║  │   Composition:          0.05 ▓░░░░░░░░░   │ ║
║  │   Background:           0.05 ▓░░░░░░░░░   │ ║
║  │                         Sum: 1.00 ✓        │ ║
║  └────────────────────────────────────────────┘ ║
║                                                  ║
║  Legacy Duplicate Detection                      ║
║  ┌────────────────────────────────────────────┐ ║
║  │ [✓] Detect duplicates                     │ ║
║  │ [✓] Group by color                        │ ║
║  │ Duplicate threshold: 0.85                 │ ║
║  │ Color groups: [3]                         │ ║
║  │ Max images per group: [10]                │ ║
║  └────────────────────────────────────────────┘ ║
║                                                  ║
║                        [Save Settings]           ║
╚══════════════════════════════════════════════════╝
```

**Estimated Time**: 4 hours

---

### **Task 3: Build Product Clustering UI Page**

**File**: `app/cluster/page.tsx`

**Features**:
1. Image upload (drag & drop or file picker)
2. Preview uploaded images
3. "Analyze Products" button → calls `useProductIdentityClustering` hook
4. Display grouped products:
   - Group name (editable)
   - Confidence score
   - Member count
   - Image thumbnails in grid
   - Split/merge buttons
5. Ungrouped images section
6. Manual grouping tools (drag images to create groups)

**UI Mockup**:
```
╔══════════════════════════════════════════════════╗
║  Product Identity Clustering                     ║
╠══════════════════════════════════════════════════╣
║  [Upload Images]  [Analyze Products]             ║
║                                                  ║
║  ┌─ Group 1: "Red T-Shirts" ───────────────────┐║
║  │ Confidence: 85%  |  Images: 4              │ ║
║  │ ┌────┐ ┌────┐ ┌────┐ ┌────┐               │ ║
║  │ │img1│ │img2│ │img3│ │img4│               │ ║
║  │ └────┘ └────┘ └────┘ └────┘               │ ║
║  │            [Split Group] [Rename]          │ ║
║  └────────────────────────────────────────────┘ ║
║                                                  ║
║  ┌─ Group 2: "Blue Jeans" ──────────────────── ┐║
║  │ Confidence: 92%  |  Images: 3              │ ║
║  │ ┌────┐ ┌────┐ ┌────┐                      │ ║
║  │ │img5│ │img6│ │img7│                      │ ║
║  │ └────┘ └────┘ └────┘                      │ ║
║  │            [Split Group] [Rename]          │ ║
║  └────────────────────────────────────────────┘ ║
║                                                  ║
║  Ungrouped Images (2)                            ║
║  ┌────┐ ┌────┐                                  ║
║  │img8│ │img9│                                  ║
║  └────┘ └────┘                                  ║
╚══════════════════════════════════════════════════╝
```

**Estimated Time**: 6 hours

---

### **Task 4: Clean Up Duplicate Code**

**Files to Delete**:
- ❌ `app/api/health/route.ts` - Use Lambda `/dev/bg-remover/health`
- ❌ `app/api/process/route.ts` - Use Lambda `/dev/bg-remover/process`
- ❌ `app/api/status/[jobId]/route.ts` - Use Lambda `/dev/bg-remover/status/{jobId}`
- ❌ `app/api/settings/route.ts` - Use Lambda `/dev/bg-remover/settings`

**Keep** (if needed):
- ✅ `app/api/batch/route.ts` - If batch processing is frontend-specific
- ✅ `app/api/cluster/route.ts` - If using legacy similarity-service

**Commands**:
```bash
rm app/api/health/route.ts
rm app/api/process/route.ts
rm -rf app/api/status/
rm app/api/settings/route.ts
```

**Estimated Time**: 15 minutes

---

### **Task 5: Integration Testing**

**Test Cases**:
1. ✅ Health check: `apiClient.health()` → 200 OK
2. ✅ Image processing without auth → 401 Unauthorized
3. ✅ Image processing with JWT → Process image successfully
4. ✅ Load settings → Returns unified schema
5. ✅ Update Product Identity threshold → Persists to SSM
6. ✅ Invalid signal weights (sum ≠ 1.0) → 400 Bad Request
7. ✅ Upload 10 product images → Groups detected
8. ✅ Split group → Creates 2 new groups
9. ✅ Merge groups → Combines into 1 group

**Estimated Time**: 2 hours

---

## 📊 Time Estimates Summary

| Task | Estimated Time | Status |
|------|---------------|--------|
| 1. Connect UI to Lambda | 3.5 hours | ⏳ Not Started |
| 2. Build Settings UI | 4 hours | ⏳ Not Started |
| 3. Build Clustering UI | 6 hours | ⏳ Not Started |
| 4. Clean up duplicates | 15 minutes | ⏳ Not Started |
| 5. Integration testing | 2 hours | ⏳ Not Started |
| **TOTAL** | **~16 hours** | **0% Complete** |

---

## 🚀 Quick Start (Do This First)

If you want to get something working quickly, start with **Task 1.1 + 1.2** (2 hours):

1. Create `lib/api-client.ts`
2. Update `app/page.tsx` to use `apiClient.processImage()`
3. Test: Upload image → Should hit Lambda backend → Get result

This gets the basic UI/backend connection working. Then you can add auth, settings, and clustering UI.

---

## 🎯 Optional Enhancements (Future)

- [ ] Batch upload with progress tracking
- [ ] Export grouped products as CSV/JSON
- [ ] Product naming suggestions (using Claude API)
- [ ] Settings presets (aggressive grouping, conservative grouping)
- [ ] Visual similarity heatmap
- [ ] Integration with AWS Rekognition for semantic analysis
- [ ] A/B testing different signal weights
- [ ] Analytics dashboard (groups created, avg confidence, etc.)

---

## 📝 Notes

- **Backend is 100% complete** - All Lambda endpoints working
- **Frontend is 0% connected** - UI calls local routes instead of Lambda
- **Product Identity is implemented** - Just needs UI to expose it
- **Estimated completion time**: 2 work days (16 hours) for full integration
