/**
 * Image Processor - Wrapper for backwards compatibility
 * Now uses the pipeline orchestrator for proper separation of concerns
 */
import { loadConfig, type BgRemoverSecrets } from '../config/loader';
import { generateBilingualDescription } from './image-analysis';
import { type ProductDescription, type BilingualProductDescription } from '../types';
import { getServiceEndpoint, extractTenantFromEvent } from '../tenant/config';
import { processImage as processThroughPipeline } from '../pipelines/image-processing-pipeline';

// Re-export types and utilities from types.ts for backwards compatibility
export { type BilingualProductDescription, type ProductDescription, createProcessResult } from '../types';

export const processImageFromUrl = async (
  imageUrl: string,
  options: any,
  tenant: string,
  stage?: string
): Promise<{
  outputBuffer: Buffer;
  metadata: any;
  productDescription?: ProductDescription;
  bilingualDescription?: BilingualProductDescription;
}> => {
  // Download image from URL first
  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error(`Failed to fetch image: ${response.statusText}`);
  const arrayBuffer = await response.arrayBuffer();
  const base64Image = Buffer.from(arrayBuffer).toString('base64');
  
  return processImageFromBase64(base64Image, response.headers.get('content-type') || 'image/png', options, tenant, stage);
};

export const processImageFromBase64 = async (
  base64Image: string,
  contentType: string,
  options: any,
  tenant: string,
  stage?: string
): Promise<{
  outputBuffer: Buffer;
  metadata: any;
  productDescription?: ProductDescription;
  bilingualDescription?: BilingualProductDescription;
}> => {
  // Delegate to the pipeline orchestrator (proper separation of concerns)
  return processThroughPipeline({
    base64Image,
    contentType,
    options,
    tenant,
    stage
  });
};


