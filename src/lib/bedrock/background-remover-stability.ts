/**
 * Background removal using Stability AI via AWS Bedrock.
 * Higher quality than rembg U2Net — better edge detection, hair/fur handling.
 */

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const BEDROCK_VISION_REGION = process.env.BEDROCK_VISION_REGION || 'us-east-1';
const STABILITY_MODEL_ID = 'us.stability.stable-image-remove-background-v1:0';

const bedrockClient = new BedrockRuntimeClient({ region: BEDROCK_VISION_REGION });

export interface StabilityRemoveBackgroundOptions {
  quality?: 'standard' | 'premium';
}

export interface StabilityRemoveBackgroundResult {
  outputBuffer: Buffer;
  processingTimeMs: number;
  metadata: {
    width: number;
    height: number;
    format: string;
  };
  method: 'stability-ai';
}

/**
 * Remove background using Stability AI via Bedrock.
 * Returns a transparent PNG buffer.
 */
export async function removeBackgroundStability(
  base64Image: string,
  _options: StabilityRemoveBackgroundOptions = {}
): Promise<StabilityRemoveBackgroundResult> {
  const startTime = Date.now();

  // Stability AI expects a multipart form or base64 input
  // Using the Bedrock InvokeModel API with base64 image
  const input = {
    prompt: '',
    image: base64Image,
    output_format: 'png',
  };

  const command = new InvokeModelCommand({
    modelId: STABILITY_MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(input),
  });

  const response = await bedrockClient.send(command);
  const responseBody = JSON.parse(new TextDecoder().decode(response.body));

  // Stability AI returns base64-encoded output image
  const outputBuffer = Buffer.from(responseBody.image, 'base64');

  return {
    outputBuffer,
    processingTimeMs: Date.now() - startTime,
    metadata: {
      width: 0, // Resolved downstream by Sharp
      height: 0,
      format: 'png',
    },
    method: 'stability-ai',
  };
}
