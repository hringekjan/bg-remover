/**
 * Standardized Error Handling for bg-remover service
 *
 * Provides consistent error codes, response formats, and logging patterns.
 *
 * @module lib/errors
 */

// ============================================================================
// Error Codes
// ============================================================================

/**
 * Standard error codes for API responses
 */
export enum ErrorCode {
  // Client Errors (4xx)
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  AUTH_ERROR = 'AUTH_ERROR',
  AUTH_EXPIRED = 'AUTH_EXPIRED',
  INSUFFICIENT_CREDITS = 'INSUFFICIENT_CREDITS',
  NOT_FOUND = 'NOT_FOUND',
  RATE_LIMITED = 'RATE_LIMITED',
  METHOD_NOT_ALLOWED = 'METHOD_NOT_ALLOWED',
  CONFLICT = 'CONFLICT',

  // Server Errors (5xx)
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  PROCESSING_ERROR = 'PROCESSING_ERROR',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
  DEPENDENCY_ERROR = 'DEPENDENCY_ERROR',
  CONFIG_ERROR = 'CONFIG_ERROR',
}

/**
 * Maps error codes to HTTP status codes
 */
export const ErrorCodeToStatus: Record<ErrorCode, number> = {
  [ErrorCode.VALIDATION_ERROR]: 400,
  [ErrorCode.AUTH_ERROR]: 401,
  [ErrorCode.AUTH_EXPIRED]: 401,
  [ErrorCode.INSUFFICIENT_CREDITS]: 402,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.METHOD_NOT_ALLOWED]: 405,
  [ErrorCode.CONFLICT]: 409,
  [ErrorCode.RATE_LIMITED]: 429,
  [ErrorCode.INTERNAL_ERROR]: 500,
  [ErrorCode.PROCESSING_ERROR]: 500,
  [ErrorCode.SERVICE_UNAVAILABLE]: 503,
  [ErrorCode.DEPENDENCY_ERROR]: 502,
  [ErrorCode.CONFIG_ERROR]: 500,
};

// ============================================================================
// Error Types
// ============================================================================

/**
 * Standardized error response format
 */
export interface ErrorResponse {
  error: ErrorCode;
  message: string;
  details?: unknown;
  requestId?: string;
  timestamp: string;
}

/**
 * API Lambda response format
 */
export interface ApiResponse<T = unknown> {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
}

/**
 * Application error with code and details
 */
export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly details?: unknown;
  public readonly httpStatus: number;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
    this.httpStatus = ErrorCodeToStatus[code];
  }
}

// ============================================================================
// Error Helpers
// ============================================================================

/**
 * Default CORS headers for all responses
 * NOTE: These are placeholder defaults. Use createTenantCorsHeaders() from lib/cors.ts
 * for proper tenant-aware CORS headers in production handlers.
 */
export const DEFAULT_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  // DEPRECATED: Use tenant-aware CORS headers via createTenantCorsHeaders()
  // Kept for backward compatibility only - will be removed in future versions
  'Access-Control-Allow-Origin': 'null',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Tenant-Id',
  'Vary': 'Origin',
};

/**
 * Create a standardized error response
 */
export function createErrorResponse(
  code: ErrorCode,
  message: string,
  details?: unknown,
  requestId?: string
): ApiResponse {
  const body: ErrorResponse = {
    error: code,
    message,
    details,
    requestId,
    timestamp: new Date().toISOString(),
  };

  return {
    statusCode: ErrorCodeToStatus[code],
    headers: DEFAULT_HEADERS,
    body: JSON.stringify(body),
  };
}

/**
 * Create a success response
 */
export function createSuccessResponse<T>(
  data: T,
  statusCode: number = 200
): ApiResponse<T> {
  return {
    statusCode,
    headers: DEFAULT_HEADERS,
    body: JSON.stringify(data),
  };
}

/**
 * Handle errors consistently and return appropriate response
 */
export function handleError(
  error: unknown,
  context: string,
  requestId?: string
): ApiResponse {
  // Log error with context
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorStack = error instanceof Error ? error.stack : undefined;

  console.error(JSON.stringify({
    level: 'error',
    msg: 'error.handler',
    context,
    requestId,
    error: errorMessage,
    stack: errorStack,
    timestamp: new Date().toISOString(),
  }));

  // Handle AppError with proper code
  if (error instanceof AppError) {
    return createErrorResponse(
      error.code,
      error.message,
      error.details,
      requestId
    );
  }

  // Handle validation errors from Zod
  if (error instanceof Error && error.name === 'ZodError') {
    return createErrorResponse(
      ErrorCode.VALIDATION_ERROR,
      'Request validation failed',
      (error as any).errors,
      requestId
    );
  }

  // Default to internal error
  return createErrorResponse(
    ErrorCode.INTERNAL_ERROR,
    'An unexpected error occurred',
    process.env.STAGE === 'dev' ? errorMessage : undefined,
    requestId
  );
}

// ============================================================================
// Convenience Error Creators
// ============================================================================

export const Errors = {
  validation: (message: string, details?: unknown) =>
    new AppError(ErrorCode.VALIDATION_ERROR, message, details),

  unauthorized: (message: string = 'Authentication required') =>
    new AppError(ErrorCode.AUTH_ERROR, message),

  forbidden: (message: string = 'Access denied') =>
    new AppError(ErrorCode.AUTH_ERROR, message),

  notFound: (resource: string, id?: string) =>
    new AppError(
      ErrorCode.NOT_FOUND,
      id ? `${resource} with ID '${id}' not found` : `${resource} not found`
    ),

  insufficientCredits: (required: number, available: number) =>
    new AppError(
      ErrorCode.INSUFFICIENT_CREDITS,
      `Insufficient credits: ${required} required, ${available} available`,
      { required, available }
    ),

  rateLimited: (retryAfter?: number) =>
    new AppError(
      ErrorCode.RATE_LIMITED,
      'Rate limit exceeded. Please try again later.',
      retryAfter ? { retryAfter } : undefined
    ),

  processing: (message: string, details?: unknown) =>
    new AppError(ErrorCode.PROCESSING_ERROR, message, details),

  dependency: (service: string, message: string) =>
    new AppError(
      ErrorCode.DEPENDENCY_ERROR,
      `${service} service error: ${message}`,
      { service }
    ),

  config: (message: string) =>
    new AppError(ErrorCode.CONFIG_ERROR, message),

  internal: (message: string = 'Internal server error') =>
    new AppError(ErrorCode.INTERNAL_ERROR, message),
};

// ============================================================================
// Request Context
// ============================================================================

/**
 * Extract request ID from Lambda event
 */
export function extractRequestId(event: any): string {
  return (
    event.requestContext?.requestId ||
    event.headers?.['x-request-id'] ||
    event.headers?.['X-Request-Id'] ||
    `req-${Date.now()}-${Math.random().toString(36).substring(7)}`
  );
}

/**
 * Wrap handler with standardized error handling
 */
export function withErrorHandling<T extends (...args: any[]) => Promise<ApiResponse>>(
  handler: T,
  context: string
): T {
  return (async (...args: Parameters<T>): Promise<ApiResponse> => {
    const event = args[0];
    const requestId = extractRequestId(event);

    try {
      return await handler(...args);
    } catch (error) {
      return handleError(error, context, requestId);
    }
  }) as T;
}
