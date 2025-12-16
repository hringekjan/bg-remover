import { z } from 'zod';

/**
 * Product Identity Detection Settings Schema
 * Configures the multi-signal detection algorithm for product grouping
 */

export const SignalWeightsSchema = z.object({
  spatial: z.number().min(0).max(1), // SSIM, edge detection, aspect ratio
  feature: z.number().min(0).max(1), // ORB keypoint matching
  semantic: z.number().min(0).max(1), // AWS Rekognition labels
  composition: z.number().min(0).max(1), // Subject position/size
  background: z.number().min(0).max(1), // Color histogram
}).refine(
  (data) => {
    const sum = data.spatial + data.feature + data.semantic + data.composition + data.background;
    return Math.abs(sum - 1.0) < 0.01; // Allow tiny floating point errors
  },
  { message: "Signal weights must sum to 1.0" }
);

export const RekognitionConfigSchema = z.object({
  minConfidence: z.number().min(0).max(100).default(50),
  maxLabels: z.number().min(1).max(100).default(20),
});

export const ProductIdentitySettingsSchema = z.object({
  threshold: z.number().min(0).max(1).default(0.70),
  minGroupSize: z.number().int().min(1).default(1),
  maxGroupSize: z.number().int().min(1).default(6),
  useRekognition: z.boolean().default(true),
  signalWeights: SignalWeightsSchema,
  rekognitionConfig: RekognitionConfigSchema.optional(),
}).refine(
  (data) => data.minGroupSize <= data.maxGroupSize,
  { message: "minGroupSize must be <= maxGroupSize" }
);

export type SignalWeights = z.infer<typeof SignalWeightsSchema>;
export type RekognitionConfig = z.infer<typeof RekognitionConfigSchema>;
export type ProductIdentitySettings = z.infer<typeof ProductIdentitySettingsSchema>;

/**
 * Default settings for product identity detection
 */
export const DEFAULT_SETTINGS: ProductIdentitySettings = {
  threshold: 0.70,
  minGroupSize: 1,
  maxGroupSize: 6,
  useRekognition: true,
  signalWeights: {
    spatial: 0.40,    // 40% - Overall layout and structure
    feature: 0.35,    // 35% - Distinctive patterns and textures
    semantic: 0.15,   // 15% - What the product is (AWS Rekognition)
    composition: 0.05, // 5% - Where product appears in frame
    background: 0.05,  // 5% - Background color consistency
  },
  rekognitionConfig: {
    minConfidence: 50,
    maxLabels: 20,
  },
};

/**
 * Product group type definition
 */
export interface ProductGroup {
  id: string;
  imageIds: string[];
  averageSimilarity: number;
  confidence: number;
  groupType: 'automatic' | 'manual' | 'split' | 'merged';
  metadata?: {
    memberCount: number;
    minSimilarity: number;
    maxSimilarity: number;
  };
  name?: string;
}

/**
 * Grouping result
 */
export interface GroupingResult {
  groups: ProductGroup[];
  ungroupedImages: string[];
  processingTime: number;
  cacheHitRate?: number;
}

/**
 * Image similarity score
 */
export interface SimilarityScore {
  imageA: string;
  imageB: string;
  overallScore: number;
  signalScores: {
    spatial: number;
    feature: number;
    semantic: number;
    composition: number;
    background: number;
  };
}
