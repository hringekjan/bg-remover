import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { ContextScope } from '@carousellabs/context-scope';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import pino from 'pino';
import { extractAuthContext, isAdmin, isStaff, isSuperAdmin } from '../utils/auth';
import { httpResponse, errorResponse } from '../utils/response';

const logger = pino({ level: 'info' });
const dynamoDbClient = new DynamoDBClient({ region: process.env.REGION });
const cognitoClient = new CognitoIdentityProviderClient({ region: process.env.REGION });

// Type definitions
interface DecryptionAttempt {
  userId: string;
  resourceId: string;
  timestamp: string;
  accessLevel: string;
  ip: string;
  userAgent: string;
  status: 'authorized' | 'unauthorized';
}

interface AlertConfig {
  threshold: number;
  windowMinutes: number;
  notificationChannel: string;
}

/**
 * Handler for monitoring unauthorized decryption attempts
 */
export const handler: APIGatewayProxyHandlerV2 = async (event, context) => {
  const scope = new ContextScope();
  
  try {
    // Extract authentication context from the request
    const authContext = extractAuthContext(event);
    
    // Validate that the requester has appropriate permissions
    if (!authContext || !authContext.userId) {
      logger.warn('Unauthorized access attempt - no auth context');
      return errorResponse(401, 'Unauthorized');
    }
    
    // Check if user is authorized to perform monitoring operations
    if (!(isAdmin(authContext) || isStaff(authContext) || isSuperAdmin(authContext))) {
      logger.warn('Insufficient permissions for decryption monitoring', { userId: authContext.userId });
      return errorResponse(403, 'Forbidden');
    }
    
    // Parse the request body for decryption attempt information
    let attempt: DecryptionAttempt | null = null;
    
    if (event.body) {
      try {
        const body = JSON.parse(event.body);
        attempt = {
          userId: body.userId || '',
          resourceId: body.resourceId || '',
          timestamp: body.timestamp || new Date().toISOString(),
          accessLevel: body.accessLevel || '',
          ip: body.ip || event.requestContext?.http?.sourceIp || '',
          userAgent: body.userAgent || event.headers?.['user-agent'] || '',
          status: body.status || 'unauthorized'
        };
      } catch (parseError) {
        logger.error('Failed to parse request body', { error: parseError });
        return errorResponse(400, 'Invalid request body');
      }
    }
    
    // If we have a decryption attempt, check if it's unauthorized
    if (attempt && attempt.status === 'unauthorized') {
      logger.info('Unauthorized decryption attempt detected', { 
        userId: attempt.userId, 
        resourceId: attempt.resourceId 
      });
      
      // Check if this is an excessive pattern of unauthorized attempts
      const isHighRisk = await checkUnusualActivity(attempt);
      
      if (isHighRisk) {
        logger.warn('High-risk unauthorized decryption pattern detected', { 
          userId: attempt.userId,
          resourceId: attempt.resourceId,
          count: attempt.userId // placeholder, would be actual count from checkUnusualActivity
        });
        
        // Send alert to on-call
        await sendOnCallAlert({
          userId: attempt.userId,
          resourceId: attempt.resourceId,
          timestamp: attempt.timestamp,
          ip: attempt.ip,
          userAgent: attempt.userAgent,
          riskLevel: 'high'
        });
      }
      
      // Store the attempt in DynamoDB for later analysis
      await storeDecryptionAttempt(attempt);
    }
    
    scope.setMetric('decryptionMonitorSuccess', 1);
    
    return httpResponse(200, {
      message: 'Monitoring completed',
      ...(attempt && { attempt })
    });
    
  } catch (error) {
    scope.setMetric('decryptionMonitorError', 1);
    logger.error('Decryption monitoring handler error', { error });
    
    return errorResponse(500, 'Internal server error');
  }
};

/**
 * Check if the decryption attempt pattern is unusual/high risk
 */
async function checkUnusualActivity(attempt: DecryptionAttempt): Promise<boolean> {
  // This would implement business logic to detect high-risk patterns
  // For now, we'll simulate a simple check
  try {
    // In a real implementation, this would query DynamoDB
    // to check recent attempts by this user or across the system
    return false; // Placeholder implementation
  } catch (error) {
    logger.error('Error checking unusual activity', { error });
    return false;
  }
}

/**
 * Store decryption attempt in DynamoDB
 */
async function storeDecryptionAttempt(attempt: DecryptionAttempt): Promise<void> {
  // Implementation would store attempt in DynamoDB table
  // This is a placeholder for the real storage logic
  logger.debug('Storing decryption attempt', { attempt });
}

/**
 * Send alert to on-call personnel
 */
async function sendOnCallAlert(alertDetails: {
  userId: string;
  resourceId: string;
  timestamp: string;
  ip: string;
  userAgent: string;
  riskLevel: 'low' | 'medium' | 'high';
}): Promise<void> {
  // Implementation would send alert through whatever notification system is used
  // For now, just log it
  logger.warn('On-call alert triggered', { alertDetails });
}