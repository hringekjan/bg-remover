import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { GroupImagesRequestSchema, type GroupImagesRequest } from '@/src/lib/types';
import { validateRequest } from '@/src/lib/validation';
import { resolveTenantFromRequest } from '@/src/lib/tenant/resolver';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const dynamoDB = new DynamoDBClient({});
const lambdaClient = new LambdaClient({});
const tableName = process.env.DYNAMODB_TABLE || 'bg-remover-dev';

/**
 * Group Images API - Async Coordinator (Next.js Route Handler)
 * 
 * Async workflow to avoid API Gateway 30s timeout:
 * 1. Accept grouping request and create job in DynamoDB
 * 2. Invoke async worker for actual processing
 * 3. Return job ID immediately for status polling
 * 4. Worker generates thumbnails, embeddings, and clustering
 * 5. Store results for status endpoint retrieval
 */

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  let jobId: string | undefined;
  let tenant: string | undefined;

  try {
    // Convert NextRequest to event-like object for resolver
    const event = {
      headers: Object.fromEntries(request.headers.entries()),
      pathParameters: {},
    };
    const stage = process.env.STAGE || 'dev';

    // Extract tenant from request
    tenant = await resolveTenantFromRequest(event, stage);

    console.log('[GroupImages] Creating async grouping job', {
      tenant,
      stage,
      requestId,
    });

    // Parse and validate request
    const body = await request.json();
    const validation = validateRequest(GroupImagesRequestSchema, body, 'group-images');

    if (!validation.success) {
      return NextResponse.json(
        {
          error: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          errors: validation.error?.details,
        },
        { status: 400 }
      );
    }

    const groupRequest = validation.data as GroupImagesRequest;
    const {
      images,
      thumbnailSize = { width: 256, height: 256 },
      similarityThreshold = 0.92,
      includeExistingEmbeddings = true,
    } = groupRequest;

    console.log('[GroupImages] Request validated', {
      imageCount: images.length,
      thumbnailSize,
      similarityThreshold,
      includeExistingEmbeddings,
      tenant,
    });

    // Create grouping job in DynamoDB first (fast operation)
    jobId = randomUUID();
    const pk = `TENANT#${tenant}#BG_REMOVER_GROUPING_JOB#${jobId}`;
    const sk = 'METADATA';
    const gsi1pk = `TENANT#${tenant}#BG_REMOVER_GROUPING_JOBS`;
    const gsi1sk = `${new Date().toISOString()}#JOB#${jobId}`;
    const now = new Date().toISOString();

    await dynamoDB.send(new PutItemCommand({
      TableName: tableName,
      Item: marshall({
        PK: pk,
        SK: sk,
        GSI1PK: gsi1pk,
        GSI1SK: gsi1sk,
        jobId,
        tenant,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
        ttl: Math.floor(Date.now() / 1000) + 86400 * 7, // 7 days retention
        entityType: 'BG_REMOVER_GROUPING_JOB',
        imageCount: images.length,
        thumbnailSize,
        similarityThreshold,
        includeExistingEmbeddings,
        requestId,
      }),
    }));

    console.log('[GroupImages] Grouping job created in DynamoDB', { jobId, tenant });

    // Invoke grouping worker asynchronously
    const workerFunctionName = process.env.GROUPING_WORKER_FUNCTION_NAME || `bg-remover-${stage}-groupImagesWorker`;
    
    const workerPayload = {
      jobId,
      tenant,
      stage,
      images,
      thumbnailSize,
      similarityThreshold,
      includeExistingEmbeddings,
      requestId,
    };

    const invokeCommand = new InvokeCommand({
      FunctionName: workerFunctionName,
      InvocationType: 'Event', // Async invocation - fire and forget
      Payload: Buffer.from(JSON.stringify(workerPayload)),
    });

    // Add timeout to Lambda invocation
    const invokePromise = lambdaClient.send(invokeCommand);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Lambda invocation timeout')), 10000) // 10s timeout
    );

    await Promise.race([invokePromise, timeoutPromise]);

    console.log('[GroupImages] Grouping worker invoked asynchronously', {
      jobId,
      workerFunctionName,
      tenant,
      imageCount: images.length,
    });

    // Return job ID immediately for status polling (within 30s API Gateway limit)
    return NextResponse.json({
      jobId,
      status: 'pending',
      message: 'Grouping job accepted and queued for processing',
      statusUrl: `/bg-remover/group-status/${jobId}`,
      estimatedDuration: '30-180 seconds', // Based on image count
      requestId,
    }, { status: 202 });

  } catch (error: any) {
    console.error('[GroupImages] Request failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      requestId,
    });

    // If we created a job, mark it as failed
    if (jobId && tenant) {
      try {
        const pk = `TENANT#${tenant}#BG_REMOVER_GROUPING_JOB#${jobId}`;
        const sk = 'METADATA';
        
        await dynamoDB.send(new PutItemCommand({
          TableName: tableName,
          Item: marshall({
            PK: pk,
            SK: sk,
            jobId,
            tenant,
            status: 'failed',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            ttl: Math.floor(Date.now() / 1000) + 86400 * 7, // 7 days retention
            entityType: 'BG_REMOVER_GROUPING_JOB',
            error: error instanceof Error ? error.message : 'Unknown error occurred',
            requestId,
          }),
        }));
      } catch (updateError) {
        console.error('[GroupImages] Failed to update job status', {
          jobId,
          updateError: updateError instanceof Error ? updateError.message : String(updateError),
        });
      }
    }

    return NextResponse.json(
      {
        error: 'GROUPING_FAILED',
        message: error instanceof Error ? error.message : 'Unknown error occurred',
        requestId,
      },
      { status: 500 }
    );
  }
}

// OPTIONS for CORS preflight
export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Tenant-Id',
    },
  });
}
