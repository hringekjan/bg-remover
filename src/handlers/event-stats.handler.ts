import { APIGatewayProxyHandler } from 'aws-lambda';
import { EventTracker } from '../lib/event-tracking';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

const client = new DynamoDBClient({});
const tracker = new EventTracker(client);

export const handler: APIGatewayProxyHandler = async (event) => {
  // Handle CORS preflight OPTIONS request
  if (event.httpMethod === 'OPTIONS' || event.requestContext?.http?.method === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
        'Access-Control-Max-Age': '86400'
      },
      body: ''
    };
  }

  try {
    // Extract tenantId from path parameters or query string
    const tenantId = event.pathParameters?.tenantId ||
                    event.queryStringParameters?.tenantId ||
                    '';

    if (!tenantId) {
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({ error: 'Tenant ID is required' })
      };
    }

    // Get stats for last 24 hours (default)
    const stats = await tracker.getEventStats(tenantId);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify(stats)
    };
  } catch (error) {
    console.error('Error fetching stats:', error);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        error: 'Failed to fetch statistics',
        details: (error as Error).message
      })
    };
  }
};
