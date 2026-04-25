import { describe, it, expect, beforeEach, vi } from 'vitest';
import { processImage } from '../src/processor';
import { ProcessRequest } from '../src/lib/types';

// Mock the dependencies
vi.mock('../src/lib/bedrock/image-processor', () => ({
  processImageFromUrl: vi.fn(),
  processImageFromBase64: vi.fn(),
}));

vi.mock('../src/lib/s3/client', () => ({
  uploadProcessedImage: vi.fn(),
  generateOutputKey: vi.fn(),
  getOutputBucket: vi.fn(),
}));

vi.mock('../src/lib/result-builder', () => ({
  createProcessResult: vi.fn(),
  createJobResult: vi.fn(),
}));

vi.mock('../src/lib/logger', () => ({
  log: {
    info: vi.fn(),
    error: vi.fn(),
  },
}));

describe('bg-remover processor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should mark all new outputs as restricted', async () => {
    // Mock implementations
    const mockProcessImageFromUrl = require('../src/lib/bedrock/image-processor').processImageFromUrl;
    const mockUploadProcessedImage = require('../src/lib/s3/client').uploadProcessedImage;
    const mockGenerateOutputKey = require('../src/lib/s3/client').generateOutputKey;
    const mockGetOutputBucket = require('../src/lib/s3/client').getOutputBucket;
    const mockCreateProcessResult = require('../src/lib/result-builder').createProcessResult;

    // Setup mocks
    mockProcessImageFromUrl.mockResolvedValue({
      outputBuffer: Buffer.from('fake-image-data'),
      metadata: {
        width: 800,
        height: 600,
        originalSize: 1024,
        processedSize: 512,
      },
    });
    
    mockUploadProcessedImage.mockResolvedValue('https://example.com/output.png');
    mockGenerateOutputKey.mockReturnValue('output-key.png');
    mockGetOutputBucket.mockResolvedValue('test-bucket');
    mockCreateProcessResult.mockReturnValue({
      success: true,
      jobId: 'test-job-id',
      outputUrl: 'https://example.com/output.png',
      processingTimeMs: 100,
      metadata: {
        width: 800,
        height: 600,
        originalSize: 1024,
        processedSize: 512,
      },
      tags: {
        restricted: true,
      }
    });

    // Test request
    const request: ProcessRequest = {
      imageUrl: 'https://example.com/image.jpg',
      outputFormat: 'png',
    };

    // Execute
    const result = await processImage(request, 'test-tenant', 'test-stage');

    // Assertions
    expect(result.tags?.restricted).toBe(true);
    expect(mockCreateProcessResult).toHaveBeenCalledWith(
      expect.any(Boolean),
      expect.any(String),
      expect.any(String),
      expect.anything(), // error
      expect.any(Number),
      expect.any(Object),
      expect.anything(), // productDescription
      expect.anything(), // multilingualDescription
      expect.anything(), // bilingualDescription
      expect.objectContaining({ restricted: true }) // tags should include restricted: true
    );
  });

  it('should handle base64 input and still mark as restricted', async () => {
    // Mock implementations
    const mockProcessImageFromBase64 = require('../src/lib/bedrock/image-processor').processImageFromBase64;
    const mockUploadProcessedImage = require('../src/lib/s3/client').uploadProcessedImage;
    const mockGenerateOutputKey = require('../src/lib/s3/client').generateOutputKey;
    const mockGetOutputBucket = require('../src/lib/s3/client').getOutputBucket;
    const mockCreateProcessResult = require('../src/lib/result-builder').createProcessResult;

    // Setup mocks
    mockProcessImageFromBase64.mockResolvedValue({
      outputBuffer: Buffer.from('fake-image-data'),
      metadata: {
        width: 800,
        height: 600,
        originalSize: 1024,
        processedSize: 512,
      },
    });
    
    mockUploadProcessedImage.mockResolvedValue('https://example.com/output.png');
    mockGenerateOutputKey.mockReturnValue('output-key.png');
    mockGetOutputBucket.mockResolvedValue('test-bucket');
    mockCreateProcessResult.mockReturnValue({
      success: true,
      jobId: 'test-job-id',
      outputUrl: 'https://example.com/output.png',
      processingTimeMs: 100,
      metadata: {
        width: 800,
        height: 600,
        originalSize: 1024,
        processedSize: 512,
      },
      tags: {
        restricted: true,
      }
    });

    // Test request with base64
    const request: ProcessRequest = {
      imageBase64: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
      outputFormat: 'jpeg',
    };

    // Execute
    const result = await processImage(request, 'test-tenant', 'test-stage');

    // Assertions
    expect(result.tags?.restricted).toBe(true);
    expect(mockCreateProcessResult).toHaveBeenCalledWith(
      expect.any(Boolean),
      expect.any(String),
      expect.any(String),
      expect.anything(), // error
      expect.any(Number),
      expect.any(Object),
      expect.anything(), // productDescription
      expect.anything(), // multilingualDescription
      expect.anything(), // bilingualDescription
      expect.objectContaining({ restricted: true }) // tags should include restricted: true
    );
  });
});