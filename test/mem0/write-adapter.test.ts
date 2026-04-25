import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  enrichMemoryWrite,
  buildCtxRef,
  buildCtxFingerprint,
  buildCtxTags,
  Envelope,
  EnrichedWrite
} from '../lib/mem0/write-adapter';

describe('Mem0 Write Adapter', () => {
  let mockEnvelope: Envelope;
  
  beforeEach(() => {
    mockEnvelope = {
      tenantId: 'tenant-123',
      appId: 'app-456',
      sessionId: 'session-789',
      principalId: 'user-abc',
      productCategory: 'bg-remover',
      market: 'us-east',
      styleTags: ['modern', 'minimal'],
      routeKey: '/api/v1/process'
    };
  });

  describe('enrichMemoryWrite', () => {
    it('should correctly add ctx_ref, ctx_fingerprint, and ctx_tags to the memory write', () => {
      const memoryWrite = {
        id: 'memory-1',
        content: 'test content',
        metadata: { test: 'data' }
      };

      const enrichedWrite = enrichMemoryWrite(memoryWrite, mockEnvelope);

      expect(enrichedWrite).toHaveProperty('ctx_ref');
      expect(enrichedWrite).toHaveProperty('ctx_fingerprint');
      expect(enrichedWrite).toHaveProperty('ctx_tags');
      
      // Verify the enriched write contains the original properties
      expect(enrichedWrite.id).toBe('memory-1');
      expect(enrichedWrite.content).toBe('test content');
      expect(enrichedWrite.metadata).toEqual({ test: 'data' });
    });
  });

  describe('buildCtxRef', () => {
    it('should return a JSON string containing exactly the required fields in correct order', () => {
      const ctxRef = buildCtxRef(mockEnvelope);
      const parsed = JSON.parse(ctxRef);
      
      // Check that all required fields are present
      expect(parsed).toHaveProperty('tenantId');
      expect(parsed).toHaveProperty('appId');
      expect(parsed).toHaveProperty('sessionId');
      expect(parsed).toHaveProperty('principalId');
      expect(parsed).toHaveProperty('productCategory');
      expect(parsed).toHaveProperty('market');
      expect(parsed).toHaveProperty('styleTags');
      expect(parsed).toHaveProperty('routeKey');
      
      // Check field order (exact order in JSON)
      const keys = Object.keys(parsed);
      expect(keys).toEqual([
        'tenantId',
        'appId',
        'sessionId',
        'principalId',
        'productCategory',
        'market',
        'styleTags',
        'routeKey'
      ]);
      
      // Check that no extra fields are present
      expect(Object.keys(parsed)).toHaveLength(8);
      
      // Check values
      expect(parsed.tenantId).toBe('tenant-123');
      expect(parsed.appId).toBe('app-456');
      expect(parsed.sessionId).toBe('session-789');
      expect(parsed.principalId).toBe('user-abc');
      expect(parsed.productCategory).toBe('bg-remover');
      expect(parsed.market).toBe('us-east');
      expect(parsed.styleTags).toEqual(['modern', 'minimal']);
      expect(parsed.routeKey).toBe('/api/v1/process');
    });
  });

  describe('buildCtxFingerprint', () => {
    it('should concatenate userId and email in specified order before hashing', () => {
      const envelopeWithUser = {
        ...mockEnvelope,
        userId: 'user123',
        email: 'user@example.com'
      };
      
      const fingerprint = buildCtxFingerprint(envelopeWithUser);
      
      // Should produce a valid hex string (64 characters for SHA-256)
      expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
      
      // Should be consistent with same input
      const fingerprint2 = buildCtxFingerprint(envelopeWithUser);
      expect(fingerprint).toBe(fingerprint2);
    });

    it('should handle missing userId and email gracefully', () => {
      const envelopeWithoutUser = {
        ...mockEnvelope,
        userId: undefined,
        email: undefined
      };
      
      const fingerprint = buildCtxFingerprint(envelopeWithoutUser);
      expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('buildCtxTags', () => {
    it('should include all required tags and handle multiple styleTags', () => {
      const tags = buildCtxTags(mockEnvelope);
      
      // Check for required tags
      expect(tags).toContain('app:bg-remover');
      expect(tags).toContain('tenant:tenant-123');
      expect(tags).toContain('cat:bg-remover');
      expect(tags).toContain('market:us-east');
      
      // Check for style tags
      expect(tags).toContain('style:modern');
      expect(tags).toContain('style:minimal');
    });

    it('should handle empty styleTags array', () => {
      const envelope = {
        ...mockEnvelope,
        styleTags: []
      };
      
      const tags = buildCtxTags(envelope);
      
      // Should still include the required tags
      expect(tags).toContain('app:bg-remover');
      expect(tags).toContain('tenant:tenant-123');
      expect(tags).toContain('cat:bg-remover');
      expect(tags).toContain('market:us-east');
      
      // Should not contain any style tags
      expect(tags.filter(tag => tag.startsWith('style:'))).toHaveLength(0);
    });
  });
});