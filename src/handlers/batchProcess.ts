import { SQSEvent } from 'aws-lambda';
import { ContextScope } from '@carousellabs/context-scope';
import { AgentTelemetry } from '@carousel/backend-kit/agent-telemetry';

const telemetry = AgentTelemetry.getInstance();

export const handler = async (event: SQSEvent): Promise<void> => {
  const startTime = Date.now();
  let error: Error | undefined;

  try {
    // Initialize context scope with 15 dimensions
    const contextScope = ContextScope.getInstance();
    contextScope.setDimension('service', 'bg-remover');
    contextScope.setDimension('function', 'batchProcess');
    contextScope.setDimension('tenantId', process.env.TENANT || 'unknown');
    contextScope.setDimension('eventType', 'SQS');
    contextScope.setDimension('recordCount', event.Records.length.toString());
    
    // Add more contextual dimensions
    contextScope.setDimension('queueArn', event.Records[0]?.eventSourceARN || 'unknown');
    contextScope.setDimension('region', process.env.AWS_REGION || 'unknown');
    contextScope.setDimension('functionVersion', process.env.AWS_LAMBDA_FUNCTION_VERSION || '$LATEST');
    contextScope.setDimension('memorySize', process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE || 'unknown');
    contextScope.setDimension('logGroupName', process.env.AWS_LAMBDA_LOG_GROUP_NAME || 'unknown');
    contextScope.setDimension('logStreamName', process.env.AWS_LAMBDA_LOG_STREAM_NAME || 'unknown');
    
    console.log(`Processing batch of ${event.Records.length} images`);
    
    // Process each SQS record
    for (const record of event.Records) {
      try {
        const body = JSON.parse(record.body);
        console.log('Processing image:', body.imageId);
        
        // Simulate processing time
        await new Promise(resolve => setTimeout(resolve, 50));
      } catch (recordError) {
        console.error('Error processing record:', recordError);
      }
    }
  } catch (err) {
    error = err as Error;
    console.error('Error in batch processing:', err);
    throw err;
  } finally {
    // Record telemetry
    const duration = Date.now() - startTime;
    const context = ContextScope.getInstance().getAllDimensions();
    
    await telemetry.recordMetric(
      'bg-remover-batch-process',
      context,
      duration,
      error
    );
  }
};