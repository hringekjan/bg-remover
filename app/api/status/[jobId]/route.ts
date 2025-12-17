/**
 * GET /api/status/[jobId] - Job Status Endpoint
 *
 * Retrieves the status and result of a background removal job.
 * Uses DynamoDB for persistent storage across Lambda cold starts.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  getJobStatus,
  setJobStatus,
  updateJobStatus,
  type JobStatus,
} from '@/lib/dynamo/job-store';

export const runtime = 'nodejs';

// Re-export for backwards compatibility
export { getJobStatus, setJobStatus };

const ParamsSchema = z.object({
  jobId: z.string().uuid('Invalid job ID format'),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
): Promise<NextResponse> {
  try {
    const resolvedParams = await params;

    // Validate job ID
    const validation = ParamsSchema.safeParse(resolvedParams);
    if (!validation.success) {
      return NextResponse.json(
        {
          error: 'Invalid job ID format',
          details: validation.error.errors,
        },
        { status: 400 }
      );
    }

    const { jobId } = validation.data;

    // Look up job status from DynamoDB
    const job = await getJobStatus(jobId);

    if (!job) {
      return NextResponse.json(
        {
          error: 'Job not found',
          jobId,
          message: 'The job may have expired or does not exist. Jobs are stored for 24 hours.',
        },
        { status: 404 }
      );
    }

    // Return job status with TTL info
    return NextResponse.json({
      jobId: job.jobId,
      status: job.status,
      progress: job.progress,
      result: job.result,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      expiresAt: job.expiresAt
        ? new Date(job.expiresAt * 1000).toISOString()
        : new Date(new Date(job.createdAt).getTime() + 24 * 60 * 60 * 1000).toISOString(),
    });
  } catch (error) {
    console.error('Error fetching job status', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });

    return NextResponse.json(
      {
        error: 'Internal server error',
        message: 'Failed to fetch job status',
      },
      { status: 500 }
    );
  }
}

// DELETE to cancel a pending job (optional)
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
): Promise<NextResponse> {
  try {
    const resolvedParams = await params;

    // Validate job ID
    const validation = ParamsSchema.safeParse(resolvedParams);
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Invalid job ID format' },
        { status: 400 }
      );
    }

    const { jobId } = validation.data;

    // Look up job status from DynamoDB
    const job = await getJobStatus(jobId);

    if (!job) {
      return NextResponse.json(
        { error: 'Job not found' },
        { status: 404 }
      );
    }

    // Can only cancel pending or processing jobs
    if (job.status !== 'pending' && job.status !== 'processing') {
      return NextResponse.json(
        {
          error: 'Cannot cancel job',
          message: `Job is already ${job.status}`,
        },
        { status: 409 }
      );
    }

    // Mark job as cancelled (using failed status) in DynamoDB
    await updateJobStatus(jobId, {
      status: 'failed',
      result: {
        success: false,
        error: 'Job cancelled by user',
      },
    });

    return NextResponse.json({
      jobId,
      status: 'cancelled',
      message: 'Job has been cancelled',
    });
  } catch (error) {
    console.error('Error cancelling job', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });

    return NextResponse.json(
      { error: 'Internal server error' },
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
      'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Tenant-Id',
    },
  });
}
