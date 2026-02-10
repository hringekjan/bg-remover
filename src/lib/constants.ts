/**
 * CORS headers for API responses
 */
export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
};

/**
 * Default page size for pagination
 */
export const DEFAULT_PAGE_SIZE = 50;

/**
 * Maximum page size for pagination
 */
export const MAX_PAGE_SIZE = 1000;
