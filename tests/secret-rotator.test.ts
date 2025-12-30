import { SecretRotator, KeyRotationEvent } from '../src/lib/security/secret-rotator';

// Mock crypto module
const mockRandomBytes = jest.fn();
jest.mock('crypto', () => ({
  ...jest.requireActual('crypto'),
  randomBytes: (size: number) => mockRandomBytes(size),
}));

// Mock AWS SDK clients
const mockSSMSend = jest.fn();
const mockEventBridgeSend = jest.fn();

jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({
    send: mockSSMSend,
  })),
  GetParameterCommand: jest.fn((input: unknown) => ({ input })),
  PutParameterCommand: jest.fn((input: unknown) => ({ input })),
}));

jest.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: jest.fn(() => ({
    send: mockEventBridgeSend,
  })),
  PutEventsCommand: jest.fn((input: unknown) => ({ input })),
}));

describe('SecretRotator', () => {
  let rotator: SecretRotator;
  const config = {
    stage: 'test',
    tenant: 'test-tenant',
    region: 'eu-west-1',
    gracePeriodHours: 24,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    rotator = new SecretRotator(config);

    // Mock randomBytes to return predictable data
    mockRandomBytes.mockReturnValue(Buffer.from('abcdefghijklmnopqrstuvwxzy123456')); // 32 bytes
  });

  describe('generateSecureAPIKey', () => {
    it('should generate a secure API key using crypto.randomBytes', () => {
      const apiKey = rotator.generateSecureAPIKey();

      expect(mockRandomBytes).toHaveBeenCalledWith(32);
      expect(apiKey).toBe('YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4enkxMjM0NTY'); // base64 of mock data
      expect(apiKey).not.toContain('+'); // URL-safe
      expect(apiKey).not.toContain('/'); // URL-safe
      expect(apiKey).not.toContain('='); // No padding
    });

    it('should generate different keys on multiple calls', () => {
      mockRandomBytes.mockReturnValueOnce(Buffer.from('11111111111111111111111111111111'));
      const key1 = rotator.generateSecureAPIKey();

      mockRandomBytes.mockReturnValueOnce(Buffer.from('22222222222222222222222222222222'));
      const key2 = rotator.generateSecureAPIKey();

      expect(key1).not.toBe(key2);
    });

    it('should handle crypto errors gracefully', () => {
      mockRandomBytes.mockImplementation(() => {
        throw new Error('Crypto error');
      });

      expect(() => rotator.generateSecureAPIKey()).toThrow('Failed to generate secure API key');
    });
  });

  describe('updateSSMParameter', () => {
    it('should update SSM parameter with new key and old key', async () => {
      mockSSMSend.mockResolvedValue({});

      await rotator.updateSSMParameter('new-key-123', 'old-key-456');

      expect(mockSSMSend).toHaveBeenCalledWith(
        expect.objectContaining({
          input: {
            Name: '/tf/test/test-tenant/api-keys/carousel',
            Value: expect.stringContaining('new-key-123'),
            Type: 'SecureString',
            Overwrite: true,
            Description: 'API keys for Carousel service - test-tenant (test)',
          },
        })
      );
    });

    it('should update SSM parameter with only new key when no old key', async () => {
      mockSSMSend.mockResolvedValue({});

      await rotator.updateSSMParameter('new-key-123');

      expect(mockSSMSend).toHaveBeenCalledWith(
        expect.objectContaining({
          input: {
            Name: '/tf/test/test-tenant/api-keys/carousel',
            Value: expect.stringContaining('new-key-123'),
            Type: 'SecureString',
            Overwrite: true,
            Description: 'API keys for Carousel service - test-tenant (test)',
          },
        })
      );
    });

    it('should handle SSM errors gracefully', async () => {
      mockSSMSend.mockRejectedValue(new Error('SSM error'));

      await expect(rotator.updateSSMParameter('new-key')).rejects.toThrow('Failed to update SSM parameter: SSM error');
    });
  });

  describe('scheduleKeyExpiry', () => {
    it('should return expiry time 24 hours from now', () => {
      const beforeTime = new Date();
      const expiryTime = rotator.scheduleKeyExpiry();
      const afterTime = new Date();

      const expiryDate = new Date(expiryTime);
      const expectedExpiry = new Date(beforeTime);
      expectedExpiry.setHours(expectedExpiry.getHours() + 24);

      expect(expiryDate.getTime()).toBeGreaterThanOrEqual(beforeTime.getTime());
      expect(expiryDate.getTime()).toBeLessThanOrEqual(afterTime.getTime() + 24 * 60 * 60 * 1000);
    });

    it('should respect custom grace period', () => {
      const customRotator = new SecretRotator({
        ...config,
        gracePeriodHours: 48,
      });

      const beforeTime = new Date();
      const expiryTime = customRotator.scheduleKeyExpiry();
      const expiryDate = new Date(expiryTime);

      expect(expiryDate.getTime() - beforeTime.getTime()).toBeGreaterThanOrEqual(47 * 60 * 60 * 1000);
      expect(expiryDate.getTime() - beforeTime.getTime()).toBeLessThanOrEqual(49 * 60 * 60 * 1000);
    });
  });

  describe('broadcastKeyRotation', () => {
    it('should send EventBridge event with rotation details', async () => {
      mockEventBridgeSend.mockResolvedValue({});

      const rotationEvent: KeyRotationEvent = {
        tenant: 'test-tenant',
        stage: 'test',
        oldKey: 'old-key',
        newKey: 'new-key',
        expiryTime: '2024-01-01T12:00:00Z',
        gracePeriodHours: 24,
        timestamp: '2024-01-01T00:00:00Z',
      };

      await rotator.broadcastKeyRotation(rotationEvent);

      expect(mockEventBridgeSend).toHaveBeenCalledWith(
        expect.objectContaining({
          input: {
            Entries: [
              {
                Source: 'carousel.bg-remover.secret-rotator',
                DetailType: 'CarouselApiKeyRotated',
                Detail: expect.stringContaining('ApiKeyRotated'),
              },
            ],
          },
        })
      );
    });

    it('should handle EventBridge errors gracefully', async () => {
      mockEventBridgeSend.mockRejectedValue(new Error('EventBridge error'));

      const rotationEvent: KeyRotationEvent = {
        tenant: 'test-tenant',
        stage: 'test',
        newKey: 'new-key',
        expiryTime: '2024-01-01T12:00:00Z',
        gracePeriodHours: 24,
        timestamp: '2024-01-01T00:00:00Z',
      };

      await expect(rotator.broadcastKeyRotation(rotationEvent)).rejects.toThrow('Failed to broadcast key rotation: EventBridge error');
    });
  });

  describe('rotateAPIKey', () => {
    beforeEach(() => {
      // Mock successful SSM operations
      mockSSMSend.mockResolvedValue({});
      mockEventBridgeSend.mockResolvedValue({});
    });

    it('should perform complete key rotation workflow', async () => {
      // Mock existing key retrieval
      mockSSMSend.mockImplementationOnce(() =>
        Promise.resolve({
          Parameter: {
            Value: JSON.stringify({ current: 'existing-key' }),
          },
        })
      );

      const result = await rotator.rotateAPIKey();

      expect(result).toEqual({
        tenant: 'test-tenant',
        stage: 'test',
        oldKey: 'existing-key',
        newKey: 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4enkxMjM0NTY',
        expiryTime: expect.any(String),
        gracePeriodHours: 24,
        timestamp: expect.any(String),
      });

      // Verify SSM was called for getting existing key
      expect(mockSSMSend).toHaveBeenCalledWith(
        expect.objectContaining({
          input: {
            Name: '/tf/test/test-tenant/api-keys/carousel',
            WithDecryption: true,
          },
        })
      );

      // Verify SSM was called for updating with new key (use nested objectContaining for partial match)
      expect(mockSSMSend).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            Name: '/tf/test/test-tenant/api-keys/carousel',
            Value: expect.stringContaining('YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4enkxMjM0NTY'),
            Type: 'SecureString',
          }),
        })
      );

      // Verify EventBridge was called
      expect(mockEventBridgeSend).toHaveBeenCalledWith(
        expect.objectContaining({
          input: {
            Entries: [
              {
                Source: 'carousel.bg-remover.secret-rotator',
                DetailType: 'CarouselApiKeyRotated',
                Detail: expect.stringContaining('ApiKeyRotated'),
              },
            ],
          },
        })
      );
    });

    it('should handle first rotation when no existing key', async () => {
      mockSSMSend.mockImplementation((command) => {
        if (command.constructor.name === 'GetParameterCommand') {
          const error = new Error('Parameter not found');
          error.name = 'ParameterNotFound';
          throw error;
        }
        return Promise.resolve({});
      });

      const result = await rotator.rotateAPIKey();

      expect(result.oldKey).toBeUndefined();
      expect(result.newKey).toBeDefined();
    });

    it('should handle rotation failures gracefully', async () => {
      mockSSMSend.mockRejectedValue(new Error('SSM failure'));

      await expect(rotator.rotateAPIKey()).rejects.toThrow('API key rotation failed: Failed to update SSM parameter: SSM failure');
    });
  });

  describe('getCurrentAPIKey', () => {
    it('should retrieve current API key from SSM', async () => {
      mockSSMSend.mockResolvedValue({
        Parameter: {
          Value: JSON.stringify({ current: 'current-key-123' }),
        },
      });

      const key = await rotator.getCurrentAPIKey();

      expect(key).toBe('current-key-123');
      expect(mockSSMSend).toHaveBeenCalledWith(
        expect.objectContaining({
          input: {
            Name: '/tf/test/test-tenant/api-keys/carousel',
            WithDecryption: true,
          },
        })
      );
    });

    it('should return null when parameter does not exist', async () => {
      const error = new Error('Parameter not found');
      error.name = 'ParameterNotFound';
      mockSSMSend.mockRejectedValue(error);

      const key = await rotator.getCurrentAPIKey();

      expect(key).toBeNull();
    });

    it('should handle SSM errors', async () => {
      mockSSMSend.mockRejectedValue(new Error('SSM error'));

      await expect(rotator.getCurrentAPIKey()).rejects.toThrow('Failed to retrieve API key: SSM error');
    });
  });
});