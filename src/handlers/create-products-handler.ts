/**
 * Lambda handler for create-products endpoint
 *
 * Wraps the Next.js API route for serverless deployment
 */

import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { POST, OPTIONS } from '../../app/api/create-products/route';
import { NextRequest } from 'next/server';

/**
 * Convert API Gateway event to NextRequest
 */
function eventToNextRequest(event: APIGatewayProxyEventV2): NextRequest {
  const url = `https://${event.requestContext.domainName}${event.rawPath}${
    event.rawQueryString ? `?${event.rawQueryString}` : ''
  }`;

  const headers = new Headers(event.headers as Record<string, string>);

  const request = new NextRequest(url, {
    method: event.requestContext.http.method,
    headers,
    body: event.body || undefined,
  });

  return request;
}

/**
 * Convert NextResponse to API Gateway result
 */
async function nextResponseToResult(response: Response): Promise<APIGatewayProxyResultV2> {
  const body = await response.text();

  return {
    statusCode: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body,
  };
}

/**
 * Main Lambda handler
 */
export async function createProducts(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const startTime = Date.now();

  try {
    console.log('Create products handler invoked', {
      method: event.requestContext.http.method,
      path: event.rawPath,
      tenant: event.headers?.['x-tenant-id'],
    });

    const request = eventToNextRequest(event);
    const method = event.requestContext.http.method;

    let response: Response;

    if (method === 'POST') {
      response = await POST(request);
    } else if (method === 'OPTIONS') {
      response = await OPTIONS();
    } else {
      return {
        statusCode: 405,
        body: JSON.stringify({ error: 'Method not allowed' }),
      };
    }

    const result = await nextResponseToResult(response);

    console.log('Create products handler completed', {
      statusCode: typeof result === 'object' && 'statusCode' in result ? result.statusCode : 200,
      latencyMs: Date.now() - startTime,
    });

    return result;

  } catch (error) {
    console.error('Create products handler error', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
}
