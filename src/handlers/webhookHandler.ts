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
    contextScope.setDimension('function', 'webhookHandler');
    contextScope.setDimension('tenantId', process.env.TENANT || 'unknown');
    contextScope.setDimension('requestId', event.requestContext.requestId);
    contextScope.setDimension('httpMethod', event.httpMethod);
    contextScope.setDimension('endpoint', event.path);
    contextScope.setDimension('userAgent', event.headers?.['User-Agent'] || 'unknown');
    contextScope.setDimension('sourceIp', event.requestContext.identity?.sourceIp || 'unknown');
    
    // Add webhook-specific dimensions
    contextScope.setDimension('webhookProvider', 'unknown'); // Would be determined from headers/body
    contextScope.setDimension('eventType', event.headers?.['X-Webhook-Event'] || 'unknown');
    contextScope.setDimension('webhookSignature', event.headers?.['X-Hub-Signature'] ? 'present' : 'missing');
    contextScope.setDimension('contentType', event.headers?.['Content-Type'] || 'unknown');
    contextScope.setDimension('contentLength', event.headers?.['Content-Length'] || 'unknown');

    // Process webhook payload
    const payload = JSON.parse(event.body || '{}');
    console.log('Received webhook:', payload);
    
    // Determine webhook provider from payload or headers
    if (payload.hasOwnProperty('github')) {
      contextScope.setDimension('webhookProvider', 'github');
    } else if (payload.hasOwnProperty('sender') && payload.hasOwnProperty('repository')) {
      contextScope.setDimension('webhookProvider', 'github');
    } else if (payload.hasOwnProperty('action')) {
      contextScope.setDimension('webhookProvider', 'generic');
    }

    // Simulate webhook processing
    await new Promise(resolve => setTimeout(resolve, 75));

    const result: APIGatewayProxyResult = {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        message: 'Webhook received and processed',
        processedAt: new Date().toISOString()
      })
    };

    // Set response-specific context
    contextScope.setDimension('statusCode', result.statusCode);
    
    return result;
  } catch (err) {
    error = err as Error;
    console.error('Error handling webhook:', err);
    
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        message: 'Failed to process webhook',
        error: err instanceof Error ? err.message : 'Unknown error'
      })
    };
  } finally {
    // Record telemetry
    const duration = Date.now() - startTime;
    const context = ContextScope.getInstance().getAllDimensions();
    
    await telemetry.recordMetric(
      'bg-remover-webhook-handler',
      context,
      duration,
      error
    );
  }
};