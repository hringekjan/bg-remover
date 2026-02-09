import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { BaseHandler } from './base-handler';
import { resolveTenantFromRequest } from '../lib/tenant/resolver';
import { validateJWTFromEvent } from '../lib/auth/jwt-validator';
import { loadTenantCognitoConfig } from '../lib/tenant/cognito-config';
import { createTenantCorsHeaders } from '../lib/cors';
import { extractRequestId } from '../lib/errors';
import { logSecurityEvent } from '../lib/logger';
const dynamoDB = new DynamoDBClient({
  requestHandler: new NodeHttpHandler({
    connectionTimeout: 5000,
    requestTimeout: 10000,
  }),
});
const tableName = process.env.DYNAMODB_TABLE || `carousel-main-${process.env.STAGE || 'dev'}`;

/**
 * Group Status Handler - Grouping Job Status Polling
 *
 * Allows clients to poll for grouping job status and results.
 * Returns the grouped images with thumbnails when complete.
 */
export class GroupStatusHandler extends BaseHandler {
  private async resolveCorsTenant(event: any, stage: string): Promise<string> {
    try {
      return await resolveTenantFromRequest(event, stage);
    } catch (error) {
      console.warn('CORS tenant resolution failed, using default', {
        error: error instanceof Error ? error.message : String(error),
      });
      return process.env.TENANT || 'carousel-labs';
    }
  }

  private buildTenantCorsHeaders(event: any, tenant: string): Record<string, string> {
    const corsHeaders = createTenantCorsHeaders(event, tenant);
    return {
      ...corsHeaders,
      'Vary': 'Origin, Authorization, X-Tenant-Id',
    };
  }

  private createCorsJsonResponse(
    body: any,
    statusCode: number,
    corsHeaders: Record<string, string>,
    additionalHeaders: Record<string, string> = {}
  ): any {
    return this.createJsonResponse(body, statusCode, {
      ...corsHeaders,
      ...additionalHeaders,
    });
  }

  private createCorsErrorResponse(
    message: string,
    statusCode: number,
    corsHeaders: Record<string, string>,
    details?: any,
    additionalHeaders: Record<string, string> = {}
  ): any {
    const errorBody = {
      error: message,
      ...(details && { details }),
      timestamp: new Date().toISOString(),
    };

    return this.createCorsJsonResponse(errorBody, statusCode, corsHeaders, {
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      'Pragma': 'no-cache',
      'Expires': '0',
      ...additionalHeaders,
    });
  }

  async handle(event: any): Promise<any> {
    console.log('GroupStatus function called', JSON.stringify(event, null, 2));
    const httpMethod = event.requestContext?.http?.method || event.httpMethod;
    const stage = this.context.stage;
    const corsTenant = await this.resolveCorsTenant(event, stage);
    const corsHeaders = this.buildTenantCorsHeaders(event, corsTenant);
    const requestId = extractRequestId(event);

    if (httpMethod === 'OPTIONS') {
      return this.createCorsJsonResponse('', 200, corsHeaders, {
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
      });
    }

    if (httpMethod !== 'GET') {
      return this.createCorsErrorResponse('Method Not Allowed', 405, corsHeaders);
    }

    const jobId = event.pathParameters?.jobId;

    if (!jobId) {
      return this.createCorsErrorResponse('jobId path parameter is required', 400, corsHeaders);
    }

    // Extract tenant and authenticate
    let tenant: string;
    let authResult = { isValid: false, userId: undefined as string | undefined, error: undefined as string | undefined };

    try {
      tenant = await resolveTenantFromRequest(event, stage);
      console.info('Resolved tenant for group status request', { tenant, jobId });
    } catch (error) {
      console.error('Tenant resolution failed', {
        error: error instanceof Error ? error.message : String(error),
        jobId,
      });
      tenant = process.env.TENANT || 'carousel-labs';
    }

    // JWT Authentication (required for grouping status)
    const requireAuth = true;
    let cognitoConfig;
    try {
      cognitoConfig = await loadTenantCognitoConfig(tenant, stage);
    } catch (error) {
      console.error('Failed to load tenant Cognito config', {
        tenant,
        error: error instanceof Error ? error.message : String(error),
        jobId,
      });
    }

    authResult = await validateJWTFromEvent(event, cognitoConfig, {
      required: requireAuth,
      expectedTenant: tenant,
      enforceTenantMatch: true,
    });

    if (!authResult.isValid && requireAuth) {
      logSecurityEvent('auth_failure', {
        authMethod: 'jwt',
        tenant,
        jobId,
        error: authResult.error,
        requestId,
      });
      console.warn('Authentication failed', {
        error: authResult.error,
        tenant,
        stage,
        path: event.requestContext?.http?.path,
        jobId,
      });

      return this.createCorsErrorResponse(
        'Valid JWT token required',
        401,
        corsHeaders,
        undefined,
        {
          'WWW-Authenticate': 'Bearer realm="bg-remover", error="invalid_token"',
        }
      );
    } else if (authResult.isValid && authResult.userId) {
      logSecurityEvent('auth_success', {
        authMethod: 'jwt',
        tenant,
        jobId,
        userId: authResult.userId,
        email: authResult.email,
        groups: authResult.groups,
        requestId,
      });
    }

    console.info('Group status request', {
      jobId,
      tenant,
      userId: authResult.userId || 'anonymous',
    });

    return this.getJobStatus(tenant, jobId, corsHeaders);
  }

  /**
   * Get grouping job status from DynamoDB
   */
  private async getJobStatus(
    tenant: string,
    jobId: string,
    corsHeaders: Record<string, string>,
  ): Promise<any> {
    const pk = `TENANT#${tenant}#BG_REMOVER_GROUPING_JOB#${jobId}`;
    const sk = 'METADATA';

    try {
      const result = await dynamoDB.send(new GetItemCommand({
        TableName: tableName,
        Key: {
          PK: { S: pk },
          SK: { S: sk },
        },
      }));

      if (!result.Item) {
        console.warn('Grouping job not found', { tenant, jobId });
        return this.createCorsErrorResponse('Grouping job not found', 404, corsHeaders);
      }

      const job = unmarshall(result.Item);

      // Build response based on status
      const response: any = {
        success: true,
        jobId: job.jobId,
        status: job.status,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        imageCount: job.imageCount,
        similarityThreshold: job.similarityThreshold,
      };

      // Add images array for per-product progress tracking (all statuses)
      response.images = job.images?.map((img: any) => ({
        imageId: img.imageId,
        status: img.status,
        progress: img.progress || 0,
        currentStep: img.currentStep,
        processedUrl: img.processedUrl,
        processingTimeMs: img.processingTimeMs,
      })) || [];

      // Add additional fields based on status
      if (job.status === 'completed') {
        response.groups = job.groups;
        response.summary = job.summary;
        response.processingTimeMs = job.processingTimeMs;
        response.completedAt = job.completedAt;
      } else if (job.status === 'failed') {
        response.error = job.error;
        response.processingTimeMs = job.processingTimeMs;
        response.completedAt = job.completedAt;
      } else if (job.status === 'processing') {
        response.startedAt = job.startedAt;
      }

      console.info('Grouping job status retrieved', { tenant, jobId, status: job.status });

      return this.createCorsJsonResponse(response, 200, corsHeaders);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      console.error('Failed to get grouping job status', {
        tenant,
        jobId,
        error: errorMessage,
        errorName: error instanceof Error ? error.name : 'Unknown',
        tableName,
      });

      return this.createCorsErrorResponse(errorMessage, 500, corsHeaders);
    }
  }
}

// Export the handler function for Lambda
export const groupStatus = async (event: any) => {
  try {
    const handler = new GroupStatusHandler();
    return await handler.handle(event);
  } catch (error) {
    const stage = process.env.STAGE || 'dev';
    let tenant = process.env.TENANT || 'carousel-labs';
    try {
      tenant = await resolveTenantFromRequest(event, stage);
    } catch (tenantError) {
      console.warn('Fallback tenant used for error response', {
        error: tenantError instanceof Error ? tenantError.message : String(tenantError),
      });
    }

    const corsHeaders = createTenantCorsHeaders(event, tenant);

    console.error('CRITICAL: Unhandled error in group status handler', {
      error: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : 'Unknown',
      errorStack: error instanceof Error ? error.stack : undefined,
      path: event.requestContext?.http?.path,
      jobId: event.pathParameters?.jobId,
    });

    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders,
        'Vary': 'Origin, Authorization, X-Tenant-Id',
      },
      body: JSON.stringify({
        error: 'Internal server error',
        message: process.env.STAGE === 'prod'
          ? 'An unexpected error occurred'
          : (error instanceof Error ? error.message : 'Unknown error'),
        timestamp: new Date().toISOString(),
      }),
    };
  }
};
