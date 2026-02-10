/**
 * Timeout Utility for Promise-based Operations
 *
 * Wraps a promise with a timeout, rejecting if the operation takes too long.
 * Used for parallel image processing to prevent hanging operations.
 */

export class TimeoutError extends Error {
  constructor(message: string, public timeoutMs: number) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Race a promise against a timeout
 *
 * @param ms - Timeout in milliseconds
 * @param promise - Promise to race
 * @param errorMessage - Custom error message (default: 'Operation timed out')
 * @returns The resolved promise or throws TimeoutError
 */
export async function timeout<T>(
  ms: number,
  promise: Promise<T>,
  errorMessage = 'Operation timed out'
): Promise<T> {
  let timeoutId: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new TimeoutError(`${errorMessage} after ${ms}ms`, ms));
    }, ms);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * Execute promises in parallel with individual and batch timeouts
 *
 * @param tasks - Array of promise-returning functions
 * @param individualTimeoutMs - Timeout for each task (default: 30s)
 * @param batchTimeoutMs - Timeout for entire batch (default: 120s)
 * @returns Results with status: fulfilled or rejected
 */
export async function executeWithTimeouts<T>(
  tasks: Array<() => Promise<T>>,
  individualTimeoutMs = 30000,
  batchTimeoutMs = 120000
): Promise<PromiseSettledResult<T>[]> {
  // Wrap each task with individual timeout
  const wrappedTasks = tasks.map((task) =>
    timeout(individualTimeoutMs, task(), `Task timeout`)
  );

  // Execute all tasks in parallel
  const batchPromise = Promise.allSettled(wrappedTasks);

  // Wrap batch with overall timeout
  try {
    return await timeout(batchTimeoutMs, batchPromise, `Batch processing timeout`);
  } catch (error) {
    if (error instanceof TimeoutError) {
      // Batch timeout - return partial results
      console.warn(`Batch timeout after ${batchTimeoutMs}ms - returning partial results`);
      // Return whatever completed before timeout
      return await Promise.allSettled(wrappedTasks);
    }
    throw error;
  }
}
