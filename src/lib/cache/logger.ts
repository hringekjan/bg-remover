/**
 * Structured logging for cache operations
 * Compatible with CloudWatch Logs Insights
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogContext {
  service?: string;
  operation?: string;
  key?: string;
  tenant?: string;
  layer?: 'L1' | 'L2';
  [key: string]: any;
}

function log(level: LogLevel, message: string, context: LogContext = {}): void {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    service: 'cache',
    ...context,
  };

  // Use appropriate console method for CloudWatch filtering
  switch (level) {
    case 'debug':
      console.debug(JSON.stringify(logEntry));
      break;
    case 'info':
      console.info(JSON.stringify(logEntry));
      break;
    case 'warn':
      console.warn(JSON.stringify(logEntry));
      break;
    case 'error':
      console.error(JSON.stringify(logEntry));
      break;
    default:
      console.log(JSON.stringify(logEntry));
  }
}

export const cacheLogger = {
  debug: (message: string, context?: LogContext) => log('debug', message, context),
  info: (message: string, context?: LogContext) => log('info', message, context),
  warn: (message: string, context?: LogContext) => log('warn', message, context),
  error: (message: string, context?: LogContext) => log('error', message, context),
};
