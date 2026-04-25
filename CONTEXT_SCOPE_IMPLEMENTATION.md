# Context Scope Implementation Guide

## Overview

This document describes the implementation and usage of the context scope middleware for the bg-remover service. The context scope provides a way to pass contextual information through the request lifecycle, enabling better routing, relevance, and sensitive information handling.

## Key Features

1. **Tenant Awareness**: Extracts tenant information from headers or authentication context
2. **Pricing Type Integration**: Supports different pricing tiers with context boosting
3. **Memory Routing**: Enables context-aware memory operations with Mem0
4. **Resource Access Control**: Provides basic authorization checking based on context

## Usage Pattern

In your Lambda handlers, use the middleware like this:

```typescript
import { contextScopeMiddleware } from '../middleware/context-scope';

exports.handler = async (event: any) => {
  try {
    // Initialize context scope
    await contextScopeMiddleware(event);
    
    // Your business logic here
    
    // Clean up after processing
    cleanupContextScope();
    
    return httpResponse({ message: 'Success' });
  } catch (error) {
    cleanupContextScope();
    return errorResponse('Internal server error');
  }
};
```

## Context Properties

- **tenant**: Tenant identifier for routing
- **pricingType**: Pricing tier (premium, standard, basic) 
- **contextBoost**: Numerical boost factor for memory search relevance

## Integration Points

1. **S3 Operations**: Uses context for proper bucket routing and access control
2. **Mem0 Memory Writes**: Context-aware memory storage with relevance scoring
3. **API Gateway Integration**: Passes context through request headers