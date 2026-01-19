import { DynamoDBStreamHandler } from 'aws-lambda';
import { SNS } from '@aws-sdk/client-sns';
import { unmarshall } from '@aws-sdk/util-dynamodb';

const sns = new SNS({ region: process.env.AWS_REGION || 'eu-west-1' });
const SNS_TOPIC_ARN = process.env.JOB_UPDATES_SNS_TOPIC_ARN;
const TENANT = process.env.TENANT || 'default';

interface ProcessedImage {
  imageId: string;
  processedUrl?: string;
  width?: number;
  height?: number;
  status: string;
  processingTimeMs?: number;
  isPrimary?: boolean;
}

interface JobUpdate {
  jobId: string;
  status: string;
  progress: number;
  processedImages: ProcessedImage[];
  totalImages?: number;
  timestamp: string;
}

/**
 * Filter DynamoDB Stream records for relevant job updates
 */
function filterJobRecord(record: any): boolean {
  // Only process MODIFY and INSERT events
  if (record.eventName !== 'MODIFY' && record.eventName !== 'INSERT') {
    return false;
  }

  // Only process job records (PK starts with 'JOB#')
  const pk = record.dynamodb?.Keys?.PK?.S;
  if (!pk || !pk.startsWith('JOB#')) {
    return false;
  }

  // Check if processedImages array exists and has changed
  const oldImages = record.dynamodb?.OldImage?.result?.M?.processedImages?.L;
  const newImages = record.dynamodb?.NewImage?.result?.M?.processedImages?.L;

  // If this is an INSERT, always process
  if (record.eventName === 'INSERT' && newImages && newImages.length > 0) {
    return true;
  }

  // For MODIFY, only process if processedImages changed
  if (record.eventName === 'MODIFY') {
    const oldLength = oldImages?.length || 0;
    const newLength = newImages?.length || 0;
    return newLength > oldLength;
  }

  return false;
}

/**
 * Publish job update to SNS topic
 */
async function publishJobUpdate(jobUpdate: JobUpdate): Promise<void> {
  console.log('[SNS] Attempting to publish job update', {
    jobId: jobUpdate.jobId,
    status: jobUpdate.status,
    progress: jobUpdate.progress,
    snsTopicArn: SNS_TOPIC_ARN ? 'SET' : 'NOT SET',
    tenant: TENANT,
  });

  if (!SNS_TOPIC_ARN) {
    console.error('[SNS] SNS_TOPIC_ARN environment variable not set - cannot send push notifications');
    return;
  }

  try {
    // Limit processedImages to first 5 for push notification payload
    const limitedUpdate = {
      ...jobUpdate,
      processedImages: jobUpdate.processedImages.slice(0, 5),
    };

    console.log('[SNS] Publishing to SNS topic', {
      topicArn: SNS_TOPIC_ARN,
      messageSize: JSON.stringify(limitedUpdate).length,
      imageCount: limitedUpdate.processedImages.length,
    });

    const result = await sns.publish({
      TopicArn: SNS_TOPIC_ARN,
      Message: JSON.stringify(limitedUpdate),
      MessageAttributes: {
        jobId: {
          DataType: 'String',
          StringValue: jobUpdate.jobId,
        },
        tenant: {
          DataType: 'String',
          StringValue: TENANT,
        },
        eventType: {
          DataType: 'String',
          StringValue: 'job-update',
        },
      },
    });

    console.log('[SNS] Successfully published job update to SNS', {
      jobId: jobUpdate.jobId,
      status: jobUpdate.status,
      progress: jobUpdate.progress,
      imageCount: jobUpdate.processedImages.length,
      tenant: TENANT,
      messageId: result.MessageId,
    });
  } catch (error) {
    console.error('[SNS] Failed to publish to SNS', {
      jobId: jobUpdate.jobId,
      error: error instanceof Error ? error.message : String(error),
      topicArn: SNS_TOPIC_ARN,
    });
    throw error;
  }
}

/**
 * DynamoDB Stream handler for bg-remover job updates
 */
export const handler: DynamoDBStreamHandler = async (event) => {
  console.log('Processing DynamoDB Stream event', {
    recordCount: event.Records.length,
    tenant: TENANT,
  });

  // Filter relevant records
  const filteredRecords = event.Records.filter(filterJobRecord);

  console.log('Filtered records', {
    total: event.Records.length,
    filtered: filteredRecords.length,
  });

  // Process each filtered record
  for (const record of filteredRecords) {
    try {
      // Extract job data
      const newImage = record.dynamodb?.NewImage;
      if (!newImage) continue;

      const job = unmarshall(newImage as any);
      const jobId = job.jobId || job.PK?.replace('JOB#', '');

      // Extract processed images
      const processedImages: ProcessedImage[] = (job.result?.processedImages || []).map(
        (img: any) => ({
          imageId: img.imageId || img.filename,
          processedUrl: img.processedUrl || img.outputUrl,
          width: img.width || img.metadata?.width,
          height: img.height || img.metadata?.height,
          status: img.status || 'completed',
          processingTimeMs: img.processingTimeMs || img.metadata?.processingTimeMs || 0,
          isPrimary: img.isPrimary,
        })
      );

      // Build job update payload
      const jobUpdate: JobUpdate = {
        jobId,
        status: job.status || 'processing',
        progress: job.progress || 0,
        processedImages,
        totalImages: processedImages.length,
        timestamp: new Date().toISOString(),
      };

      // Publish to SNS
      await publishJobUpdate(jobUpdate);
    } catch (error) {
      console.error('Error processing stream record', {
        eventID: record.eventID,
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't throw - continue processing other records
    }
  }

  console.log('Stream processing complete', {
    recordsProcessed: filteredRecords.length,
  });
};
