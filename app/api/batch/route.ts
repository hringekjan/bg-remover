/**
 * POST /api/batch - Batch Image Background Removal
 *
 * Processes multiple images for background removal in a single request.
 * Images are processed concurrently with configurable parallelism.
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { BatchRequestSchema, type BatchResult, type ProcessResult } from '@/lib/types';
import { loadConfig } from '@/lib/config/loader';
import {
  processImageFromUrl,
  processImageFromBase64,
  createProcessResult,
} from '@/lib/bedrock/image-processor';
import { uploadProcessedImage, generateOutputKey, getOutputBucket } from '@/lib/s3/client';
import {
  setBatchResult,
  getBatchResult,
  type BatchResult as DynamoBatchResult,
} from '@/lib/dynamo/job-store';

export const runtime = 'nodejs';
export const maxDuration = 300; // 5 minutes for batch processing

interface ImageTask {
  index: number;
  imageUrl?: string;
  imageBase64?: string;
  productId?: string;
}

async function processImage(
  task: ImageTask,
  config: Awaited<ReturnType<typeof loadConfig>>,
  tenant: string,
  outputFormat: 'png' | 'webp' | 'jpeg',
  quality: number
): Promise<ProcessResult> {
  const startTime = Date.now();

  try {
    let result: {
      outputBuffer: Buffer;
      metadata: {
        width: number;
        height: number;
        originalSize: number;
        processedSize: number;
      };
    };

    if (task.imageUrl) {
      result = await processImageFromUrl(task.imageUrl, {
        format: outputFormat,
        quality,
      });
    } else if (task.imageBase64) {
      result = await processImageFromBase64(task.imageBase64, 'image/png', {
        format: outputFormat,
        quality,
      });
    } else {
      return createProcessResult(false, undefined, undefined, 'No image provided', Date.now() - startTime);
    }

    // Upload processed image to S3
    const outputKey = generateOutputKey(tenant, task.productId, outputFormat);
    const contentType = outputFormat === 'png' ? 'image/png' :
                       outputFormat === 'webp' ? 'image/webp' : 'image/jpeg';

    // Get output bucket from config (priority: env var > SSM > default)
    const outputBucket = await getOutputBucket(tenant);

    const outputUrl = await uploadProcessedImage(
      outputBucket,
      outputKey,
      result.outputBuffer,
      contentType,
      {
        'original-url': task.imageUrl || 'base64-upload',
        'product-id': task.productId || 'none',
        'tenant': tenant,
        'batch-index': String(task.index),
      }
    );

    return {
      success: true,
      jobId: randomUUID(),
      outputUrl,
      processingTimeMs: Date.now() - startTime,
      metadata: result.metadata,
    };
  } catch (error) {
    return createProcessResult(
      false,
      undefined,
      undefined,
      error instanceof Error ? error.message : 'Processing failed',
      Date.now() - startTime
    );
  }
}

export async function POST(request: NextRequest): Promise<NextResponse<BatchResult>> {
  const startTime = Date.now();
  const batchId = randomUUID();

  try {
    // Parse and validate request body
    const body = await request.json();
    const validatedRequest = BatchRequestSchema.parse(body);

    const { images, outputFormat, quality, tenant, concurrency = 3 } = validatedRequest;

    console.log('Starting batch processing', {
      batchId,
      tenant,
      imageCount: images.length,
      outputFormat,
      concurrency,
    });

    // Load configuration
    const config = await loadConfig(tenant);

    // Initialize batch result
    const batchResult: BatchResult = {
      batchId,
      status: 'processing',
      totalImages: images.length,
      processedImages: 0,
      successfulImages: 0,
      failedImages: 0,
      results: [],
      startTime: new Date().toISOString(),
    };

    // Store initial job status in DynamoDB
    await setBatchResult(batchId, batchResult);

    // Process images with controlled concurrency
    const tasks: ImageTask[] = images.map((img, index) => ({
      index,
      imageUrl: img.url,
      imageBase64: img.base64,
      productId: img.productId,
    }));

    // Process in batches based on concurrency limit
    const results: ProcessResult[] = [];

    for (let i = 0; i < tasks.length; i += concurrency) {
      const batch = tasks.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map((task) => processImage(task, config, tenant, outputFormat, quality))
      );

      results.push(...batchResults);

      // Update progress in DynamoDB
      batchResult.processedImages = results.length;
      batchResult.successfulImages = results.filter((r) => r.success).length;
      batchResult.failedImages = results.filter((r) => !r.success).length;
      batchResult.results = results;
      await setBatchResult(batchId, { ...batchResult });

      console.log('Batch progress', {
        batchId,
        processed: results.length,
        total: tasks.length,
        successful: batchResult.successfulImages,
        failed: batchResult.failedImages,
      });
    }

    // Finalize batch result
    const processingTimeMs = Date.now() - startTime;
    const finalResult: BatchResult = {
      ...batchResult,
      status: batchResult.failedImages === 0 ? 'completed' :
              batchResult.successfulImages === 0 ? 'failed' : 'partial',
      results,
      endTime: new Date().toISOString(),
      processingTimeMs,
    };

    await setBatchResult(batchId, finalResult);

    console.log('Batch processing complete', {
      batchId,
      status: finalResult.status,
      processingTimeMs,
      successful: finalResult.successfulImages,
      failed: finalResult.failedImages,
    });

    return NextResponse.json(finalResult);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    console.error('Batch processing failed', {
      batchId,
      error: errorMessage,
    });

    // Handle validation errors
    if (error instanceof Error && error.name === 'ZodError') {
      return NextResponse.json(
        {
          batchId,
          status: 'failed',
          totalImages: 0,
          processedImages: 0,
          successfulImages: 0,
          failedImages: 0,
          results: [],
          error: `Validation error: ${errorMessage}`,
          startTime: new Date().toISOString(),
          endTime: new Date().toISOString(),
          processingTimeMs: Date.now() - startTime,
        } as BatchResult,
        { status: 400 }
      );
    }

    return NextResponse.json(
      {
        batchId,
        status: 'failed',
        totalImages: 0,
        processedImages: 0,
        successfulImages: 0,
        failedImages: 0,
        results: [],
        error: errorMessage,
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
        processingTimeMs: Date.now() - startTime,
      } as BatchResult,
      { status: 500 }
    );
  }
}

// GET to retrieve batch status from DynamoDB
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const batchId = searchParams.get('batchId');

  if (!batchId) {
    return NextResponse.json(
      { error: 'Missing batchId parameter' },
      { status: 400 }
    );
  }

  try {
    const result = await getBatchResult(batchId);

    if (!result) {
      return NextResponse.json(
        { error: 'Batch not found', message: 'Job may have expired (24h TTL) or does not exist' },
        { status: 404 }
      );
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error('Failed to get batch status', {
      batchId,
      error: error instanceof Error ? error.message : 'Unknown error',
    });

    return NextResponse.json(
      { error: 'Failed to retrieve batch status' },
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
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Tenant-Id',
    },
  });
}
