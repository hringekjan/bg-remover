import { randomUUID } from 'crypto';

const store = new Map<string, any>();
const mockDynamoSend = jest.fn();
const mockSqsSend = jest.fn();
const mockRecordEvent = jest.fn().mockResolvedValue(undefined);

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockDynamoSend })),
  PutItemCommand: jest.fn((input: any) => ({ __type: 'PutItemCommand', input })),
  UpdateItemCommand: jest.fn((input: any) => ({ __type: 'UpdateItemCommand', input })),
  GetItemCommand: jest.fn((input: any) => ({ __type: 'GetItemCommand', input })),
}));

jest.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: jest.fn(() => ({ send: mockSqsSend })),
  SendMessageCommand: jest.fn((input: any) => ({ __type: 'SendMessageCommand', input })),
}));

jest.mock('@aws-sdk/util-dynamodb', () => ({
  marshall: (value: any) => value,
  unmarshall: (value: any) => value,
}));

jest.mock('../../lib/event-tracking', () => ({
  EventTracker: jest.fn().mockImplementation(() => ({
    recordEvent: mockRecordEvent,
  })),
}));

const keyFor = (pk: string, sk: string) => `${pk}|${sk}`;

const initDynamoMock = () => {
  mockDynamoSend.mockImplementation(async (command: any) => {
    if (command.__type === 'PutItemCommand') {
      const { Item, ConditionExpression } = command.input;
      const pk = Item.PK || Item.pk;
      const sk = Item.SK || Item.sk;
      const key = keyFor(pk, sk);
      if (ConditionExpression?.includes('attribute_not_exists') && store.has(key)) {
        const error = new Error('ConditionalCheckFailedException');
        (error as any).name = 'ConditionalCheckFailedException';
        throw error;
      }
      store.set(key, { ...Item });
      return {};
    }

    if (command.__type === 'UpdateItemCommand') {
      const { Key, ExpressionAttributeValues } = command.input;
      const pk = Key.PK || Key.pk;
      const sk = Key.SK || Key.sk;
      const key = keyFor(pk, sk);
      const existing = store.get(key) || { PK: pk, SK: sk, imageKeys: [] };
      const updated = { ...existing };

      if (command.input.UpdateExpression.includes('list_append')) {
        const newKeys = ExpressionAttributeValues[':newKeys'] || [];
        updated.imageKeys = [...(updated.imageKeys || []), ...newKeys];
      }
      
      store.set(key, updated);
      return {};
    }

    if (command.__type === 'GetItemCommand') {
      const { Key } = command.input;
      const pk = Key.PK || Key.pk;
      const sk = Key.SK || Key.sk;
      const key = keyFor(pk, sk);
      const item = store.get(key);
      return item ? { Item: item } : {};
    }

    return {};
  });
};

const buildEvent = (messages: any[]) => ({
  Records: messages.map((message) => ({
    body: JSON.stringify(message),
  })),
});

describe('upload-events-consumer grouping mode', () => {
  beforeEach(() => {
    jest.resetModules();
    store.clear();
    mockDynamoSend.mockReset();
    mockSqsSend.mockReset();
    mockRecordEvent.mockReset().mockResolvedValue(undefined);
    initDynamoMock();
    
    process.env.DYNAMODB_TABLE = 'test-table';
    process.env.STAGE = 'dev';
    process.env.UPLOAD_EVENT_GROUPING_ENABLED = 'true';
    process.env.UPLOAD_EVENT_SHARD_COUNT = '4';
    process.env.UPLOAD_EVENT_QUEUE_URLS = 'q1,q2,q3,q4';
    process.env.GROUP_IMAGES_QUEUE_URL = 'group-queue';
    process.env.UPLOAD_EVENT_COMPLETION_GRACE_SECONDS = '0';
  });

  it('in marker mode, it does not trigger grouping without a trigger message', async () => {
    process.env.UPLOAD_EVENT_GROUPING_MODE = 'marker';
    process.env.UPLOAD_EVENT_ALLOW_TIMER = 'false';
    
    const { handler } = await import('../upload-events-consumer');
    const messages = [
      {
        type: 'object',
        bucket: 'bucket',
        key: 'temp/tenant/uploads/job1/0.jpg',
        tenant: 'tenant',
        uploadId: 'job1',
      },
    ];

    await handler(buildEvent(messages));

    // No grouping job created
    const jobKey = keyFor('TENANT#tenant#BG_REMOVER_GROUPING_JOB#job1', 'METADATA');
    expect(store.has(jobKey)).toBe(false);
    
    // No worker enqueued
    expect(mockSqsSend).not.toHaveBeenCalled();
  });

  it('in timer mode, it enqueues a delayed trigger on the first object', async () => {
    process.env.UPLOAD_EVENT_GROUPING_MODE = 'timer';
    
    const { handler } = await import('../upload-events-consumer');
    const messages = [
      {
        type: 'object',
        bucket: 'bucket',
        key: 'temp/tenant/uploads/job2/0.jpg',
        tenant: 'tenant',
        uploadId: 'job2',
      },
    ];

    await handler(buildEvent(messages));

    // Should have enqueued a delayed trigger back to shard queue
    const shardTriggerCall = mockSqsSend.mock.calls.find(call => {
        const body = JSON.parse(call[0].input.MessageBody);
        return body.type === 'trigger' && call[0].input.DelaySeconds === 30;
    });
    expect(shardTriggerCall).toBeTruthy();
  });

  it('unified worker payload includes correct defaults', async () => {
    const { handler } = await import('../upload-events-consumer');
    
    // Pre-create aggregate with completion marker to skip grace period logic
    const aggregateKey = keyFor('TENANT#tenant#BG_REMOVER_UPLOAD#job3', 'METADATA');
    store.set(aggregateKey, {
        PK: 'TENANT#tenant#BG_REMOVER_UPLOAD#job3',
        SK: 'METADATA',
        status: 'collecting',
        completionMarkerAt: new Date(Date.now() - 10000).toISOString(), // 10s ago
        imageKeys: []
    });

    const messages = [
      {
        type: 'object',
        bucket: 'bucket',
        key: 'temp/tenant/uploads/job3/0.jpg',
        tenant: 'tenant',
        uploadId: 'job3',
      },
      {
        type: 'trigger',
        bucket: 'bucket',
        key: 'temp/tenant/uploads/job3/complete.json',
        tenant: 'tenant',
        uploadId: 'job3',
      },
    ];

    await handler(buildEvent(messages));

    const workerCall = mockSqsSend.mock.calls.find(call => {
        const body = JSON.parse(call[0].input.MessageBody);
        return body.jobId === 'job3' && body.images;
    });
    
    expect(workerCall).toBeTruthy();
    const payload = JSON.parse(workerCall![0].input.MessageBody);
    expect(payload.thumbnailSize).toEqual({ width: 256, height: 256 });
    expect(payload.similarityThreshold).toBe(0.92);
    expect(payload.includeExistingEmbeddings).toBe(true);
  });
});
