// services/bg-remover/src/handlers/metadata-approval-handler.ts
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { validateJWTFromEvent } from '../lib/auth/jwt-validator';
import { createErrorResponse, createSuccessResponse, ErrorCode } from '../lib/errors';
import { logger } from '../lib/logger';

const ddbClient = new DynamoDBClient({ region: process.env.REGION || 'eu-west-1' });
const ddbDocClient = DynamoDBDocumentClient.from(ddbClient);
const TABLE_NAME = process.env.DYNAMODB_TABLE || `carousel-main-${process.env.STAGE}`;

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const requestId = event.requestContext.requestId;
  
  // 1. Authenticate and Extract Tenant Context using bg-remover's validator
  let authContext;
  try {
    const authResult = await validateJWTFromEvent(event);
    
    // Extract from result or fallback to requestContext (for mock testing)
    const tenantId = authResult.payload?.['custom:tenantId'] as string || 
                     event.requestContext?.authorizer?.jwt?.claims?.['custom:tenantId'];
    const userId = authResult.userId || 
                   event.requestContext?.authorizer?.jwt?.claims?.sub;

    if (!tenantId || !userId) {
      throw new Error('Tenant context missing');
    }
    
    authContext = { tenantId, userId };
  } catch (error) {
    return createErrorResponse(ErrorCode.UNAUTHORIZED, 'Unauthorized', requestId);
  }

  const { tenantId, userId } = authContext;
  
  if (!event.body) {
    return createErrorResponse(ErrorCode.BAD_REQUEST, 'Request body required', requestId);
  }

  try {
    const { productId, status, metadata } = JSON.parse(event.body);

    if (!productId || !status) {
      return createErrorResponse(ErrorCode.BAD_REQUEST, 'productId and status are required', requestId);
    }

    const pkValue = `TENANT#${tenantId}#PRODUCT#${productId}`;
    const skValue = `METADATA`;

    // 2. Verify existence and ownership
    const existing = await ddbDocClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: pkValue, SK: skValue }
    }));

    if (!existing.Item) {
      return createErrorResponse(ErrorCode.NOT_FOUND, 'Product not found', requestId);
    }

    // 3. Perform the Update
    const newStatus = status === 'approve' ? 'APPROVED' : 'REJECTED';
    const updatedAt = new Date().toISOString();

    await ddbDocClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: pkValue, SK: skValue },
      UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt, GSI2PK = :gsi2pk, #enrichment = :enrichment',
      ExpressionAttributeNames: {
        '#status': 'status',
        '#enrichment': 'enrichment'
      },
      ExpressionAttributeValues: {
        ':status': newStatus,
        ':updatedAt': updatedAt,
        ':gsi2pk': `TENANT#${tenantId}#PRODUCT_STATUS#${newStatus}`,
        ':enrichment': {
            ...existing.Item.enrichment,
            approvalStatus: status === 'approve' ? 'approved' : 'rejected',
            approvedBy: userId,
            approvedAt: updatedAt,
            userEdits: metadata ? [{ field: 'all', userCorrection: 'Manual review override' }] : []
        }
      }
    }));

    logger.info('Metadata approval processed', { productId, tenantId, status: newStatus, requestId });

    return createSuccessResponse({
      success: true,
      message: `Product ${productId} successfully ${newStatus.toLowerCase()}.`,
      status: newStatus
    });

  } catch (error) {
    logger.error('Error processing metadata approval', { 
        error: error instanceof Error ? error.message : String(error),
        tenantId,
        requestId
    });
    return createErrorResponse(ErrorCode.INTERNAL_ERROR, 'Internal server error during metadata approval.', requestId);
  }
}
