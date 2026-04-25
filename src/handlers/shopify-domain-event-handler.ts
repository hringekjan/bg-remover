import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { httpResponse, errorResponse } from '../../lib/utils/response';
import { extractAuthContext, isAdmin } from '../../lib/utils/auth';
import { withContextScope } from '../../lib/middleware/context-scope';
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import pino from 'pino';

// Initialize clients
const sqs = new SQSClient({});
const dynamoDB = new DynamoDBClient({});
const logger = pino();

// Environment variables
const shopifyEventQueueUrl = process.env.SHOPIFY_EVENT_QUEUE_URL || '';
const stage = process.env.STAGE || 'dev';

// Type definitions
type ShopifyEventMessage = {
  eventType: string;
  payload: any;
  timestamp: string;
  tenant?: string;
};

/**
 * Process a batch of Shopify domain events from SQS
 */
async function processShopifyEventBatch(messages: any[]): Promise<number> {
  let processedCount = 0;
  
  for (const message of messages) {
    try {
      const shopifyEvent: ShopifyEventMessage = typeof message.Body === 'string' 
        ? JSON.parse(message.Body) 
        : message.Body;

      logger.info('Processing Shopify event', {
        eventType: shopifyEvent.eventType,
        timestamp: shopifyEvent.timestamp,
        tenant: shopifyEvent.tenant
      });

      // TODO: Implement actual Shopify event processing logic here
      // For example:
      // - Call Shopify API based on event type
      // - Update database records
      // - Trigger other downstream services
      
      switch (shopifyEvent.eventType) {
        case 'booking.created':
          // Process booking creation event
          logger.info('Handling booking.created event');
          // Make API calls to Shopify or other services
          break;
        default:
          logger.warn('Unhandled Shopify event type', {
            eventType: shopifyEvent.eventType
          });
      }

      processedCount++;
    } catch (error) {
      logger.error('Failed to process Shopify event', {
        error: error instanceof Error ? error.message : String(error),
        messageId: message.MessageId
      });
      
      // Consider dead letter queue handling or other error recovery mechanisms
      continue;
    }
  }

  return processedCount;
}

/**
 * Main handler function for processing Shopify domain events
 */
export const handler = withContextScope(async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  try {
    // Extract authentication context
    const authContext = extractAuthContext(event);
    
    // Validate admin permissions if needed
    if (!isAdmin(authContext)) {
      return errorResponse(403, 'Forbidden: Admin access required');
    }

    // Validate that queue URL is configured
    if (!shopifyEventQueueUrl) {
      logger.error('SHOPIFY_EVENT_QUEUE_URL is not configured');
      return errorResponse(500, 'Internal server error');
    }

    // Receive messages from SQS queue
    const receiveParams = {
      QueueUrl: shopifyEventQueueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 20,
      VisibilityTimeout: 300
    };

    const receiveResponse = await sqs.send(new ReceiveMessageCommand(receiveParams));
    
    if (!receiveResponse.Messages || receiveResponse.Messages.length === 0) {
      logger.info('No messages to process in Shopify event queue');
      return httpResponse(200, { message: 'No messages to process' });
    }

    // Process batch of messages
    const processedCount = await processShopifyEventBatch(receiveResponse.Messages);
    
    // Delete processed messages from queue
    for (const message of receiveResponse.Messages) {
      if (message.ReceiptHandle) {
        try {
          await sqs.send(new DeleteMessageCommand({
            QueueUrl: shopifyEventQueueUrl,
            ReceiptHandle: message.ReceiptHandle
          }));
        } catch (deleteError) {
          logger.error('Failed to delete processed message', {
            error: deleteError instanceof Error ? deleteError.message : String(deleteError),
            messageId: message.MessageId
          });
        }
      }
    }

    logger.info('Successfully processed Shopify events batch', { count: processedCount });
    
    return httpResponse(200, {
      message: `Successfully processed ${processedCount} Shopify events`,
      count: processedCount
    });
  } catch (error) {
    logger.error('Error in Shopify domain event handler', {
      error: error instanceof Error ? error.message : String(error)
    });
    
    return errorResponse(500, 'Internal server error');
  }
});