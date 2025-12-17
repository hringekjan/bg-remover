/**
 * DynamoDB Job Store Unit Tests
 *
 * Tests for the bg-remover job storage module
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

// Mock DynamoDB client
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({
    send: mockSend,
  })),
  GetItemCommand: jest.fn().mockImplementation((params) => params),
  PutItemCommand: jest.fn().mockImplementation((params) => params),
  UpdateItemCommand: jest.fn().mockImplementation((params) => params),
  DeleteItemCommand: jest.fn().mockImplementation((params) => params),
}));

jest.mock('@aws-sdk/util-dynamodb', () => ({
  marshall: jest.fn((obj) => obj),
  unmarshall: jest.fn((obj) => obj),
}));

import {
  getJobStatus,
  setJobStatus,
  updateJobStatus,
  deleteJob,
  getBatchResult,
  setBatchResult,
  createJobStatus,
  resetClient,
  type JobStatus,
  type BatchResult,
} from '../lib/dynamo/job-store';

describe('DynamoDB Job Store', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetClient(); // Reset singleton between tests
  });

  describe('getJobStatus', () => {
    it('should return job status when job exists', async () => {
      const mockJob: JobStatus = {
        jobId: 'test-job-123',
        status: 'completed',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:01:00.000Z',
        expiresAt: 1704153600,
      };

      mockSend.mockResolvedValueOnce({ Item: mockJob });

      const result = await getJobStatus('test-job-123');

      expect(result).toEqual(mockJob);
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('should return undefined when job does not exist', async () => {
      mockSend.mockResolvedValueOnce({ Item: undefined });

      const result = await getJobStatus('non-existent-job');

      expect(result).toBeUndefined();
    });

    it('should throw error when DynamoDB fails', async () => {
      mockSend.mockRejectedValueOnce(new Error('DynamoDB error'));

      await expect(getJobStatus('test-job')).rejects.toThrow('DynamoDB error');
    });
  });

  describe('setJobStatus', () => {
    it('should store job status successfully', async () => {
      mockSend.mockResolvedValueOnce({});

      const jobStatus: JobStatus = {
        jobId: 'new-job-123',
        status: 'pending',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        expiresAt: 1704153600,
      };

      await setJobStatus('new-job-123', jobStatus);

      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('should auto-calculate TTL if not provided', async () => {
      mockSend.mockResolvedValueOnce({});

      const jobStatus: JobStatus = {
        jobId: 'job-without-ttl',
        status: 'processing',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        expiresAt: 0, // Will be replaced with calculated TTL
      };

      await setJobStatus('job-without-ttl', { ...jobStatus, expiresAt: 0 } as JobStatus);

      expect(mockSend).toHaveBeenCalled();
    });
  });

  describe('updateJobStatus', () => {
    it('should update job status with partial updates', async () => {
      mockSend.mockResolvedValueOnce({});

      await updateJobStatus('test-job', {
        status: 'completed',
        progress: 100,
      });

      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('should throw error on update failure', async () => {
      mockSend.mockRejectedValueOnce(new Error('Update failed'));

      await expect(
        updateJobStatus('test-job', { status: 'failed' })
      ).rejects.toThrow('Update failed');
    });
  });

  describe('deleteJob', () => {
    it('should delete job successfully', async () => {
      mockSend.mockResolvedValueOnce({});

      await deleteJob('test-job-123');

      expect(mockSend).toHaveBeenCalledTimes(1);
    });
  });

  describe('Batch Operations', () => {
    describe('setBatchResult', () => {
      it('should store batch result', async () => {
        mockSend.mockResolvedValueOnce({});

        const batchResult: BatchResult = {
          batchId: 'batch-123',
          status: 'completed',
          totalImages: 5,
          processedImages: 5,
          successfulImages: 5,
          failedImages: 0,
          results: [],
          startTime: '2024-01-01T00:00:00.000Z',
          endTime: '2024-01-01T00:01:00.000Z',
          processingTimeMs: 60000,
        };

        await setBatchResult('batch-123', batchResult);

        expect(mockSend).toHaveBeenCalledTimes(1);
      });
    });

    describe('getBatchResult', () => {
      it('should return batch result when exists', async () => {
        const mockBatch = {
          jobId: 'batch-123',
          type: 'batch',
          batchId: 'batch-123',
          status: 'completed',
          totalImages: 3,
          processedImages: 3,
          successfulImages: 2,
          failedImages: 1,
          results: [],
          startTime: '2024-01-01T00:00:00.000Z',
        };

        mockSend.mockResolvedValueOnce({ Item: mockBatch });

        const result = await getBatchResult('batch-123');

        expect(result).toBeDefined();
        expect(result?.status).toBe('completed');
      });

      it('should return undefined when batch not found', async () => {
        mockSend.mockResolvedValueOnce({ Item: undefined });

        const result = await getBatchResult('non-existent-batch');

        expect(result).toBeUndefined();
      });
    });
  });

  describe('createJobStatus', () => {
    it('should create a new job status with defaults', () => {
      const jobStatus = createJobStatus('new-job-456');

      expect(jobStatus.jobId).toBe('new-job-456');
      expect(jobStatus.status).toBe('pending');
      expect(jobStatus.createdAt).toBeDefined();
      expect(jobStatus.updatedAt).toBeDefined();
      expect(jobStatus.expiresAt).toBeGreaterThan(Date.now() / 1000);
    });

    it('should accept custom status and tenant', () => {
      const jobStatus = createJobStatus('job-with-tenant', 'processing', 'test-tenant');

      expect(jobStatus.status).toBe('processing');
      expect(jobStatus.tenant).toBe('test-tenant');
    });
  });

  describe('TTL Calculation', () => {
    it('should calculate TTL as 24 hours from now', () => {
      const jobStatus = createJobStatus('ttl-test');
      const nowInSeconds = Math.floor(Date.now() / 1000);
      const expectedTTL = nowInSeconds + (24 * 60 * 60);

      // Allow 5 second tolerance for test execution time
      expect(jobStatus.expiresAt).toBeGreaterThanOrEqual(expectedTTL - 5);
      expect(jobStatus.expiresAt).toBeLessThanOrEqual(expectedTTL + 5);
    });
  });
});
