import { BaseHandler } from './base-handler';
import { randomUUID } from 'crypto';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { marshall } from '@aws-sdk/util-dynamodb';
import { ProcessRequestSchema } from '../lib/types';
import { validateRequest } from '../lib/validation';
import { resolveTenantFromRequest } from '../lib/tenant/resolver';
import { loadTenantCognitoConfig } from '../lib/tenant/cognito-config';
import { extractAuthContext, authorize } from '@carousellabs/rbac-access-kit';
import { validateAndDebitCredits } from '../lib/credits/client';
import { bgRemoverTelemetry, calculateBgRemoverCost } from '../lib/telemetry/bg-remover-telemetry';
import { issueJobToken } from '../lib/job-token';
import { EventTracker } from '../lib/event-tracking';
import { createTenantCorsHeaders } from '../lib/cors';

const dynamoDB = new DynamoDBClient({});
const eventTracker = new EventTracker(dynamoDB);
const lambda = new LambdaClient({});
const tableName = global.process.env.DYNAMODB_TABLE || `carousel-main-${global.process.env.STAGE || 'dev'}`;
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
    const startTime = Date.now();
    console.log('Process function called (async pattern)', JSON.stringify(event, null, 2));

    // Initialize agent state if needed
    // Temporarily disabled due to build issues
    // if (this.context.agentState.getState().status === 'stopped') {
    //   await this.context.agentState.initialize();
    // }

    const httpMethod = event.requestContext?.http?.method || event.httpMethod;

    if (httpMethod === 'OPTIONS') {
      const stage = this.context.stage;
      let tenant = 'unknown';
      try {
        tenant = await resolveTenantFromRequest(event, stage);
      } catch (error) {
        console.warn('[ProcessHandler] Failed to resolve tenant for OPTIONS', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      const corsHeaders = createTenantCorsHeaders(event, tenant);
      return this.createJsonResponse('', 200, {
        ...corsHeaders,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      });
    }

    if (httpMethod !== 'POST') {
      const corsHeaders = createTenantCorsHeaders(event, 'unknown');
      return this.createErrorResponse('Method Not Allowed', 405, corsHeaders);
    }

    const stage = this.context.stage;
    const jobId = randomUUID();
    let corsHeaders = createTenantCorsHeaders(event, 'unknown');

    // Record task start
    // Temporarily disabled due to build issues
    // await this.context.agentState.startTask(jobId, {
    //   operation: 'image_processing_request',
    //   stage,
    //   httpMethod
    // });

    // ===== TENANT RESOLUTION (BEFORE AUTH) =====
    // Resolve tenant from request (header, domain, or default)
    const tenant = await resolveTenantFromRequest(event, stage);
    corsHeaders = createTenantCorsHeaders(event, tenant);

    // Log request context for debugging
    console.log('[ProcessHandler] 📋 Request context:', {
      tenant,
      stage,
      requireAuth: true,
      host: event.headers?.host,
      path: event.requestContext?.http?.path,
      hasAuthHeader: !!event.headers?.authorization,
      jobId,
      timestamp: new Date().toISOString(),
    });

    // GALACTIC STANDARD RBAC: Extract and verify auth context
    // Load tenant-specific Cognito configuration for JWT validation
    let authContext;
    try {
      authContext = extractAuthContext(event, { defaultTenantId: tenant });

      // Enforce tenant isolation
      if (authContext.tenantId !== tenant) {
        return this.createErrorResponse('Tenant access mismatch', 403, corsHeaders);
      }

      // Perform RBAC check - Background removal requires staff or specific user roles
      const decision = await authorize(authContext, {
        action: 'remove_background',
        resource: 'image',
        isStaff: true // Staff/Admin always allowed, others checked via groups
      });

      if (!decision.allow) {
        console.warn('[ProcessHandler] ❌ Authorization denied', {
          reason: decision.reason,
          userId: authContext.userId,
          tenant,
          jobId,
        });
        return this.createErrorResponse(decision.reason || 'Forbidden', 403, corsHeaders);
      }

      console.info('[ProcessHandler] ✅ Authorized request', {
        userId: authContext.userId,
        email: authContext.email,
        groups: authContext.roles,
        tenant,
        jobId,
      });
    } catch (authError: any) {
      console.warn('[ProcessHandler] ❌ Authentication failed', {
        error: authError.message,
        tenant,
        jobId,
      });

      return this.createErrorResponse(authError.message || 'Unauthorized', 401, {
        ...corsHeaders,
        'WWW-Authenticate': 'Bearer realm="bg-remover", error="invalid_token"',
      });
    }
    // ===== END GALACTIC STANDARD RBAC =====

    const userId = authContext.userId;

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

      if (creditsRequired && authContext && authContext.userId) {
        console.info('Validating credits', {
          jobId,
          tenant,
          userId: authContext.userId,
          imageCount: 1,
        });

        const creditResult = await validateAndDebitCredits(
          tenant,
          authContext.userId,
          1, // 1 credit per image
          jobId,
          productId
        );

        if (!creditResult.success) {
          console.warn('Insufficient credits', {
            jobId,
            tenant,
            userId: authContext.userId,
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
          userId: authContext.userId,
          creditsUsed: creditResult.creditsUsed,
          newBalance: creditResult.newBalance,
          transactionId: creditResult.transactionId,
        });
      }
      // ===== END CREDITS VALIDATION =====

      // Create job record in DynamoDB
      const now = new Date().toISOString();
      const pk = `TENANT#${tenant}#BG_REMOVER_JOB#${jobId}`;
      const sk = 'METADATA';
      const gsi1pk = `TENANT#${tenant}#BG_REMOVER_JOBS`;
      const gsi1sk = `${now}#JOB#${jobId}`;
      const ttl = Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60); // 7 days

      await dynamoDB.send(new PutItemCommand({
        TableName: tableName,
        Item: marshall({
          PK: pk,
          SK: sk,
          GSI1PK: gsi1pk,
          GSI1SK: gsi1sk,
          jobId,
          tenant,
          userId,
          status: 'pending',
          createdAt: now,
          updatedAt: now,
          ttl,
          productId,
          creditTransactionId,
          entityType: 'BG_REMOVER_JOB',
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

      // Record successful task completion telemetry
      const processingTime = Date.now() - startTime;

      // Estimate cost for job acceptance (minimal, just coordinator overhead)
      const cost = calculateBgRemoverCost({
        imageSize: 1024 * 100, // Estimated ~100KB for coordinator
        processingTime,
        qualityLevel: 'low',
        imageCount: 1,
      });

      await bgRemoverTelemetry.recordImageProcessing({
        taskId: jobId,
        success: true,
        responseTimeMs: processingTime,
        costUsd: cost,
        metadata: {
          imageSize: 1024 * 100,
          processingMode: 'single',
          qualityLevel: 'coordinator',
          outputFormat: 'job-accepted',
          pipelineType: productId ? 'product-processing' : 'image-processing',
        },
      });
      await eventTracker.recordEvent(tenant, 'IMAGE_UPLOADED', processingTime);

      const jobToken = issueJobToken({
        jobId,
        tenant,
        userId: authResult.userId || undefined,
      });

      // Return 202 Accepted immediately
      return this.createJsonResponse({
        success: true,
        jobId,
        status: 'pending',
        message: 'Job accepted and queued for processing',
        statusUrl: `/bg-remover/status/${jobId}`,
        jobToken,
      }, 202, corsHeaders);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const processingTime = Date.now() - startTime;

      console.error('Failed to create job', {
        jobId,
        tenant,
        userId,
        error: errorMessage,
      });

      // Record failed task telemetry
      await bgRemoverTelemetry.recordImageProcessing({
        taskId: jobId,
        success: false,
        responseTimeMs: processingTime,
        costUsd: 0,
        error: {
          message: errorMessage,
          code: 'JOB_CREATION_FAILED',
          stack: error instanceof Error ? error.stack : undefined,
        },
      });
      await eventTracker.recordEvent(tenant, 'PROCESSING_FAILED', processingTime, errorMessage);

      return this.createErrorResponse(errorMessage, 500, corsHeaders);
    }
  }
}

// Export the handler function for Lambda
export const process = async (event: any) => {
  const handler = new ProcessHandler();
  return handler.handle(event);
};
