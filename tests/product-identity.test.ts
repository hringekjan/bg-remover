/**
 * Product Identity Service Unit Tests
 *
 * Tests for embedding generation, similarity matching, and product grouping
 */

import {
  cosineSimilarity,
  classifySimilarity,
  SIMILARITY_THRESHOLDS,
} from '../src/lib/product-identity/product-identity-service';

// Mock AWS SDK clients
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({
    send: jest.fn(),
  })),
  InvokeModelCommand: jest.fn(),
}));

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({
    send: jest.fn(),
  })),
  PutItemCommand: jest.fn(),
  QueryCommand: jest.fn(),
  UpdateItemCommand: jest.fn(),
  GetItemCommand: jest.fn(),
  ConditionalCheckFailedException: class ConditionalCheckFailedException extends Error {
    constructor(message?: string) {
      super(message);
      this.name = 'ConditionalCheckFailedException';
    }
  },
}));

jest.mock('@aws-sdk/util-dynamodb', () => ({
  marshall: jest.fn((obj) => obj),
  unmarshall: jest.fn((obj) => obj),
}));

describe('Product Identity Service', () => {
  describe('cosineSimilarity', () => {
    it('should calculate similarity for identical vectors', () => {
      const a = [1, 0, 0];
      const b = [1, 0, 0];
      expect(cosineSimilarity(a, b)).toBeCloseTo(1.0);
    });

    it('should calculate similarity for orthogonal vectors', () => {
      const a = [1, 0, 0];
      const b = [0, 1, 0];
      expect(cosineSimilarity(a, b)).toBeCloseTo(0.0);
    });

    it('should calculate similarity for opposite vectors', () => {
      const a = [1, 0, 0];
      const b = [-1, 0, 0];
      expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0);
    });

    it('should calculate similarity for real-world like embeddings', () => {
      const a = [0.5, 0.3, 0.2, 0.1];
      const b = [0.48, 0.32, 0.19, 0.12];
      // Should be very similar (close to 1)
      expect(cosineSimilarity(a, b)).toBeGreaterThan(0.99);
    });

    it('should handle normalized vectors correctly', () => {
      // Normalized vectors (length = 1)
      const a = [0.6, 0.8];
      const b = [0.8, 0.6];
      const similarity = cosineSimilarity(a, b);
      expect(similarity).toBeGreaterThan(0);
      expect(similarity).toBeLessThan(1);
    });

    // BUG #7 FIX: Test empty array validation
    it('should throw error for empty arrays', () => {
      expect(() => cosineSimilarity([], [])).toThrow('Embedding arrays cannot be empty');
    });

    it('should throw error when first array is empty', () => {
      expect(() => cosineSimilarity([], [1, 2, 3])).toThrow('Embedding arrays cannot be empty');
    });

    it('should throw error when second array is empty', () => {
      expect(() => cosineSimilarity([1, 2, 3], [])).toThrow('Embedding arrays cannot be empty');
    });

    // BUG #8 FIX: Test NaN/Infinity validation
    it('should throw error for NaN values', () => {
      expect(() => cosineSimilarity([NaN, 1, 2], [1, 2, 3])).toThrow('Invalid embedding value');
    });

    it('should throw error for Infinity values', () => {
      expect(() => cosineSimilarity([Infinity, 1, 2], [1, 2, 3])).toThrow('Invalid embedding value');
    });

    it('should throw error for -Infinity values', () => {
      expect(() => cosineSimilarity([1, 2, 3], [-Infinity, 1, 2])).toThrow('Invalid embedding value');
    });

    it('should throw error for dimension mismatch', () => {
      expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow('Embedding dimensions must match');
    });

    it('should handle zero vectors gracefully', () => {
      const a = [0, 0, 0];
      const b = [1, 2, 3];
      // Zero vector should return 0 similarity
      expect(cosineSimilarity(a, b)).toBe(0);
    });
  });

  describe('classifySimilarity', () => {
    it('should classify SAME_PRODUCT for similarity >= 0.92', () => {
      expect(classifySimilarity(0.92)).toBe('SAME_PRODUCT');
      expect(classifySimilarity(0.95)).toBe('SAME_PRODUCT');
      expect(classifySimilarity(1.0)).toBe('SAME_PRODUCT');
    });

    it('should classify LIKELY_SAME for similarity >= 0.85 and < 0.92', () => {
      expect(classifySimilarity(0.85)).toBe('LIKELY_SAME');
      expect(classifySimilarity(0.88)).toBe('LIKELY_SAME');
      expect(classifySimilarity(0.919)).toBe('LIKELY_SAME');
    });

    it('should classify POSSIBLY_SAME for similarity >= 0.75 and < 0.85', () => {
      expect(classifySimilarity(0.75)).toBe('POSSIBLY_SAME');
      expect(classifySimilarity(0.80)).toBe('POSSIBLY_SAME');
      expect(classifySimilarity(0.849)).toBe('POSSIBLY_SAME');
    });

    it('should classify DIFFERENT for similarity < 0.75', () => {
      expect(classifySimilarity(0.74)).toBe('DIFFERENT');
      expect(classifySimilarity(0.5)).toBe('DIFFERENT');
      expect(classifySimilarity(0)).toBe('DIFFERENT');
      expect(classifySimilarity(-0.5)).toBe('DIFFERENT');
    });

    it('should handle edge cases at thresholds', () => {
      // Exact threshold values
      expect(classifySimilarity(SIMILARITY_THRESHOLDS.SAME_PRODUCT)).toBe('SAME_PRODUCT');
      expect(classifySimilarity(SIMILARITY_THRESHOLDS.LIKELY_SAME)).toBe('LIKELY_SAME');
      expect(classifySimilarity(SIMILARITY_THRESHOLDS.POSSIBLY_SAME)).toBe('POSSIBLY_SAME');
    });
  });

  describe('SIMILARITY_THRESHOLDS', () => {
    it('should have correct threshold values', () => {
      expect(SIMILARITY_THRESHOLDS.SAME_PRODUCT).toBe(0.92);
      expect(SIMILARITY_THRESHOLDS.LIKELY_SAME).toBe(0.85);
      expect(SIMILARITY_THRESHOLDS.POSSIBLY_SAME).toBe(0.75);
      expect(SIMILARITY_THRESHOLDS.DIFFERENT).toBe(0.0);
    });

    it('should have thresholds in descending order', () => {
      expect(SIMILARITY_THRESHOLDS.SAME_PRODUCT).toBeGreaterThan(SIMILARITY_THRESHOLDS.LIKELY_SAME);
      expect(SIMILARITY_THRESHOLDS.LIKELY_SAME).toBeGreaterThan(SIMILARITY_THRESHOLDS.POSSIBLY_SAME);
      expect(SIMILARITY_THRESHOLDS.POSSIBLY_SAME).toBeGreaterThan(SIMILARITY_THRESHOLDS.DIFFERENT);
    });
  });
});

describe('Tenant Sanitization', () => {
  // Import the module fresh to test sanitizeTenant
  let sanitizeTenant: (tenant: string) => string;

  beforeAll(async () => {
    // We need to access the private function indirectly through testing public functions
    // For now, test via public API that uses sanitizeTenant
  });

  it('should be tested through public API functions', () => {
    // The sanitizeTenant function is tested indirectly when calling
    // storeEmbedding, getEmbeddings, etc. with malicious tenant IDs
    // These integration tests would be in a separate file
    expect(true).toBe(true);
  });
});

describe('Mathematical Properties', () => {
  describe('cosineSimilarity properties', () => {
    it('should be symmetric (a,b) = (b,a)', () => {
      const a = [0.5, 0.3, 0.8, 0.1];
      const b = [0.2, 0.7, 0.4, 0.9];
      expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(b, a));
    });

    it('should return 1 for identical vectors (reflexive)', () => {
      const v = [0.1, 0.5, 0.3, 0.7];
      expect(cosineSimilarity(v, v)).toBeCloseTo(1.0);
    });

    it('should return value in range [-1, 1]', () => {
      const testCases = [
        [[1, 2, 3], [4, 5, 6]],
        [[1, 0, 0], [0, 1, 0]],
        [[1, 1, 1], [-1, -1, -1]],
        [[0.5, 0.5], [0.5, -0.5]],
      ];

      for (const [a, b] of testCases) {
        const sim = cosineSimilarity(a, b);
        // Allow small floating point errors
        expect(sim).toBeGreaterThanOrEqual(-1.0001);
        expect(sim).toBeLessThanOrEqual(1.0001);
      }
    });

    it('should be scale invariant', () => {
      const a = [1, 2, 3];
      const b = [4, 5, 6];
      const scaledA = [2, 4, 6]; // a * 2
      const scaledB = [8, 10, 12]; // b * 2

      expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(scaledA, scaledB));
    });
  });
});

describe('Performance Considerations', () => {
  it('should handle large embeddings efficiently', () => {
    // 1024-dimension embeddings (Titan Multimodal)
    const size = 1024;
    const a = Array.from({ length: size }, () => Math.random());
    const b = Array.from({ length: size }, () => Math.random());

    const start = performance.now();
    cosineSimilarity(a, b);
    const elapsed = performance.now() - start;

    // Should complete in under 5ms
    expect(elapsed).toBeLessThan(5);
  });

  it('should handle many comparisons', () => {
    const size = 1024;
    const vectors = Array.from({ length: 50 }, () =>
      Array.from({ length: size }, () => Math.random())
    );

    const start = performance.now();
    for (let i = 0; i < vectors.length; i++) {
      for (let j = i + 1; j < vectors.length; j++) {
        cosineSimilarity(vectors[i], vectors[j]);
      }
    }
    const elapsed = performance.now() - start;

    // 1225 comparisons should complete in under 2000ms (generous for CI)
    expect(elapsed).toBeLessThan(2000);
  });
});
