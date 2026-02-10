const mockSqsSend = jest.fn();

jest.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: jest.fn(() => ({ send: mockSqsSend })),
  SendMessageCommand: jest.fn((input: unknown) => ({ input, __type: 'SendMessageCommand' })),
}));

const buildSnsEvent = (key: string) => ({
  Records: [
    {
      Sns: {
        Message: JSON.stringify({
          Records: [
            {
              eventName: 'ObjectCreated:Put',
              eventTime: '2026-02-04T19:00:00Z',
              s3: {
                bucket: { name: 'bg-remover-temp-images-dev' },
                object: { key },
              },
            },
          ],
        }),
      },
    },
  ],
});

const hashString = (value: string): number => {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
};

describe('upload-events-router', () => {
  beforeEach(() => {
    jest.resetModules();
    mockSqsSend.mockReset();
    process.env.UPLOAD_EVENT_SHARD_COUNT = '4';
    process.env.UPLOAD_EVENT_QUEUE_URLS = 'q1,q2,q3,q4';
  });

  it('routes upload objects to shard queue with correct payload', async () => {
    const { handler } = await import('../upload-events-router');
    const key = 'temp/hringekjan/uploads/upload-123/0.jpg';

    await handler(buildSnsEvent(key));

    expect(mockSqsSend).toHaveBeenCalledTimes(1);
    const call = mockSqsSend.mock.calls[0][0];
    const { QueueUrl, MessageBody } = call.input;
    const expectedIndex = hashString('hringekjan:upload-123') % 4;
    const expectedQueue = ['q1', 'q2', 'q3', 'q4'][expectedIndex];

    expect(QueueUrl).toBe(expectedQueue);
    const payload = JSON.parse(MessageBody);
    expect(payload).toMatchObject({
      bucket: 'bg-remover-temp-images-dev',
      key,
      tenant: 'hringekjan',
      uploadId: 'upload-123',
      type: 'object',
    });
  });

  it('skips non-upload keys', async () => {
    const { handler } = await import('../upload-events-router');
    const key = 'temp/hringekjan/thumbnails/0.jpg';

    await handler(buildSnsEvent(key));

    expect(mockSqsSend).not.toHaveBeenCalled();
  });

  it('marks completion markers as trigger events', async () => {
    const { handler } = await import('../upload-events-router');
    const key = 'temp/hringekjan/uploads/upload-456/complete.json';

    await handler(buildSnsEvent(key));

    const call = mockSqsSend.mock.calls[0][0];
    const payload = JSON.parse(call.input.MessageBody);
    expect(payload.type).toBe('trigger');
  });
});
