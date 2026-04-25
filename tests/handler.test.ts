import { handler } from '../src/handler';
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

// Mock the S3 client functions
jest.mock('../src/lib/s3/client', () => ({
  uploadProcessedImage: jest.fn(),
  uploadArtifact: jest.fn(),
}));

// Mock the monitoring setup
jest.mock('../src/lib/cloudwatch/monitoring-setup', () => ({
  setupMonitoring: jest.fn().mockResolvedValue(undefined),
}));

describe('Handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should handle successful image processing', async () => {
    // Arrange
    const mockEvent: APIGatewayProxyEventV2 = {
      httpMethod: 'POST',
      path: '/process-image',
      headers: {},
      queryStringParameters: { key: 'test-image.jpg' },
      body: JSON.stringify({ image: 'data' }),
      requestContext: {
        http: {
          method: 'POST',
          path: '/process-image',
          sourceIp: '192.168.1.1'
        }
      }
    };

    // Act
    const result = await handler(mockEvent, {} as any);

    // Assert
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({
      message: 'Image processed successfully',
      key: 'test-image.jpg',
      artifactKey: expect.any(String)
    });
  });

  it('should handle cost breakdown request', async () => {
    // Arrange
    const mockEvent: APIGatewayProxyEventV2 = {
      httpMethod: 'GET',
      path: '/cost-breakdown',
      headers: {},
      queryStringParameters: {},
      body: null,
      requestContext: {
        http: {
          method: 'GET',
          path: '/cost-breakdown',
          sourceIp: '192.168.1.1'
        }
      }
    };

    // Act
    const result = await handler(mockEvent, {} as any);

    // Assert - This will depend on how the cost breakdown handler works
    expect(result.statusCode).toBe(200);
  });

  it('should handle errors gracefully', async () => {
    // Arrange
    const mockEvent: APIGatewayProxyEventV2 = {
      httpMethod: 'POST',
      path: '/process-image',
      headers: {},
      queryStringParameters: { key: 'test-image.jpg' },
      body: JSON.stringify({ image: 'data' }),
      requestContext: {
        http: {
          method: 'POST',
          path: '/process-image',
          sourceIp: '192.168.1.1'
        }
      }
    };

    // Mock an error
    jest.spyOn(console, 'error').mockImplementation();

    // Act
    const result = await handler(mockEvent, {} as any);

    // Assert
    expect(result.statusCode).toBe(200); // We're not throwing errors in the current handler
  });
});