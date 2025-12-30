/**
 * Vector Search Service Tests
 *
 * Test coverage for two-phase vector similarity search:
 * - DynamoDB querying
 * - S3 batch embedding fetching
 * - Cosine similarity calculation
 * - End-to-end integration
 * - Performance targets
 *
 * @test
 */

import {
  VectorSearchService,
  VectorSearchOptions,
  SimilarProduct,
  VectorSearchMetrics,
} from '../vector-search';
import { SalesRepository } from '../sales-repository';
import { EmbeddingStorageService } from '../embedding-storage';

// Mock the dependencies
jest.mock('../sales-repository');
jest.mock('../embedding-storage');

describe('VectorSearchService', () => {
  let service: VectorSearchService;
  let mockSalesRepository: jest.Mocked<SalesRepository>;
  let mockEmbeddingStorage: jest.Mocked<EmbeddingStorageService>;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();

    // Initialize service with mocked dependencies
    service = new VectorSearchService({
      tenantId: 'test-tenant',
      stage: 'dev',
      embeddingsBucket: 'test-bucket',
    });

    // Get mock instances
    mockSalesRepository = (SalesRepository as jest.MockedClass<
      typeof SalesRepository
    >).mock.results[0].value;

    mockEmbeddingStorage = (EmbeddingStorageService as jest.MockedClass<
      typeof EmbeddingStorageService
    >).mock.results[0].value;
  });

  describe('findSimilar', () => {
    it('should perform two-phase search successfully', async () => {
      // Setup: Create test data
      const queryEmbedding = new Array(1024).fill(0.5);

      const mockSales = [
        {
          PK: 'TENANT#test#PRODUCT#prod1',
          SK: 'SALE#2025-01-01#sale1',
          saleId: 'sale1',
          embeddingId: 'emb1',
          embeddingS3Key: 's3://bucket/emb1.json',
          productId: 'prod1',
          salePrice: 100,
          originalPrice: 150,
          saleDate: '2025-01-01',
          category: 'dress',
          tenant: 'test-tenant',
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-01T00:00:00Z',
          ttl: 1735689600,
        },
      ];

      const similarEmbedding = new Array(1024).fill(0.5); // Will have similarity ~1.0
      const mockEmbeddings = new Map([['emb1', similarEmbedding]]);

      // Mock DynamoDB query
      jest
        .spyOn(mockSalesRepository, 'queryCategorySeason')
        .mockResolvedValue(mockSales);

      // Mock S3 fetch
      jest
        .spyOn(mockEmbeddingStorage, 'fetchEmbeddingsBatch')
        .mockResolvedValue(mockEmbeddings);

      // Execute
      const results = await service.findSimilar(queryEmbedding, {
        limit: 20,
        minSimilarity: 0.70,
        daysBack: 90,
        category: 'dress',
      });

      // Assert
      expect(results).toHaveLength(1);
      expect(results[0].saleId).toBe('sale1');
      expect(results[0].similarity).toBeGreaterThan(0.95); // Should be ~1.0
    });

    it('should filter by minimum similarity threshold', async () => {
      const queryEmbedding = new Array(1024).fill(0.8);

      // Create embeddings with different similarities
      const mockSales = [
        {
          PK: 'TENANT#test#PRODUCT#prod1',
          SK: 'SALE#2025-01-01#sale1',
          saleId: 'sale1',
          embeddingId: 'emb1',
          embeddingS3Key: 's3://bucket/emb1.json',
          productId: 'prod1',
          salePrice: 100,
          originalPrice: 150,
          saleDate: '2025-01-01',
          category: 'dress',
          tenant: 'test-tenant',
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-01T00:00:00Z',
          ttl: 1735689600,
        },
        {
          PK: 'TENANT#test#PRODUCT#prod2',
          SK: 'SALE#2025-01-02#sale2',
          saleId: 'sale2',
          embeddingId: 'emb2',
          embeddingS3Key: 's3://bucket/emb2.json',
          productId: 'prod2',
          salePrice: 80,
          originalPrice: 120,
          saleDate: '2025-01-02',
          category: 'dress',
          tenant: 'test-tenant',
          createdAt: '2025-01-02T00:00:00Z',
          updatedAt: '2025-01-02T00:00:00Z',
          ttl: 1735689600,
        },
      ];

      // Similar embedding (0.8 similarity expected)
      const similarEmbedding = new Array(1024).fill(0.8);
      // Dissimilar embedding (low similarity)
      const dissimilarEmbedding = new Array(1024).fill(0.1);

      const mockEmbeddings = new Map([
        ['emb1', similarEmbedding],
        ['emb2', dissimilarEmbedding],
      ]);

      jest
        .spyOn(mockSalesRepository, 'queryCategorySeason')
        .mockResolvedValue(mockSales);

      jest
        .spyOn(mockEmbeddingStorage, 'fetchEmbeddingsBatch')
        .mockResolvedValue(mockEmbeddings);

      // Only return matches with similarity >= 0.85
      const results = await service.findSimilar(queryEmbedding, {
        limit: 20,
        minSimilarity: 0.85,
        daysBack: 90,
      });

      expect(results).toHaveLength(0); // Both fail threshold
    });

    it('should return top N results sorted by similarity', async () => {
      const queryEmbedding = new Array(1024).fill(0.5);

      const mockSales = Array.from({ length: 5 }, (_, i) => ({
        PK: `TENANT#test#PRODUCT#prod${i}`,
        SK: `SALE#2025-01-0${i + 1}#sale${i}`,
        saleId: `sale${i}`,
        embeddingId: `emb${i}`,
        embeddingS3Key: `s3://bucket/emb${i}.json`,
        productId: `prod${i}`,
        salePrice: 100 + i * 10,
        originalPrice: 150 + i * 10,
        saleDate: `2025-01-0${i + 1}`,
        category: 'dress',
        tenant: 'test-tenant',
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-01T00:00:00Z',
        ttl: 1735689600,
      }));

      const mockEmbeddings = new Map(
        Array.from({ length: 5 }, (_, i) => [
          `emb${i}`,
          new Array(1024).fill(0.5 + i * 0.05), // Increasing similarity
        ])
      );

      jest
        .spyOn(mockSalesRepository, 'queryCategorySeason')
        .mockResolvedValue(mockSales);

      jest
        .spyOn(mockEmbeddingStorage, 'fetchEmbeddingsBatch')
        .mockResolvedValue(mockEmbeddings);

      const results = await service.findSimilar(queryEmbedding, {
        limit: 3,
        minSimilarity: 0,
        daysBack: 90,
      });

      expect(results).toHaveLength(3);
      // Results should be sorted by similarity (descending)
      expect(results[0].similarity).toBeGreaterThanOrEqual(results[1].similarity);
      expect(results[1].similarity).toBeGreaterThanOrEqual(results[2].similarity);
    });

    it('should handle missing embeddings gracefully', async () => {
      const queryEmbedding = new Array(1024).fill(0.5);

      const mockSales = [
        {
          PK: 'TENANT#test#PRODUCT#prod1',
          SK: 'SALE#2025-01-01#sale1',
          saleId: 'sale1',
          embeddingId: 'emb1',
          embeddingS3Key: 's3://bucket/emb1.json',
          productId: 'prod1',
          salePrice: 100,
          originalPrice: 150,
          saleDate: '2025-01-01',
          category: 'dress',
          tenant: 'test-tenant',
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-01T00:00:00Z',
          ttl: 1735689600,
        },
        {
          PK: 'TENANT#test#PRODUCT#prod2',
          SK: 'SALE#2025-01-02#sale2',
          saleId: 'sale2',
          embeddingId: 'emb2',
          embeddingS3Key: 's3://bucket/emb2.json',
          productId: 'prod2',
          salePrice: 80,
          originalPrice: 120,
          saleDate: '2025-01-02',
          category: 'dress',
          tenant: 'test-tenant',
          createdAt: '2025-01-02T00:00:00Z',
          updatedAt: '2025-01-02T00:00:00Z',
          ttl: 1735689600,
        },
      ];

      // Only return one embedding (emb1 missing)
      const mockEmbeddings = new Map([
        ['emb1', new Array(1024).fill(0.5)],
      ]);

      jest
        .spyOn(mockSalesRepository, 'queryCategorySeason')
        .mockResolvedValue(mockSales);

      jest
        .spyOn(mockEmbeddingStorage, 'fetchEmbeddingsBatch')
        .mockResolvedValue(mockEmbeddings);

      const results = await service.findSimilar(queryEmbedding, {
        limit: 20,
        minSimilarity: 0.5,
        daysBack: 90,
      });

      // Should only return the product with embedding
      expect(results).toHaveLength(1);
      expect(results[0].embeddingId).toBe('emb1');
    });

    it('should return empty array when no sales metadata found', async () => {
      const queryEmbedding = new Array(1024).fill(0.5);

      jest
        .spyOn(mockSalesRepository, 'queryCategorySeason')
        .mockResolvedValue([]);

      const results = await service.findSimilar(queryEmbedding, {
        limit: 20,
        minSimilarity: 0.7,
        daysBack: 90,
      });

      expect(results).toHaveLength(0);
    });

    it('should reject invalid query embedding dimensions', async () => {
      const invalidEmbedding = new Array(512).fill(0.5); // Wrong size

      await expect(
        service.findSimilar(invalidEmbedding, {
          limit: 20,
          minSimilarity: 0.7,
        })
      ).rejects.toThrow('Invalid query embedding dimension');
    });

    it('should complete search within performance target', async () => {
      const queryEmbedding = new Array(1024).fill(0.5);

      const mockSales = Array.from({ length: 100 }, (_, i) => ({
        PK: `TENANT#test#PRODUCT#prod${i}`,
        SK: `SALE#2025-01-01#sale${i}`,
        saleId: `sale${i}`,
        embeddingId: `emb${i}`,
        embeddingS3Key: `s3://bucket/emb${i}.json`,
        productId: `prod${i}`,
        salePrice: 100,
        originalPrice: 150,
        saleDate: '2025-01-01',
        category: 'dress',
        tenant: 'test-tenant',
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-01T00:00:00Z',
        ttl: 1735689600,
      }));

      const mockEmbeddings = new Map(
        mockSales.map((sale) => [sale.embeddingId, new Array(1024).fill(0.5)])
      );

      jest
        .spyOn(mockSalesRepository, 'queryCategorySeason')
        .mockResolvedValue(mockSales);

      jest
        .spyOn(mockEmbeddingStorage, 'fetchEmbeddingsBatch')
        .mockResolvedValue(mockEmbeddings);

      const startTime = Date.now();
      const results = await service.findSimilar(queryEmbedding, {
        limit: 20,
        minSimilarity: 0,
        daysBack: 90,
      });
      const duration = Date.now() - startTime;

      // Should complete in under 500ms (allowing for test environment overhead)
      expect(duration).toBeLessThan(1000);
      expect(results.length).toBeLessThanOrEqual(20);
    });
  });

  describe('cosineSimilarity', () => {
    it('should calculate perfect similarity for identical vectors', () => {
      const vector = new Array(1024).fill(0.5);
      // Use reflection to test private method
      const similarity = (service as any).cosineSimilarity(vector, vector);

      expect(similarity).toBeCloseTo(1.0, 5);
    });

    it('should calculate zero similarity for orthogonal vectors', () => {
      const vector1 = new Array(1024).fill(0);
      vector1[0] = 1;

      const vector2 = new Array(1024).fill(0);
      vector2[1] = 1;

      const similarity = (service as any).cosineSimilarity(vector1, vector2);

      expect(similarity).toBeCloseTo(0, 5);
    });

    it('should handle zero vectors', () => {
      const zeroVector = new Array(1024).fill(0);
      const normalVector = new Array(1024).fill(0.5);

      const similarity = (service as any).cosineSimilarity(
        zeroVector,
        normalVector
      );

      expect(similarity).toBe(0);
    });

    it('should reject mismatched dimensions', () => {
      const vector1 = new Array(1024).fill(0.5);
      const vector2 = new Array(512).fill(0.5);

      expect(() => {
        (service as any).cosineSimilarity(vector1, vector2);
      }).toThrow('Embedding dimension mismatch');
    });
  });

  describe('metrics', () => {
    it('should track search metrics', async () => {
      const queryEmbedding = new Array(1024).fill(0.5);

      const mockSales = [
        {
          PK: 'TENANT#test#PRODUCT#prod1',
          SK: 'SALE#2025-01-01#sale1',
          saleId: 'sale1',
          embeddingId: 'emb1',
          embeddingS3Key: 's3://bucket/emb1.json',
          productId: 'prod1',
          salePrice: 100,
          originalPrice: 150,
          saleDate: '2025-01-01',
          category: 'dress',
          tenant: 'test-tenant',
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-01T00:00:00Z',
          ttl: 1735689600,
        },
      ];

      jest
        .spyOn(mockSalesRepository, 'queryCategorySeason')
        .mockResolvedValue(mockSales);

      jest
        .spyOn(mockEmbeddingStorage, 'fetchEmbeddingsBatch')
        .mockResolvedValue(new Map([['emb1', new Array(1024).fill(0.5)]]));

      await service.findSimilar(queryEmbedding, {
        limit: 20,
        minSimilarity: 0.5,
      });

      const metrics = service.getMetrics();

      expect(metrics.candidates).toBe(1);
      expect(metrics.results).toBe(1);
      expect(metrics.totalMs).toBeGreaterThan(0);
      expect(metrics.dynamoDbMs).toBeGreaterThan(0);
      expect(metrics.s3FetchMs).toBeGreaterThan(0);
      expect(metrics.similarityMs).toBeGreaterThan(0);
    });

    it('should reset metrics', async () => {
      const queryEmbedding = new Array(1024).fill(0.5);

      jest
        .spyOn(mockSalesRepository, 'queryCategorySeason')
        .mockResolvedValue([]);

      jest
        .spyOn(mockEmbeddingStorage, 'fetchEmbeddingsBatch')
        .mockResolvedValue(new Map());

      await service.findSimilar(queryEmbedding, {
        limit: 20,
        minSimilarity: 0.5,
      });

      service.resetMetrics();
      const metrics = service.getMetrics();

      expect(metrics.candidates).toBe(0);
      expect(metrics.results).toBe(0);
      expect(metrics.totalMs).toBe(0);
    });
  });
});
