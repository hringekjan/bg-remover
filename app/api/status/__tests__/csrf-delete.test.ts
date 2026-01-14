/**
 * CSRF Protection Tests for DELETE /api/status/[jobId]
 *
 * Tests CSRF token validation for job cancellation endpoint.
 * Ensures that malicious sites cannot cancel user jobs.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createHmac } from 'node:crypto';

// Mock dependencies
jest.mock('@/lib/dynamo/job-store', () => ({
  getJobStatus: jest.fn((jobId: string) => {
    if (jobId === 'valid-job-id') {
      return Promise.resolve({
        jobId: 'valid-job-id',
        status: 'pending',
        userId: 'test-user-id',
        tenant: 'carousel-labs',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    return Promise.resolve(null);
  }),
  updateJobStatus: jest.fn(() => Promise.resolve()),
}));

jest.mock('@/lib/auth/middleware', () => ({
  requireAuthAndResourceModification: jest.fn((req: NextRequest) => {
    return Promise.resolve({
      userId: 'test-user-id',
      tenantId: 'carousel-labs',
      email: 'test@example.com',
    });
  }),
}));

jest.mock('@/lib/auth/csrf', () => ({
  validateCsrf: jest.fn((req: NextRequest) => {
    const cookieToken = req.cookies.get('__Host-csrf-token')?.value;
    const headerToken = req.headers.get('x-csrf-token');

    if (!cookieToken) {
      return { valid: false, error: 'CSRF cookie not found' };
    }
    if (!headerToken) {
      return { valid: false, error: 'CSRF header not found' };
    }
    if (cookieToken !== headerToken) {
      return { valid: false, error: 'CSRF token mismatch' };
    }
    return { valid: true };
  }),
}));

// Import route after mocking
import { DELETE } from '../[jobId]/route';

/**
 * Generate a valid CSRF token (for testing purposes)
 */
function generateCsrfToken(secret: string): string {
  const tokenValue = 'test-token-value-' + Date.now();
  const signature = createHmac('sha256', secret)
    .update(tokenValue)
    .digest('hex')
    .substring(0, 16);
  return `${tokenValue}.${signature}`;
}

/**
 * Create a mock DELETE request with optional CSRF headers
 */
function createMockDeleteRequest(options: {
  jobId?: string;
  csrfToken?: string | null;
  authorization?: string;
} = {}): NextRequest {
  const {
    jobId = 'valid-job-id',
    csrfToken,
    authorization = 'Bearer test-token',
  } = options;

  const headers = new Headers({
    'authorization': authorization,
  });

  // Add CSRF headers if token provided
  if (csrfToken) {
    headers.set('x-csrf-token', csrfToken);
    headers.set('cookie', `__Host-csrf-token=${csrfToken}`);
  }

  const request = new NextRequest(`http://localhost:3000/api/status/${jobId}`, {
    method: 'DELETE',
    headers,
  });

  return request;
}

describe('CSRF Protection - DELETE /api/status/[jobId]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should reject DELETE request without CSRF token', async () => {
    const request = createMockDeleteRequest({ csrfToken: null });
    const response = await DELETE(request, {
      params: Promise.resolve({ jobId: 'valid-job-id' }),
    });

    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error).toBe('CSRF validation failed');
    expect(data.details).toBe('CSRF cookie not found');
  });

  it('should reject DELETE request with CSRF header but no cookie', async () => {
    const request = createMockDeleteRequest({ jobId: 'valid-job-id' });
    const headers = new Headers(request.headers);
    headers.set('x-csrf-token', 'some-token');
    headers.delete('cookie');

    const modifiedRequest = new NextRequest(request.url, {
      method: 'DELETE',
      headers,
    });

    const response = await DELETE(modifiedRequest, {
      params: Promise.resolve({ jobId: 'valid-job-id' }),
    });

    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error).toBe('CSRF validation failed');
  });

  it('should reject DELETE request with CSRF cookie but no header', async () => {
    const request = createMockDeleteRequest({ jobId: 'valid-job-id' });
    const headers = new Headers(request.headers);
    headers.set('cookie', '__Host-csrf-token=some-token');
    headers.delete('x-csrf-token');

    const modifiedRequest = new NextRequest(request.url, {
      method: 'DELETE',
      headers,
    });

    const response = await DELETE(modifiedRequest, {
      params: Promise.resolve({ jobId: 'valid-job-id' }),
    });

    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error).toBe('CSRF validation failed');
  });

  it('should reject DELETE request with mismatched CSRF tokens', async () => {
    const request = createMockDeleteRequest({ jobId: 'valid-job-id' });
    const headers = new Headers(request.headers);
    headers.set('cookie', '__Host-csrf-token=token-in-cookie');
    headers.set('x-csrf-token', 'different-token-in-header');

    const modifiedRequest = new NextRequest(request.url, {
      method: 'DELETE',
      headers,
    });

    const response = await DELETE(modifiedRequest, {
      params: Promise.resolve({ jobId: 'valid-job-id' }),
    });

    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error).toBe('CSRF validation failed');
  });

  it('should accept DELETE request with valid CSRF token', async () => {
    const validToken = generateCsrfToken('test-secret');
    const request = createMockDeleteRequest({ csrfToken: validToken });

    const response = await DELETE(request, {
      params: Promise.resolve({ jobId: 'valid-job-id' }),
    });

    // Should not be rejected by CSRF (may still fail for other reasons like job not found)
    expect(response.status).not.toBe(403);
  });

  it('should validate CSRF before checking job existence', async () => {
    // Even if job doesn't exist, CSRF should be checked first
    const request = createMockDeleteRequest({
      jobId: 'nonexistent-job-id',
      csrfToken: null,
    });

    const response = await DELETE(request, {
      params: Promise.resolve({ jobId: 'nonexistent-job-id' }),
    });

    // CSRF check happens before job lookup
    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error).toBe('CSRF validation failed');
  });
});

describe('CSRF Attack Scenarios - Job Cancellation', () => {
  it('should prevent malicious site from cancelling user jobs', async () => {
    // Simulate a cross-site DELETE request from evil.com
    const maliciousRequest = createMockDeleteRequest({
      jobId: 'valid-job-id',
      csrfToken: null, // Attacker cannot read CSRF token
      authorization: 'Bearer stolen-token', // Even with stolen auth token
    });

    const response = await DELETE(maliciousRequest, {
      params: Promise.resolve({ jobId: 'valid-job-id' }),
    });

    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error).toBe('CSRF validation failed');
  });

  it('should prevent job cancellation via forged request', async () => {
    // Attacker tries to cancel job with guessed token
    const forgedRequest = createMockDeleteRequest({
      jobId: 'valid-job-id',
      csrfToken: null,
    });

    const headers = new Headers(forgedRequest.headers);
    headers.set('x-csrf-token', 'forged-token-guess');
    headers.set('cookie', '__Host-csrf-token=different-forged-token');

    const modifiedRequest = new NextRequest(forgedRequest.url, {
      method: 'DELETE',
      headers,
    });

    const response = await DELETE(modifiedRequest, {
      params: Promise.resolve({ jobId: 'valid-job-id' }),
    });

    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error).toBe('CSRF validation failed');
  });
});
