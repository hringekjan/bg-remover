import { ContextScope } from '@carousellabs/context-scope';
import { initializeContext, extendContext, getContext, resetContext } from '../lib/context/context-manager';

describe('Context Manager', () => {
  beforeEach(() => {
    // Reset context before each test
    const contextScope = ContextScope.getInstance();
    Object.keys(contextScope.getDimensions()).forEach(key => {
      contextScope.setDimension(key, undefined);
    });
  });

  it('should initialize context without overwriting protected fields', () => {
    // Set initial protected field
    initializeContext({ requestId: 'initial-id', service: 'test-service' });
    
    // Try to overwrite protected field
    initializeContext({ requestId: 'new-id', handler: 'test-handler' });
    
    const context = getContext();
    expect(context.requestId).toBe('initial-id'); // Should remain unchanged
    expect(context.service).toBe('test-service');
    expect(context.handler).toBe('test-handler'); // Should be added
  });

  it('should extend context safely', () => {
    initializeContext({ requestId: 'test-id', service: 'test-service' });
    
    extendContext({ handler: 'test-handler', stage: 'dev' });
    
    const context = getContext();
    expect(context.requestId).toBe('test-id');
    expect(context.service).toBe('test-service');
    expect(context.handler).toBe('test-handler');
    expect(context.stage).toBe('dev');
  });

  it('should prevent overwriting protected fields when extending', () => {
    initializeContext({ requestId: 'initial-id', service: 'test-service' });
    
    // Try to overwrite protected field
    extendContext({ requestId: 'new-id', handler: 'test-handler' });
    
    const context = getContext();
    expect(context.requestId).toBe('initial-id'); // Should remain unchanged
    expect(context.handler).toBe('test-handler'); // Should be added
  });

  it('should reset context to initial state', () => {
    initializeContext({ requestId: 'initial-id', service: 'test-service' });
    extendContext({ handler: 'test-handler', stage: 'dev' });
    
    let context = getContext();
    expect(Object.keys(context)).toHaveLength(4);
    
    resetContext();
    
    context = getContext();
    expect(context.requestId).toBe('initial-id');
    expect(context.service).toBe('test-service');
    expect(context.handler).toBeUndefined(); // Should be removed
    expect(context.stage).toBeUndefined(); // Should be removed
  });
});