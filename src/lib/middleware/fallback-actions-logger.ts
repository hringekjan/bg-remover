/**
 * Fallback Actions Logger Middleware
 * 
 * This middleware logs fallback actions that occur during background removal processing,
 * such as when primary models fail and fallback models are used.
 */

import { getCurrentContextScope } from './context-scope';
import { log } from '../logger';

export interface FallbackAction {
  action: string;
  originalModel: string;
  fallbackModel: string;
  reason: string;
  timestamp: string;
  tenant?: string;
  pricingType?: string;
  jobId?: string;
}

/**
 * Log a fallback action that occurred during processing
 * 
 * @param action The name of the action that triggered the fallback
 * @param originalModel The original model that failed
 * @param fallbackModel The fallback model that was used
 * @param reason Reason for the fallback
 * @param jobId Optional job identifier for correlation
 */
export const logFallbackAction = (
  action: string,
  originalModel: string,
  fallbackModel: string,
  reason: string,
  jobId?: string
): void => {
  try {
    const contextScope = getCurrentContextScope();
    
    const fallbackAction: FallbackAction = {
      action,
      originalModel,
      fallbackModel,
      reason,
      timestamp: new Date().toISOString(),
      tenant: contextScope?.tenant,
      pricingType: contextScope?.pricingType,
      jobId,
    };

    // Log the fallback action as a warning
    log.warn('Fallback action triggered', {
      fallbackAction,
    });
  } catch (error) {
    // Silently fail to avoid breaking the main flow
    console.warn('Failed to log fallback action', error);
  }
};

/**
 * Middleware to track fallback actions in a request lifecycle
 * 
 * @param event The Lambda event object
 * @param context The Lambda context object
 */
export const fallbackActionsLoggerMiddleware = async (event: any, context: any): Promise<void> => {
  // This middleware can be extended to track fallback state throughout a request
  // For now, it just ensures context is available for logging
  try {
    // Extract any relevant context from the event
    const tenant = event.headers?.['x-tenant'] || 
                  event.headers?.['X-Tenant'] || 
                  process.env.TENANT || 
                  'carousel-labs';

    const pricingType = event.headers?.['x-pricing-type'] || 
                       event.headers?.['X-Pricing-Type'] || 
                       'standard';

    // Store in context scope for later use
    const contextScope = getCurrentContextScope();
    if (contextScope) {
      contextScope.tenant = tenant;
      contextScope.pricingType = pricingType;
    } else {
      // If no context scope exists yet, create one
      const { createContextScope } = require('@carousellabs/context-scope');
      createContextScope({
        tenant,
        pricingType,
      });
    }
  } catch (error) {
    console.warn('Failed to initialize fallback actions logger middleware', error);
  }
};