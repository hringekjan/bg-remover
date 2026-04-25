import { withContextScope } from './lib/middleware/context-scope';
import { APIGatewayProxyHandlerV2 } from 'aws-lambda';

// Simple test handler to verify middleware works
const testHandler: APIGatewayProxyHandlerV2 = async (event, context) => {
  return {
    statusCode: 200,
    body: JSON.stringify({
      message: 'Context scope middleware test successful',
      requestId: context.awsRequestId,
      functionName: context.functionName
    })
  };
};

export const handler = withContextScope(testHandler);