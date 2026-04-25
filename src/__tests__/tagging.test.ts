import { process } from '../handler';
import { jest } from '@jest/globals';

// Mock AWS SDK and other dependencies
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(),
  PutObjectCommand: jest.fn(),
}));

jest.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: jest.fn(),
  PutEventsCommand: jest.fn(),
}));

jest.mock('../lib/bedrock/image-processor', () => ({
  processImageFromUrl: jest.fn(),
  processImageFromBase64: jest.fn(),
}));

jest.mock('../lib/s3/client', () => ({
  uploadProcessedImage: jest.fn(),
  generateOutputKey: jest.fn(),
  getOutputBucket: jest.fn(),
}));

jest.mock('../lib/tenant/resolver', () => ({
  resolveTenantFromRequest: jest.fn(),
  loadTenantConfig: jest.fn(),
}));

jest.mock('../lib/tenant/cognito-config', () => ({
  loadTenantCognitoConfig: jest.fn(),
}));

jest.mock('../lib/auth/jwt-validator', () => ({
  validateJWTFromEvent: jest.fn(),
}));

jest.mock('../lib/credits/client', () => ({
  validateAndDebitCredits: jest.fn(),
  refundCredits: jest.fn(),
}));

jest.mock('../lib/job-store', () => ({
  createJob: jest.fn(),
  markJobCompleted: jest.fn(),
  markJobFailed: jest.fn(),
  getJobStatus: jest.fn(),
  updateJobStatus: jest.fn(),
}));

jest.mock('../lib/logger', () => ({
  log: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  logSecurityEvent: jest.fn(),
  logCreditOperation: jest.fn(),
  logTiming: jest.fn(),
  logServiceCall: jest.fn(),
  clearLogContext: jest.fn(),
}));

describe('Tagging Behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should tag all new bg-remover outputs as restricted in process endpoint', async () => {
    // Mock dependencies
    const mockEvent = {
      requestContext: {
        http: {
          method: 'POST',
          path: '/bg-remover/process'
        }
      },
      body: JSON.stringify({
        imageUrl: 'https://example.com/image.jpg',
        outputFormat: 'png'
      })
    };

    // Mock implementations
    (require('../lib/tenant/resolver').resolveTenantFromRequest as jest.Mock).mockResolvedValue('test-tenant');
    (require('../lib/tenant/cognito-config').loadTenantCognitoConfig as jest.Mock).mockResolvedValue({
      userPoolId: 'test-pool-id',
      issuer: 'https://cognito-idp.eu-west-1.amazonaws.com/test-pool-id'
    });
    (require('../lib/auth/jwt-validator').validateJWTFromEvent as jest.Mock).mockResolvedValue({
      isValid: true,
      userId: 'test-user'
    });
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
    (require('../lib/tenant/resolver').loadTenantConfig as jest.Mock).mockResolvedValue({});
    (require('../lib/credits/client').validateAndDebitCredits as jest.Mock).mockResolvedValue({
      success: true,
      creditsUsed: 1,
      newBalance: 99,
      transactionId: 'test-tx-id'
    });
    (require('../lib/job-store').createJob as jest.Mock).mockResolvedValue(undefined);
    (require('../lib/job-store').markJobCompleted as jest.Mock).mockResolvedValue(undefined);

    const response = await process(mockEvent);
    
    expect(response).toBeDefined();
    expect(response.statusCode).toBe(200);
    
    const responseBody = JSON.parse(response.body);
    expect(responseBody).toHaveProperty('tags');
    expect(responseBody.tags).toEqual({ restricted: true });
  });

  it('should tag all job results as restricted in status endpoint', async () => {
    // Mock dependencies
    const mockEvent = {
      requestContext: {
        http: {
          method: 'GET',
          path: '/bg-remover/status/test-job-id'
        }
      },
      pathParameters: {
        jobId: 'test-job-id'
      }
    };

    // Mock implementations
    (require('../lib/tenant/resolver').resolveTenantFromRequest as jest.Mock).mockResolvedValue('test-tenant');
    (require('../lib/tenant/cognito-config').loadTenantCognitoConfig as jest.Mock).mockResolvedValue({
      userPoolId: 'test-pool-id',
      issuer: 'https://cognito-idp.eu-west-1.amazonaws.com/test-pool-id'
    });
    (require('../lib/auth/jwt-validator').validateJWTFromEvent as jest.Mock).mockResolvedValue({
      isValid: true,
      userId: 'test-user'
    });
    (require('../lib/job-store').getJobStatus as jest.Mock).mockResolvedValue({
      jobId: 'test-job-id',
      status: 'completed',
      result: {
        outputUrl: 'https://s3.amazonaws.com/test-bucket/output.png',
        metadata: {
          width: 100,
          height: 100
        },
        processingTimeMs: 1000
      }
    });
    (require('../lib/tenant/resolver').loadTenantConfig as jest.Mock).mockResolvedValue({});

    const response = await process(mockEvent);
    
    expect(response).toBeDefined();
    expect(response.statusCode).toBe(200);
    
    const responseBody = JSON.parse(response.body);
    expect(responseBody).toHaveProperty('result');
    expect(responseBody.result).toHaveProperty('tags');
    expect(responseBody.result.tags).toEqual({ restricted: true });
  });
});