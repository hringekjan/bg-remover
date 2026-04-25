/**
 * Example usage of BG Remover Context Scope
 * 
 * This would typically be used in a Lambda handler to trace requests
 */

import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { initializeBgRemoverContext, cleanupBgRemoverContext, setImageProcessingMetadata } from './middleware/bg-remover-context-scope';

// Example handler using the BG Remover context scope
export const exampleHandler: APIGatewayProxyHandlerV2 = async (event, context) => {
  // Initialize the context scope
  await initializeBgRemoverContext(event, context);
  
  try {
    // Simulate some work
    setImageProcessingMetadata({
      originalSize: 2048,
      format: 'jpeg',
      quality: 85
    });
    
    // Your business logic here
    
    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Success' })
    };
  } finally {
    // Always clean up the context
    cleanupBgRemoverContext();
  }
};