// src/lib/bedrock/image-processor.ts
import { loadConfig, type BgRemoverSecrets } from '../config/loader';
import { generateBilingualDescription, type ProductDescription, type BilingualProductDescription } from './image-analysis';
import { getServiceEndpoint, extractTenantFromEvent } from '../tenant/config';

// Use tenant-aware API URL determination
// Falls back to direct API Gateway URL if IMAGE_OPTIMIZER_SERVICE_URL env var is set
const getImageOptimizerUrl = (tenant?: string): string => {
  if (process.env.IMAGE_OPTIMIZER_SERVICE_URL) {
    return process.env.IMAGE_OPTIMIZER_SERVICE_URL;
  }
  return getServiceEndpoint('image-optimizer', tenant);
};

/**
 * Get the image optimizer API key from config
 * Fails fast if API key is not configured (no silent fallbacks)
 *
 * @param stage - Deployment stage (dev, prod)
 * @param tenant - Tenant identifier
 * @throws Error if API key is not configured
 */
async function getImageOptimizerApiKey(stage?: string, tenant?: string): Promise<string> {
  // First check environment variable (deployment-time injection)
  if (process.env.IMAGE_OPTIMIZER_API_KEY) {
    return process.env.IMAGE_OPTIMIZER_API_KEY;
  }

  // Load from SSM via config loader with tenant context
  const { secrets } = await loadConfig(stage, tenant);

  // Check for service API key in secrets
  if (secrets.serviceApiKey) {
    return secrets.serviceApiKey;
  }

  // CRITICAL: No silent fallbacks - fail fast with clear error message
  throw new Error(
    'Image Optimizer API key not configured. ' +
    'Set IMAGE_OPTIMIZER_API_KEY environment variable or ' +
    'configure serviceApiKey in SSM parameter: /tf/{stage}/{tenant}/services/bg-remover/secrets'
  );
}

// Helper function to call the image optimizer service
async function callImageOptimizer(
  payload: { imageUrl?: string; imageBase64?: string; outputFormat: string; quality: number; targetSize?: { width: number; height: number } },
  tenant: string,
  stage?: string
): Promise<{ outputBuffer: Buffer; metadata: any }> {
  // Get API key first - will throw if not configured (fail fast)
  const apiKey = await getImageOptimizerApiKey(stage, tenant);

  // Get tenant-aware Image Optimizer service URL
  const imageOptimizerUrl = getImageOptimizerUrl(tenant);

  console.log('Calling Image Optimizer service', {
    url: imageOptimizerUrl,
    tenant,
    hasApiKey: !!apiKey,
    hasImageUrl: !!payload.imageUrl,
    hasImageBase64: !!payload.imageBase64,
  });

  const headers = {
    'Content-Type': 'application/json',
    'X-Tenant-Id': tenant,
    'x-api-key': apiKey,
  };

  try {
    const response = await fetch(imageOptimizerUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Image Optimizer API failed: ${response.status} - ${errorBody}`);
    }

    const data = await response.json(); // Assuming it returns JSON with outputBuffer (base64) and metadata

    if (!data.outputBase64) {
      throw new Error('Image Optimizer did not return outputBase64');
    }

    return {
      outputBuffer: Buffer.from(data.outputBase64, 'base64'),
      metadata: data.metadata || { width: 0, height: 0, originalSize: 0, processedSize: 0 },
    };
  } catch (error) {
    console.error('Error calling Image Optimizer service', {
      error: error instanceof Error ? error.message : String(error),
      tenant,
      url: imageOptimizerUrl,
    });
    throw error;
  }
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
  const { format, quality, targetSize, generateDescription, productName } = options;

  // First, process the image
  const result = await callImageOptimizer({ imageUrl, outputFormat: format, quality, targetSize }, tenant, stage);

  // Generate descriptions if requested
  let productDescription: ProductDescription | undefined;
  let bilingualDescription: BilingualProductDescription | undefined;

  if (generateDescription) {
    try {
      console.log('Generating bilingual description for processed image', {
        hasMetadata: !!result.metadata,
        width: result.metadata?.width,
        height: result.metadata?.height,
        size: result.metadata?.processedSize,
      });

      // Prepare metadata for routing (if available)
      const imageMetadata = result.metadata ? {
        width: result.metadata.width || 0,
        height: result.metadata.height || 0,
        fileSizeBytes: result.metadata.processedSize || 0,
        format: format || 'png',
      } : undefined;

      bilingualDescription = await generateBilingualDescription(result.outputBuffer, productName, imageMetadata);
      productDescription = bilingualDescription.en; // For backward compatibility
    } catch (error) {
      console.error('Failed to generate description:', error);
      // Continue without description rather than failing the whole request
    }
  }

  return {
    ...result,
    productDescription,
    bilingualDescription
  };
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

  // First, process the image
  const result = await callImageOptimizer({ imageBase64: base64Image, outputFormat: format, quality, targetSize }, tenant, stage);

  // Generate descriptions if requested
  let productDescription: ProductDescription | undefined;
  let bilingualDescription: BilingualProductDescription | undefined;

  if (generateDescription) {
    try {
      console.log('Generating bilingual description for processed image', {
        hasMetadata: !!result.metadata,
        width: result.metadata?.width,
        height: result.metadata?.height,
        size: result.metadata?.processedSize,
      });

      // Prepare metadata for routing (if available)
      const imageMetadata = result.metadata ? {
        width: result.metadata.width || 0,
        height: result.metadata.height || 0,
        fileSizeBytes: result.metadata.processedSize || 0,
        format: format || 'png',
      } : undefined;

      bilingualDescription = await generateBilingualDescription(result.outputBuffer, productName, imageMetadata);
      productDescription = bilingualDescription.en; // For backward compatibility
    } catch (error) {
      console.error('Failed to generate description:', error);
      // Continue without description rather than failing the whole request
    }
  }

  return {
    ...result,
    productDescription,
    bilingualDescription
  };
};


