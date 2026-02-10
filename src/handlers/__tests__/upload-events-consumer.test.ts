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

const resetState = () => {
  store.clear();
  mockDynamoSend.mockReset();
  mockSqsSend.mockReset();
  mockRecordEvent.mockReset().mockResolvedValue(undefined);
};

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
      const newKeys = ExpressionAttributeValues[':newKeys'] || [];
      const updated = { ...existing };

      if (command.input.UpdateExpression.includes('list_append')) {
        updated.status = ExpressionAttributeValues[':status'] || updated.status;
        updated.updatedAt = ExpressionAttributeValues[':now'] || updated.updatedAt;
        updated.imageKeys = [...(updated.imageKeys || []), ...newKeys];
      } else {
        const names = command.input.ExpressionAttributeNames || {};
        const values = ExpressionAttributeValues || {};
        updated.status = values[':status'] || updated.status;
        updated.updatedAt = values[':now'] || updated.updatedAt;

        const updateExpression = command.input.UpdateExpression || '';
        if (updateExpression.startsWith('SET ')) {
          const assignments = updateExpression.replace(/^SET\s+/, '').split(',');
          for (const assignment of assignments) {
            const [rawAttr, rawValue] = assignment.split('=').map((part: string) => part.trim());
            if (!rawAttr || !rawValue) {
              continue;
            }
            const attrName = names[rawAttr] || rawAttr;
            if (rawValue.startsWith('if_not_exists(')) {
              const match = /if_not_exists\([^,]+,\s*(:[A-Za-z0-9_]+)\)/.exec(rawValue);
              if (!match) {
                continue;
              }
              const valueKey = match[1];
              if (updated[attrName] === undefined && valueKey in values) {
                updated[attrName] = values[valueKey];
              }
              continue;
            }
            if (rawValue in values) {
              updated[attrName] = values[rawValue];
            }
          }
        } else {
          for (const [nameKey, fieldName] of Object.entries(names)) {
            if (nameKey.startsWith('#f')) {
              const index = nameKey.slice(2);
              const valueKey = `:v${index}`;
              if (valueKey in values) {
                updated[fieldName] = values[valueKey];
              }
            }
          }
        }
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

describe('upload-events-consumer', () => {
  beforeEach(() => {
    jest.resetModules();
    resetState();
    initDynamoMock();
    process.env.DYNAMODB_TABLE = 'test-table';
    process.env.STAGE = 'dev';
    process.env.UPLOAD_EVENT_GROUPING_ENABLED = 'true';
    process.env.UPLOAD_EVENT_SHARD_COUNT = '4';
    process.env.UPLOAD_EVENT_QUEUE_URLS = 'q1,q2,q3,q4';
    process.env.GROUP_IMAGES_QUEUE_URL = 'group-queue';
    process.env.UPLOAD_EVENT_ALLOW_TIMER = 'false';
  });

  it('aggregates objects and triggers grouping once', async () => {
    const { handler } = await import('../upload-events-consumer');
    const messages = [
      {
        type: 'object',
        bucket: 'bg-remover-temp-images-dev',
        key: 'temp/hringekjan/uploads/upload-abc/0.jpg',
        tenant: 'hringekjan',
        uploadId: 'upload-abc',
        eventTime: '2026-02-04T19:00:00Z',
      },
      {
        type: 'object',
        bucket: 'bg-remover-temp-images-dev',
        key: 'temp/hringekjan/uploads/upload-abc/1.jpg',
        tenant: 'hringekjan',
        uploadId: 'upload-abc',
        eventTime: '2026-02-04T19:00:01Z',
      },
      {
        type: 'trigger',
        bucket: 'bg-remover-temp-images-dev',
        key: 'temp/hringekjan/uploads/upload-abc/complete.json',
        tenant: 'hringekjan',
        uploadId: 'upload-abc',
      },
    ];

    await handler(buildEvent(messages));

    const aggregateKey = keyFor('TENANT#hringekjan#BG_REMOVER_UPLOAD#upload-abc', 'METADATA');
    const aggregate = store.get(aggregateKey);
    aggregate.completionMarkerAt = '2026-02-04T19:00:05Z';
    store.set(aggregateKey, aggregate);

    await handler(buildEvent([
      {
        type: 'trigger',
        bucket: 'bg-remover-temp-images-dev',
        key: 'temp/hringekjan/uploads/upload-abc/complete.json',
        tenant: 'hringekjan',
        uploadId: 'upload-abc',
      },
    ]));

    expect(aggregate?.imageKeys?.length).toBe(2);

    const workerCall = mockSqsSend.mock.calls.find((call) => {
      const payload = JSON.parse(call[0].input.MessageBody);
      return payload.jobId === 'upload-abc' && Array.isArray(payload.images);
    });
    expect(workerCall).toBeTruthy();
    const workerPayload = JSON.parse(workerCall![0].input.MessageBody);
    expect(workerPayload.images).toHaveLength(2);
  });

  it('marks aggregate disabled when grouping is off', async () => {
    process.env.UPLOAD_EVENT_GROUPING_ENABLED = 'false';
    const { handler } = await import('../upload-events-consumer');
    const messages = [
      {
        type: 'object',
        bucket: 'bg-remover-temp-images-dev',
        key: 'temp/hringekjan/uploads/upload-disabled/0.jpg',
        tenant: 'hringekjan',
        uploadId: 'upload-disabled',
      },
      {
        type: 'trigger',
        bucket: 'bg-remover-temp-images-dev',
        key: 'temp/hringekjan/uploads/upload-disabled/complete.json',
        tenant: 'hringekjan',
        uploadId: 'upload-disabled',
      },
    ];

    await handler(buildEvent(messages));

    const aggregateKey = keyFor('TENANT#hringekjan#BG_REMOVER_UPLOAD#upload-disabled', 'METADATA');
    const aggregate = store.get(aggregateKey);
    expect(aggregate?.status).toBe('disabled');

    const jobKey = keyFor('TENANT#hringekjan#BG_REMOVER_GROUPING_JOB#upload-disabled', 'METADATA');
    const job = store.get(jobKey);
    expect(job?.status).toBe('disabled');
    expect(job?.reason).toBe('grouping-disabled');

    expect(mockSqsSend).not.toHaveBeenCalled();
  });

  it('skips duplicate grouping jobs without failing', async () => {
    const { handler } = await import('../upload-events-consumer');
    const jobKey = keyFor('TENANT#hringekjan#BG_REMOVER_GROUPING_JOB#upload-dupe', 'METADATA');
    store.set(jobKey, { PK: 'TENANT#hringekjan#BG_REMOVER_GROUPING_JOB#upload-dupe', SK: 'METADATA' });
    const aggregateKey = keyFor('TENANT#hringekjan#BG_REMOVER_UPLOAD#upload-dupe', 'METADATA');
    store.set(aggregateKey, {
      PK: 'TENANT#hringekjan#BG_REMOVER_UPLOAD#upload-dupe',
      SK: 'METADATA',
      imageKeys: [],
      completionMarkerAt: '2026-02-04T19:00:05Z',
    });

    const messages = [
      {
        type: 'object',
        bucket: 'bg-remover-temp-images-dev',
        key: 'temp/hringekjan/uploads/upload-dupe/0.jpg',
        tenant: 'hringekjan',
        uploadId: 'upload-dupe',
      },
      {
        type: 'trigger',
        bucket: 'bg-remover-temp-images-dev',
        key: 'temp/hringekjan/uploads/upload-dupe/complete.json',
        tenant: 'hringekjan',
        uploadId: 'upload-dupe',
      },
    ];

    await handler(buildEvent(messages));

    const workerCall = mockSqsSend.mock.calls.find((call) => {
      const payload = JSON.parse(call[0].input.MessageBody);
      return payload.jobId === 'upload-dupe' && Array.isArray(payload.images);
    });
    expect(workerCall).toBeFalsy();
  });
});
