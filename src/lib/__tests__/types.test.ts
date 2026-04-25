import { describe, it, expect } from 'vitest';
import { ProcessResult } from '../src/lib/types';

describe('ProcessResult Type Definition', () => {
  it('should include the restricted tag in the tags object', () => {
    // This test verifies that the type definition includes the restricted field
    const sampleResult: ProcessResult = {
      success: true,
      jobId: 'test-job-id',
      outputUrl: 'https://example.com/output.png',
      processingTimeMs: 100,
      metadata: {
        width: 800,
        height: 600,
        originalSize: 1024,
        processedSize: 512,
      },
      tags: {
        restricted: true,
      }
    };

    expect(sampleResult.tags?.restricted).toBe(true);
  });

  it('should allow restricted tag to be undefined', () => {
    // This test verifies that the restricted tag can be omitted
    const sampleResult: ProcessResult = {
      success: true,
      jobId: 'test-job-id',
      outputUrl: 'https://example.com/output.png',
      processingTimeMs: 100,
      metadata: {
        width: 800,
        height: 600,
        originalSize: 1024,
        processedSize: 512,
      },
      // tags property can be omitted entirely
    };

    expect(sampleResult.tags).toBeUndefined();
  });

  it('should allow restricted tag to be explicitly false', () => {
    // This test verifies that the restricted tag can be explicitly set to false
    const sampleResult: ProcessResult = {
      success: true,
      jobId: 'test-job-id',
      outputUrl: 'https://example.com/output.png',
      processingTimeMs: 100,
      metadata: {
        width: 800,
        height: 600,
        originalSize: 1024,
        processedSize: 512,
      },
      tags: {
        restricted: false,
      }
    };

    expect(sampleResult.tags?.restricted).toBe(false);
  });
});