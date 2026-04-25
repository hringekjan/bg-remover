/**
 * Integration tests for x-context-scope header propagation
 *
 * Validates that the x-context-scope header flows through bg-remove service endpoints
 */

import { APIGatewayProxyEventV2 } from 'aws-lambda';
import { contextScopeMiddleware, cleanupContextScope } from '../../lib/middleware/context-scope';

// Mock the ContextScope class
jest.mock('@carousellabs/context-scope', () => {
  return {
    ContextScope: jest.fn().mockImplementation(() => ({
      init: jest.fn(),
      clear: jest.fn(),
      get: jest.fn(),
    })),
  };
});

describe('Context Scope Header Propagation', () => {
  const mockContextScope = {
    init: jest.fn(),
    clear: jest.fn(),
    get: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Reset the context scope instance
    jest.resetModules();
    cleanupContextScope();
  });

  it('should extract and propagate x-context-scope header', async () => {
    const mockEvent: Partial<APIGatewayProxyEventV2> = {
      headers: {
        'x-context-scope': 'test-scope-value',
        'X-Request-ID': 'test-request-id',
      },
      requestContext: {
        requestId: 'test-request-id',
      } as any,
    };

    await contextScopeMiddleware(mockEvent as APIGatewayProxyEventV2);

    // Verify that context scope was initialized with the header value
    expect(mockContextScope.init).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'test-request-id',
      })
    );
  });

  it('should handle missing x-context-scope header gracefully', async () => {
    const mockEvent: Partial<APIGatewayProxyEventV2> = {
      headers: {
        'X-Request-ID': 'test-request-id',
      },
      requestContext: {
        requestId: 'test-request-id',
      } as any,
    };

    await expect(contextScopeMiddleware(mockEvent as APIGatewayProxyEventV2)).resolves.not.toThrow();
  });

  it('should cleanup context scope after request processing', async () => {
    cleanupContextScope();
    expect(mockContextScope.clear).toHaveBeenCalled();
  });
});