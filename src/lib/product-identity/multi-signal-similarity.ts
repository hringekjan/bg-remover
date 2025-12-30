/**
 * Multi-Signal Similarity Analysis for Product Identity
 *
 * Implements a 5-signal weighted approach to determine product similarity:
 * - Spatial (40%): SSIM, edge detection, aspect ratio
 * - Feature (35%): Keypoint matching, texture patterns
 * - Semantic (15%): AWS Rekognition labels
 * - Composition (5%): Subject position/size
 * - Background (5%): Color histogram
 */

import { RekognitionClient, DetectLabelsCommand, Label } from '@aws-sdk/client-rekognition';

// Lazy load Sharp only when multi-signal features are enabled
let sharp: any = null;
async function getSharp() {
  if (!sharp) {
    try {
      sharp = (await import('sharp')).default;
    } catch (error) {
      console.error('[MultiSignal] Failed to load Sharp module:', error);
      throw new Error('Sharp module required for multi-signal analysis but not available');
    }
  }
  return sharp;
}

export interface MultiSignalSettings {
  enabled: boolean;
  weights: {
    spatial: number;      // Default: 0.40
    feature: number;      // Default: 0.35
    semantic: number;     // Default: 0.15
    composition: number;  // Default: 0.05
    background: number;   // Default: 0.05
  };
  thresholds: {
    sameProduct: number;      // Default: 0.92
    likelySame: number;       // Default: 0.85
    possiblySame: number;     // Default: 0.75
  };
  rekognition: {
    enabled: boolean;
    minConfidence: number;    // Default: 70
    maxLabels: number;        // Default: 10
    batchSize: number;        // Default: 10
  };
}

export const DEFAULT_SETTINGS: MultiSignalSettings = {
  enabled: false,  // Disabled by default - requires Sharp module for Lambda ARM64
  weights: {
    spatial: 0.40,
    feature: 0.35,
    semantic: 0.15,
    composition: 0.05,
    background: 0.05,
  },
  thresholds: {
    sameProduct: 0.92,
    likelySame: 0.85,
    possiblySame: 0.75,
  },
  rekognition: {
    enabled: true,
    minConfidence: 70,
    maxLabels: 10,
    batchSize: 10,
  },
};

export interface ImageFeatures {
  id: string;
  buffer: Buffer;
  width: number;
  height: number;
  aspectRatio: number;
  edges?: Buffer;
  colorHistogram?: number[];
  rekognitionLabels?: Label[];
}

export interface SignalBreakdown {
  spatial: number;
  feature: number;
  semantic: number;
  composition: number;
  background: number;
}

export interface SimilarityScore {
  totalScore: number;
  signalBreakdown: SignalBreakdown;
}

/**
 * Calculate spatial similarity using SSIM-like approach
 */
export async function calculateSpatialSimilarity(
  img1: ImageFeatures,
  img2: ImageFeatures
): Promise<number> {
  // Aspect ratio similarity (0-1)
  const aspectRatioDiff = Math.abs(img1.aspectRatio - img2.aspectRatio);
  const aspectScore = Math.max(0, 1 - (aspectRatioDiff / 0.5)); // 0.5 = max acceptable diff

  // Edge detection correlation (if available)
  let edgeScore = 0.5; // Default neutral score
  if (img1.edges && img2.edges) {
    // Resize edges to same size for comparison
    const size = 64;
    const sharpInstance = await getSharp();
    const edges1 = await sharpInstance(img1.edges).resize(size, size, { fit: 'fill' }).raw().toBuffer();
    const edges2 = await sharpInstance(img2.edges).resize(size, size, { fit: 'fill' }).raw().toBuffer();

    // Calculate correlation
    let sum = 0;
    for (let i = 0; i < edges1.length; i++) {
      sum += (edges1[i] === edges2[i]) ? 1 : 0;
    }
    edgeScore = sum / edges1.length;
  }

  // Weighted combination
  return (aspectScore * 0.4) + (edgeScore * 0.6);
}

/**
 * Calculate feature similarity using simple texture patterns
 * (Simplified version - full implementation would use FAST+BRIEF)
 */
export async function calculateFeatureSimilarity(
  img1: ImageFeatures,
  img2: ImageFeatures
): Promise<number> {
  // Resize both images to same size for comparison
  const size = 128;
  const sharpInstance = await getSharp();

  const buf1 = await sharpInstance(img1.buffer)
    .resize(size, size, { fit: 'cover' })
    .greyscale()
    .raw()
    .toBuffer();

  const buf2 = await sharpInstance(img2.buffer)
    .resize(size, size, { fit: 'cover' })
    .greyscale()
    .raw()
    .toBuffer();

  // Calculate pixel-wise difference
  let diff = 0;
  for (let i = 0; i < buf1.length; i++) {
    diff += Math.abs(buf1[i] - buf2[i]);
  }

  // Normalize to 0-1 (lower diff = higher similarity)
  const maxDiff = buf1.length * 255;
  return 1 - (diff / maxDiff);
}

/**
 * Calculate semantic similarity using AWS Rekognition labels
 */
export function calculateSemanticSimilarity(
  img1: ImageFeatures,
  img2: ImageFeatures
): number {
  if (!img1.rekognitionLabels || !img2.rekognitionLabels) {
    return 0.5; // Neutral score if labels unavailable
  }

  const labels1 = new Set(img1.rekognitionLabels.map(l => l.Name?.toLowerCase()));
  const labels2 = new Set(img2.rekognitionLabels.map(l => l.Name?.toLowerCase()));

  // Jaccard similarity (intersection over union)
  const intersection = new Set([...labels1].filter(x => labels2.has(x)));
  const union = new Set([...labels1, ...labels2]);

  if (union.size === 0) return 0.5;

  return intersection.size / union.size;
}

/**
 * Calculate composition similarity (subject position/size)
 */
export function calculateCompositionSimilarity(
  img1: ImageFeatures,
  img2: ImageFeatures
): number {
  // Size similarity
  const size1 = img1.width * img1.height;
  const size2 = img2.width * img2.height;
  const sizeRatio = Math.min(size1, size2) / Math.max(size1, size2);

  return sizeRatio;
}

/**
 * Calculate background similarity using color histograms
 */
export function calculateBackgroundSimilarity(
  img1: ImageFeatures,
  img2: ImageFeatures
): number {
  if (!img1.colorHistogram || !img2.colorHistogram) {
    return 0.5; // Neutral score
  }

  // Histogram intersection
  let intersection = 0;
  for (let i = 0; i < img1.colorHistogram.length; i++) {
    intersection += Math.min(img1.colorHistogram[i], img2.colorHistogram[i]);
  }

  // Normalize
  const sum1 = img1.colorHistogram.reduce((a, b) => a + b, 0);
  const sum2 = img2.colorHistogram.reduce((a, b) => a + b, 0);
  const avgSum = (sum1 + sum2) / 2;

  return avgSum > 0 ? intersection / avgSum : 0;
}

/**
 * Calculate overall similarity using weighted signals
 */
export async function calculateMultiSignalSimilarity(
  img1: ImageFeatures,
  img2: ImageFeatures,
  settings: MultiSignalSettings = DEFAULT_SETTINGS
): Promise<SimilarityScore> {
  const spatial = await calculateSpatialSimilarity(img1, img2);
  const feature = await calculateFeatureSimilarity(img1, img2);
  const semantic = calculateSemanticSimilarity(img1, img2);
  const composition = calculateCompositionSimilarity(img1, img2);
  const background = calculateBackgroundSimilarity(img1, img2);

  const totalScore =
    (spatial * settings.weights.spatial) +
    (feature * settings.weights.feature) +
    (semantic * settings.weights.semantic) +
    (composition * settings.weights.composition) +
    (background * settings.weights.background);

  return {
    totalScore,
    signalBreakdown: {
      spatial,
      feature,
      semantic,
      composition,
      background,
    },
  };
}

/**
 * Extract features from image buffer
 */
export async function extractImageFeatures(
  id: string,
  buffer: Buffer,
  rekognitionClient?: RekognitionClient,
  settings: MultiSignalSettings = DEFAULT_SETTINGS
): Promise<ImageFeatures> {
  // Get Sharp instance
  const sharpInstance = await getSharp();

  // Get image metadata
  const metadata = await sharpInstance(buffer).metadata();
  const width = metadata.width || 0;
  const height = metadata.height || 0;
  const aspectRatio = height > 0 ? width / height : 1;

  // Extract edge detection
  const edges = await sharpInstance(buffer)
    .greyscale()
    .convolve({
      width: 3,
      height: 3,
      kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1] // Edge detection kernel
    })
    .raw()
    .toBuffer();

  // Extract color histogram (64 bins RGB)
  const { channels } = await sharpInstance(buffer).stats();
  const colorHistogram: number[] = [];
  for (const channel of channels) {
    // Simple histogram (would be more sophisticated in production)
    colorHistogram.push(channel.mean || 0);
  }

  const features: ImageFeatures = {
    id,
    buffer,
    width,
    height,
    aspectRatio,
    edges,
    colorHistogram,
  };

  // Get Rekognition labels if enabled
  if (settings.rekognition.enabled && rekognitionClient) {
    try {
      const command = new DetectLabelsCommand({
        Image: { Bytes: buffer },
        MaxLabels: settings.rekognition.maxLabels,
        MinConfidence: settings.rekognition.minConfidence,
      });

      const result = await rekognitionClient.send(command);
      features.rekognitionLabels = result.Labels || [];
    } catch (error) {
      console.warn('[MultiSignal] Rekognition failed for image:', id, error);
      // Continue without labels
    }
  }

  return features;
}

/**
 * Batch extract features for multiple images
 */
export async function batchExtractFeatures(
  images: Array<{ id: string; buffer: Buffer }>,
  region: string = 'eu-west-1',
  settings: MultiSignalSettings = DEFAULT_SETTINGS
): Promise<ImageFeatures[]> {
  const rekognitionClient = settings.rekognition.enabled
    ? new RekognitionClient({ region })
    : undefined;

  const features: ImageFeatures[] = [];
  const batchSize = settings.rekognition.batchSize;

  // Process in batches to respect rate limits
  for (let i = 0; i < images.length; i += batchSize) {
    const batch = images.slice(i, i + batchSize);

    const batchFeatures = await Promise.all(
      batch.map(img => extractImageFeatures(img.id, img.buffer, rekognitionClient, settings))
    );

    features.push(...batchFeatures);

    // Small delay between batches to avoid rate limiting
    if (i + batchSize < images.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  return features;
}
