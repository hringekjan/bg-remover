import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

type S3Record = {
  eventName?: string;
  eventTime?: string;
  s3?: {
    bucket?: { name?: string };
    object?: { key?: string };
  };
};

type S3Event = {
  Records?: S3Record[];
};

const sqs = new SQSClient({});

const shardCount = Math.max(1, Number.parseInt(process.env.UPLOAD_EVENT_SHARD_COUNT || '4', 10));
const queueUrls = (process.env.UPLOAD_EVENT_QUEUE_URLS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

function decodeS3Key(rawKey: string): string {
  return decodeURIComponent(rawKey.replace(/\+/g, ' '));
}

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function extractTenantAndUploadId(key: string): { tenant: string | null; uploadId: string | null } {
  const parts = key.split('/').filter(Boolean);
  if (parts.length < 4) {
    return { tenant: null, uploadId: null };
  }

  const tempIndex = parts.indexOf('temp');
  if (tempIndex === -1 || parts.length <= tempIndex + 3) {
    return { tenant: null, uploadId: null };
  }

  const tenant = parts[tempIndex + 1];
  const uploadsIndex = tempIndex + 2;
  const uploadsSegment = parts[uploadsIndex];
  if (uploadsSegment !== 'uploads') {
    return { tenant: null, uploadId: null };
  }
  const uploadId = parts[uploadsIndex + 1] || null;

  return { tenant: tenant || null, uploadId };
}

function parseS3Event(message: any): S3Record[] {
  if (!message) {
    return [];
  }

  if (Array.isArray(message.Records)) {
    return message.Records as S3Record[];
  }

  return [];
}

export const handler = async (event: any): Promise<{ processed: number }> => {
  if (shardCount < 1) {
    throw new Error(`Invalid UPLOAD_EVENT_SHARD_COUNT: ${shardCount}. Must be >= 1.`);
  }

  if (queueUrls.length === 0) {
    throw new Error('UPLOAD_EVENT_QUEUE_URLS is empty or not configured');
  }

  if (queueUrls.length < shardCount) {
    throw new Error(`Insufficient UPLOAD_EVENT_QUEUE_URLS: found ${queueUrls.length}, expected ${shardCount}`);
  }

  let processed = 0;
  const sendPromises: Promise<unknown>[] = [];

  for (const record of event.Records || []) {
    let payload: S3Event | null = null;

    if (record.Sns?.Message) {
      if (process.env.UPLOAD_EVENT_DEBUG_LOG === 'true') {
        const preview = record.Sns.Message.slice(0, 500);
        console.log('[UploadEventRouter] SNS message preview', {
          length: record.Sns.Message.length,
          preview,
        });
      }
      try {
        payload = JSON.parse(record.Sns.Message);
      } catch (error) {
        console.warn('[UploadEventRouter] Invalid SNS message payload', {
          error: error instanceof Error ? error.message : String(error),
          preview: record.Sns.Message.slice(0, 200),
        });
        continue;
      }
    } else if (record.eventSource === 'aws:s3') {
      payload = { Records: [record] };
    }

    if (!payload) {
      continue;
    }

    const s3Records = parseS3Event(payload);
    for (const s3Record of s3Records) {
      const bucket = s3Record.s3?.bucket?.name;
      const rawKey = s3Record.s3?.object?.key;
      if (!bucket || !rawKey) {
        continue;
      }

      const key = decodeS3Key(rawKey);
      const { tenant, uploadId } = extractTenantAndUploadId(key);

      if (!tenant) {
        console.warn('[UploadEventRouter] Skipping key without tenant prefix', { key });
        continue;
      }

      const shardKey = `${tenant}:${uploadId || key}`;
      const shardIndex = hashString(shardKey) % shardCount;
      const queueUrl = queueUrls[shardIndex];

      const isCompletionMarker = key.endsWith('/complete.json') || key.endsWith('/_complete.json');
      const messageBody = JSON.stringify({
        type: isCompletionMarker ? 'trigger' : 'object',
        bucket,
        key,
        tenant,
        uploadId,
        eventTime: s3Record.eventTime,
        eventName: s3Record.eventName,
      });

      sendPromises.push(
        sqs.send(new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: messageBody,
        }))
      );
      processed += 1;
    }
  }

  if (sendPromises.length) {
    await Promise.all(sendPromises);
  }

  return { processed };
};
