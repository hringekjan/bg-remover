import { randomUUID } from 'crypto';
import { DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { EventTracker } from '../lib/event-tracking';

type UploadEventMessage = {
  type?: 'object' | 'trigger';
  bucket: string;
  key: string;
  tenant: string;
  uploadId?: string | null;
  eventTime?: string;
  eventName?: string;
};

const dynamoDB = new DynamoDBClient({});
const sqs = new SQSClient({});
const eventTracker = new EventTracker(dynamoDB);

const tableName = process.env.DYNAMODB_TABLE!;
const stage = process.env.STAGE || 'dev';
const shardCount = Math.max(1, Number.parseInt(process.env.UPLOAD_EVENT_SHARD_COUNT || '4', 10));
const queueUrls = (process.env.UPLOAD_EVENT_QUEUE_URLS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const groupImagesQueueUrl = process.env.GROUP_IMAGES_QUEUE_URL || '';
const groupingMode = process.env.UPLOAD_EVENT_GROUPING_MODE || 'marker'; // 'marker' or 'timer'
const allowTimerTrigger = (process.env.UPLOAD_EVENT_ALLOW_TIMER || 'false').toLowerCase() === 'true' || groupingMode === 'timer';
const completionGraceSeconds = Math.max(0, Number.parseInt(process.env.UPLOAD_EVENT_COMPLETION_GRACE_SECONDS || '20', 10));

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function parseMessageBody(body: string): UploadEventMessage | null {
  try {
    const parsed = JSON.parse(body);
    if (parsed?.Message) {
      return JSON.parse(parsed.Message);
    }
    return parsed;
  } catch (error) {
    console.warn('[UploadEventConsumer] Failed to parse message body', { error });
    return null;
  }
}

function groupBy<T>(items: T[], getKey: (item: T) => string): Record<string, T[]> {
  return items.reduce<Record<string, T[]>>((acc, item) => {
    const key = getKey(item);
    acc[key] = acc[key] || [];
    acc[key].push(item);
    return acc;
  }, {});
}

async function updateJobStatus(jobId: string, tenant: string, status: string, additionalFields?: Record<string, any>): Promise<void> {
  const pk = `TENANT#${tenant}#BG_REMOVER_GROUPING_JOB#${jobId}`;
  const sk = 'METADATA';

  try {
    const updateExpressions: string[] = ['#status = :status', 'updatedAt = :updatedAt'];
    const expressionAttributeNames: Record<string, string> = {
      '#status': 'status',
    };
    const expressionAttributeValues: Record<string, any> = {
      ':status': status,
      ':updatedAt': new Date().toISOString(),
    };

    if (additionalFields) {
      Object.entries(additionalFields).forEach(([key, value], index) => {
        if (value === undefined || value === null) return;
        const attrName = `#f${index}`;
        const valName = `:v${index}`;
        expressionAttributeNames[attrName] = key;
        expressionAttributeValues[valName] = value;
        updateExpressions.push(`${attrName} = ${valName}`);
      });
    }

    await dynamoDB.send(new UpdateItemCommand({
      TableName: tableName,
      Key: marshall({ PK: pk, SK: sk }),
      UpdateExpression: `SET ${updateExpressions.join(', ')}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: marshall(expressionAttributeValues, { removeUndefinedValues: true }),
    }));
  } catch (error) {
    console.error('[UploadEventConsumer] Failed to update job status atomically', {
      jobId,
      tenant,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function createUploadAggregate(tenant: string, uploadId: string, bucket: string): Promise<boolean> {
  const pk = `TENANT#${tenant}#BG_REMOVER_UPLOAD#${uploadId}`;
  const sk = 'METADATA';
  const now = new Date().toISOString();
  const ttl = Math.floor(Date.now() / 1000) + 86400 * 7;

  try {
    await dynamoDB.send(new PutItemCommand({
      TableName: tableName,
      ConditionExpression: 'attribute_not_exists(PK)',
      Item: marshall({
        PK: pk,
        SK: sk,
        tenant,
        uploadId,
        status: 'collecting',
        createdAt: now,
        updatedAt: now,
        ttl,
        source: 's3-event',
        bucket,
        imageKeys: [],
        entityType: 'BG_REMOVER_UPLOAD_AGG',
      }, { removeUndefinedValues: true }),
    }));
    return true;
  } catch (error: any) {
    if (error?.name === 'ConditionalCheckFailedException') {
      return false;
    }
    throw error;
  }
}

async function appendUploadImage(tenant: string, uploadId: string, image: { s3Bucket: string; s3Key: string; filename?: string; metadata?: Record<string, any> }): Promise<void> {
  const pk = `TENANT#${tenant}#BG_REMOVER_UPLOAD#${uploadId}`;
  const sk = 'METADATA';
  const now = new Date().toISOString();

  await dynamoDB.send(new UpdateItemCommand({
    TableName: tableName,
    Key: marshall({ PK: pk, SK: sk }),
    UpdateExpression: 'SET #status = if_not_exists(#status, :status), updatedAt = :now, imageKeys = list_append(if_not_exists(imageKeys, :empty), :newKeys)',
    ExpressionAttributeNames: {
      '#status': 'status',
    },
    ExpressionAttributeValues: marshall({
      ':status': 'collecting',
      ':now': now,
      ':empty': [],
      ':newKeys': [image],
    }),
  }));
}

async function loadUploadAggregate(tenant: string, uploadId: string): Promise<Record<string, any> | null> {
  const pk = `TENANT#${tenant}#BG_REMOVER_UPLOAD#${uploadId}`;
  const sk = 'METADATA';

  const response = await dynamoDB.send(new GetItemCommand({
    TableName: tableName,
    Key: marshall({ PK: pk, SK: sk }),
  }));

  if (!response.Item) {
    return null;
  }

  return unmarshall(response.Item);
}

async function markUploadAggregate(tenant: string, uploadId: string, status: string, fields?: Record<string, any>): Promise<void> {
  const pk = `TENANT#${tenant}#BG_REMOVER_UPLOAD#${uploadId}`;
  const sk = 'METADATA';
  const now = new Date().toISOString();
  const expressionParts = ['#status = :status', 'updatedAt = :now'];
  const expressionNames: Record<string, string> = { '#status': 'status' };
  const expressionValues: Record<string, any> = {
    ':status': status,
    ':now': now,
  };

  if (fields) {
    let index = 0;
    for (const [key, value] of Object.entries(fields)) {
      const nameKey = `#f${index}`;
      const valueKey = `:v${index}`;
      expressionNames[nameKey] = key;
      expressionValues[valueKey] = value;
      expressionParts.push(`${nameKey} = ${valueKey}`);
      index += 1;
    }
  }

  await dynamoDB.send(new UpdateItemCommand({
    TableName: tableName,
    Key: marshall({ PK: pk, SK: sk }),
    UpdateExpression: `SET ${expressionParts.join(', ')}`,
    ExpressionAttributeNames: expressionNames,
    ExpressionAttributeValues: marshall(expressionValues, { removeUndefinedValues: true }),
  }));
}

async function requeueTrigger(queueUrl: string, payload: Omit<UploadEventMessage, 'type'> & { type?: 'trigger' | 'object' }): Promise<void> {
  await sqs.send(new SendMessageCommand({
    QueueUrl: queueUrl,
    DelaySeconds: Math.min(900, completionGraceSeconds),
    MessageBody: JSON.stringify({
      ...payload,
      type: 'trigger',
    }),
  }));
}

async function markGroupingJobDisabled(
  tenant: string,
  jobId: string,
  imageCount: number,
  reason: string
): Promise<void> {
  const pk = `TENANT#${tenant}#BG_REMOVER_GROUPING_JOB#${jobId}`;
  const sk = 'METADATA';
  const now = new Date().toISOString();
  const gsi1pk = `TENANT#${tenant}#BG_REMOVER_GROUPING_JOBS`;
  const gsi1sk = `${now}#JOB#${jobId}`;

  await dynamoDB.send(new UpdateItemCommand({
    TableName: tableName,
    Key: marshall({ PK: pk, SK: sk }),
    UpdateExpression: [
      'SET #status = :status',
      'updatedAt = :now',
      'reason = :reason',
      'jobId = if_not_exists(jobId, :jobId)',
      'tenant = if_not_exists(tenant, :tenant)',
      'createdAt = if_not_exists(createdAt, :now)',
      'entityType = if_not_exists(entityType, :entityType)',
      'imageCount = if_not_exists(imageCount, :imageCount)',
      'GSI1PK = if_not_exists(GSI1PK, :gsi1pk)',
      'GSI1SK = if_not_exists(GSI1SK, :gsi1sk)',
    ].join(', '),
    ExpressionAttributeNames: {
      '#status': 'status',
    },
    ExpressionAttributeValues: marshall({
      ':status': 'disabled',
      ':now': now,
      ':reason': reason,
      ':jobId': jobId,
      ':tenant': tenant,
      ':entityType': 'BG_REMOVER_GROUPING_JOB',
      ':imageCount': imageCount,
      ':gsi1pk': gsi1pk,
      ':gsi1sk': gsi1sk,
    }, { removeUndefinedValues: true }),
  }));
}

async function enqueueGroupingWorker(
  jobId: string,
  tenant: string,
  images: Array<{ s3Bucket: string; s3Key: string; filename?: string; metadata?: Record<string, any> }>,
  requestId: string,
  settings: {
    thumbnailSize?: { width: number; height: number };
    similarityThreshold?: number;
    includeExistingEmbeddings?: boolean;
  } = {}
): Promise<void> {
  if (!groupImagesQueueUrl) {
    throw new Error('GROUP_IMAGES_QUEUE_URL is not configured');
  }

  const workerPayload = {
    jobId,
    tenant,
    stage,
    images,
    thumbnailSize: settings.thumbnailSize || { width: 256, height: 256 },
    similarityThreshold: settings.similarityThreshold || 0.92,
    includeExistingEmbeddings: settings.includeExistingEmbeddings !== false,
    requestId,
  };

  await sqs.send(new SendMessageCommand({
    QueueUrl: groupImagesQueueUrl,
    MessageBody: JSON.stringify(workerPayload),
  }));
}

export const handler = async (event: any): Promise<{ processed: number }> => {
  const groupingEnabled = (process.env.UPLOAD_EVENT_GROUPING_ENABLED || 'true').toLowerCase() === 'true';

  if (shardCount < 1) {
    throw new Error(`Invalid UPLOAD_EVENT_SHARD_COUNT: ${shardCount}. Must be >= 1.`);
  }
  if (queueUrls.length === 0) {
    throw new Error('UPLOAD_EVENT_QUEUE_URLS is empty or not configured');
  }
  if (queueUrls.length < shardCount) {
    throw new Error(`Insufficient UPLOAD_EVENT_QUEUE_URLS: found ${queueUrls.length}, expected ${shardCount}`);
  }
  if (!groupImagesQueueUrl) {
    throw new Error('GROUP_IMAGES_QUEUE_URL is not configured');
  }

  const messages: UploadEventMessage[] = [];
  for (const record of event.Records || []) {
    const message = parseMessageBody(record.body);
    if (message?.bucket && message?.key && message?.tenant) {
      messages.push(message);
    }
  }

  if (!messages.length) {
    return { processed: 0 };
  }

  const grouped = groupBy(messages, (message) => `${message.tenant}:${message.uploadId || message.key}`);

  const groupEntries = Object.entries(grouped);
  for (const [groupKey, groupMessages] of groupEntries) {
    const [tenant] = groupKey.split(':');
    const jobId = groupMessages[0].uploadId || randomUUID();
    const requestId = jobId;

    const hasTrigger = groupMessages.some((message) => message.type === 'trigger');
    const objectMessages = groupMessages.filter((message) => message.type !== 'trigger');

    const images = objectMessages.map((message) => ({
      s3Bucket: message.bucket,
      s3Key: message.key,
      filename: message.key.split('/').pop(),
      metadata: {
        uploadedAt: message.eventTime,
      },
    }));

    try {
      const uploadId = groupMessages[0].uploadId || jobId;
      const createdAggregate = await createUploadAggregate(tenant, uploadId, groupMessages[0].bucket);

      if (images.length) {
        for (const image of images) {
          await appendUploadImage(tenant, uploadId, image);
        }

        for (let i = 0; i < images.length; i += 1) {
          await eventTracker.recordEvent(tenant, 'IMAGE_UPLOADED');
        }
      }

      if (createdAggregate && allowTimerTrigger) {
        const shardKey = `${tenant}:${uploadId}`;
        const shardIndex = hashString(shardKey) % shardCount;
        const queueUrl = queueUrls[shardIndex];
        await sqs.send(new SendMessageCommand({
          QueueUrl: queueUrl,
          DelaySeconds: 30,
          MessageBody: JSON.stringify({
            type: 'trigger',
            tenant,
            uploadId,
            bucket: groupMessages[0].bucket,
            key: groupMessages[0].key,
          }),
        }));
      }

      if (!hasTrigger) {
        continue;
      }

      if (!groupingEnabled) {
        await markUploadAggregate(tenant, uploadId, 'disabled', { reason: 'grouping-disabled' });
        await markGroupingJobDisabled(tenant, jobId, images.length, 'grouping-disabled');
        continue;
      }

      const aggregate = await loadUploadAggregate(tenant, uploadId);
      if (!aggregate || aggregate.status === 'processing' || aggregate.status === 'completed') {
        continue;
      }

      const shardKey = `${tenant}:${uploadId}`;
      const shardIndex = hashString(shardKey) % shardCount;
      const queueUrl = queueUrls[shardIndex];

      // Grace period after completion marker to allow all image events to be appended.
      const nowIso = new Date().toISOString();
      const completionMarkerAt = aggregate.completionMarkerAt;
      if (!completionMarkerAt) {
        await markUploadAggregate(tenant, uploadId, 'collecting', {
          completionMarkerAt: nowIso,
        });
        await requeueTrigger(queueUrl, {
          type: 'trigger',
          tenant,
          uploadId,
          bucket: groupMessages[0].bucket,
          key: groupMessages[0].key,
        });
        continue;
      }

      const completionAgeMs = Date.now() - Date.parse(completionMarkerAt);
      if (Number.isFinite(completionAgeMs) && completionAgeMs < completionGraceSeconds * 1000) {
        await requeueTrigger(queueUrl, {
          type: 'trigger',
          tenant,
          uploadId,
          bucket: groupMessages[0].bucket,
          key: groupMessages[0].key,
        });
        continue;
      }

      const aggregateImages = Array.isArray(aggregate.imageKeys) ? aggregate.imageKeys : [];
      const pk = `TENANT#${tenant}#BG_REMOVER_GROUPING_JOB#${jobId}`;
      const sk = 'METADATA';
      const gsi1pk = `TENANT#${tenant}#BG_REMOVER_GROUPING_JOBS`;
      const gsi1sk = `${new Date().toISOString()}#JOB#${jobId}`;
      const now = new Date().toISOString();

      try {
        await dynamoDB.send(new PutItemCommand({
          TableName: tableName,
          ConditionExpression: 'attribute_not_exists(PK)',
          Item: marshall({
            PK: pk,
            SK: sk,
            GSI1PK: gsi1pk,
            GSI1SK: gsi1sk,
            jobId,
            tenant,
            status: 'pending',
            createdAt: now,
            updatedAt: now,
            ttl: Math.floor(Date.now() / 1000) + 86400 * 7,
            entityType: 'BG_REMOVER_GROUPING_JOB',
            imageCount: aggregateImages.length,
            includeExistingEmbeddings: true,
            requestId,
            source: 's3-event',
          }, { removeUndefinedValues: true }),
        }));
      } catch (error: any) {
        if (error?.name === 'ConditionalCheckFailedException') {
          console.info('[UploadEventConsumer] Grouping job already exists, skipping duplicate', { jobId, tenant });
          continue;
        }
        throw error;
      }

      await markUploadAggregate(tenant, uploadId, 'processing', { jobId });
      await enqueueGroupingWorker(jobId, tenant, aggregateImages, requestId, {
        thumbnailSize: { width: 256, height: 256 },
        similarityThreshold: 0.92,
        includeExistingEmbeddings: true,
      });
    } catch (error: any) {
      console.error('[UploadEventConsumer] Failed to process upload group', {
        jobId,
        tenant,
        error: error instanceof Error ? error.message : String(error),
      });

      await updateJobStatus(jobId, tenant, 'failed', {
        error: error instanceof Error ? error.message : String(error),
        requestId,
      });
    }
  }

  return { processed: messages.length };
};
