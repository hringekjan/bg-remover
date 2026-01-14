/**
 * DynamoDB-based Distributed Rate Limiter
 *
 * Implements sliding window rate limiting using DynamoDB with:
 * - Per-tenant rate limits (multi-tenant isolation)
 * - Per-user rate limits
 * - Configurable time windows
 * - Automatic TTL cleanup
 * - GSI for tenant-level admin queries
 *
 * Multi-Tenant DynamoDB Design:
 * - pk: Composite key for rate limit window (TENANT#tenant:ACTION#action:WINDOW#timestamp)
 * - tenant: Stored as separate attribute for GSI queries
 * - action: Stored as separate attribute for filtering
 * - userId: Stored as separate attribute when applicable
 *
 * @module lib/rate-limiter
 */

import {
  DynamoDBClient,
  UpdateItemCommand,
  GetItemCommand,
  QueryCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { log } from './logger';

// ============================================================================
// Types
// ============================================================================

export interface RateLimitConfig {
  /** Maximum requests allowed in the window */
  maxRequests: number;
  /** Time window in seconds */
  windowSeconds: number;
  /** Optional burst limit (higher short-term limit) */
  burstLimit?: number;
  /** Burst window in seconds (default: 1 second) */
  burstWindowSeconds?: number;
}

export interface RateLimitResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** Current request count in the window */
  currentCount: number;
  /** Maximum requests allowed */
  limit: number;
  /** Seconds until the rate limit resets */
  resetInSeconds: number;
  /** Remaining requests in the current window */
  remaining: number;
  /** If rate limited, retry after this many seconds */
  retryAfterSeconds?: number;
}

export interface RateLimitKey {
  /** Tenant identifier */
  tenant: string;
  /** User identifier (optional - for per-user limits) */
  userId?: string;
  /** Action identifier (e.g., 'process', 'status') */
  action: string;
}

// ============================================================================
// Configuration
// ============================================================================

// Default rate limits per action
const DEFAULT_LIMITS: Record<string, RateLimitConfig> = {
  'process': {
    maxRequests: 100,
    windowSeconds: 60, // 100 requests per minute
    burstLimit: 10,
    burstWindowSeconds: 1,
  },
  'status': {
    maxRequests: 300,
    windowSeconds: 60, // 300 requests per minute (read-heavy)
    burstLimit: 20,
    burstWindowSeconds: 1,
  },
  'settings': {
    maxRequests: 30,
    windowSeconds: 60, // 30 requests per minute (admin operations)
  },
  'default': {
    maxRequests: 100,
    windowSeconds: 60,
    burstLimit: 10,
    burstWindowSeconds: 1,
  },
};

// Per-user limits (stricter than tenant limits)
const USER_LIMITS: Record<string, RateLimitConfig> = {
  'process': {
    maxRequests: 20,
    windowSeconds: 60, // 20 requests per minute per user
    burstLimit: 5,
    burstWindowSeconds: 1,
  },
  'default': {
    maxRequests: 50,
    windowSeconds: 60,
  },
};

// ============================================================================
// DynamoDB Client
// ============================================================================

const dynamoClient = new DynamoDBClient({
  region: process.env.AWS_REGION || 'eu-west-1',
});

// Single-table design: use shared table with job store
// PK: TENANT#<tenant>#RATELIMIT (or TENANT#<tenant>#RATELIMIT#USER#<userId>)
// SK: ACTION#<action>#WINDOW#<timestamp>
const TABLE_NAME = process.env.DYNAMODB_TABLE || `carousel-main-${process.env.STAGE || 'dev'}`;

// ============================================================================
// Rate Limiter Implementation
// ============================================================================

/**
 * Generate rate limit keys for DynamoDB single-table design
 *
 * Single-table key format (pk/sk pattern):
 * - pk: TENANT#<tenant>#RATELIMIT (tenant-level) or TENANT#<tenant>#RATELIMIT#USER#<userId> (user-level)
 * - sk: ACTION#<action>#WINDOW#<timestamp>
 *
 * This format enables:
 * - Efficient tenant isolation via partition key prefix
 * - Query all rate limits for a tenant with begins_with on pk
 * - Query specific action/window with sk
 * - GSI on tenant attribute for admin dashboards
 * - Single table shared with job store (cost optimization)
 */
function generateKeys(key: RateLimitKey, windowStart: number): { pk: string; sk: string } {
  const pk = key.userId
    ? `TENANT#${key.tenant}#RATELIMIT#USER#${key.userId}`
    : `TENANT#${key.tenant}#RATELIMIT`;
  const sk = `ACTION#${key.action}#WINDOW#${windowStart}`;
  return { pk, sk };
}

/**
 * Legacy single-key format for backwards compatibility
 * @deprecated Use generateKeys() for new implementations
 */
function generateKey(key: RateLimitKey, windowStart: number): string {
  const { pk, sk } = generateKeys(key, windowStart);
  return `${pk}#${sk}`;
}

/**
 * Get the current window start timestamp
 */
function getWindowStart(windowSeconds: number): number {
  const now = Math.floor(Date.now() / 1000);
  return Math.floor(now / windowSeconds) * windowSeconds;
}

/**
 * Check and update rate limit using DynamoDB atomic counter
 */
export async function checkRateLimit(
  key: RateLimitKey,
  customConfig?: RateLimitConfig
): Promise<RateLimitResult> {
  const config = customConfig || (
    key.userId
      ? USER_LIMITS[key.action] || USER_LIMITS['default']
      : DEFAULT_LIMITS[key.action] || DEFAULT_LIMITS['default']
  );

  const windowStart = getWindowStart(config.windowSeconds);
  const { pk, sk } = generateKeys(key, windowStart);
  const ttl = windowStart + config.windowSeconds + 60; // Add 60s buffer for TTL

  try {
    // Atomic increment using DynamoDB UpdateItem (single-table design with pk/sk)
    // Stores tenant, action, userId as separate attributes for multi-tenant queries/GSI
    const updateExpression = key.userId
      ? 'SET #count = if_not_exists(#count, :zero) + :inc, #ttl = :ttl, #window = :window, #tenant = :tenant, #action = :action, #userId = :userId, #type = :type, #entityType = :entityType'
      : 'SET #count = if_not_exists(#count, :zero) + :inc, #ttl = :ttl, #window = :window, #tenant = :tenant, #action = :action, #type = :type, #entityType = :entityType';

    const expressionAttributeNames: Record<string, string> = {
      '#count': 'requestCount',
      '#ttl': 'ttl',
      '#window': 'windowStart',
      '#tenant': 'tenant',
      '#action': 'action',
      '#type': 'limitType',
      '#entityType': 'entityType',
    };

    const expressionAttributeValues: Record<string, AttributeValue> = {
      ':inc': { N: '1' },
      ':zero': { N: '0' },
      ':ttl': { N: ttl.toString() },
      ':window': { N: windowStart.toString() },
      ':tenant': { S: key.tenant },
      ':action': { S: key.action },
      ':type': { S: key.userId ? 'user' : 'tenant' },
      ':entityType': { S: 'RATELIMIT' },
    };

    if (key.userId) {
      expressionAttributeNames['#userId'] = 'userId';
      expressionAttributeValues[':userId'] = { S: key.userId };
    }

    const result = await dynamoClient.send(new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: { S: pk },
        SK: { S: sk },
      },
      UpdateExpression: updateExpression,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW',
    }));

    const currentCount = parseInt(result.Attributes?.requestCount?.N || '1', 10);
    const remaining = Math.max(0, config.maxRequests - currentCount);
    const resetInSeconds = (windowStart + config.windowSeconds) - Math.floor(Date.now() / 1000);
    const allowed = currentCount <= config.maxRequests;

    // Check burst limit if configured
    let burstAllowed = true;
    if (config.burstLimit && config.burstWindowSeconds) {
      const burstResult = await checkBurstLimit(key, config);
      burstAllowed = burstResult.allowed;
    }

    const finalAllowed = allowed && burstAllowed;

    if (!finalAllowed) {
      log.warn('Rate limit exceeded', {
        tenant: key.tenant,
        userId: key.userId,
        action: key.action,
        currentCount,
        limit: config.maxRequests,
        burstAllowed,
      });
    }

    return {
      allowed: finalAllowed,
      currentCount,
      limit: config.maxRequests,
      resetInSeconds: Math.max(0, resetInSeconds),
      remaining,
      retryAfterSeconds: finalAllowed ? undefined : Math.max(1, resetInSeconds),
    };
  } catch (error) {
    // On DynamoDB errors, fail open (allow request) but log the error
    log.error('Rate limiter DynamoDB error', error, {
      tenant: key.tenant,
      userId: key.userId,
      action: key.action,
    });

    // Fail open - allow request on error to avoid blocking legitimate traffic
    return {
      allowed: true,
      currentCount: 0,
      limit: config.maxRequests,
      resetInSeconds: config.windowSeconds,
      remaining: config.maxRequests,
    };
  }
}

/**
 * Check burst rate limit (short window)
 */
async function checkBurstLimit(
  key: RateLimitKey,
  config: RateLimitConfig
): Promise<{ allowed: boolean; count: number }> {
  if (!config.burstLimit || !config.burstWindowSeconds) {
    return { allowed: true, count: 0 };
  }

  const windowStart = getWindowStart(config.burstWindowSeconds);
  // Burst limits use same pk pattern but with BURST prefix in sk
  const pk = key.userId
    ? `TENANT#${key.tenant}#RATELIMIT#USER#${key.userId}`
    : `TENANT#${key.tenant}#RATELIMIT`;
  const sk = `BURST#ACTION#${key.action}#WINDOW#${windowStart}`;
  const ttl = windowStart + config.burstWindowSeconds + 10;

  try {
    const result = await dynamoClient.send(new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: { S: pk },
        SK: { S: sk },
      },
      UpdateExpression: 'SET #count = if_not_exists(#count, :zero) + :inc, #ttl = :ttl, #tenant = :tenant, #entityType = :entityType',
      ExpressionAttributeNames: {
        '#count': 'requestCount',
        '#ttl': 'ttl',
        '#tenant': 'tenant',
        '#entityType': 'entityType',
      },
      ExpressionAttributeValues: {
        ':inc': { N: '1' },
        ':zero': { N: '0' },
        ':ttl': { N: ttl.toString() },
        ':tenant': { S: key.tenant },
        ':entityType': { S: 'RATELIMIT_BURST' },
      },
      ReturnValues: 'ALL_NEW',
    }));

    const count = parseInt(result.Attributes?.requestCount?.N || '1', 10);
    return {
      allowed: count <= config.burstLimit,
      count,
    };
  } catch (error) {
    // Fail open on error
    log.warn('Burst rate limiter error', { error: String(error) });
    return { allowed: true, count: 0 };
  }
}

/**
 * Get current rate limit status without incrementing
 */
export async function getRateLimitStatus(
  key: RateLimitKey,
  customConfig?: RateLimitConfig
): Promise<RateLimitResult> {
  const config = customConfig || (
    key.userId
      ? USER_LIMITS[key.action] || USER_LIMITS['default']
      : DEFAULT_LIMITS[key.action] || DEFAULT_LIMITS['default']
  );

  const windowStart = getWindowStart(config.windowSeconds);
  const { pk, sk } = generateKeys(key, windowStart);

  try {
    const result = await dynamoClient.send(new GetItemCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: { S: pk },
        SK: { S: sk },
      },
    }));

    const currentCount = parseInt(result.Item?.requestCount?.N || '0', 10);
    const remaining = Math.max(0, config.maxRequests - currentCount);
    const resetInSeconds = (windowStart + config.windowSeconds) - Math.floor(Date.now() / 1000);

    return {
      allowed: currentCount < config.maxRequests,
      currentCount,
      limit: config.maxRequests,
      resetInSeconds: Math.max(0, resetInSeconds),
      remaining,
    };
  } catch (error) {
    log.error('Rate limit status error', error);
    return {
      allowed: true,
      currentCount: 0,
      limit: config.maxRequests,
      resetInSeconds: config.windowSeconds,
      remaining: config.maxRequests,
    };
  }
}

/**
 * Middleware to apply rate limiting to a handler
 */
export function withRateLimit<T extends (event: any) => Promise<any>>(
  handler: T,
  action: string
): T {
  return (async (event: any) => {
    // Extract tenant and user from event
    const tenant = event.headers?.['x-tenant-id'] ||
      event.requestContext?.authorizer?.tenant ||
      'default';
    const userId = event.requestContext?.authorizer?.principalId;

    // Check tenant-level rate limit
    const tenantResult = await checkRateLimit({ tenant, action });
    if (!tenantResult.allowed) {
      return {
        statusCode: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(tenantResult.retryAfterSeconds || 60),
          'X-RateLimit-Limit': String(tenantResult.limit),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(tenantResult.resetInSeconds),
        },
        body: JSON.stringify({
          error: 'RATE_LIMITED',
          message: 'Too many requests. Please try again later.',
          retryAfter: tenantResult.retryAfterSeconds,
        }),
      };
    }

    // Check user-level rate limit if authenticated
    if (userId) {
      const userResult = await checkRateLimit({ tenant, userId, action });
      if (!userResult.allowed) {
        return {
          statusCode: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': String(userResult.retryAfterSeconds || 60),
            'X-RateLimit-Limit': String(userResult.limit),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': String(userResult.resetInSeconds),
          },
          body: JSON.stringify({
            error: 'RATE_LIMITED',
            message: 'User rate limit exceeded. Please try again later.',
            retryAfter: userResult.retryAfterSeconds,
          }),
        };
      }
    }

    // Add rate limit headers to response
    const response = await handler(event);

    // Add rate limit headers to successful responses
    if (response && typeof response === 'object') {
      response.headers = {
        ...response.headers,
        'X-RateLimit-Limit': String(tenantResult.limit),
        'X-RateLimit-Remaining': String(tenantResult.remaining),
        'X-RateLimit-Reset': String(tenantResult.resetInSeconds),
      };
    }

    return response;
  }) as T;
}

// ============================================================================
// Admin Functions (Multi-Tenant)
// ============================================================================

/**
 * Query rate limit usage for a specific tenant
 * Uses pk prefix pattern for efficient queries (no GSI needed - cost optimization)
 *
 * @param tenant - Tenant identifier
 * @param options - Query options (limit, action filter)
 * @returns Array of rate limit records for the tenant
 */
export async function getTenantRateLimits(
  tenant: string,
  options?: { limit?: number; action?: string }
): Promise<Array<{
  tenant: string;
  action: string;
  userId?: string;
  requestCount: number;
  windowStart: number;
  limitType: 'tenant' | 'user';
}>> {
  try {
    // Query using pk prefix - no GSI needed (saves ~50% on writes + storage)
    const pk = `TENANT#${tenant}#RATELIMIT`;
    const queryParams: any = {
      TableName: TABLE_NAME,
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: {
        '#pk': 'PK',
      },
      ExpressionAttributeValues: {
        ':pk': { S: pk },
      },
      Limit: options?.limit || 100,
    };

    // Add action filter if specified
    if (options?.action) {
      queryParams.FilterExpression = '#action = :action';
      queryParams.ExpressionAttributeNames['#action'] = 'action';
      queryParams.ExpressionAttributeValues[':action'] = { S: options.action };
    }

    const result = await dynamoClient.send(new QueryCommand(queryParams));

    return (result.Items || []).map(item => ({
      tenant: item.tenant?.S || tenant,
      action: item.action?.S || 'unknown',
      userId: item.userId?.S,
      requestCount: parseInt(item.requestCount?.N || '0', 10),
      windowStart: parseInt(item.windowStart?.N || '0', 10),
      limitType: (item.limitType?.S || 'tenant') as 'tenant' | 'user',
    }));
  } catch (error) {
    log.error('Failed to query tenant rate limits', error, { tenant });
    return [];
  }
}

/**
 * Get aggregated rate limit statistics for a tenant
 *
 * @param tenant - Tenant identifier
 * @returns Aggregated statistics
 */
export async function getTenantRateLimitStats(tenant: string): Promise<{
  tenant: string;
  totalRequests: number;
  actionBreakdown: Record<string, number>;
  userCount: number;
}> {
  const limits = await getTenantRateLimits(tenant, { limit: 1000 });

  const actionBreakdown: Record<string, number> = {};
  const users = new Set<string>();
  let totalRequests = 0;

  for (const limit of limits) {
    totalRequests += limit.requestCount;
    actionBreakdown[limit.action] = (actionBreakdown[limit.action] || 0) + limit.requestCount;
    if (limit.userId) {
      users.add(limit.userId);
    }
  }

  return {
    tenant,
    totalRequests,
    actionBreakdown,
    userCount: users.size,
  };
}

// ============================================================================
// Exports
// ============================================================================

export { DEFAULT_LIMITS, USER_LIMITS };
