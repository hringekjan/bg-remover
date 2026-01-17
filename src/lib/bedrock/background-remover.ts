import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const bedrockClient = new BedrockRuntimeClient({ region: 'us-east-1' });

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
 * Remove background using Amazon Nova Canvas
 * Single Responsibility: Background removal only
 */
export async function removeBackground(
  base64Image: string,
  options: RemoveBackgroundOptions = {}
): Promise<RemoveBackgroundResult> {
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

  const outputBuffer = Buffer.from(result.images[0], 'base64');

  return {
    outputBuffer,
    processingTimeMs: Date.now() - startTime,
    metadata: {
      width: options.width || 1024,
      height: options.height || 1024,
      format: 'png'
    }
  };
}
