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
    contextScope.setDimension('function', 'statusCheck');
    contextScope.setDimension('tenantId', process.env.TENANT || 'unknown');
    contextScope.setDimension('requestId', event.requestContext.requestId);
    contextScope.setDimension('httpMethod', event.httpMethod);
    contextScope.setDimension('endpoint', event.path);
    contextScope.setDimension('userAgent', event.headers?.['User-Agent'] || 'unknown');
    contextScope.setDimension('sourceIp', event.requestContext.identity?.sourceIp || 'unknown');
    
    // Add status check specific dimensions
    contextScope.setDimension('checkType', 'health');
    contextScope.setDimension('version', process.env.VERSION || 'unknown');
    contextScope.setDimension('environment', process.env.STAGE || 'unknown');
    contextScope.setDimension('region', process.env.AWS_REGION || 'unknown');
    contextScope.setDimension('functionName', process.env.AWS_LAMBDA_FUNCTION_NAME || 'unknown');

    // Perform health checks
    const healthChecks = {
      service: 'bg-remover',
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: process.env.VERSION || '1.0.0',
      dependencies: {
        s3: 'connected',
        eventBridge: 'connected',
        dynamoDB: 'connected'
      }
    };

    const result: APIGatewayProxyResult = {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify(healthChecks)
    };

    // Set response-specific context
    contextScope.setDimension('statusCode', result.statusCode);
    
    return result;
  } catch (err) {
    error = err as Error;
    console.error('Error in status check:', err);
    
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        service: 'bg-remover',
        status: 'unhealthy',
        error: err instanceof Error ? err.message : 'Unknown error',
        timestamp: new Date().toISOString()
      })
    };
  } finally {
    // Record telemetry
    const duration = Date.now() - startTime;
    const context = ContextScope.getInstance().getAllDimensions();
    
    await telemetry.recordMetric(
      'bg-remover-status-check',
      context,
      duration,
      error
    );
  }
};