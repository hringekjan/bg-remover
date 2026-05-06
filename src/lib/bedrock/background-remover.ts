import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const bedrockClient = new BedrockRuntimeClient({ region: 'us-east-1' });

// Stability AI cross-region inference profile (requires AWS Marketplace subscription)
const STABILITY_MODEL = 'us.stability.stable-image-remove-background-v1:0';

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
  method?: 'stability' | 'sharp-passthrough';
}

/**
 * Remove background. Tries Stability AI first; falls back to Sharp passthrough
 * (original image returned as PNG) when Marketplace subscription is unavailable.
 * Fallback ensures the product creation pipeline completes so images appear in UI.
 */
export async function removeBackground(
  base64Image: string,
  options: RemoveBackgroundOptions = {}
): Promise<RemoveBackgroundResult> {
  const startTime = Date.now();

  // Attempt Stability AI background removal
  try {
    const command = new InvokeModelCommand({
      modelId: STABILITY_MODEL,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({ image: base64Image }),
    });

    const response = await bedrockClient.send(command);
    const result = JSON.parse(new TextDecoder().decode(response.body));

    if (!result.image) {
      throw new Error(`Stability returned no image: ${result.finish_reason}`);
    }

    const outputBuffer = Buffer.from(result.image, 'base64');
    return {
      outputBuffer,
      processingTimeMs: Date.now() - startTime,
      metadata: {
        width: options.width || 1024,
        height: options.height || 1024,
        format: 'png',
      },
      method: 'stability',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isMarketplaceError = msg.includes('Marketplace') || msg.includes('Subscribe') || msg.includes('subscription');
    const isAccessError = msg.includes('not authorized') || msg.includes('Access denied') || msg.includes('LEGACY');

    if (isMarketplaceError || isAccessError) {
      console.warn('[BackgroundRemover] Stability AI unavailable, using passthrough fallback', {
        reason: msg.slice(0, 120),
      });
      return await sharpPassthrough(base64Image, options, startTime);
    }

    // Any other error (validation, network) — re-throw so retry logic fires
    throw err;
  }
}

/**
 * Passthrough fallback: convert the original image to PNG using Sharp.
 * Returns the product image as-is so the pipeline completes and the UI shows results.
 */
async function sharpPassthrough(
  base64Image: string,
  options: RemoveBackgroundOptions,
  startTime: number
): Promise<RemoveBackgroundResult> {
  let sharp: any;
  try {
    sharp = (await import('sharp')).default;
  } catch {
    // Sharp not available — return original buffer directly
    const outputBuffer = Buffer.from(base64Image, 'base64');
    return {
      outputBuffer,
      processingTimeMs: Date.now() - startTime,
      metadata: { width: options.width || 1024, height: options.height || 1024, format: 'png' },
      method: 'sharp-passthrough',
    };
  }

  const inputBuffer = Buffer.from(base64Image, 'base64');
  const { data, info } = await sharp(inputBuffer)
    .resize(options.width || undefined, options.height || undefined, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer({ resolveWithObject: true });

  return {
    outputBuffer: data,
    processingTimeMs: Date.now() - startTime,
    metadata: { width: info.width, height: info.height, format: 'png' },
    method: 'sharp-passthrough',
  };
}
