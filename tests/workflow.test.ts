// services/bg-remover/tests/workflow.test.ts
import { handler as metadataApprovalHandler } from '../src/handlers/metadata-approval-handler';
import { APIGatewayProxyEventV2 } from 'aws-lambda';

describe('BG Remover Workflow Integration Tests', () => {
  
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
