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
