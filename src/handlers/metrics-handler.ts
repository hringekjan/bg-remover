import { BaseHandler } from './base-handler';
import { bgRemoverTelemetry } from '../lib/telemetry/bg-remover-telemetry';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

/**
 * Metrics Handler
 *
 * Provides real-time metrics for the bg-remover agent.
 * Supports multiple time windows: 1h, 24h, 7d
 *
 * GET /bg-remover/metrics?window=1h
 */
export class MetricsHandler extends BaseHandler {
  async handle(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    const httpMethod = event.requestContext?.http?.method || 'GET';

    if (httpMethod === 'OPTIONS') {
      return this.createJsonResponse('', 200, {
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
      });
    }

    if (httpMethod !== 'GET') {
      return this.createErrorResponse('Method Not Allowed', 405);
    }

    try {
      // Parse time window from query parameters
      const window = (event.queryStringParameters?.window as '1h' | '24h' | '7d' | '30d') || '1h';

      // Validate window parameter
      const validWindows = ['1h', '24h', '7d', '30d'];
      if (!validWindows.includes(window)) {
        return this.createErrorResponse(
          `Invalid window parameter. Must be one of: ${validWindows.join(', ')}`,
          400
        );
      }

      // Get metrics from telemetry
      const metrics = await bgRemoverTelemetry.getMetrics(window as '1h' | '24h' | '7d');

      // Return formatted response
      return this.createJsonResponse({
        success: true,
        agent: 'bg-remover',
        window,
        metrics: {
          totalTasks: metrics.totalTasks,
          successfulTasks: metrics.successfulTasks,
          failedTasks: metrics.failedTasks,
          successRate: `${metrics.successRate.toFixed(2)}%`,
          performance: {
            averageResponseTimeMs: metrics.averageResponseTimeMs.toFixed(2),
            p50ResponseTimeMs: metrics.p50ResponseTimeMs.toFixed(2),
            p95ResponseTimeMs: metrics.p95ResponseTimeMs.toFixed(2),
            p99ResponseTimeMs: metrics.p99ResponseTimeMs.toFixed(2),
          },
          costs: {
            totalCostUsd: metrics.totalCostUsd.toFixed(6),
            averageCostPerTask: metrics.averageCostPerTask.toFixed(6),
          },
          timeRange: {
            start: metrics.startTime,
            end: metrics.endTime,
          },
        },
        timestamp: new Date().toISOString(),
      }, 200);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[MetricsHandler] Failed to fetch metrics:', {
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
      });

      return this.createErrorResponse(
        `Failed to fetch metrics: ${errorMessage}`,
        500
      );
    }
  }
}

// Export the handler function for Lambda
export const metrics = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const handler = new MetricsHandler();
  return handler.handle(event);
};
