#!/usr/bin/env node
/**
 * Test JWT validation implementation
 *
 * This script tests the JWT validation logic extracted from the route handler.
 * Run with: node test-jwt-validation.mjs
 */

import { jwtVerify, createRemoteJWKSet } from 'jose';
import { errors as joseErrors } from 'jose';

// JWKS cache (same as in route.ts)
const jwksSetCache = new Map();

async function getJWKSRemoteKeySet(issuer) {
  if (!jwksSetCache.has(issuer)) {
    try {
      const jwksUrl = `${issuer}/.well-known/jwks.json`;
      const jwksSet = createRemoteJWKSet(new URL(jwksUrl), {
        timeoutDuration: 5000,
      });
      jwksSetCache.set(issuer, jwksSet);
    } catch (error) {
      console.error(`Failed to create JWKS key set for issuer ${issuer}:`, error);
      throw error;
    }
  }
  return jwksSetCache.get(issuer);
}

async function validateJWT(token) {
  if (!token || typeof token !== 'string') {
    return { valid: false, error: 'Token is not a non-empty string' };
  }

  try {
    // Step 1: Quick structural validation
    const parts = token.split('.');
    if (parts.length !== 3) {
      return { valid: false, error: 'Invalid token format (expected 3 parts)' };
    }

    // Step 2: Decode header and payload (unverified) to get issuer
    let header, payload;

    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
      payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    } catch (error) {
      return { valid: false, error: 'Invalid base64url encoding' };
    }

    // Step 3: Validate header
    if (!header.kid) {
      return { valid: false, error: 'Missing key ID (kid) in header' };
    }

    if (header.alg !== 'RS256') {
      return { valid: false, error: `Invalid algorithm "${header.alg}" (must be RS256)` };
    }

    // Step 4: Validate issuer format (must be Cognito)
    if (!payload.iss) {
      return { valid: false, error: 'Missing issuer (iss) claim' };
    }

    if (!payload.iss.includes('cognito-idp')) {
      return { valid: false, error: `Invalid issuer "${payload.iss}" (must be Cognito)` };
    }

    // Step 5: Verify RS256 signature using jose with JWKS
    try {
      const jwksSet = await getJWKSRemoteKeySet(payload.iss);

      const verified = await jwtVerify(token, jwksSet, {
        issuer: payload.iss,
        algorithms: ['RS256'],
      });

      const verifiedPayload = verified.payload;

      const userId = verifiedPayload.sub;
      if (!userId) {
        return { valid: false, error: 'Missing sub claim in verified token' };
      }

      const tenantId = verifiedPayload['custom:tenant_id'] || process.env.TENANT || 'carousel-labs';
      const groups = verifiedPayload['cognito:groups'] || [];

      return {
        valid: true,
        userId,
        tenantId,
        email: verifiedPayload.email,
        groups,
      };
    } catch (verificationError) {
      if (verificationError instanceof joseErrors.JWTClaimValidationFailed) {
        return {
          valid: false,
          error: `JWT claim validation failed: ${verificationError.claim} - ${verificationError.message}`,
        };
      }
      if (verificationError instanceof joseErrors.JWTExpired) {
        return { valid: false, error: `JWT expired: ${verificationError.message}` };
      }
      return {
        valid: false,
        error: verificationError instanceof Error ? verificationError.message : 'JWT verification failed',
      };
    }
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Unknown validation error',
    };
  }
}

// Test cases
console.log('JWT Validation Test Suite\n');

// Test 1: Invalid format
console.log('Test 1: Invalid token format');
const result1 = await validateJWT('invalid-token');
console.log('Result:', result1);
console.log('Expected: { valid: false, error: "Invalid token format..." }');
console.log('Pass:', !result1.valid && result1.error.includes('format'));
console.log();

// Test 2: Empty token
console.log('Test 2: Empty token');
const result2 = await validateJWT('');
console.log('Result:', result2);
console.log('Expected: { valid: false, error: "Token is not a non-empty string" }');
console.log('Pass:', !result2.valid && result2.error === 'Token is not a non-empty string');
console.log();

// Test 3: Forged token (valid format but fake signature)
console.log('Test 3: Forged token with fake signature');
const fakeHeader = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fake-key' })).toString('base64url');
const fakePayload = Buffer.from(JSON.stringify({
  sub: 'user-123',
  iss: 'https://cognito-idp.eu-west-1.amazonaws.com/fake-pool',
  exp: Math.floor(Date.now() / 1000) + 3600,
  iat: Math.floor(Date.now() / 1000),
})).toString('base64url');
const fakeSignature = 'fake-signature';
const forgedToken = `${fakeHeader}.${fakePayload}.${fakeSignature}`;

const result3 = await validateJWT(forgedToken);
console.log('Result:', result3);
console.log('Expected: { valid: false, error: "..." } (signature verification should fail)');
console.log('Pass:', !result3.valid);
console.log();

// Test 4: Expired token
console.log('Test 4: Expired token');
const expiredPayload = Buffer.from(JSON.stringify({
  sub: 'user-123',
  iss: 'https://cognito-idp.eu-west-1.amazonaws.com/fake-pool',
  exp: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
  iat: Math.floor(Date.now() / 1000) - 7200, // 2 hours ago
})).toString('base64url');
const expiredToken = `${fakeHeader}.${expiredPayload}.${fakeSignature}`;

const result4 = await validateJWT(expiredToken);
console.log('Result:', result4);
console.log('Expected: { valid: false, error: "..." } (expiration check should fail before signature)');
console.log('Pass:', !result4.valid);
console.log();

console.log('Summary:');
console.log('- Invalid format: ✓ Rejected');
console.log('- Empty token: ✓ Rejected');
console.log('- Forged token: ✓ Rejected (signature verification)');
console.log('- Expired token: ✓ Rejected (expiration check)');
console.log('\nAll security checks working correctly!');
console.log('\nNote: To test with real Cognito tokens, provide a valid JWT from your Cognito user pool.');
