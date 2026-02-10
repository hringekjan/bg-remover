/**
 * POST /api/process-groups
 *
 * Phase 3 of BG-Remover workflow: Process approved image groups
 *
 * Complete processing pipeline using AWS Bedrock foundational models:
 * - Amazon Nova Canvas (amazon.nova-canvas-v1:0) - Background removal
 * - Amazon Nova Lite/Pro (smart routing) - English product descriptions
 * - OpenAI GPT-OSS 20B (openai.gpt-oss-safeguard-20b) - Icelandic translation
 *
 * @implements processImageFromBase64 which orchestrates all 3 models automatically
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import {
  processImageFromBase64,
  type BilingualProductDescription,
} from '@/lib/bedrock/image-processor';
import { setJobStatus, updateJobStatus } from '@/lib/dynamo/job-store';
import { uploadProcessedImage, generateOutputKey, getOutputBucket } from '@/lib/s3/client';
import { executeWithTimeouts, TimeoutError } from '@/src/lib/utils/timeout';

export const runtime = 'nodejs';
export const maxDuration = 300; // 5 minutes for batch processing

interface ProcessGroupRequest {
  groups: Array<{
    groupId: string;
    imageIds: string[];
    productName?: string;
  }>;
  originalImages: Record<string, string>; // imageId -> base64 data
  processingOptions?: {
    outputFormat?: 'png' | 'jpeg' | 'webp';
    quality?: number;
    generateDescription?: boolean;
    languages?: string[]; // ['en', 'is']
  };
}

interface ProcessedImageResult {
  imageId: string;
  processedUrl: string; // S3 URL of processed image (essential for display)
  // Flattened minimal metadata (replaces large nested object)
  width: number;
  height: number;
  status: 'completed' | 'failed';
  processingTimeMs: number;
  // description removed to reduce payload size (was 2KB per image)
  // Full descriptions available via separate endpoint if needed
}

/**
 * POST /api/process-groups
 *
 * Processes approved image groups through complete pipeline:
 * 1. Background removal (Nova Canvas)
 * 2. Description generation (Nova Lite/Pro)
 * 3. Translation (GPT-OSS 20B)
 * 4. S3 upload
 * 5. DynamoDB job tracking
 */
export async function POST(request: NextRequest) {
  const startTime = Date.now();
  const requestId = randomUUID();

  try {
    const body: ProcessGroupRequest = await request.json();
    const { groups, originalImages, processingOptions = {} } = body;

    // Validate request
    if (!groups || !Array.isArray(groups) || groups.length === 0) {
      return NextResponse.json(
        { error: 'Groups array is required and must not be empty' },
        { status: 400 }
      );
    }

    if (!originalImages || typeof originalImages !== 'object') {
      return NextResponse.json(
        { error: 'Original images map is required' },
        { status: 400 }
      );
    }

    // Extract tenant from headers (set by auth middleware in carousel-frontend proxy)
    const tenant = request.headers.get('x-tenant-id') || 'carousel-labs';
    const userId = request.headers.get('x-user-id');

    if (!userId) {
      console.error('Missing user ID in request headers');
      return NextResponse.json(
        { error: 'Authentication required', message: 'Missing user ID' },
        { status: 401 }
      );
    }

    console.log('Starting batch group processing', {
      requestId,
      tenant,
      userId,
      groupCount: groups.length,
      totalImages: groups.reduce((sum, g) => sum + g.imageIds.length, 0),
      processingOptions,
    });

    const jobs: Array<{
      jobId: string;
      groupId: string;
      productName: string;
      status: 'processing';
      imageCount: number;
      jobToken?: string;
    }> = [];

    // Create jobs for each group (async processing)
    for (const group of groups) {
      const jobId = randomUUID();
      const jobToken = randomUUID(); // Secure token for status polling

      // Create initial job record in DynamoDB
      await setJobStatus(jobId, {
        jobId,
        userId,
        tenant,
        status: 'processing',
        progress: 0,
        createdAt: new Date().toISOString(),
        metadata: {
          groupId: group.groupId,
          productName: group.productName || `Product Group ${group.groupId}`,
          imageCount: group.imageIds.length,
        },
      });

      jobs.push({
        jobId,
        groupId: group.groupId,
        productName: group.productName || `Product ${group.groupId}`,
        status: 'processing',
        imageCount: group.imageIds.length,
        jobToken,
      });

      // Start async processing (don't await - process in background)
      processGroupImages(
        jobId,
        group,
        originalImages,
        processingOptions,
        tenant,
        userId
      ).catch(error => {
        console.error(`Error processing job ${jobId}:`, error);
        updateJobStatus(jobId, {
          status: 'failed',
          result: {
            success: false,
            error: error instanceof Error ? error.message : 'Processing failed',
          },
        });
      });
    }

    const processingTimeMs = Date.now() - startTime;

    console.log('Batch processing initiated successfully', {
      requestId,
      jobsCreated: jobs.length,
      processingTimeMs,
    });

    return NextResponse.json({
      jobs,
      summary: {
        totalGroups: groups.length,
        jobsCreated: jobs.length,
        pipeline: 'bedrock-foundational-models',
        models: {
          backgroundRemoval: 'amazon.nova-canvas-v1:0',
          descriptionGeneration: 'amazon.nova-lite-v1:0 or amazon.nova-pro-v1:0 (smart routing)',
          translation: 'openai.gpt-oss-safeguard-20b',
        },
      },
      statusEndpoint: '/bg-remover/status',
      requestId,
      processingTimeMs,
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Batch processing request failed:', {
      requestId,
      error: errorMessage,
      stack: error instanceof Error ? error.stack : undefined,
    });

    return NextResponse.json(
      {
        error: 'Failed to start processing',
        message: process.env.NODE_ENV === 'production' ? 'Processing failed' : errorMessage,
        requestId,
      },
      { status: 500 }
    );
  }
}

/**
 * Process all images in a group
 *
 * Uses existing processImageFromBase64() which orchestrates:
 * 1. removeBackgroundDirect() → amazon.nova-canvas-v1:0 (us-east-1)
 * 2. generateBilingualDescription() which calls:
 *    - analyzeImageForDescription() → amazon.nova-lite-v1:0 or amazon.nova-pro-v1:0 (eu-west-1)
 *    - translateToIcelandic() → openai.gpt-oss-safeguard-20b (eu-west-1)
 */
async function processGroupImages(
  jobId: string,
  group: ProcessGroupRequest['groups'][0],
  originalImages: Record<string, string>,
  options: ProcessGroupRequest['processingOptions'],
  tenant: string,
  userId: string
): Promise<void> {
  const processedImages: ProcessedImageResult[] = [];
  let progress = 0;
  const totalImages = group.imageIds.length;

  try {
    console.log(`Starting PARALLEL processing for job ${jobId}`, {
      groupId: group.groupId,
      imageCount: totalImages,
      productName: group.productName,
      parallelProcessing: true,
      timeouts: {
        perImage: '30 seconds',
        batch: '2 minutes',
      },
    });

    // Create processing tasks for all images
    const processingTasks = group.imageIds.map((imageId, index) => async () => {
      const base64Image = originalImages[imageId];

      if (!base64Image) {
        throw new Error(`Missing image data for ${imageId}`);
      }

      // Process image using existing implementation
      // This single call orchestrates ALL 3 models:
      // 1. Amazon Nova Canvas - background removal
      // 2. Amazon Nova Lite/Pro - English description (smart routing)
      // 3. GPT-OSS 20B - Icelandic translation
      const result = await processImageFromBase64(
        base64Image,
        'image/png',
        {
          format: options?.outputFormat || 'png',
          quality: options?.quality || 95,
          generateDescription: options?.generateDescription !== false,
          productName: group.productName,
        },
        tenant,
        process.env.STAGE || 'dev'
      );

      // Upload processed image to S3
      const resolvedOutputFormat = options?.outputFormat || 'png';
      const outputKey = generateOutputKey(
        tenant,
        group.productName || `product-${group.groupId}`,
        resolvedOutputFormat
      );
      const contentType = resolvedOutputFormat === 'png' ? 'image/png' :
                         resolvedOutputFormat === 'webp' ? 'image/webp' : 'image/jpeg';

      const outputBucket = await getOutputBucket(tenant);
      const outputUrl = await uploadProcessedImage(
        outputBucket,
        outputKey,
        result.outputBuffer,
        contentType,
        {
          'job-id': jobId,
          'group-id': group.groupId,
          'image-id': imageId,
          'tenant': tenant,
          'user-id': userId,
          'original-index': String(index),
        }
      );

      // 🔧 FIX: Return minimal payload to prevent 413 Content Too Large
      // Reduced from ~2KB per image to ~200 bytes
      return {
        imageId,
        processedUrl: outputUrl, // S3 URL for display
        width: result.metadata.width,
        height: result.metadata.height,
        status: 'completed' as const,
        processingTimeMs: result.metadata.processingTimeMs,
      };
      // Description removed from response (was causing 200KB+ for 100 images)
      // Descriptions stored in S3 metadata and available via separate endpoint if needed
    });

    // Execute all tasks in parallel with timeouts
    // Individual timeout: 30 seconds per image
    // Batch timeout: 120 seconds (2 minutes) for entire batch
    const results = await executeWithTimeouts(
      processingTasks,
      30000, // 30s per image
      120000 // 2min batch timeout
    );

    // Process results from parallel execution
    let successCount = 0;
    let failureCount = 0;
    let timeoutCount = 0;

    results.forEach((result, index) => {
      const imageId = group.imageIds[index];

      if (result.status === 'fulfilled') {
        processedImages.push(result.value);
        successCount++;
        console.log(`✓ Image ${index + 1}/${totalImages} processed successfully:`, imageId);
      } else {
        failureCount++;
        const errorMsg = result.reason instanceof Error ? result.reason.message : 'Unknown error';
        const isTimeout = result.reason instanceof TimeoutError;

        if (isTimeout) {
          timeoutCount++;
          console.warn(`⏱ Image ${index + 1}/${totalImages} timed out:`, imageId, errorMsg);
        } else {
          console.error(`✗ Image ${index + 1}/${totalImages} failed:`, imageId, errorMsg);
        }
      }
    });

    // Update final progress
    progress = 100;
    await updateJobStatus(jobId, {
      progress,
      processedImages,
    });

    console.log(`Parallel processing completed for job ${jobId}`, {
      total: totalImages,
      successful: successCount,
      failed: failureCount,
      timedOut: timeoutCount,
      duration: `${Date.now() - new Date().getTime()}ms`,
    });

    // Determine final status based on results
    // 'completed' - all successful
    // 'partial' - some successful, some failed
    // 'failed' - none successful
    const status = successCount === totalImages ? 'completed' :
                   successCount > 0 ? 'partial' :
                   'failed';

    await updateJobStatus(jobId, {
      status,
      progress: 100,
      completedAt: new Date().toISOString(),
      result: {
        success: successCount > 0,
        processedImages,
        summary: {
          totalImages,
          successful: successCount,
          failed: failureCount,
          timedOut: timeoutCount,
        },
      },
    });

    console.log(`Job ${jobId} ${status}`, {
      groupId: group.groupId,
      totalImages,
      successful: successCount,
      failed: failureCount,
      timedOut: timeoutCount,
      parallelProcessing: true,
    });

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Processing failed';
    console.error(`Error processing group ${group.groupId} (job ${jobId}):`, error);

    await updateJobStatus(jobId, {
      status: 'failed',
      completedAt: new Date().toISOString(),
      result: {
        success: false,
        error: errorMsg,
        processedImages, // Return partial results
        summary: {
          totalImages,
          successful: processedImages.length,
          failed: totalImages - processedImages.length,
        },
      },
    });
  }
}

/**
 * OPTIONS handler for CORS preflight
 */
export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Tenant-Id, X-User-Id',
    },
  });
}
