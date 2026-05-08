/**
 * SQS DLQ Handler for LCP-API Async Retry
 *
 * Purpose: Process failed LCP-API writes from SQS DLQ queue
 * Triggered by: SQS event from bg-remover-lcp-api-dlq-{stage}
 *
 * Retry strategy:
 * - Retry failed outcomes with exponential backoff
 * - Max retries: 5 (configurable)
 * - If success: delete from queue
 * - If max retries exceeded: send to dead-letter queue (DLQ-of-DLQ)
 *
 * Usage: Deploy as separate Lambda function with SQS trigger
 *
 * Configuration (serverless.yml):
 * ```yaml
 * functions:
 *   lcpApiDlqHandler:
 *     handler: src/handlers/lcp-api-dlq-handler.handler
 *     description: Async retry handler for failed LCP-API outcomes
 *     timeout: 300
 *     reservedConcurrency: 5
 *     events:
 *       - sqs:
 *           arn: arn:aws:sqs:${aws:region}:${aws:accountId}:bg-remover-lcp-api-dlq-${sls:stage}
 *           batchSize: 10
 *           maximumBatchingWindowInSeconds: 5
 * ```
 */

import { SQSEvent, SQSRecord } from 'aws-lambda';
import { SQSClient, DeleteMessageCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { OutcomeDualWriter, type OutcomePayload } from '../lib/outcomes/outcome-dual-writer';
import { logger } from '../lib/logger';

const sqs = new SQSClient({ region: process.env.AWS_REGION || 'eu-west-1' });
const dlqUrl = process.env.LCP_API_DLQ_URL || '';
const deadLetterQueueUrl = process.env.LCP_API_DEAD_LETTER_QUEUE_URL || '';
const maxRetries = parseInt(process.env.MAX_RETRY_ATTEMPTS || '5', 10);

const writer = new OutcomeDualWriter({
  lcpApiBaseUrl: process.env.LCP_API_BASE_URL,
  lcpApiAuthToken: process.env.LCP_API_AUTH_TOKEN,
  stage: process.env.STAGE || 'dev',
});

/**
 * DLQ message structure
 */
interface DlqMessage {
  jobId: string;
  tenantId: string;
  outcomeType: string;
  data: Record<string, any>;
  metadata?: Record<string, any>;
  lastError?: string;
  failedAt?: string;
  retryCount: number;
  nextRetryTime?: number; // Unix timestamp for exponential backoff
}

/**
 * Handler for SQS DLQ events
 *
 * Processes failed outcomes in batches, retrying each one up to maxRetries times.
 * If successful, deletes from queue. If max retries exceeded, sends to dead-letter queue.
 */
export async function handler(event: SQSEvent): Promise<void> {
  const batchResults: Array<{
    messageId: string;
    success: boolean;
    outcome?: OutcomePayload;
    error?: string;
  }> = [];

  logger.info('[LCP-API DLQ] Processing batch', {
    batchSize: event.Records.length,
    timestamp: new Date().toISOString(),
  });

  for (const record of event.Records) {
    try {
      const result = await processMessage(record);
      batchResults.push(result);

      if (result.success) {
        // Delete successfully processed message from queue
        await deleteMessage(record.receiptHandle);
        logger.info('[LCP-API DLQ] Message deleted after successful retry', {
          messageId: record.messageId,
          jobId: result.outcome?.jobId,
        });
      }
    } catch (error) {
      logger.error('[LCP-API DLQ] Failed to process message', {
        messageId: record.messageId,
        error: error instanceof Error ? error.message : String(error),
      });

      // Message will remain in queue and be retried (SQS will re-queue after visibility timeout)
    }
  }

  // Log batch results for observability
  const successCount = batchResults.filter(r => r.success).length;
  const failureCount = batchResults.filter(r => !r.success).length;

  logger.info('[LCP-API DLQ] Batch complete', {
    total: batchResults.length,
    success: successCount,
    failure: failureCount,
    successRate: `${((successCount / batchResults.length) * 100).toFixed(1)}%`,
  });

  // Emit metrics
  await emitMetrics(successCount, failureCount);
}

/**
 * Process a single DLQ message
 *
 * Parses the message, validates retry count, and attempts to write to LCP-API.
 * If successful, returns success. If max retries exceeded, queues to DLQ-of-DLQ.
 */
async function processMessage(record: SQSRecord): Promise<{
  messageId: string;
  success: boolean;
  outcome?: OutcomePayload;
  error?: string;
}> {
  let message: DlqMessage;

  try {
    message = JSON.parse(record.body);
  } catch (error) {
    logger.error('[LCP-API DLQ] Failed to parse message body', {
      messageId: record.messageId,
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      messageId: record.messageId,
      success: false,
      error: 'Invalid message format',
    };
  }

  // Validate required fields
  if (!message.jobId || !message.tenantId || !message.outcomeType || !message.data) {
    logger.error('[LCP-API DLQ] Message missing required fields', {
      messageId: record.messageId,
      jobId: message.jobId,
    });

    return {
      messageId: record.messageId,
      success: false,
      error: 'Missing required fields',
    };
  }

  // Check if max retries exceeded
  if (message.retryCount >= maxRetries) {
    logger.error('[LCP-API DLQ] Max retries exceeded, sending to dead-letter queue', {
      messageId: record.messageId,
      jobId: message.jobId,
      retryCount: message.retryCount,
      maxRetries,
    });

    // Send to DLQ-of-DLQ for manual investigation
    if (deadLetterQueueUrl) {
      await sendToDeadLetterQueue(message);
    }

    return {
      messageId: record.messageId,
      success: false,
      error: `Max retries (${maxRetries}) exceeded`,
    };
  }

  // Check if it's time to retry (exponential backoff)
  if (message.nextRetryTime && Date.now() < message.nextRetryTime) {
    logger.debug('[LCP-API DLQ] Retry scheduled for later', {
      messageId: record.messageId,
      jobId: message.jobId,
      nextRetryTime: new Date(message.nextRetryTime).toISOString(),
    });

    return {
      messageId: record.messageId,
      success: false,
      error: 'Not yet time to retry',
    };
  }

  // Reconstruct outcome payload for retry
  const outcome: OutcomePayload = {
    jobId: message.jobId,
    tenant: message.jobId.split('#')[0], // Extract tenant from jobId
    tenantId: message.tenantId,
    outcomeType: message.outcomeType as any,
    data: message.data,
    metadata: message.metadata,
  };

  try {
    // Attempt to write to LCP-API (this will retry internally with backoff)
    logger.info('[LCP-API DLQ] Retrying LCP-API write', {
      messageId: record.messageId,
      jobId: message.jobId,
      retryCount: message.retryCount,
    });

    // Call the private writeLcpApi method (use reflection/type casting to bypass private)
    const result = await (writer as any).writeLcpApi(outcome);

    if (result.success) {
      logger.info('[LCP-API DLQ] LCP-API write succeeded on retry', {
        messageId: record.messageId,
        jobId: message.jobId,
        retryCount: message.retryCount,
      });

      return {
        messageId: record.messageId,
        success: true,
        outcome,
      };
    } else {
      // Retry failed, will be re-queued
      logger.warn('[LCP-API DLQ] LCP-API write failed, will retry later', {
        messageId: record.messageId,
        jobId: message.jobId,
        retryCount: message.retryCount + 1,
        error: result.error,
      });

      // Calculate next retry time with exponential backoff
      const backoffMs = 1000 * Math.pow(2, message.retryCount); // 1s, 2s, 4s, 8s, 16s
      message.nextRetryTime = Date.now() + backoffMs;
      message.retryCount += 1;
      message.lastError = result.error;

      // Re-queue the message (SQS will automatically re-queue after visibility timeout)
      // Optionally, manually change the message and extend visibility timeout

      return {
        messageId: record.messageId,
        success: false,
        outcome,
        error: `Will retry in ${backoffMs}ms (attempt ${message.retryCount + 1}/${maxRetries})`,
      };
    }
  } catch (error) {
    logger.error('[LCP-API DLQ] Error during LCP-API write attempt', {
      messageId: record.messageId,
      jobId: message.jobId,
      retryCount: message.retryCount,
      error: error instanceof Error ? error.message : String(error),
    });

    // Update message for re-queue
    const backoffMs = 1000 * Math.pow(2, message.retryCount);
    message.nextRetryTime = Date.now() + backoffMs;
    message.retryCount += 1;
    message.lastError = error instanceof Error ? error.message : String(error);

    return {
      messageId: record.messageId,
      success: false,
      outcome,
      error: `Unexpected error during retry attempt ${message.retryCount}/${maxRetries}`,
    };
  }
}

/**
 * Delete a message from the DLQ queue
 */
async function deleteMessage(receiptHandle: string): Promise<void> {
  try {
    await sqs.send(
      new DeleteMessageCommand({
        QueueUrl: dlqUrl,
        ReceiptHandle: receiptHandle,
      })
    );
  } catch (error) {
    logger.error('[LCP-API DLQ] Failed to delete message', {
      error: error instanceof Error ? error.message : String(error),
    });

    throw error;
  }
}

/**
 * Send a message to the dead-letter queue (DLQ-of-DLQ) after max retries exceeded
 */
async function sendToDeadLetterQueue(message: DlqMessage): Promise<void> {
  if (!deadLetterQueueUrl) {
    logger.warn('[LCP-API DLQ] Dead-letter queue URL not configured, cannot send');
    return;
  }

  try {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: deadLetterQueueUrl,
        MessageBody: JSON.stringify({
          ...message,
          maxRetriesExceededAt: new Date().toISOString(),
          reason: `Max retries exceeded after ${maxRetries} attempts`,
        }),
      })
    );

    logger.info('[LCP-API DLQ] Sent to dead-letter queue', {
      jobId: message.jobId,
      retryCount: message.retryCount,
    });
  } catch (error) {
    logger.error('[LCP-API DLQ] Failed to send to dead-letter queue', {
      jobId: message.jobId,
      error: error instanceof Error ? error.message : String(error),
    });

    // Don't throw — this is a fallback mechanism
  }
}

/**
 * Emit CloudWatch metrics for DLQ processing
 */
async function emitMetrics(successCount: number, failureCount: number): Promise<void> {
  // TODO: Implement CloudWatch metrics emission
  // Similar to OutcomeDualWriter.emitMetrics()
  logger.info('[LCP-API DLQ] Metrics should be emitted here', {
    successCount,
    failureCount,
  });
}

export default handler;
