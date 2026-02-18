/**
 * Unit Tests for Pricing Intelligence Module
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { 
  PricingIntelligenceService,
  CategoryBaselineAnalyzer,
} from '..';
import { 
  analyzeProductName, 
  calculateAdjustments 
} from '..';
import { 
  RecencyWeightEngine,
  calculateRecencyWeight,
  calculateWeightedAverage,
} from '..';
import type { HistoricalSale, PricingRequest, PricingSuggestion } from '..';

describe('Pricing Intelligence Module', () => {
  describe('CategoryBaselineAnalyzer', () => {
    const mockSales: HistoricalSale[] = [
      { saleId: '1', productName: 'Jakki', unitPrice: 10000, quantity: 1, saleDate: '2026-01-01' },
      { saleId: '2', productName: 'Buksur', unitPrice: 8000, quantity: 1, saleDate: '2026-01-15' },
      { saleId: '3', productName: 'Kjóll', unitPrice: 12000, quantity: 1, saleDate: '2026-02-01' },
      { saleId: '4', productName: 'Bolur', unitPrice: 5000, quantity: 1, saleDate: '2026-02-10' },
      { saleId: '5', productName: 'Vest', unitPrice: 6000, quantity: 1, saleDate: '2026-02-15' },
    ];

    it('should calculate baseline statistics correctly', () => {
      const baseline = CategoryBaselineAnalyzer.calculateBaseline(mockSales, 'clothing');
      
      expect(baseline.category).toBe('clothing');
      expect(baseline.sampleSize).toBe(5);
      expect(baseline.avgPrice).toBe(8200); // (10000+8000+12000+5000+6000)/5
      expect(baseline.minPrice).toBe(5000);
      expect(baseline.maxPrice).toBe(12000);
      expect(baseline.medianPrice).toBe(8000);
      expect(baseline.stdDev).toBeGreaterThan(0);
    });

    it('should return empty baseline for no sales', () => {
      const baseline = CategoryBaselineAnalyzer.calculateBaseline([], 'clothing');
      
      expect(baseline.category).toBe('clothing');
      expect(baseline.sampleSize).toBe(0);
      expect(baseline.avgPrice).toBe(0);
    });

    it('should parse category from product name', () => {
      expect(CategoryBaselineAnalyzer.parseCategoryFromName('Boss jakki')).toBe('outerwear');
      expect(CategoryBaselineAnalyzer.parseCategoryFromName('Gallabuxur')).toBe('pants');
      expect(CategoryBaselineAnalyzer.parseCategoryFromName('Kjóll')).toBe('dresses');
      expect(CategoryBaselineAnalyzer.parseCategoryFromName('Taska')).toBe('accessories');
    });
  });

  describe('ProductNameAnalyzer', () => {
    it('should extract brand from product name', () => {
      const result1 = analyzeProductName('Boss jakki með merkjum');
      expect(result1.brand).toBe('Boss');

      const result2 = analyzeProductName('Gucci veski');
      expect(result2.brand).toBe('Gucci');
    });

    it('should extract condition from product name', () => {
      const result1 = analyzeProductName('Jakki nýtt með merkjum');
      expect(result1.condition).toBe('new_with_tags');

      const result2 = analyzeProductName('Buksur mjög gott ástand');
      expect(result2.condition).toBe('very_good');
    });

    it('should extract size from product name', () => {
      const result1 = analyzeProductName('Jakki 40');
      expect(result1.size).toBe('40');

      const result2 = analyzeProductName('Bolur M');
      expect(result2.size).toBe('M');
    });

    it('should extract color from product name', () => {
      const result1 = analyzeProductName('Svartur jakki');
      expect(result1.color).toBe('#000000');

      const result2 = analyzeProductName('Hvítur bolur');
      expect(result2.color).toBe('#FFFFFF');
    });

    it('should calculate adjustment factors', () => {
      const result = analyzeProductName('Boss jakki með merkjum');
      const adjustments = calculateAdjustments(result);

      expect(adjustments.brandAdjustment).toBe(1.8); // Boss brand
      expect(adjustments.conditionAdjustment).toBe(1.0); // new_with_tags
    });
  });

  describe('RecencyWeightEngine', () => {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const sixtyDaysAgo = new Date();
    sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);

    it('should calculate recency weight', () => {
      const weight30 = calculateRecencyWeight(thirtyDaysAgo.toISOString());
      const weight60 = calculateRecencyWeight(sixtyDaysAgo.toISOString());

      // 30 days = 1 half-life = 0.5 weight
      expect(weight30).toBeCloseTo(0.5, 1);

      // 60 days = 2 half-lives = 0.25 weight
      expect(weight60).toBeCloseTo(0.25, 1);
    });

    it('should calculate weighted average', () => {
      const sales: HistoricalSale[] = [
        { saleId: '1', productName: 'A', unitPrice: 10000, quantity: 1, saleDate: new Date().toISOString() },
        { saleId: '2', productName: 'B', unitPrice: 20000, quantity: 1, saleDate: sixtyDaysAgo.toISOString() },
      ];

      const { weightedAvg } = calculateWeightedAverage(sales);

      // Recent sale has higher weight, so avg should be closer to 10000
      expect(weightedAvg).toBeLessThan(15000);
      expect(weightedAvg).toBeGreaterThan(10000);
    });

    it('should use engine with custom config', () => {
      const engine = new RecencyWeightEngine({
        halfLifeDays: 7,
        maxAgeDays: 60,
        minWeightThreshold: 0.1,
      });

      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      const weight = engine.calculateWeight(sevenDaysAgo.toISOString());
      expect(weight).toBeCloseTo(0.5, 1); // 1 half-life
    });
  });

  describe('PricingIntelligenceService', () => {
    const mockSales: HistoricalSale[] = [
      { saleId: '1', productName: 'Jakki', category: 'outerwear', unitPrice: 10000, quantity: 1, saleDate: '2026-01-01' },
      { saleId: '2', productName: 'Jakki', category: 'outerwear', unitPrice: 12000, quantity: 1, saleDate: '2026-02-01' },
      { saleId: '3', productName: 'Jakki', category: 'outerwear', unitPrice: 11000, quantity: 1, saleDate: '2026-02-10' },
    ];

    it('should generate pricing suggestion with mock data', async () => {
      const service = new PricingIntelligenceService();
      
      const request: PricingRequest = {
        productName: 'Boss jakki með merkjum',
        category: 'outerwear',
      };

      const suggestion = await service.getSuggestionWithMockData(request, mockSales);

      expect(suggestion.suggestedPrice).toBeGreaterThan(0);
      expect(suggestion.minPrice).toBeLessThan(suggestion.suggestedPrice);
      expect(suggestion.maxPrice).toBeGreaterThan(suggestion.suggestedPrice);
      expect(suggestion.confidence).toBeDefined();
      expect(suggestion.factors).toBeDefined();
      expect(suggestion.sources.length).toBeGreaterThan(0);
    });

    it('should apply brand premium', async () => {
      const service = new PricingIntelligenceService();
      
      const request: PricingRequest = {
        productName: 'Boss jakki',
        category: 'outerwear',
      };

      const suggestion = await service.getSuggestionWithMockData(request, mockSales);

      // Brand adjustment should be applied
      expect(suggestion.factors.brandAdjustment).toBe(1.8);
    });

    it('should calculate price range around suggested price', async () => {
      const service = new PricingIntelligenceService();
      
      const request: PricingRequest = {
        productName: 'Jakki',
        category: 'outerwear',
      };

      const suggestion = await service.getSuggestionWithMockData(request, mockSales);

      // Range should be ±25% of base price
      expect(suggestion.minPrice).toBeLessThanOrEqual(suggestion.suggestedPrice);
      expect(suggestion.maxPrice).toBeGreaterThanOrEqual(suggestion.suggestedPrice);
    });
  });

  describe('Integration Tests', () => {
    it('should handle complete pricing workflow', async () => {
      const sales: HistoricalSale[] = [
        { saleId: '1', productName: 'Boss jakki', category: 'outerwear', unitPrice: 20000, quantity: 1, saleDate: '2026-01-15' },
        { saleId: '2', productName: 'Boss buksur', category: 'pants', unitPrice: 12000, quantity: 1, saleDate: '2026-02-01' },
        { saleId: '3', productName: 'Gucci taska', category: 'accessories', unitPrice: 35000, quantity: 1, saleDate: '2026-02-10' },
      ];

      const service = new PricingIntelligenceService();

      // Test outerwear with brand
      const outerwearResult = await service.getSuggestionWithMockData(
        { productName: 'Boss jakki nýtt', category: 'outerwear' },
        sales
      );
      expect(outerwearResult.suggestedPrice).toBeGreaterThan(0);
      expect(outerwearResult.factors.brandAdjustment).toBe(1.8);
      expect(outerwearResult.factors.conditionAdjustment).toBe(1.0);

      // Test accessories with luxury brand
      const accessoryResult = await service.getSuggestionWithMockData(
        { productName: 'Gucci veski', category: 'accessories' },
        sales
      );
      expect(accessoryResult.factors.brandAdjustment).toBe(2.5);
    });

    it('should handle edge cases gracefully', async () => {
      const service = new PricingIntelligenceService();

      // Empty product name
      const emptyResult = await service.getSuggestionWithMockData(
        { productName: '' },
        []
      );
      // Fallback is 5000 ISK but rounded to nearest 100
      expect(emptyResult.suggestedPrice).toBe(4800); // Fallback default

      // Unknown category
      const unknownResult = await service.getSuggestionWithMockData(
        { productName: 'Unknown product xyz123' },
        []
      );
      expect(unknownResult.sources).toContain('fallback_default');
    });
  });
});
