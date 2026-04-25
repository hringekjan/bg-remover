/**
 * BG Remover Context Scope Middleware
 * 
 * This middleware provides context scoping capabilities specific to the background remover service.
 * It integrates with @carousellabs/context-scope to track request processing metrics and context.
 */

import { createContextScope, getCurrentContextScope, cleanupContextScope } from '@carousellabs/context-scope';
import { extractAuthContext } from '../utils/auth';

export interface BgRemoverContextScope {
  service: string;
  operation: string;
  userId?: string;
  sessionId?: string;
  jobId?: string;
  imageFormat?: string;
  imageSize?: number;
  processingTime?: number;
  // Add other bg-remover specific context properties as needed
}

/**
 * Initialize BG Remover context scope for incoming requests
 * 
 * @param event - API Gateway event
 * @param context - Lambda context
 */
export const initializeBgRemoverContext = async (event: any, context: any): Promise<void> => {
  // Initialize basic context scope
  const contextScope: BgRemoverContextScope = {
    service: 'bg-remover',
    operation: 'image-processing'
  };
  
  // Extract user info from auth context if available
  try {
    const authContext = extractAuthContext(event);
    if (authContext && authContext.userId) {
      contextScope.userId = authContext.userId;
    }
    if (authContext && authContext.sessionId) {
      contextScope.sessionId = authContext.sessionId;
    }
  } catch (error) {
    // Continue even if auth extraction fails
    console.warn('Failed to extract auth context:', error);
  }
  
  // Extract job ID from query parameters or headers
  const jobId = event.queryStringParameters?.jobId || 
                event.headers?.['x-job-id'] ||
                event.headers?.['X-Job-ID'];
  if (jobId) {
    contextScope.jobId = jobId;
  }
  
  // Set additional context from request
  if (event.headers?.['content-type']) {
    contextScope.imageFormat = event.headers['content-type'].split('/')[1];
  }
  
  // Create the context scope with extracted values
  createContextScope(contextScope);
};

/**
 * Get the current BG Remover context scope
 * 
 * @returns Current BG Remover context scope object or undefined
 */
export const getBgRemoverContextScope = (): BgRemoverContextScope | undefined => {
  return getCurrentContextScope() as BgRemoverContextScope | undefined;
};

/**
 * Set image processing metadata in the context scope
 * 
 * @param metadata - Image processing metadata
 */
export const setImageProcessingMetadata = (metadata: {
  originalSize?: number;
  format?: string;
  quality?: number;
  processedSize?: number;
}): void => {
  const contextScope = getCurrentContextScope() as BgRemoverContextScope | undefined;
  if (contextScope) {
    // Merge metadata with existing context
    Object.assign(contextScope, metadata);
  }
};

/**
 * Cleanup function to clear BG Remover context scope after request processing
 */
export const cleanupBgRemoverContext = (): void => {
  cleanupContextScope();
};