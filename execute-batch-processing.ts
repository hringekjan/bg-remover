import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { RekognitionClient, DetectLabelsCommand } from '@aws-sdk/client-rekognition';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import sharp from 'sharp';

const bedrockClient = new BedrockRuntimeClient({ region: 'us-east-1' });
const rekognitionClient = new RekognitionClient({ region: 'us-east-1' });

interface ProcessingResult {
  jobId: string;
  originalFilename: string;
  backgroundRemoval: {
    success: boolean;
    outputPath: string;
    processingTimeMs: number;
  };
  productAnalysis: {
    category: string;
    colors: string[];
    features: string[];
    confidence: number;
    labels: Array<{ name: string; confidence: number }>;
  };
}

async function convertToJpeg(imageBuffer: Buffer): Promise<Buffer> {
  // Convert any image format to JPEG with white background (no transparency)
  return await sharp(imageBuffer)
    .flatten({ background: { r: 255, g: 255, b: 255 } }) // Remove transparency with white background
    .jpeg({ quality: 90 })
    .toBuffer();
}

async function removeBackground(imageBuffer: Buffer, imageId: string) {
  const startTime = Date.now();

  // Convert image to JPEG to ensure Nova Canvas compatibility
  const jpegBuffer = await convertToJpeg(imageBuffer);
  const base64Image = jpegBuffer.toString('base64');

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
        quality: 'premium',
        height: 1024,
        width: 1024
      }
    })
  });

  const response = await bedrockClient.send(command);
  const result = JSON.parse(new TextDecoder().decode(response.body));

  // Save output
  const outputDir = 'services/bg-remover/artifacts/execution-results';
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const outputPath = join(outputDir, `${imageId}-no-bg.png`);
  const outputBuffer = Buffer.from(result.images[0], 'base64');
  writeFileSync(outputPath, outputBuffer);

  return {
    success: true,
    outputPath,
    processingTimeMs: Date.now() - startTime
  };
}

async function analyzeWithRekognition(imageBuffer: Buffer) {
  const command = new DetectLabelsCommand({
    Image: {
      Bytes: imageBuffer
    },
    MaxLabels: 20,
    MinConfidence: 70,
    Features: ['GENERAL_LABELS', 'IMAGE_PROPERTIES']
  });

  const response = await rekognitionClient.send(command);

  // Extract primary category (highest confidence parent label)
  const primaryLabel = response.Labels?.[0];
  const category = primaryLabel?.Name || 'Unknown';

  // Extract features (high confidence labels)
  const features = response.Labels
    ?.filter(label => label.Confidence! > 80)
    .map(label => label.Name!) || [];

  // Extract dominant colors
  const colors = response.ImageProperties?.DominantColors
    ?.map(color => color.SimplifiedColor!) || [];

  return {
    category,
    colors,
    features,
    confidence: primaryLabel?.Confidence || 0,
    labels: response.Labels?.map(l => ({
      name: l.Name!,
      confidence: l.Confidence!
    })) || []
  };
}

async function processImage(imagePath: string, imageId: string): Promise<ProcessingResult> {
  console.log(`Processing ${imageId}...`);
  const originalImageBuffer = readFileSync(imagePath);

  // Convert to JPEG for Rekognition compatibility
  const jpegBuffer = await convertToJpeg(originalImageBuffer);

  // Stage 1: Remove background with Nova Canvas (uses JPEG internally)
  const bgRemovalResult = await removeBackground(originalImageBuffer, imageId);
  console.log(`  ✅ Background removed (${bgRemovalResult.processingTimeMs}ms)`);

  // Stage 2: Analyze with Rekognition (use JPEG version of original image)
  const rekognitionResult = await analyzeWithRekognition(jpegBuffer);
  console.log(`  ✅ Product analyzed: ${rekognitionResult.category} (${rekognitionResult.confidence.toFixed(1)}% confidence)`);

  return {
    jobId: imageId,
    originalFilename: imagePath.split('/').pop()!,
    backgroundRemoval: bgRemovalResult,
    productAnalysis: rekognitionResult,
  };
}

async function processBatch() {
  console.log('🚀 Starting batch image processing...\n');

  // Read manifest
  const manifestPath = '/tmp/bg-remover-batch-manifest.json';
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

  const results: ProcessingResult[] = [];
  const startTime = Date.now();

  for (const img of manifest.images) {
    try {
      const result = await processImage(img.path, img.id);
      results.push(result);
    } catch (error: any) {
      console.error(`  ❌ Error processing ${img.id}:`, error.message);
      results.push({
        jobId: img.id,
        originalFilename: img.filename,
        backgroundRemoval: {
          success: false,
          outputPath: '',
          processingTimeMs: 0
        },
        productAnalysis: {
          category: 'Error',
          colors: [],
          features: [],
          confidence: 0,
          labels: []
        }
      });
    }
  }

  const totalTime = Date.now() - startTime;

  // Generate comprehensive results
  const output = {
    success: true,
    timestamp: new Date().toISOString(),
    totalImages: results.length,
    successfulProcessing: results.filter(r => r.backgroundRemoval.success).length,
    modelsUsed: {
      backgroundRemoval: 'amazon.nova-canvas-v1:0',
      productAnalysis: 'aws.rekognition.detect-labels'
    },
    performance: {
      totalProcessingTimeMs: totalTime,
      averagePerImageMs: Math.round(totalTime / results.length),
      successRate: `${Math.round((results.filter(r => r.backgroundRemoval.success).length / results.length) * 100)}%`
    },
    results
  };

  // Save results JSON
  const outputPath = 'services/bg-remover/artifacts/execution-results/processing-results.json';
  writeFileSync(outputPath, JSON.stringify(output, null, 2));

  console.log('\n✅ Batch processing complete!');
  console.log(`📊 Total time: ${(totalTime / 1000).toFixed(1)}s`);
  console.log(`📈 Success rate: ${output.performance.successRate}`);
  console.log(`📁 Results saved to: ${outputPath}`);
  console.log(`🖼️  Images saved to: services/bg-remover/artifacts/execution-results/`);

  return output;
}

// Execute
processBatch().catch(console.error);
