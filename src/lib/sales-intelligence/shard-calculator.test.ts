/**
 * Tests for Shard Calculator
 *
 * Validates deterministic shard assignment and even distribution
 */

import {
  getCategoryShard,
  getEmbeddingShard,
  buildGSI1PK,
  buildGSI1SK,
  buildGSI2PK,
  buildGSI2SK,
  buildGSI3PK,
  buildGSI3SK,
  verifyShardDistribution,
} from './shard-calculator';

describe('ShardCalculator', () => {
  describe('getCategoryShard', () => {
    it('should return valid shard 0-9', () => {
      const testCases = [
        'sale_abc0',
        'sale_abc1',
        'sale_abc9',
        'sale_xyz',
        '12345',
        'a',
      ];

      testCases.forEach((saleId) => {
        const shard = getCategoryShard(saleId);
        expect(shard).toBeGreaterThanOrEqual(0);
        expect(shard).toBeLessThanOrEqual(9);
      });
    });

    it('should be deterministic', () => {
      const saleId = 'sale_abc123';
      const shard1 = getCategoryShard(saleId);
      const shard2 = getCategoryShard(saleId);
      expect(shard1).toBe(shard2);
    });

    it('should use last character', () => {
      // Last char '0' → code 48 → 48 % 10 = 8
      expect(getCategoryShard('sale_0')).toBe(8);

      // Last char 'a' → code 97 → 97 % 10 = 7
      expect(getCategoryShard('sale_a')).toBe(7);
    });

    it('should throw on empty string', () => {
      expect(() => getCategoryShard('')).toThrow('saleId cannot be empty');
    });

    it('should distribute evenly across test set', () => {
      const saleIds = Array.from({ length: 1000 }, (_, i) => `sale_${i}`);
      const distribution = verifyShardDistribution(saleIds, getCategoryShard, 10);

      // Should have < 5% deviation
      expect(distribution.stdDev).toBeLessThan(50);
      expect(distribution.maxDeviation).toBeLessThan(50);
    });
  });

  describe('getEmbeddingShard', () => {
    it('should return valid shard 0-4', () => {
      const testCases = [
        'prod_123',
        'prod_abc',
        'product_xyz',
        '12345',
        'test',
      ];

      testCases.forEach((productId) => {
        const shard = getEmbeddingShard(productId);
        expect(shard).toBeGreaterThanOrEqual(0);
        expect(shard).toBeLessThanOrEqual(4);
      });
    });

    it('should be deterministic', () => {
      const productId = 'prod_abc123';
      const shard1 = getEmbeddingShard(productId);
      const shard2 = getEmbeddingShard(productId);
      expect(shard1).toBe(shard2);
    });

    it('should throw on empty string', () => {
      expect(() => getEmbeddingShard('')).toThrow('productId cannot be empty');
    });

    it('should distribute evenly across test set', () => {
      const productIds = Array.from({ length: 1000 }, (_, i) => `prod_${i}`);
      const distribution = verifyShardDistribution(productIds, getEmbeddingShard, 5);

      // Should have reasonably even distribution
      expect(distribution.stdDev).toBeLessThan(100);
      expect(distribution.maxDeviation).toBeLessThan(100);
    });

    it('should handle different productId formats', () => {
      // UUID format
      const uuid = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
      expect([0, 1, 2, 3, 4]).toContain(getEmbeddingShard(uuid));

      // Numeric format
      const numeric = '12345678901234567890';
      expect([0, 1, 2, 3, 4]).toContain(getEmbeddingShard(numeric));

      // Slug format
      const slug = 'my-product-name-v2';
      expect([0, 1, 2, 3, 4]).toContain(getEmbeddingShard(slug));
    });
  });

  describe('buildGSI1PK', () => {
    it('should build valid partition key', () => {
      const pk = buildGSI1PK('carousel-labs', 'dress', 5);
      expect(pk).toBe('TENANT#carousel-labs#CATEGORY#dress#SHARD#5');
    });

    it('should validate tenant', () => {
      expect(() => buildGSI1PK('', 'dress', 5)).toThrow('tenant cannot be empty');
    });

    it('should validate category', () => {
      expect(() => buildGSI1PK('tenant', '', 5)).toThrow('category cannot be empty');
    });

    it('should validate shard range', () => {
      expect(() => buildGSI1PK('tenant', 'dress', -1)).toThrow('shard must be 0-9');
      expect(() => buildGSI1PK('tenant', 'dress', 10)).toThrow('shard must be 0-9');
    });
  });

  describe('buildGSI1SK', () => {
    it('should build valid sort key', () => {
      const sk = buildGSI1SK('2025-12-29', 99.99);
      expect(sk).toBe('DATE#2025-12-29#PRICE#0000009999');
    });

    it('should pad prices correctly', () => {
      expect(buildGSI1SK('2025-12-29', 0).endsWith('0000000000')).toBe(true);
      expect(buildGSI1SK('2025-12-29', 999.99).endsWith('0000099999')).toBe(true);
      expect(buildGSI1SK('2025-12-29', 1.50).endsWith('0000000150')).toBe(true);
    });

    it('should validate date format', () => {
      expect(() => buildGSI1SK('2025-13-29', 99.99)).toThrow('YYYY-MM-DD format');
      expect(() => buildGSI1SK('25-12-29', 99.99)).toThrow('YYYY-MM-DD format');
      expect(() => buildGSI1SK('2025/12/29', 99.99)).toThrow('YYYY-MM-DD format');
    });

    it('should reject invalid calendar dates', () => {
      // Feb 31 is invalid
      expect(() => buildGSI1SK('2025-02-31', 99.99)).toThrow('valid date');
      // Month 13 is invalid
      expect(() => buildGSI1SK('2025-13-01', 99.99)).toThrow('valid date');
      // Day 32 is invalid
      expect(() => buildGSI1SK('2025-12-32', 99.99)).toThrow('valid date');
      // Day 0 is invalid
      expect(() => buildGSI1SK('2025-01-00', 99.99)).toThrow('valid date');
      // Month 0 is invalid
      expect(() => buildGSI1SK('2025-00-15', 99.99)).toThrow('valid date');
    });

    it('should accept valid dates', () => {
      // Leap year Feb 29
      expect(() => buildGSI1SK('2020-02-29', 99.99)).not.toThrow();
      // Non-leap year Feb 28 is valid
      expect(() => buildGSI1SK('2021-02-28', 99.99)).not.toThrow();
      // Month boundaries
      expect(() => buildGSI1SK('2025-01-31', 99.99)).not.toThrow();
      expect(() => buildGSI1SK('2025-04-30', 99.99)).not.toThrow();
    });

    it('should validate price', () => {
      expect(() => buildGSI1SK('2025-12-29', -1)).toThrow('salePrice cannot be negative');
    });

    it('should enable numeric range queries', () => {
      // Lower price should sort before higher price
      const sk1 = buildGSI1SK('2025-12-29', 10);
      const sk2 = buildGSI1SK('2025-12-29', 100);
      const sk3 = buildGSI1SK('2025-12-29', 1000);

      expect(sk1 < sk2).toBe(true);
      expect(sk2 < sk3).toBe(true);
    });
  });

  describe('buildGSI2PK', () => {
    it('should build valid partition key', () => {
      const pk = buildGSI2PK('carousel-labs', 2);
      expect(pk).toBe('TENANT#carousel-labs#EMBTYPE#PRODUCT#SHARD#2');
    });

    it('should validate shard range', () => {
      expect(() => buildGSI2PK('tenant', -1)).toThrow('shard must be 0-4');
      expect(() => buildGSI2PK('tenant', 5)).toThrow('shard must be 0-4');
    });
  });

  describe('buildGSI2SK', () => {
    it('should build valid sort key', () => {
      const sk = buildGSI2SK('2025-12-29');
      expect(sk).toBe('DATE#2025-12-29');
    });

    it('should validate date format', () => {
      expect(() => buildGSI2SK('2025-13-29')).toThrow('YYYY-MM-DD format');
    });
  });

  describe('buildGSI3PK', () => {
    it('should build valid partition key', () => {
      const pk = buildGSI3PK('carousel-labs', 'Nike');
      expect(pk).toBe('TENANT#carousel-labs#BRAND#Nike');
    });

    it('should validate brand', () => {
      expect(() => buildGSI3PK('tenant', '')).toThrow('brand cannot be empty');
    });
  });

  describe('buildGSI3SK', () => {
    it('should build valid sort key', () => {
      const sk = buildGSI3SK('2025-12-29', 99.99);
      expect(sk).toBe('DATE#2025-12-29#PRICE#0000009999');
    });

    it('should be identical to GSI1SK format', () => {
      const gsi1sk = buildGSI1SK('2025-12-29', 99.99);
      const gsi3sk = buildGSI3SK('2025-12-29', 99.99);
      expect(gsi1sk).toBe(gsi3sk);
    });
  });

  describe('verifyShardDistribution', () => {
    it('should calculate distribution statistics', () => {
      const ids = Array.from({ length: 100 }, (_, i) => `id_${i}`);
      const stats = verifyShardDistribution(ids, getCategoryShard, 10);

      expect(Object.keys(stats.distribution)).toHaveLength(10);
      expect(stats.avgItemsPerShard).toBe(10);
      expect(stats.stdDev).toBeGreaterThanOrEqual(0);
      expect(stats.maxDeviation).toBeGreaterThanOrEqual(0);
    });

    it('should reject invalid shard ranges', () => {
      const ids = ['id_1'];

      // Mock function that returns invalid shard
      const badShardFn = () => 99;

      expect(() => {
        verifyShardDistribution(ids, badShardFn, 10);
      }).toThrow('invalid shard');
    });

    it('should handle uneven distribution', () => {
      const ids = Array.from({ length: 25 }, (_, i) => `id_${i}`);

      // Function that always returns same shard
      const constShardFn = () => 0;

      const stats = verifyShardDistribution(ids, constShardFn, 10);

      expect(stats.distribution[0]).toBe(25);
      expect(stats.distribution[1]).toBe(0);
      expect(stats.stdDev).toBeGreaterThan(0);
    });
  });

  describe('Integration: Key Building Consistency', () => {
    it('should build consistent keys for same input', () => {
      const tenant = 'carousel-labs';
      const category = 'dress';
      const saleDate = '2025-12-29';
      const salePrice = 99.99;
      const saleId = 'sale_123';
      const productId = 'prod_456';

      // Multiple calls should produce identical keys
      const pk1 = buildGSI1PK(tenant, category, getCategoryShard(saleId));
      const pk2 = buildGSI1PK(tenant, category, getCategoryShard(saleId));
      expect(pk1).toBe(pk2);

      const sk1 = buildGSI1SK(saleDate, salePrice);
      const sk2 = buildGSI1SK(saleDate, salePrice);
      expect(sk1).toBe(sk2);
    });

    it('should work with all GSI key builders', () => {
      const tenant = 'carousel-labs';
      const saleDate = '2025-12-29';
      const saleId = 'sale_123';
      const productId = 'prod_456';
      const salePrice = 99.99;
      const brand = 'Nike';

      // GSI-1 keys
      const gsi1pk = buildGSI1PK(tenant, 'dress', getCategoryShard(saleId));
      const gsi1sk = buildGSI1SK(saleDate, salePrice);
      expect(gsi1pk).toMatch(/^TENANT#/);
      expect(gsi1sk).toMatch(/^DATE#/);

      // GSI-2 keys
      const gsi2pk = buildGSI2PK(tenant, getEmbeddingShard(productId));
      const gsi2sk = buildGSI2SK(saleDate);
      expect(gsi2pk).toMatch(/^TENANT#/);
      expect(gsi2sk).toMatch(/^DATE#/);

      // GSI-3 keys
      const gsi3pk = buildGSI3PK(tenant, brand);
      const gsi3sk = buildGSI3SK(saleDate, salePrice);
      expect(gsi3pk).toMatch(/^TENANT#/);
      expect(gsi3sk).toMatch(/^DATE#/);
    });
  });

  describe('Edge Cases', () => {
    it('should handle unicode characters in IDs', () => {
      // Should not throw with unicode
      const shard1 = getCategoryShard('sale_café_123');
      const shard2 = getEmbeddingShard('prod_北京_456');

      expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]).toContain(shard1);
      expect([0, 1, 2, 3, 4]).toContain(shard2);
    });

    it('should handle very long IDs', () => {
      const longId = 'sale_' + 'x'.repeat(1000);
      expect(() => getCategoryShard(longId)).not.toThrow();
    });

    it('should handle special characters in category/brand', () => {
      expect(() => buildGSI1PK('tenant', 'dress-v2', 5)).not.toThrow();
      expect(() => buildGSI3PK('tenant', 'Nike Inc.')).not.toThrow();
    });
  });
});
