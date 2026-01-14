// Test setup file
import { jest } from '@jest/globals';

// Mock environment variables
process.env.STAGE = 'test';
process.env.AWS_REGION = 'eu-west-1';
process.env.DYNAMODB_TABLE = 'bg-remover-jobs-test';
process.env.ANALYTICS_BUCKET = 'test-analytics-bucket';

// Mock AWS SDK clients
jest.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: jest.fn().mockImplementation(() => ({
    send: jest.fn(),
  })),
  PutEventsCommand: jest.fn(),
}));

jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn().mockImplementation(() => ({
    send: jest.fn(),
  })),
  GetParameterCommand: jest.fn(),
}));

// Mock crypto (only for non-DynamoDB tests)
jest.mock('crypto', () => ({
  randomUUID: jest.fn(() => 'test-uuid-123'),
}));

// Mock fetch for image-optimizer calls
global.fetch = jest.fn() as jest.MockedFunction<typeof fetch>;

// Clear all mocks before each test
beforeEach(() => {
  jest.clearAllMocks();
});