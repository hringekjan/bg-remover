/**
 * Result builder utilities for bg-remover service
 */

import {
  ProcessResult,
  ProcessRequest,
  type ProductDescription,
  type MultilingualProductDescription,
  type BilingualProductDescription
} from './types';

/**
 * Creates a standardized process result with optional restricted tag
 */
export const createProcessResult = (
  success: boolean,
  jobId?: string,
  outputUrl?: string,
  error?: string,
  processingTimeMs?: number,
  metadata?: { width: number; height: number; originalSize: number; processedSize: number },
  productDescription?: ProductDescription,
  multilingualDescription?: MultilingualProductDescription,
  bilingualDescription?: BilingualProductDescription,
  tags?: { restricted?: boolean },
): ProcessResult => ({
  success,
  jobId,
  outputUrl,
  error,
  processingTimeMs,
  metadata,
  productDescription,
  multilingualDescription,
  bilingualDescription,
  tags,
});

/**
 * Creates a job result with restricted tag
 */
export const createJobResult = (
  success: boolean,
  jobId: string,
  outputUrl: string,
  processingTimeMs: number,
  metadata: { width: number; height: number; originalSize: number; processedSize: number },
  productDescription?: ProductDescription,
  multilingualDescription?: MultilingualProductDescription,
  bilingualDescription?: BilingualProductDescription,
  tags?: { restricted?: boolean },
): ProcessResult => ({
  success,
  jobId,
  outputUrl,
  processingTimeMs,
  metadata,
  productDescription,
  multilingualDescription,
  bilingualDescription,
  tags,
});