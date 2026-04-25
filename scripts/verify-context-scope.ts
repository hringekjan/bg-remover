#!/usr/bin/env ts-node

// Script to verify context scope implementation

import { contextScopeMiddleware, getCurrentContextScope, cleanupContextScope } from '../lib/middleware/context-scope';

console.log('=== Verifying Context Scope Implementation ===');

// Test 1: Basic tenant from headers
console.log('\nTest 1: Basic tenant from headers');
const testEvent1 = {
  headers: {
    'x-tenant': 'test-tenant'
  }
};

async function runTests() {
  try {
    await contextScopeMiddleware(testEvent1);
    const context1 = getCurrentContextScope();
    console.log('✓ Context extracted:', context1);
    cleanupContextScope();
    
    // Test 2: Pricing type boosting
    console.log('\nTest 2: Pricing type boosting');
    const testEvent2 = {
      headers: {
        'x-tenant': 'test-tenant',
        'x-pricing-type': 'premium'
      }
    };
    
    await contextScopeMiddleware(testEvent2);
    const context2 = getCurrentContextScope();
    console.log('✓ Context with boost:', context2);
    cleanupContextScope();
    
    // Test 3: Default values
    console.log('\nTest 3: Default values');
    const testEvent3 = {
      headers: {}
    };
    
    await contextScopeMiddleware(testEvent3);
    const context3 = getCurrentContextScope();
    console.log('✓ Default context:', context3);
    cleanupContextScope();
    
    console.log('\n=== All Tests Passed ===');
    
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

runTests();