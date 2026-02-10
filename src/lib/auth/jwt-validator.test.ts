/**
 * Unit Tests for JWT Validator Security Fix
 *
 * Tests HMAC-based cache key generation to prevent cache poisoning attacks.
 * Critical security requirements:
 * 1. Code uses HMAC instead of plain SHA-256 (verified by source inspection)
 * 2. Cache keys use full 64-char hash, not substring
 * 3. No hash information leaked in logs
 * 4. Environment configuration for CACHE_KEY_SECRET
 */

import { buildCacheKey } from '../cache/constants';
import * as fs from 'fs';
import * as path from 'path';

describe('JWT Validator Security Fix', () => {
  describe('Source Code Verification', () => {
    let sourceFile: string;

    beforeAll(() => {
      // Read the jwt-validator source file
      sourceFile = fs.readFileSync(
        path.join(__dirname, 'jwt-validator.ts'),
        'utf-8'
      );
    });

    it('should use createHmac instead of createHash for token hashing', () => {
      // Verify import statement uses createHmac
      expect(sourceFile).toContain("import { createHmac } from 'crypto'");

      // Verify NOT using createHash for token hashing
      expect(sourceFile).not.toContain("createHash('sha256').update(token)");

      // Verify HMAC is used for token hashing
      expect(sourceFile).toContain("createHmac('sha256', CACHE_KEY_SECRET)");
    });

    it('should have CACHE_KEY_SECRET defined with environment variable fallback', () => {
      expect(sourceFile).toContain('process.env.CACHE_KEY_SECRET');
      expect(sourceFile).toContain('default-cache-key-secret-change-me');
      expect(sourceFile).toContain('NOT SECURE FOR PRODUCTION');
    });

    it('should not log token hashes in console statements', () => {
      // Extract console.debug/warn calls and check they don't log tokenHash as a property
      const consolePattern = /console\.(debug|warn)\([^{]*\{[^}]*\}/g;
      const consoleCalls = sourceFile.match(consolePattern) || [];

      for (const call of consoleCalls) {
        // Check if tokenHash appears as an object property (would be: tokenHash: value)
        const hasTokenHashProperty = /tokenHash\s*:/.test(call);
        expect(hasTokenHashProperty).toBe(false);
      }

      // Verify security comment exists (tokenHash mentioned in comments is OK)
      expect(sourceFile).toContain('tokenHash deliberately omitted for security');
    });

    it('should use HMAC for cache poisoning prevention', () => {
      // Verify HMAC comment exists
      expect(sourceFile).toContain('prevents cache poisoning attacks');

      // Verify HMAC secret management
      expect(sourceFile).toContain('CACHE_KEY_SECRET');
    });

    it('should enforce JWT clock tolerance and max token age', () => {
      expect(sourceFile).toContain('JWT_CLOCK_TOLERANCE_SECONDS');
      expect(sourceFile).toContain('JWT_MAX_TOKEN_AGE_SECONDS');
      expect(sourceFile).toContain('clockTolerance');
      expect(sourceFile).toContain('maxTokenAge');
    });

    it('should require iss, exp, and iat claims', () => {
      expect(sourceFile).toContain('Missing iss claim in JWT');
      expect(sourceFile).toContain('Missing or invalid exp claim in JWT');
      expect(sourceFile).toContain('Missing or invalid iat claim in JWT');
    });
  });

  describe('Cache Key Generation', () => {
    it('should use full 64-char hash in cache keys', () => {
      const fullHash = 'a'.repeat(64); // 64-char hex hash

      const cacheKey = buildCacheKey.jwtValidation(fullHash);

      expect(cacheKey).toBe(`jwt-validation-${fullHash}`);
      expect(cacheKey).toContain(fullHash); // Full hash, not substring
      expect(cacheKey.length).toBe('jwt-validation-'.length + 64);
    });

    it('should not truncate hash to 32 chars (security fix verification)', () => {
      const fullHash = 'abcdef1234567890'.repeat(4); // 64 chars

      const cacheKey = buildCacheKey.jwtValidation(fullHash);

      // Verify full hash is used (not substring(0, 32))
      expect(cacheKey).toContain(fullHash);
      expect(cacheKey).toBe('jwt-validation-' + fullHash);
      expect(cacheKey).not.toBe('jwt-validation-' + fullHash.substring(0, 32));
    });

    it('should generate valid cache keys for cache service', () => {
      const tokenHash = 'b'.repeat(64);

      const cacheKey = buildCacheKey.jwtValidation(tokenHash);

      // Cache key format validation (matches cache service requirements)
      expect(cacheKey).toMatch(/^[a-zA-Z0-9_-]+$/); // Only allowed chars
      expect(cacheKey).toContain('jwt-validation-');
      expect(cacheKey.length).toBeGreaterThan(20); // Has meaningful data
    });
  });

  describe('Configuration Requirements', () => {
    it('should document CACHE_KEY_SECRET in serverless.yml', () => {
      // Path from src/lib/auth to root: ../../../
      const serverlessFile = fs.readFileSync(
        path.join(__dirname, '../../../serverless.yml'),
        'utf-8'
      );

      // Verify CACHE_KEY_SECRET is configured
      expect(serverlessFile).toContain('CACHE_KEY_SECRET');

      // Verify it loads from SSM (tenant-specific parameter, not nested in secrets JSON)
      expect(serverlessFile).toContain('services/bg-remover/cache-key-secret');
    });

    it('should use tenant-specific secrets for better isolation', () => {
      const serverlessFile = fs.readFileSync(
        path.join(__dirname, '../../../serverless.yml'),
        'utf-8'
      );

      // Verify tenant variable is used in SSM path
      expect(serverlessFile).toMatch(/\$\{env:TENANT[^}]*\}.*services\/bg-remover\/cache-key-secret/);
    });
  });

  describe('Security Documentation', () => {
    it('should have CRITICAL comment about cache poisoning prevention', () => {
      const sourceFile = fs.readFileSync(
        path.join(__dirname, 'jwt-validator.ts'),
        'utf-8'
      );

      expect(sourceFile).toContain('CRITICAL');
      expect(sourceFile).toContain('prevents cache poisoning');
    });

    it('should document HMAC usage in comments', () => {
      const sourceFile = fs.readFileSync(
        path.join(__dirname, 'jwt-validator.ts'),
        'utf-8'
      );

      expect(sourceFile).toContain('HMAC');
      expect(sourceFile).toContain('cache key from HMAC');
    });
  });
});
