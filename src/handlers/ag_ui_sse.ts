import { Context } from '@aws-lambda/types';
import { APIGatewayProxyResultV2 } from 'aws-lambda';
import { extractAuthContext, isAdmin } from '../utils/auth';
import { httpResponse, errorResponse } from '../utils/response';
import pino from 'pino';

const logger = pino();

export const handler = async (
  event: any,
  context: Context
): Promise<APIGatewayProxyResultV2> => {
  try {
    // Extract authentication context
    const authContext = extractAuthContext(event);
    
    // Check if user has admin privileges
    if (!isAdmin(authContext)) {
      return errorResponse(403, 'Forbidden');
    }

    // Process SSE connection logic here
    // This would typically involve:
    // 1. Validating request parameters
    // 2. Setting up SSE connection
    // 3. Streaming updates to client
    
    // For now, returning basic SSE headers to establish connection
    const response = {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'X-Accel-Buffering': 'no', // Disable buffering for SSE in NGINX
      },
      body: 'data: SSE connection established\n\n'
    };

    return httpResponse(response);
  } catch (error) {
    logger.error({ error }, 'Error in ag_ui_sse handler');
    return errorResponse(500, 'Internal server error');
  }
};