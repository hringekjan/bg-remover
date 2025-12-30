/**
 * DynamoDB TTL Backfill Script Tests
 *
 * Tests for the backfill-ttl.ts script with focus on:
 * - Uppercase PK/SK attribute handling
 * - TTL calculation correctness
 * - Batch processing
 * - Error handling and retry logic
 * - Dry-run functionality
 */

import {
  DynamoDBClient,
  ScanCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { backfillTTL } from '../backfill-ttl';

// Mock DynamoDB client
const dynamoMock = mockClient(DynamoDBClient);

describe('backfill-ttl', () => {
  beforeEach(() => {
    dynamoMock.reset();
    jest.clearAllMocks();
  });

  describe('ProjectionExpression uppercase PK/SK', () => {
    it('should use uppercase PK and SK in scan projection', async () => {
      dynamoMock.on(ScanCommand).resolves({
        Items: [
          {
            PK: { S: 'TENANT#carousel-labs#PRODUCT#prod_123' },
            SK: { S: 'SALE#2025-01-15#sale_456' },
            saleDate: { S: '2025-01-15' },
          },
        ],
        ScannedCount: 1,
        Count: 1,
      });

      dynamoMock.on(UpdateItemCommand).resolves({});

      await backfillTTL({
        tableName: 'test-sales-table',
        region: 'eu-west-1',
        dryRun: false,
      });

      // Verify scan used uppercase PK/SK
      const scanCalls = dynamoMock.commandCalls(ScanCommand);
      expect(scanCalls).toHaveLength(1);

      const scanInput = scanCalls[0].args[0].input;
      expect(scanInput.ProjectionExpression).toBe('PK, SK, saleDate, #ttl');
      expect(scanInput.ExpressionAttributeNames).toEqual({ '#ttl': 'ttl' });
    });

    it('should extract uppercase PK and SK from scan results', async () => {
      const testItems = [
        {
          PK: { S: 'TENANT#carousel-labs#PRODUCT#prod_123' },
          SK: { S: 'SALE#2025-01-15#sale_456' },
          saleDate: { S: '2025-01-15' },
        },
        {
          PK: { S: 'TENANT#carousel-labs#PRODUCT#prod_789' },
          SK: { S: 'SALE#2025-01-16#sale_789' },
          saleDate: { S: '2025-01-16' },
        },
      ];

      dynamoMock.on(ScanCommand).resolves({
        Items: testItems,
        ScannedCount: 2,
        Count: 2,
      });

      dynamoMock.on(UpdateItemCommand).resolves({});

      const result = await backfillTTL({
        tableName: 'test-sales-table',
        region: 'eu-west-1',
        dryRun: false,
      });

      // Verify both items were processed
      expect(result.totalProcessed).toBe(2);
      expect(result.totalUpdated).toBe(2);

      // Verify update commands used uppercase keys
      const updateCalls = dynamoMock.commandCalls(UpdateItemCommand);
      expect(updateCalls).toHaveLength(2);

      // Check first update
      const firstUpdateKey = updateCalls[0].args[0].input.Key as any;
      expect(firstUpdateKey).toHaveProperty('PK');
      expect(firstUpdateKey).toHaveProperty('SK');
      expect(firstUpdateKey.PK).toEqual({ S: 'TENANT#carousel-labs#PRODUCT#prod_123' });
      expect(firstUpdateKey.SK).toEqual({ S: 'SALE#2025-01-15#sale_456' });

      // Check second update
      const secondUpdateKey = updateCalls[1].args[0].input.Key as any;
      expect(secondUpdateKey.PK).toEqual({ S: 'TENANT#carousel-labs#PRODUCT#prod_789' });
      expect(secondUpdateKey.SK).toEqual({ S: 'SALE#2025-01-16#sale_789' });
    });
  });

  describe('TTL calculation', () => {
    it('should calculate correct TTL for 2-year retention', async () => {
      dynamoMock.on(ScanCommand).resolves({
        Items: [
          {
            PK: { S: 'TENANT#carousel-labs#PRODUCT#prod_123' },
            SK: { S: 'SALE#2025-01-15#sale_456' },
            saleDate: { S: '2025-01-15' },
          },
        ],
        ScannedCount: 1,
        Count: 1,
      });

      dynamoMock.on(UpdateItemCommand).resolves({});

      await backfillTTL({
        tableName: 'test-sales-table',
        region: 'eu-west-1',
        dryRun: false,
        ttlYears: 2,
      });

      // Verify TTL was set correctly
      const updateCalls = dynamoMock.commandCalls(UpdateItemCommand);
      const updateInput = updateCalls[0].args[0].input;

      // Expected TTL: 2027-01-15 (2 years from 2025-01-15)
      const expectedDate = new Date('2027-01-15');
      const expectedTTL = Math.floor(expectedDate.getTime() / 1000);

      const ttlValue = (updateInput.ExpressionAttributeValues as any)?.[':ttl'];

      // ttlValue comes in DynamoDB format {N: "value"}, extract the numeric value
      const actualTTL = typeof ttlValue === 'object' ? parseInt(ttlValue.N || ttlValue) : ttlValue;

      // Allow for small variations due to timing (within 1 hour)
      expect(Math.abs(actualTTL - expectedTTL)).toBeLessThan(3600);
    });

    it('should calculate TTL with custom retention years', async () => {
      dynamoMock.on(ScanCommand).resolves({
        Items: [
          {
            PK: { S: 'TENANT#carousel-labs#PRODUCT#prod_123' },
            SK: { S: 'SALE#2025-06-30#sale_456' },
            saleDate: { S: '2025-06-30' },
          },
        ],
        ScannedCount: 1,
        Count: 1,
      });

      dynamoMock.on(UpdateItemCommand).resolves({});

      await backfillTTL({
        tableName: 'test-sales-table',
        region: 'eu-west-1',
        dryRun: false,
        ttlYears: 3,
      });

      // Expected TTL: 2028-06-30 (3 years from 2025-06-30)
      const expectedDate = new Date('2028-06-30');
      const expectedTTL = Math.floor(expectedDate.getTime() / 1000);

      const updateCalls = dynamoMock.commandCalls(UpdateItemCommand);
      const updateInput = updateCalls[0].args[0].input;
      const ttlValue = (updateInput.ExpressionAttributeValues as any)?.[':ttl'];

      // ttlValue comes in DynamoDB format {N: "value"}, extract the numeric value
      const actualTTL = typeof ttlValue === 'object' ? parseInt(ttlValue.N || ttlValue) : ttlValue;

      // Allow for small variations due to timing (within 1 hour)
      expect(Math.abs(actualTTL - expectedTTL)).toBeLessThan(3600);
    });
  });

  describe('Dry-run mode', () => {
    it('should not execute updates in dry-run mode', async () => {
      dynamoMock.on(ScanCommand).resolves({
        Items: [
          {
            PK: { S: 'TENANT#carousel-labs#PRODUCT#prod_123' },
            SK: { S: 'SALE#2025-01-15#sale_456' },
            saleDate: { S: '2025-01-15' },
          },
          {
            PK: { S: 'TENANT#carousel-labs#PRODUCT#prod_789' },
            SK: { S: 'SALE#2025-01-16#sale_789' },
            saleDate: { S: '2025-01-16' },
          },
        ],
        ScannedCount: 2,
        Count: 2,
      });

      dynamoMock.on(UpdateItemCommand).resolves({});

      const result = await backfillTTL({
        tableName: 'test-sales-table',
        region: 'eu-west-1',
        dryRun: true,
      });

      // Verify no updates were sent
      const updateCalls = dynamoMock.commandCalls(UpdateItemCommand);
      expect(updateCalls).toHaveLength(0);

      // But counters should reflect what would have been updated
      expect(result.totalProcessed).toBe(2);
      expect(result.totalUpdated).toBe(2);
      expect(result.dryRun).toBe(true);
    });

    it('should report dry-run mode in result', async () => {
      dynamoMock.on(ScanCommand).resolves({
        Items: [],
        ScannedCount: 0,
        Count: 0,
      });

      const result = await backfillTTL({
        tableName: 'test-sales-table',
        region: 'eu-west-1',
        dryRun: true,
      });

      expect(result.dryRun).toBe(true);
    });
  });

  describe('TTL skip logic', () => {
    it('should skip items that already have TTL set', async () => {
      dynamoMock.on(ScanCommand).resolves({
        Items: [
          {
            PK: { S: 'TENANT#carousel-labs#PRODUCT#prod_123' },
            SK: { S: 'SALE#2025-01-15#sale_456' },
            saleDate: { S: '2025-01-15' },
            ttl: { N: '1704067200' }, // Already has TTL
          },
          {
            PK: { S: 'TENANT#carousel-labs#PRODUCT#prod_789' },
            SK: { S: 'SALE#2025-01-16#sale_789' },
            saleDate: { S: '2025-01-16' },
            // No TTL - should be updated
          },
        ],
        ScannedCount: 2,
        Count: 2,
      });

      dynamoMock.on(UpdateItemCommand).resolves({});

      const result = await backfillTTL({
        tableName: 'test-sales-table',
        region: 'eu-west-1',
        dryRun: false,
      });

      // Only one item should be updated
      expect(result.totalProcessed).toBe(2);
      expect(result.totalUpdated).toBe(1);
      expect(result.totalSkipped).toBe(1);

      const updateCalls = dynamoMock.commandCalls(UpdateItemCommand);
      expect(updateCalls).toHaveLength(1);
    });

    it('should skip items without saleDate', async () => {
      dynamoMock.on(ScanCommand).resolves({
        Items: [
          {
            PK: { S: 'TENANT#carousel-labs#PRODUCT#prod_123' },
            SK: { S: 'SALE#2025-01-15#sale_456' },
            // Missing saleDate
          },
          {
            PK: { S: 'TENANT#carousel-labs#PRODUCT#prod_789' },
            SK: { S: 'SALE#2025-01-16#sale_789' },
            saleDate: { S: '2025-01-16' },
          },
        ],
        ScannedCount: 2,
        Count: 2,
      });

      dynamoMock.on(UpdateItemCommand).resolves({});

      const result = await backfillTTL({
        tableName: 'test-sales-table',
        region: 'eu-west-1',
        dryRun: false,
      });

      // Only one valid item should be updated
      expect(result.totalProcessed).toBe(2);
      expect(result.totalUpdated).toBe(1);
      expect(result.totalSkipped).toBe(1);
    });
  });

  describe('Batch processing', () => {
    it('should process multiple batches with pagination', async () => {
      const batch1Items = Array(100)
        .fill(null)
        .map((_, i) => ({
          PK: { S: `TENANT#carousel-labs#PRODUCT#prod_${i}` },
          SK: { S: `SALE#2025-01-15#sale_${i}` },
          saleDate: { S: '2025-01-15' },
        }));

      const batch2Items = Array(50)
        .fill(null)
        .map((_, i) => ({
          PK: { S: `TENANT#carousel-labs#PRODUCT#prod_${100 + i}` },
          SK: { S: `SALE#2025-01-16#sale_${100 + i}` },
          saleDate: { S: '2025-01-16' },
        }));

      dynamoMock
        .on(ScanCommand)
        .resolvesOnce({
          Items: batch1Items,
          ScannedCount: 100,
          Count: 100,
          LastEvaluatedKey: { PK: { S: 'TENANT#carousel-labs#PRODUCT#prod_99' } },
        })
        .resolvesOnce({
          Items: batch2Items,
          ScannedCount: 50,
          Count: 50,
        });

      dynamoMock.on(UpdateItemCommand).resolves({});

      const result = await backfillTTL({
        tableName: 'test-sales-table',
        region: 'eu-west-1',
        dryRun: false,
        batchSize: 100,
      });

      // Verify all items were processed
      expect(result.totalProcessed).toBe(150);
      expect(result.totalUpdated).toBe(150);

      // Verify scan was called twice
      const scanCalls = dynamoMock.commandCalls(ScanCommand);
      expect(scanCalls).toHaveLength(2);

      // Verify second scan used LastEvaluatedKey
      expect(scanCalls[1].args[0].input.ExclusiveStartKey).toEqual({
        PK: { S: 'TENANT#carousel-labs#PRODUCT#prod_99' },
      });

      // Verify 150 updates were sent
      const updateCalls = dynamoMock.commandCalls(UpdateItemCommand);
      expect(updateCalls).toHaveLength(150);
    });

    it('should respect custom batch size', async () => {
      const batch1Items = Array(25)
        .fill(null)
        .map((_, i) => ({
          PK: { S: `TENANT#carousel-labs#PRODUCT#prod_${i}` },
          SK: { S: `SALE#2025-01-15#sale_${i}` },
          saleDate: { S: '2025-01-15' },
        }));

      const batch2Items = Array(25)
        .fill(null)
        .map((_, i) => ({
          PK: { S: `TENANT#carousel-labs#PRODUCT#prod_${25 + i}` },
          SK: { S: `SALE#2025-01-16#sale_${25 + i}` },
          saleDate: { S: '2025-01-16' },
        }));

      dynamoMock
        .on(ScanCommand)
        .resolvesOnce({
          Items: batch1Items,
          ScannedCount: 25,
          Count: 25,
          LastEvaluatedKey: { PK: { S: 'TENANT#carousel-labs#PRODUCT#prod_24' } },
        })
        .resolvesOnce({
          Items: batch2Items,
          ScannedCount: 25,
          Count: 25,
        });

      dynamoMock.on(UpdateItemCommand).resolves({});

      await backfillTTL({
        tableName: 'test-sales-table',
        region: 'eu-west-1',
        dryRun: false,
        batchSize: 25,
      });

      // Verify scan was called with batch size
      const scanCalls = dynamoMock.commandCalls(ScanCommand);
      expect(scanCalls[0].args[0].input.Limit).toBe(25);
      expect(scanCalls[1].args[0].input.Limit).toBe(25);
    });
  });

  describe('Error handling', () => {
    it('should continue processing after update failure', async () => {
      dynamoMock.on(ScanCommand).resolves({
        Items: [
          {
            PK: { S: 'TENANT#carousel-labs#PRODUCT#prod_1' },
            SK: { S: 'SALE#2025-01-15#sale_1' },
            saleDate: { S: '2025-01-15' },
          },
          {
            PK: { S: 'TENANT#carousel-labs#PRODUCT#prod_2' },
            SK: { S: 'SALE#2025-01-16#sale_2' },
            saleDate: { S: '2025-01-16' },
          },
          {
            PK: { S: 'TENANT#carousel-labs#PRODUCT#prod_3' },
            SK: { S: 'SALE#2025-01-17#sale_3' },
            saleDate: { S: '2025-01-17' },
          },
        ],
        ScannedCount: 3,
        Count: 3,
      });

      // First update fails, second succeeds, third succeeds
      dynamoMock
        .on(UpdateItemCommand)
        .rejectsOnce(new Error('Update failed'))
        .resolvesOnce({})
        .resolvesOnce({});

      const result = await backfillTTL({
        tableName: 'test-sales-table',
        region: 'eu-west-1',
        dryRun: false,
      });

      // Verify processing continued despite failure
      expect(result.totalProcessed).toBe(3);
      expect(result.totalUpdated).toBe(2);
      expect(result.totalFailed).toBe(1);
    });

    it('should validate batch size constraints', async () => {
      await expect(
        backfillTTL({
          tableName: 'test-sales-table',
          batchSize: 0,
        })
      ).rejects.toThrow('batchSize must be between 1 and 1000');

      await expect(
        backfillTTL({
          tableName: 'test-sales-table',
          batchSize: 1001,
        })
      ).rejects.toThrow('batchSize must be between 1 and 1000');
    });

    it('should validate required tableName', async () => {
      await expect(
        backfillTTL({
          tableName: '',
        })
      ).rejects.toThrow('tableName is required');
    });
  });

  describe('Progress reporting', () => {
    it('should call progress callback', async () => {
      const progressCallback = jest.fn();

      dynamoMock.on(ScanCommand).resolves({
        Items: Array(150)
          .fill(null)
          .map((_, i) => ({
            PK: { S: `TENANT#carousel-labs#PRODUCT#prod_${i}` },
            SK: { S: `SALE#2025-01-15#sale_${i}` },
            saleDate: { S: '2025-01-15' },
          })),
        ScannedCount: 150,
        Count: 150,
      });

      dynamoMock.on(UpdateItemCommand).resolves({});

      await backfillTTL({
        tableName: 'test-sales-table',
        region: 'eu-west-1',
        dryRun: false,
        onProgress: progressCallback,
      });

      // Progress callback should be called at 100 and 150 items
      expect(progressCallback).toHaveBeenCalled();
      const calls = progressCallback.mock.calls;

      // Verify progress structure
      expect(calls[0][0]).toHaveProperty('processed');
      expect(calls[0][0]).toHaveProperty('updated');
      expect(calls[0][0]).toHaveProperty('skipped');
      expect(calls[0][0]).toHaveProperty('failed');
      expect(calls[0][0]).toHaveProperty('estimatedTotal');
      expect(calls[0][0]).toHaveProperty('rate');
      expect(calls[0][0]).toHaveProperty('estimatedRemaining');
    });

    it('should track correct statistics', async () => {
      dynamoMock.on(ScanCommand).resolves({
        Items: [
          {
            PK: { S: 'TENANT#carousel-labs#PRODUCT#prod_1' },
            SK: { S: 'SALE#2025-01-15#sale_1' },
            saleDate: { S: '2025-01-15' },
          },
          {
            PK: { S: 'TENANT#carousel-labs#PRODUCT#prod_2' },
            SK: { S: 'SALE#2025-01-16#sale_2' },
            saleDate: { S: '2025-01-16' },
            ttl: { N: '1704067200' }, // Already has TTL
          },
          {
            PK: { S: 'TENANT#carousel-labs#PRODUCT#prod_3' },
            SK: { S: 'SALE#2025-01-17#sale_3' },
            // Missing saleDate
          },
        ],
        ScannedCount: 3,
        Count: 3,
      });

      dynamoMock.on(UpdateItemCommand).resolves({});

      const result = await backfillTTL({
        tableName: 'test-sales-table',
        region: 'eu-west-1',
        dryRun: false,
      });

      expect(result.totalProcessed).toBe(3);
      expect(result.totalUpdated).toBe(1);
      expect(result.totalSkipped).toBe(2);
      expect(result.totalFailed).toBe(0);
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });
  });
});
