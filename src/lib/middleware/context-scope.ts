/**
 * Enhanced Context Scope Middleware for BG-Remover Service
 * 
 * This middleware provides enhanced context scoping capabilities for the bg-remover service.
 * It extends the basic context scope functionality to include additional contextual information
 * and provides utilities for managing enhanced context during request processing.
 */

import { createContextScope, getCurrentContextScope, cleanupContextScope } from '@carousellabs/context-scope';
import { extractAuthContext } from '../utils/auth';

export interface EnhancedContextScope {
  pricingType?: string;
  tenant?: string;
  // Add other context scope properties as needed
  contextBoost?: number; // Deterministic context boost for memory search
  requestId?: string;
  userId?: string;
  serviceVersion?: string;
}

/**
 * Enhanced context scope middleware for processing incoming requests
 * 
 * This function initializes the enhanced context scope by extracting context
 * information from the request and storing it in the context scope.
 * It also applies deterministic context boosting for memory search operations.
 */
export const enhancedContextScopeMiddleware = async (event: any, context: any): Promise<void> => {
  // Initialize enhanced context scope
  const contextScope: EnhancedContextScope = {};
  
  // Extract pricing type from headers
  const pricingType = event.headers?.['x-pricing-type'] || 
                     event.headers?.['X-Pricing-Type'] ||
                     event.headers?.['pricing-type'];
  
  // Extract tenant from headers or default
  const tenant = event.headers?.['x-tenant'] || 
                event.headers?.['X-Tenant'] ||
                process.env.TENANT || 
                'carousel-labs';
  
  // Extract request ID from context or event
  const requestId = context?.awsRequestId || 
                   event.headers?.['x-request-id'] || 
                   event.headers?.['X-Request-ID'] ||
                   Math.random().toString(36).substring(2, 15);
  
  // Determine context boost based on pricing type
  let contextBoost = 1.0;
  if (pricingType) {
    switch (pricingType.toLowerCase()) {
      case 'premium':
        contextBoost = 1.5;
        break;
      case 'standard':
        contextBoost = 1.2;
        break;
      case 'basic':
        contextBoost = 1.0;
        break;
      default:
        contextBoost = 1.0;
    }
  }
  
  // Set values in the context scope
  if (pricingType) {
    contextScope.pricingType = pricingType;
  }
  if (tenant) {
    contextScope.tenant = tenant;
  }
  contextScope.contextBoost = contextBoost;
  contextScope.requestId = requestId;
  
  // Extract user info from auth context if available
  try {
    const authContext = extractAuthContext(event);
    if (authContext && authContext.userId) {
      contextScope.userId = authContext.userId;
    }
  } catch (error) {
    // Continue even if auth extraction fails
    console.warn('Failed to extract auth context:', error);
  }
  
  // Set service version from environment
  contextScope.serviceVersion = process.env.SERVICE_VERSION || '1.0.0';
  
  // Create enhanced context scope with extracted values
  createContextScope(contextScope);
};

/**
 * Get the current enhanced context boost value
 * 
 * @returns Current context boost value (default 1.0)
 */
export const getEnhancedContextBoost = (): number => {
  const contextScope = getCurrentContextScope();
  return contextScope?.contextBoost || 1.0;
};

/**
 * Get the current enhanced context scope
 * 
 * @returns Current enhanced context scope object or undefined
 */
export const getEnhancedContextScope = (): EnhancedContextScope | undefined => {
  return getCurrentContextScope() as EnhancedContextScope | undefined;
};

/**
 * Validates if the resource access is authorized for the current enhanced context scope
 * 
 * @param action The action being performed (e.g., 's3-upload', 's3-download')
 * @returns boolean indicating if access is authorized
 */
export const validateEnhancedResourceAccess = (action: string): boolean => {
  const contextScope = getCurrentContextScope();
  
  // If no context scope is set, deny access
  if (!contextScope) {
    return false;
  }
  
  // Allow access for now - in a real implementation, this would validate
  // against actual permissions based on pricing type and user role
  return true;
};

/**
 * Cleanup function to clear enhanced context scope after request processing
 */
export const cleanupEnhancedContextScope = (): void => {
  cleanupContextScope();
};