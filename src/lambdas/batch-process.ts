import { SQSEvent } from 'aws-lambda';
import { ContextScope } from '@carousellabs/context-scope';
import { AgentTelemetry } from '@carousel/backend-kit/agent-telemetry';

export const handler = async (event: SQSEvent): Promise<void> => {
  const startTime = Date.now();
  let isError = false;
  let processedCount = 0;
  
  try {
    // Initialize context scope with 15 dimensions
    ContextScope.initialize({
      tenant: process.env.TENANT,
      service: 'bg-remover',
      handler: 'batch-process',
      stage: process.env.STAGE,
      region: process.env.AWS_REGION,
      functionVersion: process.env.AWS_LAMBDA_FUNCTION_VERSION,
      functionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
      memorySize: process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE,
      logGroup: process.env.AWS_LAMBDA_LOG_GROUP_NAME,
      logStream: process.env.AWS_LAMBDA_LOG_STREAM_NAME,
      accountId: process.env.AWS_ACCOUNT_ID,
      messageId: event.Records[0]?.messageId,
      eventSource: event.Records[0]?.eventSource,
      md5OfBody: event.Records[0]?.md5OfBody
    });

    // Process each SQS message
    for (const record of event.Records) {
      try {
        const body = JSON.parse(record.body);
        const imageUrl = body.imageUrl;
        
        if (imageUrl) {
          // Simulate batch processing
          console.log(`Processing image: ${imageUrl}`);
          processedCount++;
          
          // In a real implementation, we would call the actual background removal service
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch (recordError) {
        console.error('Error processing record:', recordError);
        isError = true;
      }
    }
  } catch (error) {
    isError = true;
    console.error('Error in batch processing:', error);
    throw error;
  } finally {
    // Record telemetry
    await AgentTelemetry.recordMetric({
      agentId: 'bg-remover-batch-process',
      metrics: {
        invocations: 1,
        duration: Date.now() - startTime,
        errors: isError ? 1 : 0,
        context: {
          ...ContextScope.getAll(),
          processedRecords: processedCount,
          totalRecords: event.Records.length
        }
      }
    });
  }
};