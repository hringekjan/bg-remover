import { unmarshall } from '@aws-sdk/util-dynamodb';

const mockSnsSend = jest.fn().mockResolvedValue({ MessageId: 'msg-123' });

jest.mock('@aws-sdk/client-sns', () => ({
  SNSClient: jest.fn(() => ({ send: mockSnsSend })),
  PublishCommand: jest.fn((input: any) => ({ __type: 'PublishCommand', input })),
}));

// Remove the unmarshall mock so we use the real one imported above
// jest.mock('@aws-sdk/util-dynamodb', () => ({ ... }));

describe('stream-processor', () => {
  let handler: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.JOB_UPDATES_SNS_TOPIC_ARN = 'test-topic-arn';
    const mod = await import('../stream-processor');
    handler = mod.handler;
  });

  it('processes multi-tenant job records', async () => {
    const event = {
      Records: [
        {
          eventName: 'MODIFY',
          dynamodb: {
            Keys: {
              PK: { S: 'TENANT#hringekjan#BG_REMOVER_GROUPING_JOB#job-123' },
              SK: { S: 'METADATA' },
            },
            OldImage: {
              status: { S: 'processing' },
              result: { M: { processedImages: { L: [] } } },
            },
            NewImage: {
              PK: { S: 'TENANT#hringekjan#BG_REMOVER_GROUPING_JOB#job-123' },
              SK: { S: 'METADATA' },
              status: { S: 'completed' },
              jobId: { S: 'job-123' },
              tenant: { S: 'hringekjan' },
              result: { M: { processedImages: { L: [{ M: { imageId: { S: 'img1' }, status: { S: 'completed' } } }] } } },
            },
          },
        },
      ],
    };

    await handler(event);

    expect(mockSnsSend).toHaveBeenCalledTimes(1);
    const publishInput = mockSnsSend.mock.calls[0][0].input;
    const message = JSON.parse(publishInput.Message);
    expect(message.jobId).toBe('job-123');
  });

  it('ignores non-job records', async () => {
    const event = {
      Records: [
        {
          eventName: 'INSERT',
          dynamodb: {
            Keys: {
              PK: { S: 'TENANT#hringekjan#SOME_OTHER_ENTITY#123' },
            },
            NewImage: {
              PK: { S: 'TENANT#hringekjan#SOME_OTHER_ENTITY#123' },
            },
          },
        },
      ],
    };

    await handler(event);

    expect(mockSnsSend).not.toHaveBeenCalled();
  });

  it('processes legacy job records (backward compatibility)', async () => {
    const event = {
      Records: [
        {
          eventName: 'MODIFY',
          dynamodb: {
            Keys: {
              PK: { S: 'TENANT#hringekjan#BG_REMOVER_JOB#legacy-456' },
            },
            OldImage: {
              result: { M: { processedImages: { L: [] } } },
            },
            NewImage: {
              PK: { S: 'TENANT#hringekjan#BG_REMOVER_JOB#legacy-456' },
              jobId: { S: 'legacy-456' },
              result: { M: { processedImages: { L: [{ M: { imageId: { S: 'img1' } } }] } } },
            },
          },
        },
      ],
    };

    await handler(event);

    expect(mockSnsSend).toHaveBeenCalledTimes(1);
    const message = JSON.parse(mockSnsSend.mock.calls[0][0].input.Message);
    expect(message.jobId).toBe('legacy-456');
  });
});
