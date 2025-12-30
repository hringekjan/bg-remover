/**
 * Model Router - Deterministic routing logic for tiered model selection
 *
 * Routes image processing requests to appropriate Bedrock models based on
 * objective complexity indicators (image size, dimensions, processing options).
 *
 * Approach: Start with simple heuristics, add ML later if data justifies it.
 * Philosophy: "Measure first, optimize second" - Marvin's guidance.
 */

import { TIERED_MODELS } from '../bedrock/model-registry';

export interface ImageMetadata {
  width: number;
  height: number;
  fileSizeBytes: number;
  format?: string;
  hasAlpha?: boolean;
}

export interface ProcessingOptions {
  generateDescription?: boolean;
  autoTrim?: boolean;
  centerSubject?: boolean;
  enhanceColors?: boolean;
  targetSize?: { width: number; height: number };
  quality?: number;
}

export interface RoutingDecision {
  modelId: string;
  tier: 'default' | 'complex' | 'expert';
  reason: string;
  confidence: number; // 0-1
  metadata: {
    megapixels: number;
    fileSizeMB: number;
    complexityScore: number;
  };
}

/**
 * Calculate complexity score based on image characteristics
 * Higher score = more complex processing required
 */
function calculateComplexityScore(
  metadata: ImageMetadata,
  options: ProcessingOptions
): number {
  let score = 0;

  // Megapixels (0-40 points)
  const megapixels = (metadata.width * metadata.height) / 1_000_000;
  if (megapixels > 10) score += 40;
  else if (megapixels > 5) score += 25;
  else if (megapixels > 2) score += 10;

  // File size (0-20 points)
  const fileSizeMB = metadata.fileSizeBytes / (1024 * 1024);
  if (fileSizeMB > 10) score += 20;
  else if (fileSizeMB > 5) score += 10;

  // Alpha channel complexity (0-15 points)
  if (metadata.hasAlpha) score += 15;

  // Processing options complexity (0-25 points)
  if (options.generateDescription) score += 10; // LLM analysis required
  if (options.enhanceColors) score += 5;
  if (options.centerSubject) score += 5;
  if (options.autoTrim) score += 5;

  return score;
}

/**
 * Route image processing to appropriate model tier
 *
 * Decision thresholds (empirically derived, adjust based on metrics):
 * - 0-30: default (nova-lite) - simple images, fast processing
 * - 31-60: complex (nova-pro) - medium complexity
 * - 61+: expert (nova-pro with extended context) - high complexity
 *
 * Target distribution (based on TIERED_MODELS comments):
 * - 90% default
 * - 8% complex
 * - 2% expert
 */
export function routeToModel(
  metadata: ImageMetadata,
  options: ProcessingOptions = {}
): RoutingDecision {
  const complexityScore = calculateComplexityScore(metadata, options);
  const megapixels = (metadata.width * metadata.height) / 1_000_000;
  const fileSizeMB = metadata.fileSizeBytes / (1024 * 1024);

  // Routing decision tree
  if (complexityScore <= 30) {
    // Default tier: 90% of requests
    return {
      modelId: TIERED_MODELS.default,
      tier: 'default',
      reason: 'Simple image with basic processing requirements',
      confidence: complexityScore < 15 ? 0.95 : 0.85,
      metadata: {
        megapixels,
        fileSizeMB,
        complexityScore,
      },
    };
  } else if (complexityScore <= 60) {
    // Complex tier: 8% of requests
    return {
      modelId: TIERED_MODELS.complex,
      tier: 'complex',
      reason: 'Medium complexity - enhanced processing or larger image',
      confidence: complexityScore < 45 ? 0.80 : 0.70,
      metadata: {
        megapixels,
        fileSizeMB,
        complexityScore,
      },
    };
  } else {
    // Expert tier: 2% of requests
    return {
      modelId: TIERED_MODELS.expert,
      tier: 'expert',
      reason: 'High complexity - large image with advanced processing',
      confidence: 0.90,
      metadata: {
        megapixels,
        fileSizeMB,
        complexityScore,
      },
    };
  }
}

/**
 * Detailed routing reasons for logging and debugging
 */
export function getRoutingExplanation(decision: RoutingDecision): string {
  const { tier, metadata, reason } = decision;
  return [
    `Tier: ${tier}`,
    `Reason: ${reason}`,
    `Complexity Score: ${metadata.complexityScore}/100`,
    `Image Size: ${metadata.megapixels.toFixed(2)}MP (${metadata.fileSizeMB.toFixed(2)}MB)`,
    `Confidence: ${(decision.confidence * 100).toFixed(0)}%`,
  ].join(' | ');
}

/**
 * Validate routing decision for A/B testing
 * Returns true if decision is within expected distribution
 */
export function validateRoutingDistribution(
  decisions: RoutingDecision[]
): {
  valid: boolean;
  distribution: Record<string, number>;
  warnings: string[];
} {
  const total = decisions.length;
  const counts = {
    default: decisions.filter(d => d.tier === 'default').length,
    complex: decisions.filter(d => d.tier === 'complex').length,
    expert: decisions.filter(d => d.tier === 'expert').length,
  };

  const distribution = {
    default: (counts.default / total) * 100,
    complex: (counts.complex / total) * 100,
    expert: (counts.expert / total) * 100,
  };

  const warnings: string[] = [];

  // Expected: 90% default, 8% complex, 2% expert (±10% tolerance)
  if (distribution.default < 80 || distribution.default > 95) {
    warnings.push(`Default tier at ${distribution.default.toFixed(1)}% (expected 85-95%)`);
  }
  if (distribution.complex < 5 || distribution.complex > 15) {
    warnings.push(`Complex tier at ${distribution.complex.toFixed(1)}% (expected 5-15%)`);
  }
  if (distribution.expert > 5) {
    warnings.push(`Expert tier at ${distribution.expert.toFixed(1)}% (expected <5%)`);
  }

  return {
    valid: warnings.length === 0,
    distribution,
    warnings,
  };
}
