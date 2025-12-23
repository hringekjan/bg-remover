/**
 * Structured Logging for bg-remover service
 *
 * Provides consistent structured logging with:
 * - Request ID correlation
 * - Tenant context
 * - CloudWatch Insights compatible JSON format
 *
 * @module lib/logger
 */

// Log levels mapping
const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
} as const;

type LogLevelName = keyof typeof LOG_LEVELS;

const currentLogLevel = LOG_LEVELS[(process.env.LOG_LEVEL?.toUpperCase() as LogLevelName) || 'INFO'] || LOG_LEVELS.INFO;

// Persistent attributes
const persistentAttributes = {
  service: 'bg-remover',
  environment: process.env.STAGE || 'dev',
  version: process.env.npm_package_version || '1.0.0',
  region: process.env.AWS_REGION || 'eu-west-1',
};

// Additional keys that can be appended
let additionalKeys: Record<string, unknown> = {};

// Simple structured logger interface matching Lambda Powertools
interface SimpleLogger {
  debug: (message: string, extra?: Record<string, unknown>) => void;
  info: (message: string, extra?: Record<string, unknown>) => void;
  warn: (message: string, extra?: Record<string, unknown>) => void;
  error: (message: string, extra?: Record<string, unknown>) => void;
  appendKeys: (keys: Record<string, unknown>) => void;
  resetKeys: () => void;
  createChild: (options: { persistentLogAttributes: Record<string, unknown> }) => SimpleLogger;
}

function formatLog(level: string, message: string, extra?: Record<string, unknown>): string {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    level,
    message,
    ...persistentAttributes,
    ...additionalKeys,
    ...extra,
  };
  return JSON.stringify(logEntry);
}

const logger: SimpleLogger = {
  debug: (message: string, extra?: Record<string, unknown>) => {
    if (currentLogLevel <= LOG_LEVELS.DEBUG) {
      console.debug(formatLog('DEBUG', message, extra));
    }
  },
  info: (message: string, extra?: Record<string, unknown>) => {
    if (currentLogLevel <= LOG_LEVELS.INFO) {
      console.info(formatLog('INFO', message, extra));
    }
  },
  warn: (message: string, extra?: Record<string, unknown>) => {
    if (currentLogLevel <= LOG_LEVELS.WARN) {
      console.warn(formatLog('WARN', message, extra));
    }
  },
  error: (message: string, extra?: Record<string, unknown>) => {
    if (currentLogLevel <= LOG_LEVELS.ERROR) {
      console.error(formatLog('ERROR', message, extra));
    }
  },
  appendKeys: (keys: Record<string, unknown>) => {
    additionalKeys = { ...additionalKeys, ...keys };
  },
  resetKeys: () => {
    additionalKeys = {};
  },
  createChild: (options: { persistentLogAttributes: Record<string, unknown> }): SimpleLogger => {
    const childKeys = { ...options.persistentLogAttributes };
    return {
      debug: (message: string, extra?: Record<string, unknown>) => {
        if (currentLogLevel <= LOG_LEVELS.DEBUG) {
          console.debug(formatLog('DEBUG', message, { ...childKeys, ...extra }));
        }
      },
      info: (message: string, extra?: Record<string, unknown>) => {
        if (currentLogLevel <= LOG_LEVELS.INFO) {
          console.info(formatLog('INFO', message, { ...childKeys, ...extra }));
        }
      },
      warn: (message: string, extra?: Record<string, unknown>) => {
        if (currentLogLevel <= LOG_LEVELS.WARN) {
          console.warn(formatLog('WARN', message, { ...childKeys, ...extra }));
        }
      },
      error: (message: string, extra?: Record<string, unknown>) => {
        if (currentLogLevel <= LOG_LEVELS.ERROR) {
          console.error(formatLog('ERROR', message, { ...childKeys, ...extra }));
        }
      },
      appendKeys: (keys: Record<string, unknown>) => {
        Object.assign(childKeys, keys);
      },
      resetKeys: () => {
        Object.keys(childKeys).forEach(k => delete childKeys[k]);
      },
      createChild: logger.createChild,
    };
  },
};

/**
 * Request context for structured logging
 */
export interface LogContext {
  requestId?: string;
  tenant?: string;
  userId?: string;
  jobId?: string;
  [key: string]: unknown;
}

/**
 * Create a child logger with request-specific context
 * Use this at the start of each Lambda handler
 */
export function createRequestLogger(context: LogContext): SimpleLogger {
  const childLogger = logger.createChild({
    persistentLogAttributes: {
      ...context,
    },
  });
  return childLogger;
}

/**
 * Log levels with semantic meaning
 */
export const log = {
  /**
   * Debug level - detailed information for troubleshooting
   * Only logged when LOG_LEVEL=DEBUG
   */
  debug: (message: string, attributes?: Record<string, unknown>) => {
    logger.debug(message, { data: attributes });
  },

  /**
   * Info level - standard operational information
   */
  info: (message: string, attributes?: Record<string, unknown>) => {
    logger.info(message, { data: attributes });
  },

  /**
   * Warn level - unexpected but recoverable conditions
   */
  warn: (message: string, attributes?: Record<string, unknown>) => {
    logger.warn(message, { data: attributes });
  },

  /**
   * Error level - failures requiring attention
   */
  error: (message: string, error?: Error | unknown, attributes?: Record<string, unknown>) => {
    if (error instanceof Error) {
      logger.error(message, {
        error: {
          name: error.name,
          message: error.message,
          stack: error.stack,
        },
        data: attributes,
      });
    } else {
      logger.error(message, {
        error: String(error),
        data: attributes,
      });
    }
  },
};

/**
 * Log a Lambda handler invocation with context
 */
export function logHandlerInvocation(
  handlerName: string,
  event: any,
  context: LogContext
): void {
  logger.appendKeys({
    requestId: context.requestId,
    tenant: context.tenant,
    userId: context.userId,
    functionName: handlerName,
  });

  logger.info(`Handler invoked: ${handlerName}`, {
    data: {
      httpMethod: event.requestContext?.http?.method,
      path: event.requestContext?.http?.path,
      hasBody: !!event.body,
      ...context,
    },
  });
}

/**
 * Log a successful response
 */
export function logResponse(
  statusCode: number,
  processingTimeMs?: number,
  attributes?: Record<string, unknown>
): void {
  logger.info('Response sent', {
    data: {
      statusCode,
      processingTimeMs,
      ...attributes,
    },
  });
}

/**
 * Log timing metrics for performance analysis
 */
export function logTiming(
  operation: string,
  durationMs: number,
  attributes?: Record<string, unknown>
): void {
  logger.info(`Timing: ${operation}`, {
    data: {
      operation,
      durationMs,
      ...attributes,
    },
  });
}

/**
 * Log external service calls
 */
export function logServiceCall(
  service: string,
  operation: string,
  success: boolean,
  durationMs?: number,
  attributes?: Record<string, unknown>
): void {
  const logData = {
    data: {
      service,
      operation,
      success,
      durationMs,
      ...attributes,
    },
  };

  if (success) {
    logger.info(`Service call: ${service}.${operation}`, logData);
  } else {
    logger.warn(`Service call: ${service}.${operation}`, logData);
  }
}

/**
 * Log security-related events (authentication, authorization)
 */
export function logSecurityEvent(
  event: 'auth_success' | 'auth_failure' | 'auth_skip' | 'rate_limit' | 'ssrf_blocked',
  attributes: Record<string, unknown>
): void {
  const logData = {
    data: {
      securityEvent: event,
      ...attributes,
    },
  };

  const isWarning = event.includes('failure') || event.includes('blocked') || event.includes('limit');
  if (isWarning) {
    logger.warn(`Security event: ${event}`, logData);
  } else {
    logger.info(`Security event: ${event}`, logData);
  }
}

/**
 * Log credit operations
 */
export function logCreditOperation(
  operation: 'debit' | 'refund' | 'check',
  success: boolean,
  attributes: Record<string, unknown>
): void {
  const logData = {
    data: {
      creditOperation: operation,
      success,
      ...attributes,
    },
  };

  if (success) {
    logger.info(`Credit operation: ${operation}`, logData);
  } else {
    logger.warn(`Credit operation: ${operation}`, logData);
  }
}

/**
 * Clear the logger context (call at end of handler)
 */
export function clearLogContext(): void {
  logger.resetKeys();
}

// Export the base logger for advanced use cases
export { logger };
