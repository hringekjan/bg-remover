/**
 * Image Processing Pipeline Orchestrator
 * Single Responsibility: Orchestrates the flow between services
 * Properly separates concerns - doesn't implement any business logic itself
 */

import { removeBackground, type RemoveBackgroundOptions } from '../bedrock/background-remover';
import { analyzeWithRekognition } from '../rekognition/analyzer';
import { analyzeWithNovaPro } from '../bedrock/nova-pro-analyzer';
import { type ProductDescription, type BilingualProductDescription } from '../types';

export interface ProcessImageInput {
  base64Image: string;
  contentType: string;
  options: {
    format?: string;
    quality?: 'high' | 'standard';
    targetSize?: {
      width?: number;
      height?: number;
    };
    generateDescription?: boolean;
    productName?: string;
  };
  tenant: string;
  stage?: string;
}

export interface ProcessImageResult {
  outputBuffer: Buffer;
  metadata: {
    width: number;
    height: number;
    originalSize: number;
    processedSize: number;
    processingTimeMs: number;
  };
  productDescription?: ProductDescription;
  bilingualDescription?: BilingualProductDescription;
}

/**
 * Process image through the complete pipeline
 * - Orchestrates 3 independent services
 * - Runs background removal + Rekognition in parallel (saves 2-3s)
 * - Early rejection on moderation failure
 * - Single Nova Pro call with Rekognition context
 */
export async function processImage(input: ProcessImageInput): Promise<ProcessImageResult> {
  const { base64Image, options, tenant } = input;
  const { format, quality, targetSize, generateDescription, productName } = options;

  console.log('✨ Pipeline: Background removal + Rekognition in parallel', {
    tenant,
    productName,
    format: format || 'png'
  });

  const imageBuffer = Buffer.from(base64Image, 'base64');

  // Step 1: Parallel execution - Background removal + Rekognition analysis
  const bgOptions: RemoveBackgroundOptions = {
    quality: quality === 'high' ? 'premium' : 'standard',
    height: targetSize?.height,
    width: targetSize?.width
  };

  const [bgResult, rekResult] = await Promise.all([
    removeBackground(base64Image, bgOptions),
    analyzeWithRekognition(imageBuffer)
  ]);

  // Step 2: Early rejection if content moderation failed
  if (!rekResult.approved) {
    throw new Error(`Image rejected: ${rekResult.reason || 'Content moderation failed'}`);
  }

  const resultMetadata = {
    width: bgResult.metadata.width,
    height: bgResult.metadata.height,
    originalSize: (base64Image.length * 3) / 4,
    processedSize: bgResult.outputBuffer.length,
    processingTimeMs: bgResult.processingTimeMs
  };

  // Step 3: Generate descriptions (optional) - Single Nova Pro call
  let productDescription: ProductDescription | undefined;
  let bilingualDescription: BilingualProductDescription | undefined;

  if (generateDescription) {
    try {
      console.log('Generating bilingual description with Nova Pro + Rekognition context');

      // Single Nova Pro call with Rekognition context (faster, cheaper, better)
      const novaProResult = await analyzeWithNovaPro(
        bgResult.outputBuffer,
        productName,
        {
          labels: rekResult.labels,
          detectedBrand: rekResult.brand,
          detectedSize: rekResult.size,
          category: rekResult.category,
          colors: rekResult.colors
        }
      );

      // Build bilingual description
      bilingualDescription = {
        en: {
          short: novaProResult.short_en,
          long: novaProResult.long_en,
          category: novaProResult.category,
          colors: novaProResult.colors,
          condition: novaProResult.condition,
          keywords: novaProResult.keywords,
          stylingTip: novaProResult.stylingTip_en
        },
        is: {
          short: novaProResult.short_is,
          long: novaProResult.long_is,
          category: novaProResult.category,
          colors: novaProResult.colors,
          condition: novaProResult.condition,
          keywords: novaProResult.keywords,
          stylingTip: novaProResult.stylingTip_is
        }
      };

      console.log('✅ Auto-detected from image:', {
        brand: novaProResult.brand || rekResult.brand,
        size: novaProResult.size || rekResult.size,
        material: novaProResult.material
      });

      productDescription = bilingualDescription.en;
    } catch (error) {
      console.error('Failed to generate description:', error);
      // Don't fail the entire pipeline if description generation fails
    }
  }

  return {
    outputBuffer: bgResult.outputBuffer,
    metadata: resultMetadata,
    productDescription,
    bilingualDescription
  };
}
