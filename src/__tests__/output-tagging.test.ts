import { processImage } from '../processor';
import { jest } from '@jest/globals';

// Mock AWS SDK and other dependencies
jest.mock('../lib/bedrock/image-processor', () => ({
  processImageFromUrl: jest.fn(),
  processImageFromBase64: jest.fn(),
}));

jest.mock('../lib/s3/client', () => ({
  uploadProcessedImage: jest.fn(),
  generateOutputKey: jest.fn(),
  getOutputBucket: jest.fn(),
}));

jest.mock('../lib/logger', () => ({
  log: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

describe('Output Tagging', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should tag all outputs as restricted in processImage function', async () => {
    // Mock dependencies  
    (require('../lib/bedrock/image-processor').processImageFromUrl as jest.Mock).mockResolvedValue({
      outputBuffer: Buffer.from('test-image-data'),
      metadata: {
        width: 100,
        height: 100,
        originalSize: 1000,
        processedSize: 500
      }
    });
    
    (require('../lib/s3/client').uploadProcessedImage as jest.Mock).mockResolvedValue('https://s3.amazonaws.com/test-bucket/output.png');
    (require('../lib/s3/client').getOutputBucket as jest.Mock).mockResolvedValue('test-bucket');
    (require('../lib/s3/client').generateOutputKey as jest.Mock).mockReturnValue('test-key');

    const request = {
      imageUrl: 'https://example.com/image.jpg',
      outputFormat: 'png'
    };
    
    const result = await processImage(request, 'test-tenant', 'test-stage');
    
    expect(result).toBeDefined();
    expect(result).toHaveProperty('tags');
    expect(result.tags).toEqual({ restricted: true });
  });
});