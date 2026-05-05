import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const bedrockClient = new BedrockRuntimeClient({ region: 'us-east-1' });

// Nova Canvas (amazon.nova-canvas-v1:0) is LEGACY — replaced by Stability AI cross-region inference profile
const BG_REMOVAL_MODEL = 'us.stability.stable-image-remove-background-v1:0';

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
}

/**
 * Remove background using Stability AI stable-image-remove-background.
 * Replaces Nova Canvas (now LEGACY on Bedrock since 2026-05).
 */
export async function removeBackground(
  base64Image: string,
  options: RemoveBackgroundOptions = {}
): Promise<RemoveBackgroundResult> {
  const startTime = Date.now();

  // Stability AI remove-background takes multipart/form-data via Bedrock's
  // InvokeModel — body is JSON with base64-encoded image field.
  const command = new InvokeModelCommand({
    modelId: BG_REMOVAL_MODEL,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      image: base64Image,
    }),
  });

  const response = await bedrockClient.send(command);
  const result = JSON.parse(new TextDecoder().decode(response.body));

  // Stability response: { image: "<base64>", finish_reason: "SUCCESS" }
  if (!result.image) {
    throw new Error(`Stability background removal failed: ${result.finish_reason || 'no image returned'}`);
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
  };
}
