import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { loadConfig, type BgRemoverSecrets } from '../config/loader';
import { generateBilingualDescription } from './image-analysis';
import { type ProductDescription, type BilingualProductDescription } from '../types';
import { getServiceEndpoint, extractTenantFromEvent } from '../tenant/config';
import { analyzeWithRekognition } from '../rekognition/analyzer';
import { analyzeWithNovaPro } from './nova-pro-analyzer';

// Re-export types and utilities from types.ts for backwards compatibility
export { type BilingualProductDescription, type ProductDescription, createProcessResult } from '../types';

const bedrockClient = new BedrockRuntimeClient({ region: 'us-east-1' });

/**
 * Remove background using Amazon Nova Canvas (Direct Bedrock Integration)
 */
async function removeBackgroundDirect(
  base64Image: string,
  options: {
    quality?: 'standard' | 'premium';
    height?: number;
    width?: number;
  } = {}
): Promise<{ outputBuffer: Buffer; processingTimeMs: number }> {
  const startTime = Date.now();
  
  const command = new InvokeModelCommand({
    modelId: 'amazon.nova-canvas-v1:0',
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      taskType: 'BACKGROUND_REMOVAL',
      backgroundRemovalParams: {
        image: base64Image
      },
      imageGenerationConfig: {
        numberOfImages: 1,
        quality: options.quality || 'premium',
        height: options.height || 1024,
        width: options.width || 1024
      }
    })
  });

  const response = await bedrockClient.send(command);
  const result = JSON.parse(new TextDecoder().decode(response.body));

  if (!result.images || result.images.length === 0) {
    throw new Error('Nova Canvas failed to return a processed image');
  }

  return {
    outputBuffer: Buffer.from(result.images[0], 'base64'),
    processingTimeMs: Date.now() - startTime
  };
}

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
  const { format, quality, targetSize, generateDescription, productName } = options;

  console.log('✨ Optimized pipeline: Background removal + Rekognition in parallel', {
    tenant,
    productName,
    format: format || 'png'
  });

  const imageBuffer = Buffer.from(base64Image, 'base64');

  // 1. Run background removal AND Rekognition in PARALLEL (saves ~2-3s)
  const [bgResult, rekResult] = await Promise.all([
    removeBackgroundDirect(base64Image, {
      quality: quality === 'high' ? 'premium' : 'standard',
      height: targetSize?.height,
      width: targetSize?.width
    }),
    analyzeWithRekognition(imageBuffer)
  ]);

  const { outputBuffer, processingTimeMs } = bgResult;

  const resultMetadata = {
    width: targetSize?.width || 1024,
    height: targetSize?.height || 1024,
    originalSize: (base64Image.length * 3) / 4,
    processedSize: outputBuffer.length,
    processingTimeMs
  };

  // 2. Early rejection if Rekognition failed moderation
  if (!rekResult.approved) {
    throw new Error(`Image rejected: ${rekResult.reason || 'Content moderation failed'}`);
  }

  // 3. Generate descriptions using Nova Pro (single call for English + Icelandic)
  let productDescription: ProductDescription | undefined;
  let bilingualDescription: BilingualProductDescription | undefined;

  if (generateDescription) {
    try {
      console.log('Generating bilingual description with Nova Pro + Rekognition context');

      const imageMetadata = {
        width: resultMetadata.width,
        height: resultMetadata.height,
        fileSizeBytes: resultMetadata.processedSize,
        format: format || 'png',
      };

      // Use Nova Pro with Rekognition context (faster, cheaper, better)
      const novaProResult = await analyzeWithNovaPro(
        outputBuffer,
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
    }
  }

  return {
    outputBuffer,
    metadata: resultMetadata,
    productDescription,
    bilingualDescription
  };
};


