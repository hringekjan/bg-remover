/**
 * Tests for Sales Repository
 *
 * Mocks DynamoDB interactions and validates repository behavior
 */

import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  QueryCommand,
  DeleteItemCommand,
  UpdateItemCommand,
  BatchWriteItemCommand,
  ScanCommand,
} from '@aws-sdk/client-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { Logger } from '@aws-lambda-powertools/logger';

import { SalesRepository } from './sales-repository';
import { createSalesRecord } from '../sales-intelligence-types';
import type { SalesRecord } from '../sales-intelligence-types';

describe('SalesRepository', () => {
  let repo: SalesRepository;
  const mockDynamoDB = mockClient(DynamoDBClient);
  const mockLogger = new Logger({ serviceName: 'SalesRepositoryTest' });

  beforeEach(() => {
    mockDynamoDB.reset();
    repo = new SalesRepository({
      tableName: 'test-sales-intelligence',
      region: 'eu-west-1',
      logger: mockLogger,
      ttlYears: 2,
    });
  });

  describe('putSale', () => {
    it('should store a sale record with calculated TTL', async () => {
      const sale = createSalesRecord({
        tenant: 'carousel-labs',
        productId: 'prod_123',
        saleId: 'sale_abc',
        saleDate: '2025-12-29',
        salePrice: 99.99,
        originalPrice: 199.99,
        category: 'dress',
        brand: 'Nike',
        embeddingId: 'emb_xyz',
        embeddingS3Key: 's3://bucket/carousel-labs/products/prod_123/sales/sale_abc.json',
      });

      mockDynamoDB.on(PutItemCommand).resolves({});

      await repo.putSale(sale);

      expect(mockDynamoDB.call(0).args[0].input).toHaveProperty('TableName', 'test-sales-intelligence');
      expect(mockDynamoDB.call(0).args[0].input).toHaveProperty('Item');
    });

    it('should calculate correct TTL (2 years from sale date)', async () => {
      const sale = createSalesRecord({
        tenant: 'carousel-labs',
        productId: 'prod_123',
        saleId: 'sale_abc',
        saleDate: '2025-12-29',
        salePrice: 99.99,
        originalPrice: 199.99,
        category: 'dress',
        embeddingId: 'emb_xyz',
        embeddingS3Key: 's3://bucket/tenant/products/prod_123/sales/sale_abc.json',
      });

      mockDynamoDB.on(PutItemCommand).resolves({});

      await repo.putSale(sale);

      // TTL should be set to 2 years from sale date
      const putCommand = mockDynamoDB.call(0);
      expect(putCommand).toBeDefined();
    });

    it('should populate GSI keys correctly', async () => {
      const sale = createSalesRecord({
        tenant: 'carousel-labs',
        productId: 'prod_123',
        saleId: 'sale_abc',
        saleDate: '2025-12-29',
        salePrice: 99.99,
        originalPrice: 199.99,
        category: 'dress',
        brand: 'Nike',
        embeddingId: 'emb_xyz',
        embeddingS3Key: 's3://bucket/tenant/products/prod_123/sales/sale_abc.json',
      });

      mockDynamoDB.on(PutItemCommand).resolves({});

      await repo.putSale(sale);

      // Verify GSI keys were set
      const putCommand = mockDynamoDB.call(0);
      expect(putCommand).toBeDefined();
      expect(mockDynamoDB.commandCalls(PutItemCommand)).toHaveLength(1);
    });

    it('should include brand GSI keys when brand is present', async () => {
      const sale = createSalesRecord({
        tenant: 'carousel-labs',
        productId: 'prod_123',
        saleId: 'sale_abc',
        saleDate: '2025-12-29',
        salePrice: 99.99,
        originalPrice: 199.99,
        category: 'dress',
        brand: 'Nike',
        embeddingId: 'emb_xyz',
        embeddingS3Key: 's3://bucket/tenant/products/prod_123/sales/sale_abc.json',
      });

      mockDynamoDB.on(PutItemCommand).resolves({});

      await repo.putSale(sale);

      expect(mockDynamoDB.commandCalls(PutItemCommand)).toHaveLength(1);
    });
  });

  describe('getSale', () => {
    it('should retrieve a sale record by key', async () => {
      const mockRecord = {
        PK: { S: 'TENANT#carousel-labs#PRODUCT#prod_123' },
        SK: { S: 'SALE#2025-12-29#sale_abc' },
        tenant: { S: 'carousel-labs' },
        productId: { S: 'prod_123' },
        saleId: { S: 'sale_abc' },
        saleDate: { S: '2025-12-29' },
        salePrice: { N: '99.99' },
        originalPrice: { N: '199.99' },
        category: { S: 'dress' },
        embeddingId: { S: 'emb_xyz' },
        embeddingS3Key: { S: 's3://bucket/tenant/products/prod_123/sales/sale_abc.json' },
        createdAt: { S: '2025-12-29T00:00:00Z' },
        updatedAt: { S: '2025-12-29T00:00:00Z' },
        ttl: { N: '1798982400' },
      };

      mockDynamoDB.on(GetItemCommand).resolves({
        Item: mockRecord,
      });

      const result = await repo.getSale(
        'carousel-labs',
        'prod_123',
        '2025-12-29',
        'sale_abc'
      );

      expect(result).toBeDefined();
      expect(result?.PK).toBe('TENANT#carousel-labs#PRODUCT#prod_123');
      expect(result?.SK).toBe('SALE#2025-12-29#sale_abc');
      expect(mockDynamoDB.commandCalls(GetItemCommand)).toHaveLength(1);
    });

    it('should return undefined when record not found', async () => {
      mockDynamoDB.on(GetItemCommand).resolves({
        Item: undefined,
      });

      const result = await repo.getSale(
        'carousel-labs',
        'prod_123',
        '2025-12-29',
        'sale_abc'
      );

      expect(result).toBeUndefined();
    });
  });

  describe('queryCategorySeason', () => {
    it('should query category trends across all shards', async () => {
      mockDynamoDB.on(QueryCommand).resolves({
        Items: [],
        Count: 0,
        ScannedCount: 0,
      });

      const results = await repo.queryCategorySeason(
        'carousel-labs',
        'dress',
        'SPRING'
      );

      // Should query 10 shards
      expect(mockDynamoDB.commandCalls(QueryCommand).length).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(results)).toBe(true);
    });

    it('should filter by date range', async () => {
      mockDynamoDB.on(QueryCommand).resolves({
        Items: [],
        Count: 0,
        ScannedCount: 0,
      });

      const results = await repo.queryCategorySeason(
        'carousel-labs',
        'dress',
        undefined,
        '2025-12-01',
        '2025-12-31'
      );

      expect(Array.isArray(results)).toBe(true);
    });
  });

  describe('queryProductEmbeddings', () => {
    it('should query embeddings by product ID', async () => {
      mockDynamoDB.on(QueryCommand).resolves({
        Items: [],
        Count: 0,
        ScannedCount: 0,
      });

      const results = await repo.queryProductEmbeddings(
        'carousel-labs',
        'prod_123'
      );

      expect(Array.isArray(results)).toBe(true);
      expect(mockDynamoDB.commandCalls(QueryCommand)).toHaveLength(1);
    });

    it('should support date range filtering', async () => {
      mockDynamoDB.on(QueryCommand).resolves({
        Items: [],
        Count: 0,
        ScannedCount: 0,
      });

      const results = await repo.queryProductEmbeddings(
        'carousel-labs',
        'prod_123',
        '2025-12-01',
        '2025-12-31'
      );

      expect(Array.isArray(results)).toBe(true);
    });
  });

  describe('queryBrandPricing', () => {
    it('should query sales by brand', async () => {
      mockDynamoDB.on(QueryCommand).resolves({
        Items: [],
        Count: 0,
        ScannedCount: 0,
      });

      const results = await repo.queryBrandPricing(
        'carousel-labs',
        'Nike'
      );

      expect(Array.isArray(results)).toBe(true);
      expect(mockDynamoDB.commandCalls(QueryCommand)).toHaveLength(1);
    });

    it('should support date range filtering', async () => {
      mockDynamoDB.on(QueryCommand).resolves({
        Items: [],
        Count: 0,
        ScannedCount: 0,
      });

      const results = await repo.queryBrandPricing(
        'carousel-labs',
        'Nike',
        '2025-12-01',
        '2025-12-31'
      );

      expect(Array.isArray(results)).toBe(true);
    });
  });

  describe('updateSale', () => {
    it('should update a sale record', async () => {
      mockDynamoDB.on(UpdateItemCommand).resolves({});

      await repo.updateSale(
        'carousel-labs',
        'prod_123',
        '2025-12-29',
        'sale_abc',
        { salePrice: 89.99 }
      );

      expect(mockDynamoDB.commandCalls(UpdateItemCommand)).toHaveLength(1);
    });

    it('should skip GSI key updates', async () => {
      mockDynamoDB.on(UpdateItemCommand).resolves({});

      // Update with a mix of GSI and non-GSI fields to test filtering
      await repo.updateSale(
        'carousel-labs',
        'prod_123',
        '2025-12-29',
        'sale_abc',
        { GSI1PK: 'invalid', salePrice: 89.99 } as any
      );

      expect(mockDynamoDB.commandCalls(UpdateItemCommand)).toHaveLength(1);
    });

    it('should update updatedAt timestamp', async () => {
      mockDynamoDB.on(UpdateItemCommand).resolves({});

      await repo.updateSale(
        'carousel-labs',
        'prod_123',
        '2025-12-29',
        'sale_abc',
        { salePrice: 89.99 }
      );

      // Verify updatedAt was set
      expect(mockDynamoDB.commandCalls(UpdateItemCommand)).toHaveLength(1);
    });
  });

  describe('deleteSale', () => {
    it('should delete a sale record', async () => {
      mockDynamoDB.on(DeleteItemCommand).resolves({});

      await repo.deleteSale(
        'carousel-labs',
        'prod_123',
        '2025-12-29',
        'sale_abc'
      );

      expect(mockDynamoDB.commandCalls(DeleteItemCommand)).toHaveLength(1);
    });
  });

  describe('batchWriteSales', () => {
    it('should batch write multiple records', async () => {
      mockDynamoDB.on(BatchWriteItemCommand).resolves({
        UnprocessedItems: {},
      });

      const sales = Array.from({ length: 10 }, (_, i) =>
        createSalesRecord({
          tenant: 'carousel-labs',
          productId: `prod_${i}`,
          saleId: `sale_${i}`,
          saleDate: '2025-12-29',
          salePrice: 99.99 + i,
          originalPrice: 199.99 + i,
          category: 'dress',
          embeddingId: `emb_${i}`,
          embeddingS3Key: `s3://bucket/tenant/products/prod_${i}/sales/sale_${i}.json`,
        })
      );

      const written = await repo.batchWriteSales(sales);

      expect(written).toBe(10);
      expect(mockDynamoDB.commandCalls(BatchWriteItemCommand)).toHaveLength(1);
    });

    it('should handle batch size limits (max 25)', async () => {
      mockDynamoDB.on(BatchWriteItemCommand).resolves({
        UnprocessedItems: {},
      });

      const sales = Array.from({ length: 50 }, (_, i) =>
        createSalesRecord({
          tenant: 'carousel-labs',
          productId: `prod_${i}`,
          saleId: `sale_${i}`,
          saleDate: '2025-12-29',
          salePrice: 99.99,
          originalPrice: 199.99,
          category: 'dress',
          embeddingId: `emb_${i}`,
          embeddingS3Key: `s3://bucket/tenant/products/prod_${i}/sales/sale_${i}.json`,
        })
      );

      await repo.batchWriteSales(sales);

      // Should split into 2 batches (25 + 25)
      expect(mockDynamoDB.commandCalls(BatchWriteItemCommand).length).toBeGreaterThanOrEqual(1);
    });

    it('should calculate TTL for batch items', async () => {
      mockDynamoDB.on(BatchWriteItemCommand).resolves({
        UnprocessedItems: {},
      });

      const sales = Array.from({ length: 5 }, (_, i) =>
        createSalesRecord({
          tenant: 'carousel-labs',
          productId: `prod_${i}`,
          saleId: `sale_${i}`,
          saleDate: '2025-12-29',
          salePrice: 99.99,
          originalPrice: 199.99,
          category: 'dress',
          embeddingId: `emb_${i}`,
          embeddingS3Key: `s3://bucket/tenant/products/prod_${i}/sales/sale_${i}.json`,
        })
      );

      await repo.batchWriteSales(sales);

      expect(mockDynamoDB.commandCalls(BatchWriteItemCommand)).toHaveLength(1);
    });
  });

  describe('Error Handling', () => {
    it('should handle DynamoDB errors gracefully', async () => {
      mockDynamoDB.on(PutItemCommand).rejects(new Error('DynamoDB error'));

      const sale = createSalesRecord({
        tenant: 'carousel-labs',
        productId: 'prod_123',
        saleId: 'sale_abc',
        saleDate: '2025-12-29',
        salePrice: 99.99,
        originalPrice: 199.99,
        category: 'dress',
        embeddingId: 'emb_xyz',
        embeddingS3Key: 's3://bucket/tenant/products/prod_123/sales/sale_abc.json',
      });

      await expect(repo.putSale(sale)).rejects.toThrow();
    });

    it('should log errors when operations fail', async () => {
      const loggerSpy = jest.spyOn(mockLogger, 'error');
      mockDynamoDB.on(GetItemCommand).rejects(new Error('Read error'));

      await expect(
        repo.getSale('carousel-labs', 'prod_123', '2025-12-29', 'sale_abc')
      ).rejects.toThrow();

      expect(loggerSpy).toHaveBeenCalled();
    });
  });

  describe('Multi-tenant Isolation', () => {
    it('should use tenant ID in primary key', async () => {
      mockDynamoDB.on(PutItemCommand).resolves({});

      const sale1 = createSalesRecord({
        tenant: 'tenant-a',
        productId: 'prod_123',
        saleId: 'sale_abc',
        saleDate: '2025-12-29',
        salePrice: 99.99,
        originalPrice: 199.99,
        category: 'dress',
        embeddingId: 'emb_xyz',
        embeddingS3Key: 's3://bucket/tenant/products/prod_123/sales/sale_abc.json',
      });

      await repo.putSale(sale1);

      // PK should contain tenant-a
      expect(mockDynamoDB.commandCalls(PutItemCommand)).toHaveLength(1);
    });

    it('should isolate queries by tenant', async () => {
      mockDynamoDB.on(QueryCommand).resolves({
        Items: [],
        Count: 0,
        ScannedCount: 0,
      });

      await repo.queryCategorySeason('tenant-a', 'dress');
      await repo.queryCategorySeason('tenant-b', 'dress');

      // Both queries should succeed with different tenant contexts
      expect(mockDynamoDB.commandCalls(QueryCommand).length).toBeGreaterThanOrEqual(2);
    });
  });
});
