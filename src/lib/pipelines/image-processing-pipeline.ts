/**
 * Image Processing Pipeline Orchestrator
 * Single Responsibility: Orchestrates the flow between services
 * Properly separates concerns - doesn't implement any business logic itself
 */

import { removeBackground, type RemoveBackgroundOptions } from '../bedrock/background-remover';
import { analyzeWithRekognition } from '../rekognition/analyzer';
import { analyzeWithMistralPixtral } from '../bedrock/mistral-pixtral-analyzer';
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
  rekognitionAnalysis?: {
    labels: string[];
    colors: string[];
    category: string;
    brand?: string;
    size?: string;
    material?: string;
    careInstructions?: string[];
    moderationLabels: Array<{ name: string; confidence: number }>;
  };
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
  let mistralResult: any | undefined; // Declare outside for pricing/rating suggestions

  if (generateDescription) {
    try {
      console.log('Generating bilingual description with Mistral Pixtral Large + Rekognition context');

      // Single Mistral Pixtral Large call with Rekognition context (faster, cheaper, better)
      mistralResult = await analyzeWithMistralPixtral(
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
          short: mistralResult.short_en,
          long: mistralResult.long_en,
          category: mistralResult.category,
          colors: mistralResult.colors,
          condition: mistralResult.condition,
          keywords: mistralResult.keywords,
          stylingTip: mistralResult.stylingTip_en
        },
        is: {
          short: mistralResult.short_is,
          long: mistralResult.long_is,
          category: mistralResult.category,
          colors: mistralResult.colors,
          condition: mistralResult.condition,
          keywords: mistralResult.keywords,
          stylingTip: mistralResult.stylingTip_is
        }
      };

      console.log('✅ Auto-detected from image:', {
        brand: mistralResult.brand || rekResult.brand,
        size: mistralResult.size || rekResult.size,
        material: mistralResult.material
      });

      productDescription = bilingualDescription.en;
    } catch (error) {
      console.error('❌ Failed to generate description:', error);
      console.error('❌ Error name:', error instanceof Error ? error.name : typeof error);
      console.error('❌ Error message:', error instanceof Error ? error.message : String(error));
      console.error('❌ Error stack:', error instanceof Error ? error.stack : 'No stack trace');
      if (error && typeof error === 'object') {
        console.error('❌ Error details:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
      }
      // Don't fail the entire pipeline if description generation fails
    }
  }

  return {
    outputBuffer: bgResult.outputBuffer,
    metadata: resultMetadata,
    productDescription,
    bilingualDescription,
    mistralResult, // Include Mistral analysis for pricing/rating suggestions
    rekognitionAnalysis: {
      labels: rekResult.labels,
      colors: rekResult.colors,
      category: rekResult.category,
      brand: rekResult.brand,
      size: rekResult.size,
      material: rekResult.material,
      careInstructions: rekResult.careInstructions,
      moderationLabels: rekResult.moderationLabels
    }
  };
}
