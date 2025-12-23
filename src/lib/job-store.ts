/**
 * DynamoDB-backed Job Store for bg-remover service
 *
 * Provides persistent job status storage across Lambda invocations.
 * Uses DynamoDB single-table design with TTL for automatic cleanup.
 *
 * Single-table key format:
 * - pk: TENANT#<tenant>#JOB
 * - sk: JOB#<jobId>
 *
 * This enables efficient tenant queries and shared table with rate limits.
 */

import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  DeleteItemCommand,
  UpdateItemCommand,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';

// ============================================================================
// Types
// ============================================================================

export interface JobStatus {
  jobId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress?: number;
  result?: {
    success: boolean;
    outputUrl?: string;
    error?: string;
    processingTimeMs?: number;
    metadata?: {
      width: number;
      height: number;
      originalSize: number;
      processedSize: number;
    };
  };
  createdAt: string;
  updatedAt: string;
  expiresAt?: number; // TTL timestamp (seconds since epoch)
  tenant?: string;
  userId?: string;
}

// ============================================================================
// Configuration
// ============================================================================

// Single-table design: shared table with rate limiter
const TABLE_NAME = process.env.BG_REMOVER_TABLE_NAME || process.env.JOB_STORE_TABLE_NAME || 'bg-remover-dev';
const JOB_TTL_SECONDS = 24 * 60 * 60; // 24 hours
const DEFAULT_TENANT = process.env.TENANT || 'default';

// ============================================================================
// Key Generation (Single-Table Design)
// ============================================================================

/**
 * Generate pk/sk for a job (single-table design)
 */
function generateJobKeys(jobId: string, tenant: string = DEFAULT_TENANT): { pk: string; sk: string } {
  return {
    pk: `TENANT#${tenant}#JOB`,
    sk: `JOB#${jobId}`,
  };
}

// Lazy-initialized DynamoDB client
let dynamoClient: DynamoDBClient | null = null;

function getClient(): DynamoDBClient {
  if (!dynamoClient) {
    dynamoClient = new DynamoDBClient({
      region: process.env.AWS_REGION || 'eu-west-1',
    });
  }
  return dynamoClient;
}

// ============================================================================
// Job Store Functions
// ============================================================================

/**
 * Get job status from DynamoDB
 *
 * @param jobId - The job identifier
 * @param tenant - Optional tenant (defaults to env TENANT or 'default')
 */
export async function getJobStatus(jobId: string, tenant?: string): Promise<JobStatus | null> {
  const client = getClient();
  const { pk, sk } = generateJobKeys(jobId, tenant || DEFAULT_TENANT);

  try {
    const result = await client.send(
      new GetItemCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: { S: pk },
          sk: { S: sk },
        },
      })
    );

    if (!result.Item) {
      return null;
    }

    return unmarshall(result.Item) as JobStatus;
  } catch (error) {
    console.error('Failed to get job status from DynamoDB', {
      jobId,
      tenant: tenant || DEFAULT_TENANT,
      error: error instanceof Error ? error.message : String(error),
      tableName: TABLE_NAME,
    });
    throw error;
  }
}

/**
 * Create or update job status in DynamoDB (single-table design)
 */
export async function setJobStatus(job: JobStatus): Promise<void> {
  const client = getClient();
  const tenant = job.tenant || DEFAULT_TENANT;
  const { pk, sk } = generateJobKeys(job.jobId, tenant);

  // Set TTL if not already set
  const jobWithTTL: JobStatus & { pk: string; sk: string; entityType: string } = {
    ...job,
    pk,
    sk,
    entityType: 'JOB', // For GSI queries by entity type
    tenant, // Ensure tenant is always set
    expiresAt: job.expiresAt || Math.floor(Date.now() / 1000) + JOB_TTL_SECONDS,
    updatedAt: new Date().toISOString(),
  };

  try {
    await client.send(
      new PutItemCommand({
        TableName: TABLE_NAME,
        Item: marshall(jobWithTTL, {
          removeUndefinedValues: true,
        }),
      })
    );
  } catch (error) {
    console.error('Failed to set job status in DynamoDB', {
      jobId: job.jobId,
      tenant,
      error: error instanceof Error ? error.message : String(error),
      tableName: TABLE_NAME,
    });
    throw error;
  }
}

/**
 * Update job status (partial update)
 *
 * @param jobId - The job identifier
 * @param updates - Partial job updates
 * @param tenant - Optional tenant (defaults to env TENANT or 'default')
 */
export async function updateJobStatus(
  jobId: string,
  updates: Partial<Omit<JobStatus, 'jobId'>>,
  tenant?: string
): Promise<JobStatus | null> {
  const client = getClient();
  const { pk, sk } = generateJobKeys(jobId, tenant || DEFAULT_TENANT);

  // Build update expression
  const updateExpressions: string[] = ['#updatedAt = :updatedAt'];
  const expressionAttributeNames: Record<string, string> = {
    '#updatedAt': 'updatedAt',
  };
  const expressionAttributeValues: Record<string, any> = {
    ':updatedAt': new Date().toISOString(),
  };

  if (updates.status !== undefined) {
    updateExpressions.push('#status = :status');
    expressionAttributeNames['#status'] = 'status';
    expressionAttributeValues[':status'] = updates.status;
  }

  if (updates.progress !== undefined) {
    updateExpressions.push('#progress = :progress');
    expressionAttributeNames['#progress'] = 'progress';
    expressionAttributeValues[':progress'] = updates.progress;
  }

  if (updates.result !== undefined) {
    updateExpressions.push('#result = :result');
    expressionAttributeNames['#result'] = 'result';
    expressionAttributeValues[':result'] = updates.result;
  }

  try {
    const result = await client.send(
      new UpdateItemCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: { S: pk },
          sk: { S: sk },
        },
        UpdateExpression: `SET ${updateExpressions.join(', ')}`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: marshall(expressionAttributeValues),
        ReturnValues: 'ALL_NEW',
        ConditionExpression: 'attribute_exists(pk)',
      })
    );

    if (!result.Attributes) {
      return null;
    }

    return unmarshall(result.Attributes) as JobStatus;
  } catch (error: any) {
    if (error.name === 'ConditionalCheckFailedException') {
      return null; // Job doesn't exist
    }
    console.error('Failed to update job status in DynamoDB', {
      jobId,
      tenant: tenant || DEFAULT_TENANT,
      error: error instanceof Error ? error.message : String(error),
      tableName: TABLE_NAME,
    });
    throw error;
  }
}

/**
 * Delete job from DynamoDB
 *
 * @param jobId - The job identifier
 * @param tenant - Optional tenant (defaults to env TENANT or 'default')
 */
export async function deleteJob(jobId: string, tenant?: string): Promise<boolean> {
  const client = getClient();
  const { pk, sk } = generateJobKeys(jobId, tenant || DEFAULT_TENANT);

  try {
    await client.send(
      new DeleteItemCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: { S: pk },
          sk: { S: sk },
        },
        ConditionExpression: 'attribute_exists(pk)',
      })
    );
    return true;
  } catch (error: any) {
    if (error.name === 'ConditionalCheckFailedException') {
      return false; // Job doesn't exist
    }
    console.error('Failed to delete job from DynamoDB', {
      jobId,
      tenant: tenant || DEFAULT_TENANT,
      error: error instanceof Error ? error.message : String(error),
      tableName: TABLE_NAME,
    });
    throw error;
  }
}

/**
 * Create a new job with initial status
 */
export async function createJob(
  jobId: string,
  tenant?: string,
  userId?: string
): Promise<JobStatus> {
  const now = new Date().toISOString();
  const job: JobStatus = {
    jobId,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    expiresAt: Math.floor(Date.now() / 1000) + JOB_TTL_SECONDS,
    tenant,
    userId,
  };

  await setJobStatus(job);
  return job;
}

/**
 * Mark job as processing
 */
export async function markJobProcessing(
  jobId: string,
  progress?: number,
  tenant?: string
): Promise<JobStatus | null> {
  return updateJobStatus(jobId, {
    status: 'processing',
    progress,
  }, tenant);
}

/**
 * Mark job as completed with result
 */
export async function markJobCompleted(
  jobId: string,
  result: JobStatus['result'],
  tenant?: string
): Promise<JobStatus | null> {
  return updateJobStatus(jobId, {
    status: 'completed',
    progress: 100,
    result,
  }, tenant);
}

/**
 * Mark job as failed with error
 */
export async function markJobFailed(
  jobId: string,
  error: string,
  processingTimeMs?: number,
  tenant?: string
): Promise<JobStatus | null> {
  return updateJobStatus(jobId, {
    status: 'failed',
    result: {
      success: false,
      error,
      processingTimeMs,
    },
  }, tenant);
}

// ============================================================================
// Multi-Tenant Admin Functions
// ============================================================================

/**
 * Query all jobs for a specific tenant
 * Uses single-table design with pk prefix for efficient tenant queries
 *
 * @param tenant - Tenant identifier
 * @param options - Query options (limit, status filter)
 * @returns Array of jobs for the tenant
 */
export async function getJobsByTenant(
  tenant: string,
  options?: { limit?: number; status?: JobStatus['status'] }
): Promise<JobStatus[]> {
  const client = getClient();
  const pk = `TENANT#${tenant}#JOB`;

  try {
    const queryParams: any = {
      TableName: TABLE_NAME,
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: {
        '#pk': 'pk',
      },
      ExpressionAttributeValues: {
        ':pk': { S: pk },
      },
      Limit: options?.limit || 100,
      ScanIndexForward: false, // Most recent first
    };

    // Add status filter if specified
    if (options?.status) {
      queryParams.FilterExpression = '#status = :status';
      queryParams.ExpressionAttributeNames['#status'] = 'status';
      queryParams.ExpressionAttributeValues[':status'] = { S: options.status };
    }

    const result = await client.send(new QueryCommand(queryParams));

    return (result.Items || []).map(item => unmarshall(item) as JobStatus);
  } catch (error) {
    console.error('Failed to query jobs by tenant', {
      tenant,
      error: error instanceof Error ? error.message : String(error),
      tableName: TABLE_NAME,
    });
    return [];
  }
}

/**
 * Get job statistics for a tenant
 *
 * @param tenant - Tenant identifier
 * @returns Job statistics
 */
export async function getTenantJobStats(tenant: string): Promise<{
  tenant: string;
  totalJobs: number;
  statusBreakdown: Record<string, number>;
  completedCount: number;
  failedCount: number;
  pendingCount: number;
}> {
  const jobs = await getJobsByTenant(tenant, { limit: 1000 });

  const statusBreakdown: Record<string, number> = {};
  for (const job of jobs) {
    statusBreakdown[job.status] = (statusBreakdown[job.status] || 0) + 1;
  }

  return {
    tenant,
    totalJobs: jobs.length,
    statusBreakdown,
    completedCount: statusBreakdown['completed'] || 0,
    failedCount: statusBreakdown['failed'] || 0,
    pendingCount: statusBreakdown['pending'] || 0,
  };
}
