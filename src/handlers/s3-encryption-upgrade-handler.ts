import { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { ContextScope } from "@carousellabs/context-scope";
import { checkAndUpgradeS3Encryption } from "../lib/s3/encryption-checker";
import { setupMonitoring } from "../lib/cloudwatch/monitoring-setup";
import { withCloudFrontPathNormalization } from "../lib/middleware/cloudfront-path-normalizer";
import { httpResponse, errorResponse } from "../lib/utils/response";
import { extractAuthContext, isAdmin } from "../lib/utils/auth";

// Setup monitoring on cold start
setupMonitoring().catch(console.error);

const baseHandler: APIGatewayProxyHandlerV2 = async (event, context) => {
  const scope = new ContextScope();
  
  try {
    // Extract authentication context
    const authContext = extractAuthContext(event);
    
    // Check if user has admin privileges
    if (!isAdmin(authContext)) {
      return errorResponse(403, "Access denied: Admin privileges required");
    }

    // Validate required environment variables
    const vectorsBucket = process.env.S3_VECTORS_BUCKET;
    const tablesBucket = process.env.S3_TABLES_BUCKET;
    const kmsKeyId = process.env.S3_ENCRYPTION_KMS_KEY_ID;
    
    if (!vectorsBucket || !tablesBucket || !kmsKeyId) {
      console.error("Missing required environment variables for encryption upgrade");
      return errorResponse(500, "Missing required configuration for encryption upgrade");
    }

    // Perform encryption check and upgrade
    const result = await checkAndUpgradeS3Encryption(
      vectorsBucket, 
      tablesBucket, 
      kmsKeyId
    );

    scope.setMetric("encryptionCheckAndUpgradeSuccess", 1);
    
    return httpResponse(200, {
      message: "S3 encryption check and upgrade completed",
      vectorsBucket: result.vectorsBucket,
      tablesBucket: result.tablesBucket,
      upgradedVectors: result.upgradedVectors,
      upgradedTables: result.upgradedTables
    });
  } catch (error) {
    scope.setMetric("encryptionCheckAndUpgradeError", 1);
    console.error("Encryption check and upgrade error:", error);
    
    return errorResponse(500, "Failed to check and upgrade S3 encryption");
  }
};

// Apply CloudFront path normalization middleware
export const handler: APIGatewayProxyHandlerV2 = withCloudFrontPathNormalization(baseHandler);