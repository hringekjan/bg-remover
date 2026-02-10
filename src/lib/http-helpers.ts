import { APIGatewayProxyResult } from 'aws-lambda';

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

/**
 * Create HTTP response with CORS headers
 */
export function createResponse<T>(
  statusCode: number,
  body: ApiResponse<T>,
  corsHeaders?: Record<string, string>
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      ...corsHeaders,
    },
    body: JSON.stringify(body),
  };
}

/**
 * Create success response
 */
export function successResponse<T>(data: T, corsHeaders?: Record<string, string>): APIGatewayProxyResult {
  return createResponse(200, {
    success: true,
    data,
  }, corsHeaders);
}

/**
 * Create error response
 */
export function errorResponse(statusCode: number, error: string, corsHeaders?: Record<string, string>): APIGatewayProxyResult {
  return createResponse(statusCode, {
    success: false,
    error,
  }, corsHeaders);
}

/**
 * Create not found response
 */
export function notFoundResponse(resource: string, corsHeaders?: Record<string, string>): APIGatewayProxyResult {
  return errorResponse(404, `${resource} not found`, corsHeaders);
}

/**
 * Create validation error response
 */
export function validationErrorResponse(error: string, corsHeaders?: Record<string, string>): APIGatewayProxyResult {
  return errorResponse(400, `Validation error: ${error}`, corsHeaders);
}
