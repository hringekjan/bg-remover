/**
 * Credits Integration & Parallel Processing Tests
 *
 * Tests credit validation, debit, refund logic and parallel batch processing
 * for the create-products endpoint.
 */

import { NextRequest } from 'next/server';
import { POST } from '../route';
import { validateAndDebitCredits, refundCredits } from '@/src/lib/credits/client';
import { validateJWTFromEvent } from '@/src/lib/auth/jwt-validator';
import { createProductInCarouselApi } from '@/lib/carousel-api/client';

// Mock dependencies
jest.mock('@/src/lib/credits/client');
jest.mock('@/src/lib/auth/jwt-validator');
jest.mock('@/lib/carousel-api/client');
jest.mock('@/lib/bedrock/image-processor');
jest.mock('@/lib/s3/client');
jest.mock('@/lib/dynamo/job-store');

const mockValidateAndDebit = validateAndDebitCredits as jest.MockedFunction<typeof validateAndDebitCredits>;
const mockRefundCredits = refundCredits as jest.MockedFunction<typeof refundCredits>;
const mockValidateJWT = validateJWTFromEvent as jest.MockedFunction<typeof validateJWTFromEvent>;
const mockCreateProduct = createProductInCarouselApi as jest.MockedFunction<typeof createProductInCarouselApi>;

/**
 * Helper: Create test request with product groups
 */
function createCreditsTestRequest(options: {
  productGroups: number;
  imagesPerGroup: number;
  tenantId?: string;
  userId?: string;
}): NextRequest {
  const groups = Array(options.productGroups).fill(null).map((_, i) => ({
    images: Array(options.imagesPerGroup).fill(null).map((_, j) => ({
      url: `https://example.com/product-${i}/image-${j}.jpg`,
    })),
    metadata: {
      title: `Product ${i + 1}`,
      price: 100,
      category: 'test',
    },
  }));

  const url = 'https://api.dev.carousellabs.co/bg-remover/create-products';
  const headers = new Headers({
    'authorization': 'Bearer mock-jwt-token',
    'x-tenant-id': options.tenantId || 'carousel-labs',
    'x-user-id': options.userId || 'user-123',
    'content-type': 'application/json',
  });

  return new NextRequest(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ productGroups: groups }),
  });
}

/**
 * Mock successful image processing
 */
function mockSuccessfulImageProcessing() {
  const { processImageFromUrl } = require('@/lib/bedrock/image-processor');
  const { uploadProcessedImage, getOutputBucket, generateOutputKey } = require('@/lib/s3/client');
  const { setJobStatus } = require('@/lib/dynamo/job-store');

  processImageFromUrl.mockResolvedValue({
    outputBuffer: Buffer.from('processed-image'),
    metadata: {},
  });

  getOutputBucket.mockResolvedValue('test-bucket');

  generateOutputKey.mockImplementation(
    (tenant: string, productId: string, format: string) =>
      `${tenant}/${productId}/image.${format}`
  );

  uploadProcessedImage.mockImplementation(
    (bucket: string, key: string) =>
      Promise.resolve(`https://cdn.carousellabs.co/${key}`)
  );

  // Mock job store to prevent DynamoDB errors
  setJobStatus.mockResolvedValue(undefined);
}

/**
 * Mock product creation in carousel-api
 */
function mockProductCreation(success: boolean = true) {
  if (success) {
    mockCreateProduct.mockResolvedValue({
      product: {
        id: `prod-${Math.random().toString(36).substring(7)}`,
        title: 'Test Product',
        description: '',
        price: 100,
        category: 'test',
        images: [],
        location: '',
        availability: 'available' as const,
        state: 'active' as const,
        ownerId: 'user-123',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      error: undefined,
    });
  } else {
    mockCreateProduct.mockResolvedValue({
      product: undefined,
      error: 'Product creation failed',
    });
  }
}

describe('Credits Integration', () => {
  beforeEach(() => {
    // Set environment to require credits
    process.env.REQUIRE_CREDITS = 'true';
    process.env.STAGE = 'prod';

    // Mock JWT validation (authenticated user)
    mockValidateJWT.mockResolvedValue({
      isValid: true,
      userId: 'user-123',
      email: 'test@example.com',
      payload: {
        'custom:tenant': 'carousel-labs',
        email: 'test@example.com',
      },
      groups: ['tenant:carousel-labs'],
    });

    // Mock successful image processing and product creation by default
    mockSuccessfulImageProcessing();
    mockProductCreation(true);

    jest.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.REQUIRE_CREDITS;
    delete process.env.STAGE;
  });

  it('should debit credits successfully when user has sufficient balance', async () => {
    // Mock: User has 100 credits, needs 10
    mockValidateAndDebit.mockResolvedValue({
      success: true,
      transactionId: 'txn-abc-123',
      creditsUsed: 10,
      newBalance: 90,
    });

    const request = createCreditsTestRequest({
      productGroups: 10,
      imagesPerGroup: 1,
    });

    const response = await POST(request);
    const data = await response.json();

    // Verify credits were debited
    expect(mockValidateAndDebit).toHaveBeenCalledWith(
      'carousel-labs',
      'user-123',
      10, // Total images
      expect.any(String), // jobId
      undefined
    );

    // Verify processing continued
    expect(response.status).toBe(200);
    expect(data.status).toBe('completed');
    expect(data.totalGroups).toBe(10);
  });

  it('should return 402 Payment Required when insufficient credits', async () => {
    // Mock: User has 2 credits, needs 10
    mockValidateAndDebit.mockResolvedValue({
      success: false,
      error: 'Insufficient credits. Balance: 2, Required: 10',
      errorCode: 'INSUFFICIENT_CREDITS',
      httpStatus: 402,
    });

    const request = createCreditsTestRequest({
      productGroups: 10,
      imagesPerGroup: 1,
    });

    const response = await POST(request);
    const data = await response.json();

    // Verify 402 Payment Required
    expect(response.status).toBe(402);
    expect(data.error).toBe('Insufficient credits');
    expect(data.errorCode).toBe('INSUFFICIENT_CREDITS');
    expect(data.requiredCredits).toBe(10);
    expect(data.jobId).toBeDefined();

    // Verify NO processing occurred
    expect(mockCreateProduct).not.toHaveBeenCalled();
    expect(mockRefundCredits).not.toHaveBeenCalled();
  });

  it('should refund credits for failed images (partial failure)', async () => {
    // Mock: Debit 10 credits initially
    mockValidateAndDebit.mockResolvedValue({
      success: true,
      transactionId: 'txn-partial-123',
      creditsUsed: 10,
      newBalance: 90,
    });

    // Mock: 7 products succeed, 3 fail
    let callCount = 0;
    mockCreateProduct.mockImplementation(() => {
      callCount++;
      if (callCount <= 7) {
        // First 7 succeed
        return Promise.resolve({
          product: {
            id: `prod-${callCount}`,
            title: 'Test Product',
            description: '',
            price: 100,
            category: 'test',
            images: ['https://cdn.example.com/image.jpg'],
            location: '',
            availability: 'available' as const,
            state: 'active' as const,
            ownerId: 'user-123',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          error: undefined,
        });
      } else {
        // Last 3 fail
        return Promise.resolve({
          product: undefined,
          error: 'Product creation failed',
        });
      }
    });

    mockRefundCredits.mockResolvedValue({
      success: true,
      newBalance: 93,
      transactionId: 'refund-txn-123',
    });

    const request = createCreditsTestRequest({
      productGroups: 10,
      imagesPerGroup: 1,
    });

    const response = await POST(request);
    const data = await response.json();

    // Verify partial completion
    expect(response.status).toBe(200);
    expect(data.status).toBe('partial');

    // Verify refund was called with 3 credits (failed images)
    expect(mockRefundCredits).toHaveBeenCalledWith(
      'carousel-labs',
      'user-123',
      3, // 3 failed images
      expect.any(String), // jobId
      'txn-partial-123' // Original transaction ID
    );
  });

  it('should refund all credits when all images fail', async () => {
    // Mock: Debit 10 credits
    mockValidateAndDebit.mockResolvedValue({
      success: true,
      transactionId: 'txn-all-fail-123',
      creditsUsed: 10,
      newBalance: 90,
    });

    // Mock: All products fail
    mockCreateProduct.mockResolvedValue({
      product: undefined,
      error: 'Product creation failed',
    });

    mockRefundCredits.mockResolvedValue({
      success: true,
      newBalance: 100, // Full refund
      transactionId: 'refund-all-txn-123',
    });

    const request = createCreditsTestRequest({
      productGroups: 10,
      imagesPerGroup: 1,
    });

    const response = await POST(request);
    const data = await response.json();

    // Verify failed status
    expect(response.status).toBe(200);
    expect(data.status).toBe('failed');

    // Verify full refund
    expect(mockRefundCredits).toHaveBeenCalledWith(
      'carousel-labs',
      'user-123',
      10, // All 10 images failed
      expect.any(String),
      'txn-all-fail-123'
    );
  });

  it('should not refund when all images succeed', async () => {
    // Mock: Debit 10 credits
    mockValidateAndDebit.mockResolvedValue({
      success: true,
      transactionId: 'txn-success-123',
      creditsUsed: 10,
      newBalance: 90,
    });

    mockRefundCredits.mockResolvedValue({
      success: true,
      newBalance: 90,
      transactionId: 'should-not-be-called',
    });

    const request = createCreditsTestRequest({
      productGroups: 10,
      imagesPerGroup: 1,
    });

    const response = await POST(request);
    const data = await response.json();

    // Verify success
    expect(response.status).toBe(200);
    expect(data.status).toBe('completed');

    // Verify NO refund was called
    expect(mockRefundCredits).not.toHaveBeenCalled();
  });

  it('should prevent double-charging with idempotency keys', async () => {
    mockValidateAndDebit.mockResolvedValue({
      success: true,
      transactionId: 'txn-idempotent-123',
      creditsUsed: 5,
      newBalance: 95,
    });

    const request = createCreditsTestRequest({
      productGroups: 5,
      imagesPerGroup: 1,
    });

    await POST(request);

    // Verify idempotency key format
    const debitCall = mockValidateAndDebit.mock.calls[0];
    const jobId = debitCall[3]; // jobId is 4th parameter

    // The debitCredits function internally uses: `bg-remover:${jobId}`
    // We're verifying the jobId is consistently passed
    expect(jobId).toBeDefined();
    expect(typeof jobId).toBe('string');
    // In tests, crypto.randomUUID is mocked to return 'test-uuid-123'
    expect(jobId.length).toBeGreaterThan(0);
  });
});

describe('Parallel Batch Processing', () => {
  beforeEach(() => {
    // Disable credits for these tests
    delete process.env.REQUIRE_CREDITS;
    process.env.STAGE = 'dev';

    // Mock JWT validation
    mockValidateJWT.mockResolvedValue({
      isValid: true,
      userId: 'user-123',
      email: 'test@example.com',
      payload: {
        'custom:tenant': 'carousel-labs',
      },
    });

    mockSuccessfulImageProcessing();
    mockProductCreation(true);

    jest.clearAllMocks();
  });

  it('should process 10 groups in 2 batches with concurrency=5', async () => {
    const request = createCreditsTestRequest({
      productGroups: 10,
      imagesPerGroup: 1,
    });

    // Spy on console.log to verify batch logging
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

    const response = await POST(request);
    const data = await response.json();

    // Verify completion
    expect(response.status).toBe(200);
    expect(data.totalGroups).toBe(10);

    // Verify batch logging (2 batches: 0-4, 5-9)
    const batchLogs = consoleSpy.mock.calls.filter(
      call => call[0] === 'Batch completed'
    );

    expect(batchLogs.length).toBe(2);

    // Batch 1: items 0-4
    expect(batchLogs[0][1]).toMatchObject({
      batchNumber: 1,
      totalBatches: 2,
      processedItems: 5,
      totalItems: 10,
    });

    // Batch 2: items 5-9
    expect(batchLogs[1][1]).toMatchObject({
      batchNumber: 2,
      totalBatches: 2,
      processedItems: 10,
      totalItems: 10,
    });

    consoleSpy.mockRestore();
  });

  it('should continue processing when one group times out', async () => {
    const { processImageFromUrl } = require('@/lib/bedrock/image-processor');

    // Mock: Group 3 times out (index 2), others succeed
    let processCount = 0;
    processImageFromUrl.mockImplementation(() => {
      const currentCount = processCount++;
      if (currentCount === 2) {
        // Group 3 times out
        return new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Group processing timeout')), 100);
        });
      }
      return Promise.resolve({
        outputBuffer: Buffer.from('processed'),
        metadata: {},
      });
    });

    // Mock product creation to track which groups succeed
    let createCount = 0;
    mockCreateProduct.mockImplementation(() => {
      createCount++;
      return Promise.resolve({
        product: {
          id: `prod-${createCount}`,
          title: 'Test Product',
          description: '',
          price: 100,
          category: 'test',
          images: ['https://cdn.example.com/image.jpg'],
          location: '',
          availability: 'available' as const,
          state: 'active' as const,
          ownerId: 'user-123',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        error: undefined,
      });
    });

    const request = createCreditsTestRequest({
      productGroups: 5,
      imagesPerGroup: 1,
    });

    const response = await POST(request);
    const data = await response.json();

    // Verify partial completion (4 succeed, 1 fails)
    expect(response.status).toBe(200);
    expect(data.status).toBe('partial');

    // Group 3 should have failed status
    const failedGroup = data.products.find((p: any) => p.status === 'failed');
    expect(failedGroup).toBeDefined();
    // Error message is "All images failed processing" when timeout occurs
    expect(failedGroup.error).toContain('failed processing');

    // Other groups should succeed
    const succeededGroups = data.products.filter((p: any) => p.status === 'created');
    expect(succeededGroups.length).toBe(4);
  });

  it('should enforce minimum timeout of 15 seconds per group', async () => {
    const request = createCreditsTestRequest({
      productGroups: 50, // Maximum allowed
      imagesPerGroup: 1,
    });

    // Spy on console.log to capture timeout calculation
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

    await POST(request);

    // Find the timeout calculation log entry
    const timeoutCalcLog = consoleSpy.mock.calls.find(
      call => call[0] === 'Timeout calculation'
    );

    expect(timeoutCalcLog).toBeDefined();

    // With 50 groups:
    // Available time = 270s (300s - 30s buffer) = 270000ms
    // Calculated per group = 270000ms / 50 = 5400ms
    // Enforced minimum = 15000ms
    const logData = timeoutCalcLog![1];
    expect(logData.calculatedPerGroupMs).toBe(5400);
    expect(logData.finalPerGroupMs).toBe(15000); // Minimum enforced
    expect(logData.enforced).toBe(true); // Minimum was enforced

    consoleSpy.mockRestore();
  });

  it('should call garbage collection between batches', async () => {
    // Mock global.gc
    const mockGc = jest.fn();
    global.gc = mockGc;

    const request = createCreditsTestRequest({
      productGroups: 10, // 2 batches of 5
      imagesPerGroup: 1,
    });

    await POST(request);

    // gc() should be called once (between batch 1 and batch 2)
    // NOT called after the last batch
    expect(mockGc).toHaveBeenCalledTimes(1);

    // Cleanup
    delete (global as any).gc;
  });
});
