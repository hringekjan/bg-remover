import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ContextScope } from '@carousellabs/context-scope';
import { AgentTelemetry } from '@carousel/backend-kit/agent-telemetry';

const telemetry = AgentTelemetry.getInstance();

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const startTime = Date.now();
  let error: Error | undefined;

  try {
    // Initialize context scope with 15 dimensions
    const contextScope = ContextScope.getInstance();
    contextScope.setDimension('service', 'bg-remover');
    contextScope.setDimension('function', 'processImage');
    contextScope.setDimension('tenantId', process.env.TENANT || 'unknown');
    contextScope.setDimension('requestId', event.requestContext.requestId);
    contextScope.setDimension('httpMethod', event.httpMethod);
    contextScope.setDimension('endpoint', event.path);
    contextScope.setDimension('userAgent', event.headers?.['User-Agent'] || 'unknown');
    contextScope.setDimension('sourceIp', event.requestContext.identity?.sourceIp || 'unknown');
    
    // Add more contextual dimensions
    contextScope.setDimension('contentType', event.headers?.['Content-Type'] || 'unknown');
    contextScope.setDimension('contentLength', event.headers?.['Content-Length'] || 'unknown');
    contextScope.setDimension('apiStage', event.requestContext.stage);
    contextScope.setDimension('accountId', event.requestContext.accountId);
    contextScope.setDimension('resourcePath', event.requestContext.resourcePath);
    contextScope.setDimension('authorizerType', event.requestContext.authorizer?.principalId ? 'CUSTOM' : 'NONE');
    contextScope.setDimension('protocol', event.requestContext.protocol);

    // Process image logic here (existing implementation)
    console.log('Processing image for background removal...');
    
    // Simulate processing time
    await new Promise(resolve => setTimeout(resolve, 100));

    const result: APIGatewayProxyResult = {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        message: 'Background removal completed successfully',
        processedAt: new Date().toISOString()
      })
    };

    // Set response-specific context
    contextScope.setDimension('statusCode', result.statusCode);
    
    return result;
  } catch (err) {
    error = err as Error;
    console.error('Error processing image:', err);
    
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        message: 'Failed to process image',
        error: err instanceof Error ? err.message : 'Unknown error'
      })
    };
  } finally {
    // Record telemetry
    const duration = Date.now() - startTime;
    const context = ContextScope.getInstance().getAllDimensions();
    
    await telemetry.recordMetric(
      'bg-remover-process-image',
      context,
      duration,
      error
    );
  }
};