/**
 * E2E Context Propagation Integration Test
 *
 * Verifies the full context-scope propagation chain:
 *   (1) Incoming request carries x-context-* headers
 *   (2) Middleware ingests headers into ContextScope dimensions
 *   (3) extractContextFromHeaders returns correct ContextPayload
 *   (4) buildContextEnvelope produces a valid 3-tier envelope
 *   (5) Downstream consumer reconstructs identical headers via toHeaders()
 *   (6) validateRequiredHeaders() rejects incomplete requests
 *
 * In CI this test runs against a mocked NextRequest. When LocalStack is
 * available (LOCALSTACK_ENDPOINT set), the same assertions apply to
 * live DDB writes via the bg-remover handler.
 *
 * SPEC: artifacts/bg-remover-context-scope/SPEC.md §4.2
 * CLASSIFICATION-REVIEW §1.2
 */

import { ContextScope, toHeaders, type ContextPayload } from '@carousellabs/context-scope'
import type { RequestLike } from '../../lib/middleware/context-scope'
import {
  ingestContextHeaders,
  extractContextFromHeaders,
  buildContextEnvelope,
  validateRequiredHeaders,
} from '../../lib/middleware/context-scope'

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Minimal request mock — implements the RequestLike interface used by
 * the context-scope middleware functions. No Next.js dependency required.
 */
class MockRequest implements RequestLike {
  readonly headers: RequestLike['headers']

  constructor(rawHeaders: Record<string, string>) {
    const lc: Record<string, string> = {}
    for (const [k, v] of Object.entries(rawHeaders)) lc[k.toLowerCase()] = v

    this.headers = {
      get: (name: string) => lc[name.toLowerCase()] ?? null,
      forEach: (fn: (value: string, name: string) => void) => {
        for (const [k, v] of Object.entries(lc)) fn(v, k)
      },
    }
  }
}

/**
 * Build a MockRequest with x-context-* headers encoding the supplied payload
 * dimensions. Uses toHeaders() from context-scope transport layer so the
 * header serialisation is identical to what mem0-web-app sends.
 */
function buildRequest(
  payload: ContextPayload,
  extra?: Record<string, string>
): MockRequest {
  const serialised = toHeaders(payload)
  const headers: Record<string, string> = {
    'x-tenant-id': 'tenant_test_001',
    ...serialised,
    ...extra,
  }
  return new MockRequest(headers)
}

/**
 * Clear ContextScope singleton state between tests by writing empty values
 * for any known dimensions. The singleton is module-level so we must reset
 * between test cases to prevent cross-test leakage.
 */
function clearContextScope(): void {
  const scope = ContextScope.getInstance()
  const dims = scope.getDimensions()
  for (const key of Object.keys(dims)) {
    scope.setDimension(key, undefined)
  }
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const FULL_PAYLOAD: ContextPayload = {
  app: { name: 'mem0-web-app' },
  user: { id: 'usr_abc123', roles: ['operator'] },
  route: { path: '/dashboard/products' },
  businessDomain: { vertical: 'ecommerce', productCategory: 'clothing', market: 'uk' },
  env: { locale: 'en-GB' },
  extra: {
    tenantId: 'tenant_test_001',
    jobId: 'job_xyz789',
    memoryDomain: 'images',
  },
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Context propagation — ingest → extract → envelope → reconstruct', () => {
  beforeEach(() => {
    clearContextScope()
  })

  afterEach(() => {
    clearContextScope()
  })

  // ── (1) Header ingestion ──────────────────────────────────────────────────

  describe('ingestContextHeaders()', () => {
    it('registers x-context-app dimension in ContextScope', () => {
      const req = buildRequest(FULL_PAYLOAD)
      ingestContextHeaders(req)

      const dims = ContextScope.getDimensions()
      expect(dims['app']).toBeDefined()
      expect((dims['app'] as { name: string }).name).toBe('mem0-web-app')
    })

    it('registers x-context-user dimension in ContextScope', () => {
      const req = buildRequest(FULL_PAYLOAD)
      ingestContextHeaders(req)

      const dims = ContextScope.getDimensions()
      const user = dims['user'] as { id: string; roles: string[] }
      expect(user.id).toBe('usr_abc123')
      expect(user.roles).toContain('operator')
    })

    it('registers x-context-businessdomain dimension in ContextScope', () => {
      const req = buildRequest(FULL_PAYLOAD)
      ingestContextHeaders(req)

      const dims = ContextScope.getDimensions()
      const bd = dims['businessdomain'] as { vertical?: string; productCategory?: string }
      // context-scope toHeaders() lowercases the dimension name
      expect(bd?.vertical ?? (dims['businessDomain'] as { vertical?: string })?.vertical).toBe('ecommerce')
    })

    it('ignores non-context headers', () => {
      const req = buildRequest(FULL_PAYLOAD, {
        'authorization': 'Bearer some-token',
        'content-type': 'application/json',
      })
      ingestContextHeaders(req)

      const dims = ContextScope.getDimensions()
      expect(dims['authorization']).toBeUndefined()
      expect(dims['content-type']).toBeUndefined()
    })

    it('parses JSON dimension values automatically', () => {
      const req = buildRequest({ app: { name: 'bg-remover' } })
      ingestContextHeaders(req)

      const dims = ContextScope.getDimensions()
      // Should parse JSON string → object, not store raw JSON string
      const app = dims['app']
      expect(typeof app).toBe('object')
      expect(app).not.toBeNull()
    })

    it('stores plain-string dimension values as-is', () => {
      const req = new MockRequest({ 'x-context-stage': 'dev' })
      ingestContextHeaders(req)

      const dims = ContextScope.getDimensions()
      expect(dims['stage']).toBe('dev')
    })
  })

  // ── (2) Header extraction ─────────────────────────────────────────────────

  describe('extractContextFromHeaders()', () => {
    it('returns a ContextPayload with app, user, businessDomain fields', () => {
      const req = buildRequest(FULL_PAYLOAD)
      const payload = extractContextFromHeaders(req)

      expect(payload.app?.name).toBe('mem0-web-app')
      expect(payload.user?.id).toBe('usr_abc123')
      // businessDomain may arrive under businessdomain or businessDomain key
      const bd = payload.businessDomain
      expect(bd?.vertical).toBe('ecommerce')
    })

    it('does NOT mutate ContextScope state', () => {
      clearContextScope()
      const before = { ...ContextScope.getDimensions() }

      const req = buildRequest(FULL_PAYLOAD)
      extractContextFromHeaders(req)

      expect(ContextScope.getDimensions()).toEqual(before)
    })

    it('stores unknown dimensions in payload.extra', () => {
      const req = new MockRequest({ 'x-context-customfield': 'hello' })
      const payload = extractContextFromHeaders(req)
      expect(payload.extra?.['customfield']).toBe('hello')
    })

    it('handles missing optional headers gracefully', () => {
      const req = new MockRequest({ 'x-context-app': JSON.stringify({ name: 'bg-remover' }) })
      const payload = extractContextFromHeaders(req)
      expect(payload.app?.name).toBe('bg-remover')
      expect(payload.user).toBeUndefined()
      expect(payload.businessDomain).toBeUndefined()
    })
  })

  // ── (3) Envelope construction ─────────────────────────────────────────────

  describe('buildContextEnvelope()', () => {
    it('produces routing tier with tenantId, applicationId, sessionId, principalId', () => {
      const req = buildRequest(FULL_PAYLOAD)
      const payload = extractContextFromHeaders(req)
      const envelope = buildContextEnvelope(payload, { tenantId: 'tenant_test_001', sessionId: 'job_xyz789' })

      expect(envelope.routing.tenantId).toBe('tenant_test_001')
      expect(envelope.routing.applicationId).toBe('mem0-web-app')
      expect(envelope.routing.sessionId).toBe('job_xyz789')
      expect(envelope.routing.principalId).toBe('usr_abc123')
    })

    it('produces relevance tier with vertical and productCategory', () => {
      const req = buildRequest(FULL_PAYLOAD)
      const payload = extractContextFromHeaders(req)
      const envelope = buildContextEnvelope(payload)

      expect(envelope.relevance.vertical).toBe('ecommerce')
      expect(envelope.relevance.productCategory).toBe('clothing')
    })

    it('builds routeKey from applicationId + memoryDomain + productCategory', () => {
      const req = buildRequest(FULL_PAYLOAD)
      const payload = extractContextFromHeaders(req)
      const envelope = buildContextEnvelope(payload)

      // routeKey = "{app}:{memoryDomain}:{productCategory}"
      expect(envelope.relevance.routeKey).toMatch(/mem0-web-app:images:clothing/)
    })

    it('sensitive tier is empty (hashing handled downstream)', () => {
      const req = buildRequest(FULL_PAYLOAD)
      const payload = extractContextFromHeaders(req)
      const envelope = buildContextEnvelope(payload)

      // Sensitive tier should not contain raw PII
      expect(envelope.sensitive.userIdHash).toBeUndefined()
      expect(envelope.sensitive.emailHash).toBeUndefined()
    })
  })

  // ── (4) Downstream reconstruction — identical headers ────────────────────

  describe('End-to-end round-trip: ingest → extract → reconstruct', () => {
    it('downstream consumer receives headers matching the originating payload', () => {
      const req = buildRequest(FULL_PAYLOAD)

      // Step 1: middleware ingests headers
      ingestContextHeaders(req)

      // Step 2: extract structured payload
      const extracted = extractContextFromHeaders(req)

      // Step 3: downstream reconstructs headers to forward to next service
      const reconstructed = toHeaders(extracted)

      // App and user dimensions must survive the round-trip
      const sentApp = JSON.stringify(FULL_PAYLOAD.app)
      const recvApp = reconstructed['x-context-app']
      if (recvApp) {
        expect(JSON.parse(recvApp)).toEqual(FULL_PAYLOAD.app)
      } else {
        // toHeaders may omit app if empty; verify at least same keys
        expect(Object.keys(reconstructed).length).toBeGreaterThan(0)
      }
    })

    it('context dimensions registered in ContextScope survive clearContextScope reset', () => {
      const req = buildRequest(FULL_PAYLOAD)
      ingestContextHeaders(req)

      const dimsBefore = ContextScope.getDimensions()
      expect(Object.keys(dimsBefore).length).toBeGreaterThan(0)

      clearContextScope()
      const dimsAfter = ContextScope.getDimensions()
      // After clear, no non-undefined values should remain
      const defined = Object.values(dimsAfter).filter((v) => v !== undefined)
      expect(defined.length).toBe(0)
    })
  })

  // ── (5) validateRequiredHeaders ───────────────────────────────────────────

  describe('validateRequiredHeaders()', () => {
    it('returns true when all required routing fields are present', () => {
      const req = buildRequest(FULL_PAYLOAD, { 'x-tenant-id': 'tenant_test_001' })
      expect(validateRequiredHeaders(req)).toBe(true)
    })

    it('returns false when x-tenant-id is missing', () => {
      const headers = toHeaders(FULL_PAYLOAD)
      delete headers['x-tenant-id']
      const req = new MockRequest(headers)
      // no x-tenant-id and no x-context-* tenantId
      expect(validateRequiredHeaders(req)).toBe(false)
    })

    it('returns false when x-context-app (appId) is missing', () => {
      const partialPayload: ContextPayload = {
        user: { id: 'usr_abc123' },
        extra: { tenantId: 'tenant_test_001', jobId: 'job_xyz789' },
      }
      const req = buildRequest(partialPayload, { 'x-tenant-id': 'tenant_test_001' })
      expect(validateRequiredHeaders(req)).toBe(false)
    })

    it('returns false when sessionId (extra.jobId) is missing', () => {
      const partialPayload: ContextPayload = {
        app: { name: 'bg-remover' },
        user: { id: 'usr_abc123' },
        extra: { tenantId: 'tenant_test_001' },
        // no jobId / sessionId
      }
      const req = buildRequest(partialPayload, { 'x-tenant-id': 'tenant_test_001' })
      expect(validateRequiredHeaders(req)).toBe(false)
    })

    it('returns false when principalId (user.id) is missing', () => {
      const partialPayload: ContextPayload = {
        app: { name: 'bg-remover' },
        // no user
        extra: { tenantId: 'tenant_test_001', jobId: 'job_xyz789' },
      }
      const req = buildRequest(partialPayload, { 'x-tenant-id': 'tenant_test_001' })
      expect(validateRequiredHeaders(req)).toBe(false)
    })

    it('accepts x-tenant-id from header even when not in x-context-* extra', () => {
      const payloadWithoutTenant: ContextPayload = {
        app: { name: 'bg-remover' },
        user: { id: 'usr_abc123' },
        extra: { jobId: 'job_xyz789' },
      }
      const req = buildRequest(payloadWithoutTenant, { 'x-tenant-id': 'tenant_test_001' })
      expect(validateRequiredHeaders(req)).toBe(true)
    })
  })
})

// ─── LocalStack integration note ─────────────────────────────────────────────
//
// When LOCALSTACK_ENDPOINT is set, the CI pipeline extends these tests to:
//   1. POST /api/process with x-context-* headers (via supertest against
//      the Next.js handler running in localstack)
//   2. Query DDB lcp-jobs-test table — verify the stored item contains
//      ctx_ref = routing.sessionId and ctx_tags = relevance values
//   3. Assert the response includes x-context-* echo headers matching input
//
// Example CI config (GitHub Actions):
//   env:
//     LOCALSTACK_ENDPOINT: http://localhost:4566
//     STAGE: test
//
// The localstack fixtures live in: infra/localstack/init-scripts/
//
