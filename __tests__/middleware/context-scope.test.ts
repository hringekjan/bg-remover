import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { contextScopeMiddleware, cleanupContextScope, getCurrentContextScope } from './context-scope';
import { createContextScope } from '@carousellabs/context-scope';

// Mock the extractAuthContext function
vi.mock('../utils/auth', () => ({
  extractAuthContext: vi.fn()
}));

describe('Context Scope Middleware', () => {
  beforeEach(() => {
    // Clear any existing context scope
    cleanupContextScope();
  });

  afterEach(() => {
    // Clean up after each test
    cleanupContextScope();
  });

  it('should initialize context scope with tenant from headers', async () => {
    const mockEvent = {
      headers: {
        'x-tenant': 'test-tenant'
      }
    };

    await contextScopeMiddleware(mockEvent);

    const contextScope = getCurrentContextScope();
    expect(contextScope).toBeDefined();
    expect(contextScope?.tenant).toBe('test-tenant');
  });

  it('should initialize context scope with tenant from environment', async () => {
    const originalEnv = process.env.TENANT;
    process.env.TENANT = 'env-tenant';

    const mockEvent = {
      headers: {}
    };

    await contextScopeMiddleware(mockEvent);

    const contextScope = getCurrentContextScope();
    expect(contextScope).toBeDefined();
    expect(contextScope?.tenant).toBe('env-tenant');

    // Restore original environment
    process.env.TENANT = originalEnv;
  });

  it('should use default tenant when none provided', async () => {
    const mockEvent = {
      headers: {}
    };

    await contextScopeMiddleware(mockEvent);

    const contextScope = getCurrentContextScope();
    expect(contextScope).toBeDefined();
    expect(contextScope?.tenant).toBe('carousel-labs');
  });

  it('should set context boost based on pricing type', async () => {
    const mockEvent = {
      headers: {
        'x-pricing-type': 'premium'
      }
    };

    await contextScopeMiddleware(mockEvent);

    const contextScope = getCurrentContextScope();
    expect(contextScope).toBeDefined();
    expect(contextScope?.contextBoost).toBe(1.5);
  });

  it('should set default context boost when no pricing type', async () => {
    const mockEvent = {
      headers: {}
    };

    await contextScopeMiddleware(mockEvent);

    const contextScope = getCurrentContextScope();
    expect(contextScope).toBeDefined();
    expect(contextScope?.contextBoost).toBe(1.0);
  });

  it('should handle mixed case pricing type', async () => {
    const mockEvent = {
      headers: {
        'x-pricing-type': 'PREMIUM'
      }
    };

    await contextScopeMiddleware(mockEvent);

    const contextScope = getCurrentContextScope();
    expect(contextScope).toBeDefined();
    expect(contextScope?.contextBoost).toBe(1.5);
  });
});