import { removeBackground as callImageOptimizerRembg } from '../../../lib/image-optimizer/client';

export interface RemoveBackgroundOptions {
  quality?: 'standard' | 'premium';
  height?: number;
  width?: number;
}

export interface RemoveBackgroundResult {
  outputBuffer: Buffer;
  processingTimeMs: number;
  metadata: {
    width: number;
    height: number;
    format: string;
  };
  method?: 'rembg' | 'sharp-passthrough';
}

/**
 * Remove background using rembg U2Net model via image-optimizer service.
 * Returns a transparent PNG buffer.
 */
export async function removeBackground(
  base64Image: string,
  options: RemoveBackgroundOptions = {}
): Promise<RemoveBackgroundResult> {
  const startTime = Date.now();

  const result = await callImageOptimizerRembg({ imageBase64: base64Image });
  const outputBuffer = Buffer.from(result.outputBase64, 'base64');

  return {
    outputBuffer,
    processingTimeMs: Date.now() - startTime,
    metadata: {
      // Actual dimensions resolved downstream by Sharp in image-processing-pipeline
      width: options.width || 0,
      height: options.height || 0,
      format: 'png',
    },
    method: 'rembg',
  };
}
