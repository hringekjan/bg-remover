/**
 * Backend tracing utilities for bg-remover Lambda service
 * @module lib/trace
 *
 * Provides structured logging for Lambda handlers with:
 * - Request correlation via trace IDs
 * - Performance timing
 * - Service call tracking
 * - Error context
 */

import { randomUUID } from 'crypto';

/**
 * Trace context for Lambda execution
 */
export interface LambdaTraceContext {
  traceId: string;
  jobId?: string;
  tenantId: string;
  userId: string;
  requestId: string; // AWS Lambda request ID
  functionName: string;
  startTime: number;
}

/**
 * Structured log entry for CloudWatch
 */
export interface LambdaLogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  traceId: string;
  jobId?: string;
  tenantId: string;
  userId: string;
  requestId: string;
  functionName: string;
  action: string;
  duration?: number;
  result: 'success' | 'error' | 'partial';
  metadata?: Record<string, unknown>;
  error?: {
    message: string;
    code?: string;
    stack?: string;
  };
}

/**
 * Create Lambda trace context from event
 *
 * @example
 * const context = createLambdaTraceContext(event, lambdaContext, {
 *   tenantId: 'carousel-labs',
 *   userId: 'user_123',
 * });
 */
export function createLambdaTraceContext(
  event: any,
  lambdaContext: any,
  params: {
    tenantId: string;
    userId: string;
    jobId?: string;
  }
): LambdaTraceContext {
  // Extract trace ID from headers (propagated from frontend)
  const headers = event.headers || {};
  const existingTraceId = headers['x-trace-id'] || headers['x-request-id'];

  return {
    traceId: existingTraceId || `req_${randomUUID()}`,
    jobId: params.jobId,
    tenantId: params.tenantId,
    userId: params.userId,
    requestId: lambdaContext.requestId || randomUUID(),
    functionName: lambdaContext.functionName || 'unknown',
    startTime: Date.now(),
  };
}

/**
 * Log Lambda invocation start
 */
export function logLambdaStart(
  context: LambdaTraceContext,
  action: string,
  metadata?: Record<string, unknown>
): void {
  const entry: LambdaLogEntry = {
    timestamp: new Date().toISOString(),
    level: 'info',
    traceId: context.traceId,
    jobId: context.jobId,
    tenantId: context.tenantId,
    userId: context.userId,
    requestId: context.requestId,
    functionName: context.functionName,
    action,
    result: 'success',
    metadata: {
      ...metadata,
      phase: 'start',
    },
  };

  console.log(JSON.stringify(entry));
}

/**
 * Log Lambda execution success
 */
export function logLambdaSuccess(
  context: LambdaTraceContext,
  action: string,
  metadata?: Record<string, unknown>
): void {
  const duration = Date.now() - context.startTime;

  const entry: LambdaLogEntry = {
    timestamp: new Date().toISOString(),
    level: 'info',
    traceId: context.traceId,
    jobId: context.jobId,
    tenantId: context.tenantId,
    userId: context.userId,
    requestId: context.requestId,
    functionName: context.functionName,
    action,
    duration,
    result: 'success',
    metadata: {
      ...metadata,
      phase: 'complete',
    },
  };

  console.log(JSON.stringify(entry));
}

/**
 * Log Lambda execution error
 */
export function logLambdaError(
  context: LambdaTraceContext,
  action: string,
  error: Error | unknown,
  metadata?: Record<string, unknown>
): void {
  const duration = Date.now() - context.startTime;

  const errorDetails =
    error instanceof Error
      ? {
          message: error.message,
          code: (error as any).code,
          stack: error.stack,
        }
      : {
          message: String(error),
        };

  const entry: LambdaLogEntry = {
    timestamp: new Date().toISOString(),
    level: 'error',
    traceId: context.traceId,
    jobId: context.jobId,
    tenantId: context.tenantId,
    userId: context.userId,
    requestId: context.requestId,
    functionName: context.functionName,
    action,
    duration,
    result: 'error',
    metadata,
    error: errorDetails,
  };

  console.error(JSON.stringify(entry));
}

/**
 * Log service call (Bedrock, S3, DynamoDB, etc.)
 */
export function logServiceCall(
  context: LambdaTraceContext,
  serviceName: string,
  operation: string,
  success: boolean,
  duration?: number,
  metadata?: Record<string, unknown>
): void {
  const entry: LambdaLogEntry = {
    timestamp: new Date().toISOString(),
    level: success ? 'info' : 'warn',
    traceId: context.traceId,
    jobId: context.jobId,
    tenantId: context.tenantId,
    userId: context.userId,
    requestId: context.requestId,
    functionName: context.functionName,
    action: `service:${serviceName}:${operation}`,
    duration,
    result: success ? 'success' : 'error',
    metadata,
  };

  console.log(JSON.stringify(entry));
}

/**
 * Add trace ID to Lambda response headers
 */
export function addTraceHeaders(
  headers: Record<string, string>,
  context: LambdaTraceContext
): Record<string, string> {
  return {
    ...headers,
    'x-trace-id': context.traceId,
    'x-request-id': context.requestId,
  };
}
