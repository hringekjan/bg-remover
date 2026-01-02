import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { BaseHandler } from './base-handler';
import { resolveTenantFromRequest } from '../lib/tenant/resolver';
import { validateJWTFromEvent } from '../lib/auth/jwt-validator';
import { loadTenantCognitoConfig } from '../lib/tenant/cognito-config';

const dynamoDB = new DynamoDBClient({});
const tableName = process.env.BG_REMOVER_TABLE_NAME!;

/**
 * Status Handler - Job Status Polling
 *
 * Allows clients to poll for job status and results.
 * Supports GET (retrieve status) and DELETE (cancel job).
 *
 * Response statuses:
 * - pending: Job queued, not yet started
 * - processing: Job currently being processed
 * - completed: Job finished successfully (includes result)
 * - failed: Job failed (includes error message)
 * - cancelled: Job was cancelled by user
 */
export class StatusHandler extends BaseHandler {
  async handle(event: any): Promise<any> {
    console.log('Status function called', JSON.stringify(event, null, 2));
    const httpMethod = event.requestContext?.http?.method || event.httpMethod;

    if (httpMethod === 'OPTIONS') {
      return this.createJsonResponse('', 200, {
        'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
      });
    }

    const stage = this.context.stage;
    const jobId = event.pathParameters?.jobId;

    // ===== TENANT RESOLUTION (BEFORE AUTH) =====
    let tenant: string;
    try {
      tenant = await resolveTenantFromRequest(event, stage);
      console.info('Resolved tenant for status request', { tenant, jobId });
    } catch (error) {
      console.error('Tenant resolution failed, using default', {
        error: error instanceof Error ? error.message : String(error),
        jobId,
      });
      tenant = process.env.TENANT || 'carousel-labs';
    }

    // ===== JWT AUTHENTICATION (WITH TENANT-SPECIFIC CONFIG) =====
    const requireAuth = stage === 'prod' || process.env.REQUIRE_AUTH === 'true';

    // Load tenant-specific Cognito configuration for JWT validation
    let cognitoConfig;
    try {
      cognitoConfig = await loadTenantCognitoConfig(tenant, stage);
      console.debug('Using Cognito config for tenant', {
        tenant,
        userPoolId: cognitoConfig.userPoolId,
        jobId,
      });
    } catch (error) {
      console.error('Failed to load tenant Cognito config, falling back to default', {
        tenant,
        error: error instanceof Error ? error.message : String(error),
        jobId,
      });
      // Continue with default config on error - loadTenantCognitoConfig already has fallback
      cognitoConfig = undefined;
    }

    const authResult = await validateJWTFromEvent(event, cognitoConfig, {
      required: requireAuth
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
    // ===== END JWT AUTHENTICATION =====

    if (!jobId) {
      return this.createErrorResponse('jobId path parameter is required', 400);
    }

    console.info('Status request', {
      jobId,
      tenant,
      method: httpMethod,
      userId: authResult.userId || 'anonymous',
    });

    if (httpMethod === 'GET') {
      return this.getJobStatus(tenant, jobId, authResult.userId);
    } else if (httpMethod === 'DELETE') {
      return this.cancelJob(tenant, jobId, authResult.userId);
    } else {
      return this.createErrorResponse('Method Not Allowed', 405);
    }
  }

  /**
   * Get job status from DynamoDB
   */
  private async getJobStatus(tenant: string, jobId: string, userId?: string): Promise<any> {
    const pk = `TENANT#${tenant}#JOB`;
    const sk = `JOB#${jobId}`;

    try {
      const result = await dynamoDB.send(new GetItemCommand({
        TableName: tableName,
        Key: marshall({ pk, sk }),
      }));

      if (!result.Item) {
        console.warn('Job not found', { tenant, jobId });
        return this.createErrorResponse('Job not found', 404);
      }

      const job = unmarshall(result.Item);

      // Authorization check: Only allow access if user owns the job (in prod)
      const stage = this.context.stage;
      if (stage === 'prod' && userId && job.userId !== userId) {
        console.warn('Unauthorized access attempt', {
          tenant,
          jobId,
          requestingUser: userId,
          jobOwner: job.userId,
        });
        return this.createErrorResponse('Not authorized to access this job', 403);
      }

      // Build response based on status
      const response: any = {
        success: true,
        jobId: job.jobId,
        status: job.status,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      };

      // Add additional fields based on status
      if (job.status === 'completed') {
        response.outputUrl = job.outputUrl;
        response.processingTimeMs = job.processingTimeMs;
        response.metadata = job.metadata;
        response.productDescription = job.productDescription;
        response.multilingualDescription = job.multilingualDescription;
        response.bilingualDescription = job.bilingualDescription;
        response.completedAt = job.completedAt;
      } else if (job.status === 'failed') {
        response.error = job.error;
        response.errorDetails = job.errorDetails;
        response.completedAt = job.completedAt;
        response.refundStatus = job.refundStatus;
        response.refundTransactionId = job.refundTransactionId;
      } else if (job.status === 'processing') {
        response.startedAt = job.startedAt;
      }

      console.info('Job status retrieved', { tenant, jobId, status: job.status });

      return this.createJsonResponse(response);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      console.error('Failed to get job status', {
        tenant,
        jobId,
        error: errorMessage,
        errorName: error instanceof Error ? error.name : 'Unknown',
        tableName,
      });

      // Classify DynamoDB errors for appropriate HTTP status codes
      if (error instanceof Error) {
        // Throttling errors - temporary issue, client should retry
        if (error.name === 'ProvisionedThroughputExceededException' ||
            error.name === 'RequestLimitExceeded') {
          return this.createErrorResponse(
            'Service temporarily unavailable. Please retry in a few seconds.',
            503
          );
        }

        // Permission errors - configuration issue
        if (error.name === 'AccessDeniedException') {
          console.error('CRITICAL: DynamoDB permission denied', { tenant, jobId });
          return this.createErrorResponse(
            'Unable to retrieve job status. Please contact support.',
            500
          );
        }

        // Table not found - deployment issue
        if (error.name === 'ResourceNotFoundException') {
          console.error('CRITICAL: DynamoDB table not found', { tableName, tenant });
          return this.createErrorResponse(
            'Service configuration error. Please contact support.',
            500
          );
        }
      }

      // Generic error - sanitize message in production
      const userMessage = this.context.stage === 'prod'
        ? 'Failed to retrieve job status. Please try again later.'
        : errorMessage;

      return this.createErrorResponse(userMessage, 500);
    }
  }

  /**
   * Cancel a pending or processing job
   */
  private async cancelJob(tenant: string, jobId: string, userId?: string): Promise<any> {
    const pk = `TENANT#${tenant}#JOB`;
    const sk = `JOB#${jobId}`;

    try {
      // First, get the current job to check ownership and status
      const getResult = await dynamoDB.send(new GetItemCommand({
        TableName: tableName,
        Key: marshall({ pk, sk }),
      }));

      if (!getResult.Item) {
        console.warn('Job not found for cancellation', { tenant, jobId });
        return this.createErrorResponse('Job not found', 404);
      }

      const job = unmarshall(getResult.Item);

      // Authorization check
      const stage = this.context.stage;
      if (stage === 'prod' && userId && job.userId !== userId) {
        console.warn('Unauthorized cancellation attempt', {
          tenant,
          jobId,
          requestingUser: userId,
          jobOwner: job.userId,
        });
        return this.createErrorResponse('Not authorized to cancel this job', 403);
      }

      // Check if job can be cancelled
      if (job.status === 'completed' || job.status === 'failed') {
        return this.createErrorResponse(
          `Cannot cancel job with status: ${job.status}`,
          400
        );
      }

      if (job.status === 'cancelled') {
        return this.createJsonResponse({
          success: true,
          jobId,
          status: 'cancelled',
          message: 'Job already cancelled',
        });
      }

      // Update job status to cancelled
      await dynamoDB.send(new UpdateItemCommand({
        TableName: tableName,
        Key: marshall({ pk, sk }),
        UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt, cancelledAt = :cancelledAt',
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: marshall({
          ':status': 'cancelled',
          ':updatedAt': new Date().toISOString(),
          ':cancelledAt': new Date().toISOString(),
        }),
      }));

      console.info('Job cancelled successfully', { tenant, jobId, previousStatus: job.status });

      // Note: The worker Lambda should check job status before processing
      // and abort if status is 'cancelled'

      return this.createJsonResponse({
        success: true,
        jobId,
        status: 'cancelled',
        message: 'Job cancelled successfully',
        previousStatus: job.status,
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      console.error('Failed to cancel job', {
        tenant,
        jobId,
        error: errorMessage,
      });

      return this.createErrorResponse(errorMessage, 500);
    }
  }
}

// Export the handler function for Lambda
export const status = async (event: any) => {
  const handler = new StatusHandler();
  return handler.handle(event);
};
