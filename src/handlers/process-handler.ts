import { BaseHandler } from './base-handler';
import { randomUUID } from 'crypto';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { marshall } from '@aws-sdk/util-dynamodb';
import { ProcessRequestSchema } from '../lib/types';
import { validateRequest } from '../lib/validation';
import { resolveTenantFromRequest } from '../lib/tenant/resolver';
import { validateJWTFromEvent } from '../lib/auth/jwt-validator';
import { loadTenantCognitoConfig } from '../lib/tenant/cognito-config';
import { validateAndDebitCredits } from '../lib/credits/client';

const dynamoDB = new DynamoDBClient({});
const lambda = new LambdaClient({});
const tableName = global.process.env.BG_REMOVER_TABLE_NAME!;
const workerFunctionName = global.process.env.WORKER_FUNCTION_NAME!;

/**
 * Process Handler - Async Job Coordinator
 *
 * This handler accepts image processing requests, validates them,
 * debits credits, creates a job in DynamoDB, and invokes the worker
 * Lambda asynchronously. Returns 202 Accepted immediately.
 *
 * Key improvements:
 * - No HTTP API Gateway timeout (30s) constraints
 * - Immediate response to client (<2s)
 * - Worker can process for up to 15 minutes
 * - Client polls /status/{jobId} for results
 */
export class ProcessHandler extends BaseHandler {
  async handle(event: any): Promise<any> {
    console.log('Process function called (async pattern)', JSON.stringify(event, null, 2));
    const httpMethod = event.requestContext?.http?.method || event.httpMethod;

    if (httpMethod === 'OPTIONS') {
      return this.createJsonResponse('', 200, {
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      });
    }

    if (httpMethod !== 'POST') {
      return this.createErrorResponse('Method Not Allowed', 405);
    }

    const stage = this.context.stage;
    const jobId = randomUUID();

    // ===== TENANT RESOLUTION (BEFORE AUTH) =====
    // Resolve tenant from request (header, domain, JWT claims, or default)
    const tenant = await resolveTenantFromRequest(event, stage);

    // Log request context for debugging
    console.log('[ProcessHandler] 📋 Request context:', {
      tenant,
      stage,
      requireAuth: stage === 'prod' || global.process.env.REQUIRE_AUTH === 'true',
      host: event.headers?.host,
      path: event.requestContext?.http?.path,
      hasAuthHeader: !!event.headers?.authorization,
      jobId,
      timestamp: new Date().toISOString(),
    });

    // ===== JWT AUTHENTICATION (WITH TENANT-SPECIFIC CONFIG) =====
    const requireAuth = stage === 'prod' || global.process.env.REQUIRE_AUTH === 'true';

    // Load tenant-specific Cognito configuration for JWT validation
    let cognitoConfig;
    try {
      cognitoConfig = await loadTenantCognitoConfig(tenant, stage);

      console.log('[ProcessHandler] 🔐 Cognito config loaded:', {
        tenant,
        userPoolId: cognitoConfig.userPoolId,
        issuer: cognitoConfig.issuer,
        jobId,
      });
    } catch (error) {
      console.error('[ProcessHandler] ❌ Failed to load tenant Cognito config:', {
        tenant,
        error: error instanceof Error ? error.message : String(error),
        jobId,
      });
      // Re-throw the error - loadTenantCognitoConfig now fails fast in prod
      throw error;
    }

    const authResult = await validateJWTFromEvent(event, cognitoConfig, {
      required: requireAuth
    });

    console.log('[ProcessHandler] Authentication result:', {
      isValid: authResult.isValid,
      hasUserId: !!authResult.userId,
      userId: authResult.userId,
      error: authResult.error,
      requireAuth,
      tenant,
      jobId,
    });

    if (!authResult.isValid && requireAuth) {
      console.warn('Authentication failed', {
        error: authResult.error,
        tenant,
        stage,
        path: event.requestContext?.http?.path,
        jobId,
      });

      return this.createErrorResponse('Valid JWT token required', 401, {
        'WWW-Authenticate': 'Bearer realm="bg-remover", error="invalid_token"',
      });
    }

    if (authResult.isValid && authResult.userId) {
      console.info('Authenticated request', {
        userId: authResult.userId,
        email: authResult.email,
        groups: authResult.groups,
        tenant,
        jobId,
      });
    }
    // ===== END JWT AUTHENTICATION =====

    const userId = authResult.userId || 'anonymous';

    try {
      // Parse and validate request body
      let body: any;
      try {
        body = JSON.parse(event.body || '{}');
      } catch (error) {
        console.warn('Invalid JSON in request body', {
          error: error instanceof Error ? error.message : String(error)
        });
        return this.createErrorResponse('Request body must be valid JSON', 400);
      }

      const validation = validateRequest(ProcessRequestSchema, body, 'process-request');
      if (!validation.success) {
        console.warn('Request validation failed', {
          tenant,
          errors: validation.error?.details,
        });
        return this.createErrorResponse(
          validation.error?.message || 'Validation failed',
          400,
          validation.error?.details
        );
      }

      const validatedRequest = validation.data!;
      const { productId } = validatedRequest;

      console.info('Creating async job', {
        jobId,
        tenant,
        userId,
        productId,
        hasUrl: !!validatedRequest.imageUrl,
        hasBase64: !!validatedRequest.imageBase64,
      });

      // ===== CREDITS VALIDATION =====
      const creditsRequired = stage === 'prod' || global.process.env.REQUIRE_CREDITS === 'true';
      let creditTransactionId: string | undefined;

      if (creditsRequired && authResult.isValid && authResult.userId) {
        console.info('Validating credits', {
          jobId,
          tenant,
          userId: authResult.userId,
          imageCount: 1,
        });

        const creditResult = await validateAndDebitCredits(
          tenant,
          authResult.userId,
          1, // 1 credit per image
          jobId,
          productId
        );

        if (!creditResult.success) {
          console.warn('Insufficient credits', {
            jobId,
            tenant,
            userId: authResult.userId,
            error: creditResult.error,
            errorCode: creditResult.errorCode,
          });

          return this.createErrorResponse(
            creditResult.error || 'Insufficient credits',
            creditResult.httpStatus || 402,
            { errorCode: creditResult.errorCode, jobId }
          );
        }

        creditTransactionId = creditResult.transactionId;

        console.info('Credits debited successfully', {
          jobId,
          tenant,
          userId: authResult.userId,
          creditsUsed: creditResult.creditsUsed,
          newBalance: creditResult.newBalance,
          transactionId: creditResult.transactionId,
        });
      }
      // ===== END CREDITS VALIDATION =====

      // Create job record in DynamoDB
      const pk = `TENANT#${tenant}#JOB`;
      const sk = `JOB#${jobId}`;
      const now = new Date().toISOString();
      const ttl = Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60); // 7 days

      await dynamoDB.send(new PutItemCommand({
        TableName: tableName,
        Item: marshall({
          pk,
          sk,
          jobId,
          tenant,
          userId,
          status: 'pending',
          createdAt: now,
          updatedAt: now,
          ttl,
          productId,
          creditTransactionId,
        }),
      }));

      console.info('Job created in DynamoDB', { jobId, tenant, userId });

      // Invoke worker Lambda asynchronously
      const workerPayload = {
        jobId,
        tenant,
        userId,
        creditTransactionId,
        requestBody: body,
        stage,
      };

      await lambda.send(new InvokeCommand({
        FunctionName: workerFunctionName,
        InvocationType: 'Event', // Async invocation
        Payload: Buffer.from(JSON.stringify(workerPayload)),
      }));

      console.info('Worker Lambda invoked asynchronously', { jobId, tenant });

      // Return 202 Accepted immediately
      return this.createJsonResponse({
        success: true,
        jobId,
        status: 'pending',
        message: 'Job accepted and queued for processing',
        statusUrl: `/bg-remover/status/${jobId}`,
      }, 202);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      console.error('Failed to create job', {
        jobId,
        tenant,
        userId,
        error: errorMessage,
      });

      return this.createErrorResponse(errorMessage, 500);
    }
  }
}

// Export the handler function for Lambda
export const process = async (event: any) => {
  const handler = new ProcessHandler();
  return handler.handle(event);
};