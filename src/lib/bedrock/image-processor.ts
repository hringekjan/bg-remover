import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { loadConfig, type BgRemoverSecrets } from '../config/loader';
import { generateBilingualDescription, type ProductDescription, type BilingualProductDescription } from './image-analysis';
import { getServiceEndpoint, extractTenantFromEvent } from '../tenant/config';

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

  console.log('✨ Performing direct Bedrock background removal via Nova Canvas', {
    tenant,
    productName,
    format: format || 'png'
  });

  // 1. Core Background Removal
  const { outputBuffer, processingTimeMs } = await removeBackgroundDirect(base64Image, {
    quality: quality === 'high' ? 'premium' : 'standard',
    height: targetSize?.height,
    width: targetSize?.width
  });

  const resultMetadata = {
    width: targetSize?.width || 1024,
    height: targetSize?.height || 1024,
    originalSize: (base64Image.length * 3) / 4,
    processedSize: outputBuffer.length,
    processingTimeMs
  };

  // 2. Generate descriptions if requested
  let productDescription: ProductDescription | undefined;
  let bilingualDescription: BilingualProductDescription | undefined;

  if (generateDescription) {
    try {
      console.log('Generating bilingual description for processed image');
      
      const imageMetadata = {
        width: resultMetadata.width,
        height: resultMetadata.height,
        fileSizeBytes: resultMetadata.processedSize,
        format: format || 'png',
      };

      bilingualDescription = await generateBilingualDescription(outputBuffer, productName, imageMetadata);
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


