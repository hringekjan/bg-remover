import { createHmac, timingSafeEqual } from 'crypto';

const DEFAULT_TTL_SECONDS = 60 * 60; // 1 hour

export interface JobTokenPayload {
  jobId: string;
  tenant: string;
  userId?: string;
  exp: number;
}

function base64UrlEncode(value: string | Buffer): string {
  return Buffer.isBuffer(value)
    ? value.toString('base64url')
    : Buffer.from(value, 'utf8').toString('base64url');
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function getJobTokenSecret(): string | undefined {
  return process.env.JOB_TOKEN_SECRET;
}

function signPayload(payloadB64: string, secret: string): string {
  return base64UrlEncode(createHmac('sha256', secret).update(payloadB64).digest());
}

export function issueJobToken(
  input: Omit<JobTokenPayload, 'exp'>,
  ttlSeconds: number = DEFAULT_TTL_SECONDS
): string | null {
  const secret = getJobTokenSecret();
  if (!secret) {
    console.warn('[JobToken] Missing JOB_TOKEN_SECRET, skipping token issuance');
    return null;
  }

  const payload: JobTokenPayload = {
    ...input,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };

  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signature = signPayload(payloadB64, secret);
  return `${payloadB64}.${signature}`;
}

export function verifyJobToken(token: string): { valid: boolean; payload?: JobTokenPayload; reason?: string } {
  const secret = getJobTokenSecret();
  if (!secret) {
    return { valid: false, reason: 'missing-secret' };
  }

  const [payloadB64, signature] = token.split('.');
  if (!payloadB64 || !signature) {
    return { valid: false, reason: 'invalid-format' };
  }

  const expectedSignature = signPayload(payloadB64, secret);
  const expectedBuf = Buffer.from(expectedSignature);
  const actualBuf = Buffer.from(signature);
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    return { valid: false, reason: 'invalid-signature' };
  }

  let payload: JobTokenPayload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadB64)) as JobTokenPayload;
  } catch (error) {
    return { valid: false, reason: 'invalid-payload' };
  }

  if (!payload?.jobId || !payload?.tenant || !payload?.exp) {
    return { valid: false, reason: 'missing-claims' };
  }

  if (payload.exp < Math.floor(Date.now() / 1000)) {
    return { valid: false, reason: 'expired' };
  }

  return { valid: true, payload };
}
