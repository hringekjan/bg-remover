import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ContextScope } from '@carousellabs/context-scope';
import { AgentTelemetry } from '@carousel/backend-kit/agent-telemetry';

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const startTime = Date.now();
  let isError = false;
  
  try {
    // Initialize context scope with 15 dimensions
    ContextScope.initialize({
      tenant: process.env.TENANT,
      service: 'bg-remover',
      handler: 'status',
      requestId: event.requestContext.requestId,
      userAgent: event.headers?.['User-Agent'],
      sourceIp: event.requestContext.identity?.sourceIp,
      stage: process.env.STAGE,
      region: process.env.AWS_REGION,
      functionVersion: process.env.AWS_LAMBDA_FUNCTION_VERSION,
      functionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
      memorySize: process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE,
      logGroup: process.env.AWS_LAMBDA_LOG_GROUP_NAME,
      logStream: process.env.AWS_LAMBDA_LOG_STREAM_NAME,
      accountId: process.env.AWS_ACCOUNT_ID
    });

    // Return service status
    const status = {
      service: 'bg-remover',
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: process.env.VERSION || '1.0.0'
    };

    return {
      statusCode: 200,
      body: JSON.stringify(status)
    };
  } catch (error) {
    isError = true;
    console.error('Error getting status:', error);
    
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Unable to determine service status' })
    };
  } finally {
    // Record telemetry
    await AgentTelemetry.recordMetric({
      agentId: 'bg-remover-status',
      metrics: {
        invocations: 1,
        duration: Date.now() - startTime,
        errors: isError ? 1 : 0,
        context: ContextScope.getAll()
      }
    });
  }
};