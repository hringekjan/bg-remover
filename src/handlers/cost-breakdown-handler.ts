import { BaseHandler } from './base-handler';
import { bgRemoverTelemetry } from '../lib/telemetry/bg-remover-telemetry';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

/**
 * Cost Breakdown Handler
 *
 * Provides cost breakdown per agent with efficiency colour coding.
 * 
 * GET /bg-remover/cost-breakdown
 */
export class CostBreakdownHandler extends BaseHandler {
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
      // Get cost breakdown from telemetry
      const costBreakdown = await bgRemoverTelemetry.getCostBreakdown();

      // Format the response with efficiency colour coding
      const formattedBreakdown = this.formatCostBreakdown(costBreakdown);

      // Return formatted response
      return this.createJsonResponse({
        success: true,
        agent: 'bg-remover',
        breakdown: formattedBreakdown,
        timestamp: new Date().toISOString(),
      }, 200);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[CostBreakdownHandler] Failed to fetch cost breakdown:', {
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
      });

      return this.createErrorResponse(
        `Failed to fetch cost breakdown: ${errorMessage}`,
        500
      );
    }
  }

  /**
   * Format cost breakdown with efficiency colour coding
   */
  private formatCostBreakdown(breakdown: any): any {
    // Calculate efficiencies for each agent
    const agents = Object.entries(breakdown.agents || {}).map(([agentId, agentData]: [string, any]) => {
      const data = agentData as any;
      
      // Calculate efficiency score (this will depend on your specific logic)
      // For now we'll use a simplified approach
      let efficiencyScore = 0;
      let efficiencyColor = 'red';
      
      // Simple efficiency calculation based on cost per task
      if (data.totalCostUsd > 0 && data.totalTasks > 0) {
        const costPerTask = data.totalCostUsd / data.totalTasks;
        
        // Efficiency scale: 0-100 where 100 is most efficient
        efficiencyScore = Math.min(100, Math.max(0, 100 - (costPerTask * 1000)));
        
        // Color coding based on efficiency
        if (efficiencyScore >= 80) {
          efficiencyColor = 'green';
        } else if (efficiencyScore >= 60) {
          efficiencyColor = 'yellow';
        } else {
          efficiencyColor = 'red';
        }
      }
      
      return {
        agentId,
        totalTasks: data.totalTasks,
        totalCostUsd: data.totalCostUsd.toFixed(6),
        averageCostPerTask: data.averageCostPerTask?.toFixed(6) || '0.000000',
        efficiencyScore: efficiencyScore.toFixed(2),
        efficiencyColor,
        tasksByWindow: data.tasksByWindow || {},
        costByWindow: data.costByWindow || {}
      };
    });

    // Calculate overall statistics
    const totalTasks = Object.values(breakdown.agents || {})
      .reduce((sum: number, agent: any) => sum + (agent.totalTasks || 0), 0);
    
    const totalCost = Object.values(breakdown.agents || {})
      .reduce((sum: number, agent: any) => sum + (agent.totalCostUsd || 0), 0);

    return {
      agents,
      totalTasks,
      totalCostUsd: totalCost.toFixed(6),
      averageCostPerTask: totalTasks > 0 ? (totalCost / totalTasks).toFixed(6) : '0.000000',
      timestamp: new Date().toISOString()
    };
  }
}

// Export the handler function for Lambda
export const costBreakdown = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const handler = new CostBreakdownHandler();
  return handler.handle(event);
};