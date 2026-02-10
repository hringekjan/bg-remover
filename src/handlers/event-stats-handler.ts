import { APIGatewayProxyHandler } from 'aws-lambda';
import { EventTracker } from '../lib/event-tracking';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { resolveTenantFromRequest } from '../lib/tenant/resolver';

const client = new DynamoDBClient({});
const tracker = new EventTracker(client);

export const handler: APIGatewayProxyHandler = async (event) => {
  // Handle CORS preflight OPTIONS request
  // Check both REST API v1 (event.httpMethod) and HTTP API v2 (event.requestContext.http.method)
  const method = (event.httpMethod || event.requestContext?.http?.method || '').toUpperCase();

  if (method === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, x-tenant-id',
        'Access-Control-Max-Age': '86400'
      },
      body: ''
    };
  }

  try {
    // Resolve tenant using multi-strategy resolver (hostname, headers, JWT, etc.)
    const stage = process.env.STAGE || 'dev';
    const tenantId = await resolveTenantFromRequest(event, stage);

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

    // Get timeframe from query parameters (in hours, defaults to 24)
    const timeframeHours = parseInt(
      event.queryStringParameters?.timeframeHours || '24', 
      10
    );
    const timeframeMs = timeframeHours * 60 * 60 * 1000;
    
    console.log('[EventStatsHandler] Fetching stats for tenant:', tenantId, 'timeframe:', timeframeHours, 'hours');
    
    const stats = await tracker.getEventStats(tenantId, timeframeMs);

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
