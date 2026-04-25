import { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { ContextScope } from "@carousellabs/context-scope";
import { withCostBreakdown } from "../middleware/cost-breakdown";
import { setupMonitoring } from "../lib/cloudwatch/monitoring-setup";

// Setup monitoring on cold start
setupMonitoring().catch(console.error);

/**
 * Handler for cost breakdown with efficiency color coding
 */
export const handler: APIGatewayProxyHandlerV2 = withCostBreakdown(async (event, context) => {
  const scope = new ContextScope();
  
  try {
    // Default response for main handler
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "BG Remover Service",
        version: "1.0.0"
      })
    };
  } catch (error) {
    scope.setMetric("handlerExecutionError", 1);
    console.error("Handler error:", error);
    
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Internal server error"
      })
    };
  }
});