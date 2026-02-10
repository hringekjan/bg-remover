/**
 * Comprehensive test suite for /api/process-groups endpoint
 *
 * Tests cover:
 * - Request validation
 * - Job creation
 * - Image processing pipeline
 * - Error handling
 * - Multi-model integration (Nova Canvas, Nova Lite/Pro, GPT-OSS 20B)
 * - S3 upload
 * - DynamoDB job tracking
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { NextRequest } from 'next/server';
import { POST, OPTIONS } from '../route';
import { randomUUID } from 'crypto';

// Mock dependencies
jest.mock('@/lib/bedrock/image-processor');
jest.mock('@/lib/dynamo/job-store');
jest.mock('@/lib/s3/client');

import { processImageFromBase64 } from '@/lib/bedrock/image-processor';
import { setJobStatus, updateJobStatus } from '@/lib/dynamo/job-store';
import { uploadProcessedImage, generateOutputKey, getOutputBucket } from '@/lib/s3/client';

const mockProcessImageFromBase64 = processImageFromBase64 as jest.MockedFunction<typeof processImageFromBase64>;
const mockSetJobStatus = setJobStatus as jest.MockedFunction<typeof setJobStatus>;
const mockUpdateJobStatus = updateJobStatus as jest.MockedFunction<typeof updateJobStatus>;
const mockUploadProcessedImage = uploadProcessedImage as jest.MockedFunction<typeof uploadProcessedImage>;
const mockGenerateOutputKey = generateOutputKey as jest.MockedFunction<typeof generateOutputKey>;
const mockGetOutputBucket = getOutputBucket as jest.MockedFunction<typeof getOutputBucket>;

describe('/api/process-groups', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Default mock implementations
    mockProcessImageFromBase64.mockResolvedValue({
      outputBuffer: Buffer.from('processed-image-data'),
      metadata: {
        width: 1024,
        height: 1024,
        originalSize: 1000000,
        processedSize: 500000,
        processingTimeMs: 2500,
      },
      bilingualDescription: {
        en: {
          short: 'Blue Cotton Shirt',
          long: 'A classic blue cotton shirt perfect for any occasion.',
          category: 'clothing',
          colors: ['blue', 'white'],
          condition: 'very_good',
          keywords: ['shirt', 'cotton', 'blue', 'classic'],
        },
        is: {
          short: 'Blátt Bómullarskyrta',
          long: 'Klassísk blá bómullarskyrta fullkomin fyrir hvaða tilefni sem er.',
          category: 'fatnað',
          colors: ['blátt', 'hvítt'],
          condition: 'mjög_gott',
          keywords: ['skyrta', 'bómull', 'blá', 'klassísk'],
        },
      },
    });

    mockSetJobStatus.mockResolvedValue(undefined);
    mockUpdateJobStatus.mockResolvedValue(undefined);
    mockGetOutputBucket.mockResolvedValue('test-bucket');
    mockGenerateOutputKey.mockReturnValue('tenant/product/image-123.png');
    mockUploadProcessedImage.mockResolvedValue('https://s3.amazonaws.com/test-bucket/image-123.png');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('POST /api/process-groups', () => {
    const createMockRequest = (body: any, headers: Record<string, string> = {}) => {
      return new NextRequest('http://localhost:3000/api/process-groups', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: {
          'content-type': 'application/json',
          'x-tenant-id': headers['x-tenant-id'] || 'test-tenant',
          'x-user-id': headers['x-user-id'] || 'user-123',
          ...headers,
        },
      });
    };

    describe('Request Validation', () => {
      it('should reject empty groups array', async () => {
        const request = createMockRequest({
          groups: [],
          originalImages: {},
        });

        const response = await POST(request);
        const data = await response.json();

        expect(response.status).toBe(400);
        expect(data.error).toContain('Groups array');
      });

      it('should reject missing groups field', async () => {
        const request = createMockRequest({
          originalImages: {},
        });

        const response = await POST(request);
        const data = await response.json();

        expect(response.status).toBe(400);
        expect(data.error).toContain('Groups array');
      });

      it('should reject missing originalImages field', async () => {
        const request = createMockRequest({
          groups: [{ groupId: 'group-1', imageIds: ['img-1'] }],
        });

        const response = await POST(request);
        const data = await response.json();

        expect(response.status).toBe(400);
        expect(data.error).toContain('Original images');
      });

      it('should reject request without user ID', async () => {
        const request = createMockRequest(
          {
            groups: [{ groupId: 'group-1', imageIds: ['img-1'] }],
            originalImages: { 'img-1': 'base64-data' },
          },
          { 'x-user-id': '' } // Empty user ID
        );

        const response = await POST(request);
        const data = await response.json();

        expect(response.status).toBe(401);
        expect(data.error).toContain('Authentication');
      });
    });

    describe('Job Creation', () => {
      it('should create jobs for all groups', async () => {
        const request = createMockRequest({
          groups: [
            { groupId: 'group-1', imageIds: ['img-1'], productName: 'Blue Shirt' },
            { groupId: 'group-2', imageIds: ['img-2', 'img-3'], productName: 'Red Dress' },
          ],
          originalImages: {
            'img-1': 'base64-data-1',
            'img-2': 'base64-data-2',
            'img-3': 'base64-data-3',
          },
        });

        const response = await POST(request);
        const data = await response.json();

        expect(response.status).toBe(200);
        expect(data.jobs).toHaveLength(2);
        expect(data.summary.totalGroups).toBe(2);
        expect(data.summary.jobsCreated).toBe(2);

        // Verify job creation calls
        expect(mockSetJobStatus).toHaveBeenCalledTimes(2);
        expect(mockSetJobStatus).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            groupId: 'group-1',
            productName: 'Blue Shirt',
            status: 'processing',
            imageCount: 1,
          })
        );
      });

      it('should include correct model information in summary', async () => {
        const request = createMockRequest({
          groups: [{ groupId: 'group-1', imageIds: ['img-1'] }],
          originalImages: { 'img-1': 'base64-data' },
        });

        const response = await POST(request);
        const data = await response.json();

        expect(data.summary.models).toEqual({
          backgroundRemoval: 'amazon.nova-canvas-v1:0',
          descriptionGeneration: 'amazon.nova-lite-v1:0 or amazon.nova-pro-v1:0 (smart routing)',
          translation: 'openai.gpt-oss-safeguard-20b',
        });
      });

      it('should generate unique job IDs and tokens', async () => {
        const mockRandomUUID = randomUUID as jest.MockedFunction<typeof randomUUID>;
        mockRandomUUID
          .mockReturnValueOnce('request-1')
          .mockReturnValueOnce('job-1')
          .mockReturnValueOnce('token-1')
          .mockReturnValueOnce('job-2')
          .mockReturnValueOnce('token-2');

        const request = createMockRequest({
          groups: [
            { groupId: 'group-1', imageIds: ['img-1'] },
            { groupId: 'group-2', imageIds: ['img-2'] },
          ],
          originalImages: {
            'img-1': 'base64-data-1',
            'img-2': 'base64-data-2',
          },
        });

        const response = await POST(request);
        const data = await response.json();

        const jobIds = data.jobs.map((j: any) => j.jobId);
        const jobTokens = data.jobs.map((j: any) => j.jobToken);

        // All job IDs should be unique
        expect(new Set(jobIds).size).toBe(jobIds.length);
        // All job tokens should be unique
        expect(new Set(jobTokens).size).toBe(jobTokens.length);
      });
    });

    describe('Image Processing Pipeline', () => {
      it('should process images using processImageFromBase64', async () => {
        const request = createMockRequest({
          groups: [
            {
              groupId: 'group-1',
              imageIds: ['img-1', 'img-2'],
              productName: 'Test Product',
            },
          ],
          originalImages: {
            'img-1': 'base64-image-1',
            'img-2': 'base64-image-2',
          },
          processingOptions: {
            outputFormat: 'png',
            quality: 95,
            generateDescription: true,
          },
        });

        const response = await POST(request);
        expect(response.status).toBe(200);

        // Allow async processing to start
        await new Promise(resolve => setTimeout(resolve, 100));

        // Should have called processImageFromBase64 for each image
        expect(mockProcessImageFromBase64).toHaveBeenCalledTimes(2);
        expect(mockProcessImageFromBase64).toHaveBeenCalledWith(
          'base64-image-1',
          'image/png',
          expect.objectContaining({
            format: 'png',
            quality: 95,
            generateDescription: true,
            productName: 'Test Product',
          }),
          'test-tenant',
          expect.any(String)
        );
      });

      it('should upload processed images to S3', async () => {
        const request = createMockRequest({
          groups: [{ groupId: 'group-1', imageIds: ['img-1'], productName: 'Test' }],
          originalImages: { 'img-1': 'base64-data' },
        });

        const response = await POST(request);
        expect(response.status).toBe(200);

        await new Promise(resolve => setTimeout(resolve, 100));

        expect(mockGetOutputBucket).toHaveBeenCalledWith('test-tenant');
        expect(mockUploadProcessedImage).toHaveBeenCalledWith(
          'test-bucket',
          expect.any(String),
          expect.any(Buffer),
          'image/png',
          expect.objectContaining({
            'job-id': expect.any(String),
            'group-id': 'group-1',
            'image-id': 'img-1',
            'tenant': 'test-tenant',
            'user-id': 'user-123',
            'original-index': '0',
          })
        );
      });

      it('should update job progress during processing', async () => {
        const request = createMockRequest({
          groups: [{ groupId: 'group-1', imageIds: ['img-1', 'img-2'], productName: 'Test' }],
          originalImages: {
            'img-1': 'base64-1',
            'img-2': 'base64-2',
          },
        });

        const response = await POST(request);
        expect(response.status).toBe(200);

        await new Promise(resolve => setTimeout(resolve, 200));

        // Should update progress multiple times (once per image + final completion)
        expect(mockUpdateJobStatus).toHaveBeenCalled();
        const progressCalls = mockUpdateJobStatus.mock.calls.filter(call =>
          call[1].progress !== undefined
        );
        expect(progressCalls.length).toBeGreaterThan(0);
      });

      it('should handle bilingual descriptions correctly', async () => {
        const request = createMockRequest({
          groups: [{ groupId: 'group-1', imageIds: ['img-1'], productName: 'Shirt' }],
          originalImages: { 'img-1': 'base64' },
        });

        const response = await POST(request);
        expect(response.status).toBe(200);

        await new Promise(resolve => setTimeout(resolve, 100));

        // Verify bilingual descriptions are processed
        expect(mockProcessImageFromBase64).toHaveBeenCalledWith(
          expect.any(String),
          expect.any(String),
          expect.objectContaining({
            generateDescription: true,
          }),
          expect.any(String),
          expect.any(String)
        );
      });
    });

    describe('Error Handling', () => {
      it('should handle processImageFromBase64 failure gracefully', async () => {
        mockProcessImageFromBase64.mockRejectedValueOnce(
          new Error('Nova Canvas service unavailable')
        );

        const request = createMockRequest({
          groups: [{ groupId: 'group-1', imageIds: ['img-1'] }],
          originalImages: { 'img-1': 'base64' },
        });

        const response = await POST(request);
        expect(response.status).toBe(200); // Job creation succeeds

        await new Promise(resolve => setTimeout(resolve, 100));

        // Job should be marked as failed
        expect(mockUpdateJobStatus).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            status: 'failed',
          })
        );
      });

      it('should continue processing other images if one fails', async () => {
        mockProcessImageFromBase64
          .mockRejectedValueOnce(new Error('Image 1 failed'))
          .mockResolvedValueOnce({
            outputBuffer: Buffer.from('image-2-data'),
            metadata: {
              width: 1024,
              height: 1024,
              originalSize: 1000,
              processedSize: 500,
              processingTimeMs: 1000,
            },
            bilingualDescription: {
              en: { short: 'Product', long: 'Description', category: 'general', colors: [], condition: 'good', keywords: [] },
              is: { short: 'Vara', long: 'Lýsing', category: 'almennt', colors: [], condition: 'gott', keywords: [] },
            },
          });

        const request = createMockRequest({
          groups: [{ groupId: 'group-1', imageIds: ['img-1', 'img-2'] }],
          originalImages: { 'img-1': 'base64-1', 'img-2': 'base64-2' },
        });

        const response = await POST(request);
        expect(response.status).toBe(200);

        await new Promise(resolve => setTimeout(resolve, 200));

        // Should have attempted both images
        expect(mockProcessImageFromBase64).toHaveBeenCalledTimes(2);
        // Should upload only the successful one
        expect(mockUploadProcessedImage).toHaveBeenCalledTimes(1);
      });

      it('should handle S3 upload failure', async () => {
        mockUploadProcessedImage.mockRejectedValueOnce(new Error('S3 upload failed'));

        const request = createMockRequest({
          groups: [{ groupId: 'group-1', imageIds: ['img-1'] }],
          originalImages: { 'img-1': 'base64' },
        });

        const response = await POST(request);
        expect(response.status).toBe(200);

        await new Promise(resolve => setTimeout(resolve, 100));

        // Job processing should continue despite S3 failure
        expect(mockProcessImageFromBase64).toHaveBeenCalled();
      });

      it('should handle missing image data', async () => {
        const request = createMockRequest({
          groups: [{ groupId: 'group-1', imageIds: ['img-1', 'img-2'] }],
          originalImages: { 'img-1': 'base64-data' }, // img-2 missing
        });

        const response = await POST(request);
        expect(response.status).toBe(200);

        await new Promise(resolve => setTimeout(resolve, 100));

        // Should only process the image with data
        expect(mockProcessImageFromBase64).toHaveBeenCalledTimes(1);
      });

      it('should return 500 on unexpected errors', async () => {
        const request = createMockRequest({
          groups: [{ groupId: 'group-1', imageIds: ['img-1'] }],
          originalImages: { 'img-1': 'base64' },
        });

        // Simulate unexpected error in job creation
        mockSetJobStatus.mockRejectedValueOnce(new Error('Database connection lost'));

        const response = await POST(request);
        const data = await response.json();

        expect(response.status).toBe(500);
        expect(data.error).toContain('Failed to start processing');
      });
    });

    describe('Processing Options', () => {
      it('should respect output format option', async () => {
        const request = createMockRequest({
          groups: [{ groupId: 'group-1', imageIds: ['img-1'] }],
          originalImages: { 'img-1': 'base64' },
          processingOptions: {
            outputFormat: 'webp',
            quality: 85,
          },
        });

        const response = await POST(request);
        expect(response.status).toBe(200);

        await new Promise(resolve => setTimeout(resolve, 100));

        expect(mockProcessImageFromBase64).toHaveBeenCalledWith(
          expect.any(String),
          expect.any(String),
          expect.objectContaining({
            format: 'webp',
            quality: 85,
          }),
          expect.any(String),
          expect.any(String)
        );
      });

      it('should use default options when not specified', async () => {
        const request = createMockRequest({
          groups: [{ groupId: 'group-1', imageIds: ['img-1'] }],
          originalImages: { 'img-1': 'base64' },
        });

        const response = await POST(request);
        expect(response.status).toBe(200);

        await new Promise(resolve => setTimeout(resolve, 100));

        expect(mockProcessImageFromBase64).toHaveBeenCalledWith(
          expect.any(String),
          expect.any(String),
          expect.objectContaining({
            format: 'png',
            quality: 95,
            generateDescription: true,
          }),
          expect.any(String),
          expect.any(String)
        );
      });
    });

    describe('Tenant Isolation', () => {
      it('should pass tenant ID to all operations', async () => {
        const request = createMockRequest(
          {
            groups: [{ groupId: 'group-1', imageIds: ['img-1'] }],
            originalImages: { 'img-1': 'base64' },
          },
          { 'x-tenant-id': 'hringekjan' }
        );

        const response = await POST(request);
        expect(response.status).toBe(200);

        await new Promise(resolve => setTimeout(resolve, 100));

        expect(mockProcessImageFromBase64).toHaveBeenCalledWith(
          expect.any(String),
          expect.any(String),
          expect.any(Object),
          'hringekjan', // tenant ID
          expect.any(String)
        );

        expect(mockGetOutputBucket).toHaveBeenCalledWith('hringekjan');
      });
    });
  });

  describe('OPTIONS /api/process-groups', () => {
    it('should return CORS headers', async () => {
      const response = await OPTIONS();

      expect(response.status).toBe(200);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
      expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Content-Type');
    });
  });
});
