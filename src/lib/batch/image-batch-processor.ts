/**
 * Image batch processor using the generic BatchProcessor
 *
 * Usage example for processing multiple images in parallel
 */

import { BatchProcessor, BatchProcessOptions } from './processor';
import { processImageFromBase64, processImageFromUrl } from '../bedrock/image-processor';

export interface ImageInput {
  imageUrl?: string;
  imageBase64?: string;
  contentType?: string;
  outputFormat?: 'png' | 'jpeg' | 'webp';
  quality?: number;
  productName?: string;
}

export interface ImageOutput {
  outputBuffer: Buffer;
  metadata: {
    width: number;
    height: number;
    originalSize: number;
    processedSize: number;
  };
  productDescription?: any;
}

/**
 * Process batch of images in parallel
 *
 * Example:
 * ```typescript
 * const images = [
 *   { imageBase64: 'base64data1...', outputFormat: 'png' },
 *   { imageBase64: 'base64data2...', outputFormat: 'png' },
 * ];
 *
 * const result = await processBatchImages(images, 'carousel-labs', {
 *   maxConcurrency: 3,
 *   onProgress: (progress) => {
 *     console.log(`${progress.percentage}% complete`);
 *   },
 * });
 *
 * console.log(`${result.successCount}/${result.totalItems} images processed`);
 * ```
 */
export async function processBatchImages(
  images: ImageInput[],
  tenant: string,
  options: BatchProcessOptions = {}
) {
  const processor = new BatchProcessor<ImageInput, ImageOutput>({
    maxConcurrency: options.maxConcurrency ?? 3,
    enableRetry: options.enableRetry ?? true,
    maxRetries: options.maxRetries ?? 2,
    onProgress: options.onProgress,
    onItemComplete: options.onItemComplete,
  });

  return processor.process(images, async (image, index) => {
    console.log(`Processing image ${index + 1}/${images.length}`);

    const processingOptions = {
      format: image.outputFormat ?? 'png',
      quality: image.quality ?? 90,
      autoTrim: true,
      centerSubject: true,
      enhanceColors: false,
      generateDescription: false,
      productName: image.productName,
    };

    if (image.imageUrl) {
      return processImageFromUrl(image.imageUrl, processingOptions, tenant);
    } else if (image.imageBase64) {
      return processImageFromBase64(
        image.imageBase64,
        image.contentType ?? 'image/png',
        processingOptions,
        tenant
      );
    } else {
      throw new Error('Either imageUrl or imageBase64 must be provided');
    }
  });
}
