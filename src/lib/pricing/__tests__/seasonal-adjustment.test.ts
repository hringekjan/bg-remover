/**
 * Tests for Seasonal Adjustment Service
 *
 * Covers:
 * - Seasonal multiplier calculation
 * - Peak/off-season detection
 * - Confidence weighting
 * - Edge cases (insufficient data, single month, etc.)
 */

import { SeasonalAdjustmentService } from '../seasonal-adjustment';
import type { SalesRecord } from '../../sales-intelligence-types';

// Mock the SalesRepository
jest.mock('../../sales-intelligence/sales-repository', () => {
  return {
    SalesRepository: jest.fn().mockImplementation(() => ({
      queryCategorySeason: jest.fn(),
    })),
  };
});

describe('SeasonalAdjustmentService', () => {
  let service: SeasonalAdjustmentService;
  let mockSalesRepo: any;

  beforeEach(() => {
    service = new SeasonalAdjustmentService('test-tenant', 'test-table');

    // Access the mocked repository through the service
    mockSalesRepo = (service as any).salesRepo;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('calculateSeasonalMultiplier', () => {
    it('should return 1.0 for insufficient data', async () => {
      mockSalesRepo.queryCategorySeason.mockResolvedValue([]);

      const multiplier = await service.calculateSeasonalMultiplier('coats');

      expect(multiplier).toBe(1.0);
    });

    it('should return higher multiplier for peak season months', async () => {
      // Mock winter coat sales: high in Dec, low in July
      const mockSales: SalesRecord[] = [];

      // December: High prices, fast sales (peak season)
      for (let i = 0; i < 20; i++) {
        mockSales.push({
          PK: `TENANT#test#PRODUCT#prod_${i}`,
          SK: `SALE#2024-12-15#sale_${i}`,
          saleId: `sale_${i}`,
          productId: `prod_${i}`,
          saleDate: '2024-12-15',
          salePrice: 150, // Higher price
          originalPrice: 200,
          tenant: 'test-tenant',
          category: 'coats',
          daysToSell: 10, // Fast sales in peak season
          embeddingId: `emb_${i}`,
          embeddingS3Key: `s3://bucket/emb_${i}`,
          createdAt: '2024-12-15T00:00:00Z',
          updatedAt: '2024-12-15T00:00:00Z',
          ttl: 2000000000,
        });
      }

      // July: Lower prices, slow sales (off-season)
      for (let i = 20; i < 25; i++) {
        mockSales.push({
          PK: `TENANT#test#PRODUCT#prod_${i}`,
          SK: `SALE#2024-07-15#sale_${i}`,
          saleId: `sale_${i}`,
          productId: `prod_${i}`,
          saleDate: '2024-07-15',
          salePrice: 75, // Lower price
          originalPrice: 150,
          tenant: 'test-tenant',
          category: 'coats',
          daysToSell: 60, // Slow sales in off-season
          embeddingId: `emb_${i}`,
          embeddingS3Key: `s3://bucket/emb_${i}`,
          createdAt: '2024-07-15T00:00:00Z',
          updatedAt: '2024-07-15T00:00:00Z',
          ttl: 2000000000,
        });
      }

      // Fill remaining months with average data
      for (let month = 1; month <= 12; month++) {
        if (month === 7 || month === 12) continue; // Skip already filled months
        const daysInMonth = 3;
        for (let i = 0; i < daysInMonth; i++) {
          mockSales.push({
            PK: `TENANT#test#PRODUCT#prod_m${month}_${i}`,
            SK: `SALE#2024-${String(month).padStart(2, '0')}-15#sale_m${month}_${i}`,
            saleId: `sale_m${month}_${i}`,
            productId: `prod_m${month}_${i}`,
            saleDate: `2024-${String(month).padStart(2, '0')}-15`,
            salePrice: 110, // Average price
            originalPrice: 150,
            tenant: 'test-tenant',
            category: 'coats',
            daysToSell: 35, // Average sales velocity
            embeddingId: `emb_m${month}_${i}`,
            embeddingS3Key: `s3://bucket/emb_m${month}_${i}`,
            createdAt: `2024-${String(month).padStart(2, '0')}-15T00:00:00Z`,
            updatedAt: `2024-${String(month).padStart(2, '0')}-15T00:00:00Z`,
            ttl: 2000000000,
          });
        }
      }

      mockSalesRepo.queryCategorySeason.mockResolvedValue(mockSales);

      const decemberMultiplier = await service.calculateSeasonalMultiplier('coats', undefined, 12);
      const julyMultiplier = await service.calculateSeasonalMultiplier('coats', undefined, 7);

      // December should have higher multiplier than July
      expect(decemberMultiplier).toBeGreaterThan(julyMultiplier);
      expect(decemberMultiplier).toBeGreaterThan(1.0);
      expect(julyMultiplier).toBeLessThan(1.0);
    });

    it('should apply confidence weighting', async () => {
      // Create two scenarios: one with many sales, one with few
      const manyMonthlySales = Array.from({ length: 30 }, (_, i) => ({
        PK: `TENANT#test#PRODUCT#prod_${i}`,
        SK: `SALE#2024-01-15#sale_${i}`,
        saleId: `sale_${i}`,
        productId: `prod_${i}`,
        saleDate: '2024-01-15',
        salePrice: 100, // Higher price
        originalPrice: 100,
        tenant: 'test-tenant',
        category: 'swimwear',
        daysToSell: 15,
        embeddingId: `emb_${i}`,
        embeddingS3Key: `s3://bucket/emb_${i}`,
        createdAt: '2024-01-15T00:00:00Z',
        updatedAt: '2024-01-15T00:00:00Z',
        ttl: 2000000000,
      })) as SalesRecord[];

      // Monthly distribution: Jan high (30), other months low (5 each)
      const fullYearSales = manyMonthlySales.concat(
        Array.from({ length: 5 }, (_, i) => ({
          PK: `TENANT#test#PRODUCT#prod_${30 + i}`,
          SK: `SALE#2024-02-15#sale_${30 + i}`,
          saleId: `sale_${30 + i}`,
          productId: `prod_${30 + i}`,
          saleDate: '2024-02-15',
          salePrice: 50,
          originalPrice: 50,
          tenant: 'test-tenant',
          category: 'swimwear',
          daysToSell: 25,
          embeddingId: `emb_${30 + i}`,
          embeddingS3Key: `s3://bucket/emb_${30 + i}`,
          createdAt: '2024-02-15T00:00:00Z',
          updatedAt: '2024-02-15T00:00:00Z',
          ttl: 2000000000,
        })) as SalesRecord[]
      );

      // Fill other months with average data
      for (let month = 3; month <= 12; month++) {
        for (let i = 0; i < 5; i++) {
          fullYearSales.push({
            PK: `TENANT#test#PRODUCT#prod_${35 + (month - 3) * 5 + i}`,
            SK: `SALE#2024-${String(month).padStart(2, '0')}-15#sale_${35 + (month - 3) * 5 + i}`,
            saleId: `sale_${35 + (month - 3) * 5 + i}`,
            productId: `prod_${35 + (month - 3) * 5 + i}`,
            saleDate: `2024-${String(month).padStart(2, '0')}-15`,
            salePrice: 70,
            originalPrice: 70,
            tenant: 'test-tenant',
            category: 'swimwear',
            daysToSell: 20,
            embeddingId: `emb_${35 + (month - 3) * 5 + i}`,
            embeddingS3Key: `s3://bucket/emb_${35 + (month - 3) * 5 + i}`,
            createdAt: `2024-${String(month).padStart(2, '0')}-15T00:00:00Z`,
            updatedAt: `2024-${String(month).padStart(2, '0')}-15T00:00:00Z`,
            ttl: 2000000000,
          } as SalesRecord);
        }
      }

      mockSalesRepo.queryCategorySeason.mockResolvedValue(fullYearSales);

      const multiplier = await service.calculateSeasonalMultiplier('swimwear', undefined, 1);

      // With high confidence (30 sales), multiplier should be closer to actual ratio
      // Expected: 100/70 = 1.43 (average of 30@100 + 5@50 = 3500/50 = 70)
      expect(multiplier).toBeGreaterThan(1.1);
      expect(multiplier).toBeLessThanOrEqual(1.5); // Clamped at 1.5x
    });

    it('should clamp multiplier to 0.5x - 1.5x range', async () => {
      // Create extreme scenario with huge price swing
      const extremeSales: SalesRecord[] = [];

      // January: Very high prices
      for (let i = 0; i < 50; i++) {
        extremeSales.push({
          PK: `TENANT#test#PRODUCT#prod_${i}`,
          SK: `SALE#2024-01-15#sale_${i}`,
          saleId: `sale_${i}`,
          productId: `prod_${i}`,
          saleDate: '2024-01-15',
          salePrice: 1000,
          originalPrice: 1000,
          tenant: 'test-tenant',
          category: 'luxury-bags',
          daysToSell: 8,
          embeddingId: `emb_${i}`,
          embeddingS3Key: `s3://bucket/emb_${i}`,
          createdAt: '2024-01-15T00:00:00Z',
          updatedAt: '2024-01-15T00:00:00Z',
          ttl: 2000000000,
        });
      }

      // August: Very low prices (fire sale)
      for (let i = 50; i < 55; i++) {
        extremeSales.push({
          PK: `TENANT#test#PRODUCT#prod_${i}`,
          SK: `SALE#2024-08-15#sale_${i}`,
          saleId: `sale_${i}`,
          productId: `prod_${i}`,
          saleDate: '2024-08-15',
          salePrice: 100,
          originalPrice: 100,
          tenant: 'test-tenant',
          category: 'luxury-bags',
          daysToSell: 45,
          embeddingId: `emb_${i}`,
          embeddingS3Key: `s3://bucket/emb_${i}`,
          createdAt: '2024-08-15T00:00:00Z',
          updatedAt: '2024-08-15T00:00:00Z',
          ttl: 2000000000,
        });
      }

      // Fill remaining months
      for (let month = 1; month <= 12; month++) {
        if (month === 1 || month === 8) continue;
        for (let i = 0; i < 5; i++) {
          extremeSales.push({
            PK: `TENANT#test#PRODUCT#prod_m${month}_${i}`,
            SK: `SALE#2024-${String(month).padStart(2, '0')}-15#sale_m${month}_${i}`,
            saleId: `sale_m${month}_${i}`,
            productId: `prod_m${month}_${i}`,
            saleDate: `2024-${String(month).padStart(2, '0')}-15`,
            salePrice: 550,
            originalPrice: 550,
            tenant: 'test-tenant',
            category: 'luxury-bags',
            daysToSell: 25,
            embeddingId: `emb_m${month}_${i}`,
            embeddingS3Key: `s3://bucket/emb_m${month}_${i}`,
            createdAt: `2024-${String(month).padStart(2, '0')}-15T00:00:00Z`,
            updatedAt: `2024-${String(month).padStart(2, '0')}-15T00:00:00Z`,
            ttl: 2000000000,
          });
        }
      }

      mockSalesRepo.queryCategorySeason.mockResolvedValue(extremeSales);

      const januaryMultiplier = await service.calculateSeasonalMultiplier('luxury-bags', undefined, 1);

      // Should be clamped at 1.5x even though raw would be much higher
      expect(januaryMultiplier).toBeLessThanOrEqual(1.5);
    });
  });

  describe('detectSeasonalPattern', () => {
    it('should return null for insufficient data', async () => {
      mockSalesRepo.queryCategorySeason.mockResolvedValue(
        Array.from({ length: 50 }, (_, i) => ({
          PK: `TENANT#test#PRODUCT#prod_${i}`,
          SK: `SALE#2024-01-15#sale_${i}`,
          saleId: `sale_${i}`,
          productId: `prod_${i}`,
          saleDate: '2024-01-15',
          salePrice: 100,
          originalPrice: 100,
          tenant: 'test-tenant',
          category: 'coats',
          embeddingId: `emb_${i}`,
          embeddingS3Key: `s3://bucket/emb_${i}`,
          createdAt: '2024-01-15T00:00:00Z',
          updatedAt: '2024-01-15T00:00:00Z',
          ttl: 2000000000,
        }))
      );

      const pattern = await service.detectSeasonalPattern('coats');

      // Less than 100 sales required
      expect(pattern).toBeNull();
    });

    it('should detect seasonal patterns', async () => {
      // Simulate swimwear sales (strong seasonality)
      const mockSales: SalesRecord[] = [];

      // Summer months (June, July, August): High prices, many sales, fast sales
      const summerMonths = [6, 7, 8];
      summerMonths.forEach((month) => {
        for (let i = 0; i < 20; i++) {
          mockSales.push({
            PK: `TENANT#test#PRODUCT#prod_${month}_${i}`,
            SK: `SALE#2024-${String(month).padStart(2, '0')}-15#sale_${i}`,
            saleId: `sale_${month}_${i}`,
            productId: `prod_${month}_${i}`,
            saleDate: `2024-${String(month).padStart(2, '0')}-15`,
            salePrice: 100,
            originalPrice: 100,
            tenant: 'test-tenant',
            category: 'swimwear',
            daysToSell: 8, // Fast sales in peak season
            embeddingId: `emb_${month}_${i}`,
            embeddingS3Key: `s3://bucket/emb_${month}_${i}`,
            createdAt: `2024-${String(month).padStart(2, '0')}-15T00:00:00Z`,
            updatedAt: `2024-${String(month).padStart(2, '0')}-15T00:00:00Z`,
            ttl: 2000000000,
          });
        }
      });

      // Winter months (December, January, February): Low prices, few sales, slow sales
      const winterMonths = [12, 1, 2];
      winterMonths.forEach((month) => {
        const year = month === 12 ? 2024 : 2025;
        for (let i = 0; i < 5; i++) {
          mockSales.push({
            PK: `TENANT#test#PRODUCT#prod_w${month}_${i}`,
            SK: `SALE#${year}-${String(month).padStart(2, '0')}-15#sale_w${i}`,
            saleId: `sale_w${month}_${i}`,
            productId: `prod_w${month}_${i}`,
            saleDate: `${year}-${String(month).padStart(2, '0')}-15`,
            salePrice: 30,
            originalPrice: 30,
            tenant: 'test-tenant',
            category: 'swimwear',
            daysToSell: 65, // Slow sales in off-season
            embeddingId: `emb_w${month}_${i}`,
            embeddingS3Key: `s3://bucket/emb_w${month}_${i}`,
            createdAt: `${year}-${String(month).padStart(2, '0')}-15T00:00:00Z`,
            updatedAt: `${year}-${String(month).padStart(2, '0')}-15T00:00:00Z`,
            ttl: 2000000000,
          });
        }
      });

      // Fill other months (March-May, September-November) with neutral prices
      for (let month = 3; month <= 11; month++) {
        if (month >= 6 && month <= 8) continue; // Skip summer
        if (month >= 12) continue; // Skip December
        const daysInMonth = 8;
        for (let i = 0; i < daysInMonth; i++) {
          mockSales.push({
            PK: `TENANT#test#PRODUCT#prod_n${month}_${i}`,
            SK: `SALE#2024-${String(month).padStart(2, '0')}-15#sale_n${i}`,
            saleId: `sale_n${month}_${i}`,
            productId: `prod_n${month}_${i}`,
            saleDate: `2024-${String(month).padStart(2, '0')}-15`,
            salePrice: 50,
            originalPrice: 50,
            tenant: 'test-tenant',
            category: 'swimwear',
            daysToSell: 35, // Average sales velocity
            embeddingId: `emb_n${month}_${i}`,
            embeddingS3Key: `s3://bucket/emb_n${month}_${i}`,
            createdAt: `2024-${String(month).padStart(2, '0')}-15T00:00:00Z`,
            updatedAt: `2024-${String(month).padStart(2, '0')}-15T00:00:00Z`,
            ttl: 2000000000,
          });
        }
      }

      mockSalesRepo.queryCategorySeason.mockResolvedValue(mockSales);

      const pattern = await service.detectSeasonalPattern('swimwear');

      expect(pattern).not.toBeNull();
      expect(pattern!.category).toBe('swimwear');
      expect(pattern!.seasonalityScore).toBeGreaterThan(0.15);
      expect(pattern!.peakMonths).toContain(6); // June
      expect(pattern!.peakMonths).toContain(7); // July
      expect(pattern!.peakMonths).toContain(8); // August
      expect(pattern!.offSeasonMonths.length).toBeGreaterThan(0);
      expect(pattern!.sampleSize).toBeGreaterThan(100);
    });

    it('should include brand-specific patterns', async () => {
      const mockSales: SalesRecord[] = Array.from({ length: 120 }, (_, i) => ({
        PK: `TENANT#test#PRODUCT#prod_${i}`,
        SK: `SALE#2024-${String((i % 12) + 1).padStart(2, '0')}-15#sale_${i}`,
        saleId: `sale_${i}`,
        productId: `prod_${i}`,
        saleDate: `2024-${String((i % 12) + 1).padStart(2, '0')}-15`,
        salePrice: 100 + (i % 12) * 10,
        originalPrice: 100 + (i % 12) * 10,
        tenant: 'test-tenant',
        category: 'dresses',
        brand: 'designer-x',
        daysToSell: 20 + ((i % 12) % 2) * 10, // Alternating pattern
        embeddingId: `emb_${i}`,
        embeddingS3Key: `s3://bucket/emb_${i}`,
        createdAt: `2024-${String((i % 12) + 1).padStart(2, '0')}-15T00:00:00Z`,
        updatedAt: `2024-${String((i % 12) + 1).padStart(2, '0')}-15T00:00:00Z`,
        ttl: 2000000000,
      }));

      mockSalesRepo.queryCategorySeason.mockResolvedValue(mockSales);

      const pattern = await service.detectSeasonalPattern('dresses', 'designer-x');

      expect(pattern?.brand).toBe('designer-x');
      expect(pattern?.monthlyStats.length).toBe(12);
    });
  });

  describe('Edge cases', () => {
    it('should handle missing daysToSell field', async () => {
      const mockSales: SalesRecord[] = Array.from({ length: 30 }, (_, i) => ({
        PK: `TENANT#test#PRODUCT#prod_${i}`,
        SK: `SALE#2024-01-15#sale_${i}`,
        saleId: `sale_${i}`,
        productId: `prod_${i}`,
        saleDate: '2024-01-15',
        salePrice: 100,
        originalPrice: 100,
        tenant: 'test-tenant',
        category: 'coats',
        // daysToSell is intentionally omitted
        embeddingId: `emb_${i}`,
        embeddingS3Key: `s3://bucket/emb_${i}`,
        createdAt: '2024-01-15T00:00:00Z',
        updatedAt: '2024-01-15T00:00:00Z',
        ttl: 2000000000,
      }));

      // Fill other months
      for (let month = 2; month <= 12; month++) {
        for (let i = 0; i < 3; i++) {
          mockSales.push({
            PK: `TENANT#test#PRODUCT#prod_m${month}_${i}`,
            SK: `SALE#2024-${String(month).padStart(2, '0')}-15#sale_m${month}_${i}`,
            saleId: `sale_m${month}_${i}`,
            productId: `prod_m${month}_${i}`,
            saleDate: `2024-${String(month).padStart(2, '0')}-15`,
            salePrice: 100,
            originalPrice: 100,
            tenant: 'test-tenant',
            category: 'coats',
            embeddingId: `emb_m${month}_${i}`,
            embeddingS3Key: `s3://bucket/emb_m${month}_${i}`,
            createdAt: `2024-${String(month).padStart(2, '0')}-15T00:00:00Z`,
            updatedAt: `2024-${String(month).padStart(2, '0')}-15T00:00:00Z`,
            ttl: 2000000000,
          });
        }
      }

      mockSalesRepo.queryCategorySeason.mockResolvedValue(mockSales);

      const multiplier = await service.calculateSeasonalMultiplier('coats');

      // Should not crash, return 1.0 when insufficient data
      expect(multiplier).toBe(1.0);
    });

    it('should handle repository errors gracefully', async () => {
      mockSalesRepo.queryCategorySeason.mockRejectedValue(
        new Error('DynamoDB connection failed')
      );

      const multiplier = await service.calculateSeasonalMultiplier('coats');

      // Should fail safely with neutral multiplier
      expect(multiplier).toBe(1.0);
    });
  });
});
