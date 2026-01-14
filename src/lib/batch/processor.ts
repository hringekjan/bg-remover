/**
 * Batch image processor with parallel processing
 *
 * Features:
 * - Process multiple images in parallel
 * - Configurable concurrency limit
 * - Graceful degradation on partial failures
 * - Progress tracking
 * - Automatic retry with exponential backoff
 */

import { BatchTask, BatchResult, ProcessResult } from '../types';
import { processImageFromUrl, processImageFromBase64, createProcessResult } from '../bedrock/image-processor';
import { uploadProcessedImage, generateOutputKey, getOutputBucket } from '../s3/client';
import { loadConfig } from '../config/loader';
import { randomUUID } from 'crypto';

export interface BatchProcessOptions {
  /** Max concurrent processing (default: 3) */
  maxConcurrency?: number;
  /** Enable retry on failure (default: true) */
  enableRetry?: boolean;
  /** Max retry attempts (default: 2) */
  maxRetries?: number;
  /** Progress callback */
  onProgress?: (progress: BatchProgress) => void;
  /** Item completion callback */
  onItemComplete?: (result: BatchItemResult) => void;
}

export interface BatchProgress {
  total: number;
  completed: number;
  failed: number;
  inProgress: number;
  percentage: number;
}

export interface BatchItemResult {
  index: number;
  success: boolean;
  data?: any;
  error?: string;
  retries: number;
  processingTimeMs: number;
}

export interface BatchResult {
  totalItems: number;
  successCount: number;
  failureCount: number;
  results: BatchItemResult[];
  totalTimeMs: number;
}

/**
 * Batch processor for parallel operations
 */
export class BatchProcessor<TInput, TOutput> {
  private readonly maxConcurrency: number;
  private readonly enableRetry: boolean;
  private readonly maxRetries: number;
  private readonly onProgress?: (progress: BatchProgress) => void;
  private readonly onItemComplete?: (result: BatchItemResult) => void;

  constructor(options: BatchProcessOptions = {}) {
    this.maxConcurrency = options.maxConcurrency ?? 3;
    this.enableRetry = options.enableRetry ?? true;
    this.maxRetries = options.maxRetries ?? 2;
    this.onProgress = options.onProgress;
    this.onItemComplete = options.onItemComplete;
  }

  /**
   * Process batch of items in parallel
   */
  async process(
    items: TInput[],
    processFn: (item: TInput, index: number) => Promise<TOutput>
  ): Promise<BatchResult> {
    const startTime = Date.now();
    const results: BatchItemResult[] = [];
    const itemsWithMetadata = items.map((item, index) => ({
      item,
      index,
      retries: 0,
    }));

    const pending = [...itemsWithMetadata];
    const active: Promise<void>[] = [];
    let completed = 0;
    let failed = 0;

    // Report initial progress
    this.reportProgress({
      total: items.length,
      completed: 0,
      failed: 0,
      inProgress: 0,
      percentage: 0,
    });

    while (pending.length > 0 || active.length > 0) {
      // Start new tasks up to max concurrency
      while (active.length < this.maxConcurrency && pending.length > 0) {
        const itemData = pending.shift()!;

        const task = this.processItem(itemData, processFn)
          .then((result) => {
            results[itemData.index] = result;

            if (result.success) {
              completed++;
            } else {
              failed++;

              // Retry logic
              if (this.enableRetry && itemData.retries < this.maxRetries) {
                itemData.retries++;
                console.log(
                  `Retrying item ${itemData.index} (attempt ${itemData.retries}/${this.maxRetries})`
                );

                // Add back to pending with exponential backoff
                setTimeout(() => {
                  pending.push(itemData);
                }, Math.pow(2, itemData.retries) * 1000);
              }
            }

            // Report item completion
            if (this.onItemComplete) {
              this.onItemComplete(result);
            }

            // Report progress
            this.reportProgress({
              total: items.length,
              completed,
              failed,
              inProgress: active.length,
              percentage: (completed / items.length) * 100,
            });
          })
          .catch((error) => {
            console.error(`Unexpected error processing item ${itemData.index}:`, error);
            failed++;
          });

        active.push(task);
      }

      // Wait for at least one task to complete
      if (active.length > 0) {
        await Promise.race(active);

        // Remove completed tasks
        const stillActive: Promise<void>[] = [];
        for (const promise of active) {
          let isSettled = false;
          promise.then(() => {
            isSettled = true;
          }).catch(() => {
            isSettled = true;
          });

          // Only keep promises that haven't settled yet
          if (!isSettled) {
            stillActive.push(promise);
          }
        }

        active.length = 0;
        active.push(...stillActive);
      }
    }

    // Wait for all active tasks
    await Promise.allSettled(active);

    const totalTimeMs = Date.now() - startTime;

    return {
      totalItems: items.length,
      successCount: completed,
      failureCount: failed,
      results,
      totalTimeMs,
    };
  }

  /**
   * Process single item with timing
   */
  private async processItem(
    itemData: { item: TInput; index: number; retries: number },
    processFn: (item: TInput, index: number) => Promise<TOutput>
  ): Promise<BatchItemResult> {
    const startTime = Date.now();

    try {
      const data = await processFn(itemData.item, itemData.index);

      return {
        index: itemData.index,
        success: true,
        data,
        retries: itemData.retries,
        processingTimeMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        index: itemData.index,
        success: false,
        error: error instanceof Error ? error.message : String(error),
        retries: itemData.retries,
        processingTimeMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Report progress
   */
  private reportProgress(progress: BatchProgress): void {
    if (this.onProgress) {
      this.onProgress(progress);
    }
  }
}

/**
 * Helper function for batch processing with Promise.allSettled
 */
export async function processBatch<TInput, TOutput>(
  items: TInput[],
  processFn: (item: TInput, index: number) => Promise<TOutput>,
  options: BatchProcessOptions = {}
): Promise<BatchResult> {
  const processor = new BatchProcessor<TInput, TOutput>(options);
  return processor.process(items, processFn);
}

/**
 * Process a batch of images for background removal
 */
export async function processBatch(batch: BatchTask): Promise<BatchResult> {
  const startTime = Date.now();
  const batchId = randomUUID();

  try {
    const { images, outputFormat, quality, tenant, concurrency = 3 } = batch;

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

    // Process images with controlled concurrency
    const tasks = images.map((img, index) => ({
      index,
      imageUrl: img.url,
      imageBase64: img.base64,
      productId: img.productId,
    }));

    // Process in batches based on concurrency limit
    const results: ProcessResult[] = [];

    for (let i = 0; i < tasks.length; i += concurrency) {
      const batchTasks = tasks.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batchTasks.map(async (task) => {
          const taskStartTime = Date.now();

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
              return createProcessResult(false, undefined, undefined, 'No image provided', Date.now() - taskStartTime);
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
              processingTimeMs: Date.now() - taskStartTime,
              metadata: result.metadata,
            };
          } catch (error) {
            return createProcessResult(
              false,
              undefined,
              undefined,
              error instanceof Error ? error.message : 'Processing failed',
              Date.now() - taskStartTime
            );
          }
        })
      );

      results.push(...batchResults);

      // Update progress
      batchResult.processedImages = results.length;
      batchResult.successfulImages = results.filter((r) => r.success).length;
      batchResult.failedImages = results.filter((r) => !r.success).length;
      batchResult.results = results;

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

    console.log('Batch processing complete', {
      batchId,
      status: finalResult.status,
      processingTimeMs,
      successful: finalResult.successfulImages,
      failed: finalResult.failedImages,
    });

    return finalResult;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    console.error('Batch processing failed', {
      batchId,
      error: errorMessage,
    });

    return {
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
    };
  }
}