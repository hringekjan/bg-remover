// services/bg-remover/tests/workflow.test.ts
import { APIGatewayProxyEventV2 } from 'aws-lambda';

var mockDdbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({
    send: mockDdbSend,
  })),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: jest.fn(() => ({
      send: mockDdbSend,
    })),
  },
  GetCommand: jest.fn((input: unknown) => ({ input, __type: 'GetCommand' })),
  UpdateCommand: jest.fn((input: unknown) => ({ input, __type: 'UpdateCommand' })),
}));

jest.mock('../src/lib/auth/jwt-validator', () => ({
  validateJWTFromEvent: jest.fn((event: APIGatewayProxyEventV2) => {
    const tenantId = event.requestContext?.authorizer?.jwt?.claims?.['custom:tenantId'];
    const userId = event.requestContext?.authorizer?.jwt?.claims?.sub;
    if (!tenantId || !userId) {
      throw new Error('Unauthorized');
    }
    return Promise.resolve({
      isValid: true,
      payload: {
        'custom:tenantId': tenantId,
        sub: userId,
      },
      userId,
    });
  }),
}));

import { handler as metadataApprovalHandler } from '../src/handlers/metadata-approval-handler';

describe('BG Remover Workflow Integration Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.DYNAMODB_TABLE = 'carousel-main-test';
    process.env.STAGE = 'test';
    mockDdbSend.mockImplementation(async (input: any) => {
      if (input?.__type === 'GetCommand') {
        return { Item: { pk: 'TENANT#test-tenant-id#PRODUCT#test-product-id', sk: 'METADATA', enrichment: {} } };
      }
      if (input?.__type === 'UpdateCommand') {
        return {};
      }
      return {};
    });
  });
  
  test('Metadata Approval Handler should process valid approval', async () => {
    const mockEvent: Partial<APIGatewayProxyEventV2> = {
      body: JSON.stringify({
        productId: 'test-product-id',
        status: 'approved',
        metadata: {
          content: { en: { name: 'Approved Product' } }
        }
      }),
      requestContext: {
        http: { method: 'POST' },
        authorizer: {
          jwt: {
            claims: {
              'custom:tenantId': 'test-tenant-id',
              'sub': 'test-user-id'
            }
          }
        }
      } as any
    };

    const result = await metadataApprovalHandler(mockEvent as APIGatewayProxyEventV2);
    
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.message).toContain('successfully');
  });

  test('Metadata Approval Handler should reject unauthorized requests', async () => {
    const mockEvent: Partial<APIGatewayProxyEventV2> = {
      body: JSON.stringify({ productId: 'test-product-id' }),
      requestContext: {
        http: { method: 'POST' }
        // Missing authorizer context
      } as any
    };

    const result = await metadataApprovalHandler(mockEvent as APIGatewayProxyEventV2);
    expect(result.statusCode).toBe(401);
  });

  test('Metadata Approval Handler should validate required fields', async () => {
    const mockEvent: Partial<APIGatewayProxyEventV2> = {
      body: JSON.stringify({ productId: 'test-product-id' }), // Missing status
      requestContext: {
        http: { method: 'POST' },
        authorizer: {
          jwt: { claims: { 'custom:tenantId': 'test-tenant-id', 'sub': 'test-user-id' } }
        }
      } as any
    };

    const result = await metadataApprovalHandler(mockEvent as APIGatewayProxyEventV2);
    expect(result.statusCode).toBe(400);
  });
});
