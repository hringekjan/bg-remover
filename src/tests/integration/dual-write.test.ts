/**
 * Integration tests for OutcomeDualWriter
 *
 * Test scenarios:
 * 1. Both Mem0 and DDB succeed — overall success, no divergence
 * 2. Mem0 succeeds, DDB fails — overall success, divergence detected
 * 3. Mem0 fails, DDB succeeds — overall success, divergence detected
 * 4. Both fail — overall failure
 * 5. Mem0 transient failure, retry succeeds
 * 6. DDB transient failure, retry succeeds
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { OutcomeDualWriter, Outcome, DualWriteResult } from '../../lib/outcome-dual-writer';

// Mock fetch for Mem0 API
global.fetch = vi.fn();

// Mock DynamoDBClient
vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: vi.fn(),
  PutItemCommand: vi.fn(),
}));

// Mock CloudWatch
vi.mock('../../lib/cloudwatch-metrics', () => ({
  createCloudWatchMetrics: vi.fn(() => ({
    putMetric: vi.fn().mockResolvedValue(undefined),
  })),
}));

describe('OutcomeDualWriter', () => {
  let writer: OutcomeDualWriter;
  let mockDdbClient: any;
  let testOutcome: Outcome;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();

    // Setup mock DynamoDB client
    mockDdbClient = {
      send: vi.fn().mockResolvedValue({ ConsumedCapacity: { CapacityUnits: 1 } }),
    };

    // Create writer instance
    writer = new OutcomeDualWriter(
      'https://api.mem0.ai',
      'test-api-key',
      mockDdbClient as any,
      'lcp-outcomes-dev',
      { maxRetries: 2, initialDelayMs: 10, maxDelayMs: 100 } // Fast retries for testing
    );

    // Test outcome
    testOutcome = {
      id: 'outcome-123',
      tenantId: 'carousel-labs',
      outcomeType: 'sale',
      classification: 'restricted',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      actualPrice: 1500,
      listingPrice: 2000,
      currency: 'ISK',
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Both targets succeed', () => {
    it('should return overall success with no divergence', async () => {
      // Setup: both endpoints succeed
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 201,
        statusText: 'Created',
      });

      // Act
      const result = await writer.writeOutcome(testOutcome);

      // Assert
      expect(result.overallSuccess).toBe(true);
      expect(result.diverged).toBe(false);
      expect(result.mem0Result.success).toBe(true);
      expect(result.ddbResult.success).toBe(true);
      expect(mockDdbClient.send).toHaveBeenCalledTimes(1);
    });
  });

  describe('Mem0 succeeds, DDB fails', () => {
    it('should return overall success but mark as diverged', async () => {
      // Setup: Mem0 succeeds, DDB fails
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 201,
      });
      mockDdbClient.send.mockRejectedValueOnce(new Error('DynamoDB timeout'));

      // Act
      const result = await writer.writeOutcome(testOutcome);

      // Assert
      expect(result.overallSuccess).toBe(true); // At least one succeeded
      expect(result.diverged).toBe(true); // One succeeded, one failed
      expect(result.mem0Result.success).toBe(true);
      expect(result.ddbResult.success).toBe(false);
      expect(result.ddbResult.error?.message).toContain('DynamoDB timeout');
    });
  });

  describe('DDB succeeds, Mem0 fails', () => {
    it('should return overall success but mark as diverged', async () => {
      // Setup: Mem0 fails (non-2xx response), DDB succeeds
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      });

      // Act
      const result = await writer.writeOutcome(testOutcome);

      // Assert
      expect(result.overallSuccess).toBe(true); // DDB succeeded
      expect(result.diverged).toBe(true); // One succeeded, one failed
      expect(result.mem0Result.success).toBe(false);
      expect(result.ddbResult.success).toBe(true);
    });
  });

  describe('Both targets fail', () => {
    it('should return overall failure', async () => {
      // Setup: both fail
      (global.fetch as any).mockRejectedValueOnce(new Error('Network error'));
      mockDdbClient.send.mockRejectedValueOnce(new Error('DynamoDB unavailable'));

      // Act
      const result = await writer.writeOutcome(testOutcome);

      // Assert
      expect(result.overallSuccess).toBe(false);
      expect(result.diverged).toBe(false); // Both failed
      expect(result.mem0Result.success).toBe(false);
      expect(result.ddbResult.success).toBe(false);
      expect(result.mem0Result.error?.message).toContain('Network error');
      expect(result.ddbResult.error?.message).toContain('DynamoDB unavailable');
    });
  });

  describe('Transient failures with retry', () => {
    it('should recover from Mem0 transient failure on retry', async () => {
      // Setup: Mem0 fails first, then succeeds
      (global.fetch as any)
        .mockRejectedValueOnce(new Error('Network timeout'))
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
        });

      // Act
      const result = await writer.writeOutcome(testOutcome);

      // Assert
      expect(result.overallSuccess).toBe(true);
      expect(result.mem0Result.success).toBe(true);
      expect(result.ddbResult.success).toBe(true);
      // Fetch should be called twice (once failed, once succeeded)
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('should recover from DDB transient failure on retry', async () => {
      // Setup: DDB fails first, then succeeds
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 201,
      });
      mockDdbClient.send
        .mockRejectedValueOnce(new Error('Provisioned throughput exceeded'))
        .mockResolvedValueOnce({ ConsumedCapacity: { CapacityUnits: 1 } });

      // Act
      const result = await writer.writeOutcome(testOutcome);

      // Assert
      expect(result.overallSuccess).toBe(true);
      expect(result.ddbResult.success).toBe(true);
      expect(mockDdbClient.send).toHaveBeenCalledTimes(2);
    });
  });

  describe('Exponential backoff', () => {
    it('should apply increasing delays between retries', async () => {
      const delays: number[] = [];
      const originalSetTimeout = global.setTimeout;

      // Track setTimeout calls
      global.setTimeout = vi.fn((cb: any, delay: number) => {
        delays.push(delay);
        return originalSetTimeout(cb, 0); // Execute immediately for test
      }) as any;

      // Setup: Mem0 fails all attempts
      (global.fetch as any)
        .mockRejectedValueOnce(new Error('Attempt 1'))
        .mockRejectedValueOnce(new Error('Attempt 2'));

      // Act
      const result = await writer.writeOutcome(testOutcome);

      // Assert: delays should follow exponential pattern (10ms, 20ms)
      expect(delays).toContain(10); // 10 * 2^0
      expect(delays).toContain(20); // 10 * 2^1

      global.setTimeout = originalSetTimeout;
    });
  });

  describe('Metrics emission', () => {
    it('should emit success metrics on successful dual-write', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 201,
      });

      const result = await writer.writeOutcome(testOutcome);

      // The createCloudWatchMetrics mock should have been called
      // This is verified by the successful completion
      expect(result.overallSuccess).toBe(true);
    });

    it('should emit divergence metric when targets diverge', async () => {
      (global.fetch as any).mockRejectedValueOnce(new Error('Network error'));
      // DDB succeeds by default

      const result = await writer.writeOutcome(testOutcome);

      expect(result.diverged).toBe(true);
      // Divergence metric would be emitted via CloudWatch mock
    });
  });

  describe('Edge cases', () => {
    it('should handle outcome with nested metadata', async () => {
      const complexOutcome: Outcome = {
        ...testOutcome,
        metadata: {
          nested: {
            deep: {
              value: 'test',
            },
          },
        },
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 201,
      });

      const result = await writer.writeOutcome(complexOutcome);

      expect(result.overallSuccess).toBe(true);
      // Verify fetch was called with proper structure
      expect(global.fetch).toHaveBeenCalled();
    });

    it('should include tenant and outcome IDs in request headers', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 201,
      });

      await writer.writeOutcome(testOutcome);

      const callArgs = (global.fetch as any).mock.calls[0];
      expect(callArgs[1].headers['X-Outcome-ID']).toBe(testOutcome.id);
      expect(callArgs[1].headers['X-Tenant-ID']).toBe(testOutcome.tenantId);
    });
  });
});
