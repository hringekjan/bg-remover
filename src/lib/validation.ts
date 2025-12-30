// src/lib/validation.ts
import { z } from 'zod';

export interface ValidationResult<T> {
  success: boolean;
  data?: T;
  error?: {
    message: string;
    details?: any;
    code: string;
  };
}

export class ValidationError extends Error {
  public readonly code: string;
  public readonly details?: any;

  constructor(message: string, code: string = 'VALIDATION_ERROR', details?: any) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Validates request data against a Zod schema
 * @param schema - Zod schema to validate against
 * @param data - Data to validate
 * @param context - Context for logging
 * @returns ValidationResult
 */
export function validateRequest<T>(
  schema: z.ZodSchema<T>,
  data: any,
  context: string = 'unknown'
): ValidationResult<T> {
  try {
    const result = schema.safeParse(data);

    if (result.success) {
      console.log('Validation successful', {
        context,
        validatedFields: Object.keys(result.data as any),
      });
      return { success: true, data: result.data };
    } else {
      const errorDetails = result.error.errors.map(err => ({
        field: err.path.join('.'),
        message: err.message,
        code: err.code,
      }));

      console.warn('Validation failed', {
        context,
        errors: errorDetails,
        inputData: JSON.stringify(data).substring(0, 500), // Truncate for logging
      });

      return {
        success: false,
        error: {
          message: 'Request validation failed',
          details: errorDetails,
          code: 'VALIDATION_ERROR',
        },
      };
    }
  } catch (error) {
    console.error('Validation error', {
      context,
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      success: false,
      error: {
        message: 'Validation processing failed',
        code: 'VALIDATION_PROCESSING_ERROR',
      },
    };
  }
}

/**
 * Validates path parameters
 * @param params - Path parameters object
 * @param context - Context for logging
 * @returns ValidationResult
 */
export function validatePathParams(
  params: Record<string, string> | undefined,
  requiredParams: string[],
  context: string = 'path-params'
): ValidationResult<Record<string, string>> {
  if (!params) {
    return {
      success: false,
      error: {
        message: 'Missing path parameters',
        code: 'MISSING_PATH_PARAMS',
      },
    };
  }

  const missingParams = requiredParams.filter(param => !params[param]);

  if (missingParams.length > 0) {
    return {
      success: false,
      error: {
        message: `Missing required path parameters: ${missingParams.join(', ')}`,
        code: 'MISSING_PATH_PARAMS',
        details: { missingParams },
      },
    };
  }

  return { success: true, data: params };
}

/**
 * Sanitizes string input to prevent injection attacks
 * @param input - Input string to sanitize
 * @returns Sanitized string
 */
export function sanitizeString(input: string): string {
  if (typeof input !== 'string') return '';

  return input
    .trim()
    .replace(/[<>]/g, '') // Remove potential HTML tags
    .replace(/javascript:/gi, '') // Remove javascript: protocol
    .replace(/data:/gi, '') // Remove data: protocol
    .substring(0, 10000); // Limit length
}

/**
 * Validates file size for base64 images
 * @param base64String - Base64 encoded string
 * @param maxSizeBytes - Maximum allowed size in bytes
 * @returns boolean
 */
export function validateBase64Size(base64String: string, maxSizeBytes: number = 10 * 1024 * 1024): boolean {
  try {
    // Calculate approximate size (base64 is ~33% larger than binary)
    const approximateSize = (base64String.length * 3) / 4;
    return approximateSize <= maxSizeBytes;
  } catch {
    return false;
  }
}

/**
 * Rate limiting helper (basic implementation)
 * Note: In production, use Redis or DynamoDB for distributed rate limiting
 */
const requestCounts = new Map<string, { count: number; resetTime: number }>();

export function checkRateLimit(
  identifier: string,
  maxRequests: number = 100,
  windowMs: number = 60000 // 1 minute
): { allowed: boolean; remaining: number; resetTime: number } {
  const now = Date.now();
  const key = identifier;

  const current = requestCounts.get(key);

  if (!current || now > current.resetTime) {
    // Reset window
    requestCounts.set(key, {
      count: 1,
      resetTime: now + windowMs,
    });
    return { allowed: true, remaining: maxRequests - 1, resetTime: now + windowMs };
  }

  if (current.count >= maxRequests) {
    return { allowed: false, remaining: 0, resetTime: current.resetTime };
  }

  current.count++;
  return {
    allowed: true,
    remaining: maxRequests - current.count,
    resetTime: current.resetTime
  };
}