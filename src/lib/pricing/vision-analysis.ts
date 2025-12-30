/**
 * Vision Analysis Service - Bedrock Nova Lite Integration
 *
 * Provides cost-effective visual quality assessment using AWS Bedrock Nova Lite
 * multimodal model for product condition analysis and pricing adjustments.
 *
 * Features:
 * - Condition quality rating (1-10 scale)
 * - Photo quality assessment
 * - Defect detection
 * - Pricing multiplier generation (0.75-1.15)
 * - Error handling with graceful degradation
 *
 * Cost: $0.000096 per request
 * Latency: <1s per image
 */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { z } from 'zod';

/**
 * Visual quality assessment result
 */
export interface VisualQualityAssessment {
  conditionScore: number; // 1-10 scale
  photoQualityScore: number; // 1-10 scale
  visibleDefects: string[];
  overallAssessment: 'excellent' | 'good' | 'fair' | 'poor';
  pricingImpact: 'increase' | 'neutral' | 'decrease';
  reasoning: string;
  multiplier: number; // 0.75-1.15
}

/**
 * Product context for vision analysis
 */
export interface ProductContext {
  category?: string;
  brand?: string;
  claimedCondition?: string;
}

/**
 * Supported image media types for Bedrock Nova Lite
 */
export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/webp';

/**
 * Image input with explicit format specification
 */
export interface ImageInput {
  base64: string;
  mediaType: ImageMediaType;
}

/**
 * Zod schema for Bedrock assessment response validation
 * Ensures all responses conform to expected structure before processing
 */
const BedrockAssessmentSchema = z.object({
  conditionScore: z
    .number()
    .min(1)
    .max(10)
    .describe('Product condition rating 1-10'),
  photoQualityScore: z
    .number()
    .min(1)
    .max(10)
    .describe('Photo quality rating 1-10'),
  visibleDefects: z
    .array(z.string())
    .describe('List of detected defects'),
  overallAssessment: z
    .enum(['excellent', 'good', 'fair', 'poor'])
    .describe('Holistic quality assessment'),
  pricingImpact: z
    .enum(['increase', 'neutral', 'decrease'])
    .describe('Pricing direction recommendation'),
  reasoning: z
    .string()
    .min(1)
    .describe('Explanation of assessment'),
});

type BedrockAssessment = z.infer<typeof BedrockAssessmentSchema>;

/**
 * Validates base64 encoded image format and size constraints
 *
 * @param input - Base64 encoded image string
 * @throws Error if validation fails
 */
function validateBase64Image(input: string): void {
  // Type check
  if (!input || typeof input !== 'string') {
    throw new Error('Invalid image input: must be non-empty string');
  }

  // Base64 format validation
  const base64Regex = /^[A-Za-z0-9+/]+={0,2}$/;
  if (!base64Regex.test(input)) {
    throw new Error('Invalid base64 encoding');
  }

  // Size validation (5MB max, matching Nova Lite API limits)
  const sizeBytes = (input.length * 3) / 4;
  const maxSizeBytes = 5 * 1024 * 1024; // 5MB
  if (sizeBytes > maxSizeBytes) {
    throw new Error(
      `Image too large: ${(sizeBytes / 1024 / 1024).toFixed(2)}MB (max 5MB)`
    );
  }
}

/**
 * Auto-detects image format from base64 magic bytes
 *
 * @param base64 - Base64 encoded image
 * @returns Detected media type
 * @throws Error if format not recognized
 */
function detectImageFormat(base64: string): ImageMediaType {
  // JPEG magic bytes: FFD8FF
  if (base64.startsWith('/9j/')) {
    return 'image/jpeg';
  }
  // PNG magic bytes: 89504E47
  if (base64.startsWith('iVBORw')) {
    return 'image/png';
  }
  // WebP magic bytes: 52494646...57454250
  if (base64.startsWith('UklGR')) {
    return 'image/webp';
  }

  throw new Error('Unsupported or unrecognized image format');
}

/**
 * VisionAnalysisService - Bedrock Nova Lite for visual quality assessment
 */
export class VisionAnalysisService {
  private bedrock: BedrockRuntimeClient;
  private region: string;
  private readonly requestTimeout: number;
  private readonly maxResponseSize: number = 10 * 1024; // 10KB

  /**
   * Initialize vision analysis service with configurable timeout
   *
   * @param options - Configuration options
   * @param options.region - AWS region (default: us-east-1)
   * @param options.timeout - Request timeout in milliseconds (default: 10000)
   */
  constructor(
    options: { region?: string; timeout?: number } = {}
  ) {
    this.region = options.region || 'us-east-1';
    this.requestTimeout = options.timeout || 10000; // 10 seconds default

    this.bedrock = new BedrockRuntimeClient({
      region: this.region,
      requestHandler: {
        requestTimeout: this.requestTimeout,
      },
      maxAttempts: 3,
      retryMode: 'adaptive',
    });

    console.log('[VisionAnalysis] Initialized', {
      region: this.region,
      model: 'us.amazon.nova-lite-v1:0',
      timeout: `${this.requestTimeout}ms`,
    });
  }

  /**
   * Returns default assessment for error cases
   *
   * @returns Neutral assessment with no multiplier adjustment
   */
  private getDefaultAssessment(): VisualQualityAssessment {
    return {
      conditionScore: 5,
      photoQualityScore: 5,
      visibleDefects: [],
      overallAssessment: 'good',
      pricingImpact: 'neutral',
      reasoning: 'Vision analysis unavailable, using neutral assessment',
      multiplier: 1.0,
    };
  }

  /**
   * Assess visual quality using Bedrock Nova Lite
   *
   * Analyzes product image for condition, defects, and photo quality,
   * returning a pricing multiplier for use in price suggestions.
   *
   * @param imageInput - Image input with base64 and media type, or plain base64 string
   * @param context - Optional product context
   * @returns Quality assessment with pricing multiplier
   * @throws Error if image validation fails (validation handled in try-catch)
   */
  async assessVisualQuality(
    imageInput: ImageInput | string,
    context?: ProductContext
  ): Promise<VisualQualityAssessment> {
    const startTime = Date.now();

    try {
      // Handle both legacy string input and new ImageInput interface
      let base64: string;
      let mediaType: ImageMediaType;

      if (typeof imageInput === 'string') {
        // Legacy support: validate and auto-detect format
        base64 = imageInput;
        validateBase64Image(base64);
        mediaType = detectImageFormat(base64);
      } else {
        // New ImageInput interface
        base64 = imageInput.base64;
        mediaType = imageInput.mediaType;
        validateBase64Image(base64);
      }

      const prompt = this.buildPrompt(context);

      const response = await this.bedrock.send(
        new InvokeModelCommand({
          modelId: 'us.amazon.nova-lite-v1:0',
          contentType: 'application/json',
          accept: 'application/json',
          body: JSON.stringify({
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'image',
                    source: {
                      type: 'base64',
                      media_type: mediaType,
                      data: base64,
                    },
                  },
                  {
                    type: 'text',
                    text: prompt,
                  },
                ],
              },
            ],
            inferenceConfig: {
              maxTokens: 500,
              temperature: 0.3, // Low temperature for consistent scoring
              topP: 0.9,
            },
          }),
        })
      );

      // Validate response body exists
      if (!response.body) {
        throw new Error('Empty response body from Bedrock');
      }

      // Read and validate response size before parsing
      const bodyString = await new Response(response.body as any).text();

      if (bodyString.length > this.maxResponseSize) {
        console.error('[VisionAnalysis] Response too large', {
          size: bodyString.length,
          maxSize: this.maxResponseSize,
        });
        return this.getDefaultAssessment();
      }

      // Parse outer response envelope
      let result: any;
      try {
        result = JSON.parse(bodyString);
      } catch (e) {
        throw new Error('Failed to parse Bedrock response envelope');
      }

      // Extract assessment JSON from response content
      const responseText =
        result.output?.message?.content?.[0]?.text ||
        result.content?.[0]?.text ||
        '';

      if (!responseText) {
        throw new Error('No assessment text in Bedrock response');
      }

      // Parse assessment JSON
      let rawAssessment: any;
      try {
        rawAssessment = JSON.parse(responseText);
      } catch (e) {
        throw new Error('Failed to parse assessment JSON from Bedrock');
      }

      // Validate assessment structure with Zod
      const assessment = BedrockAssessmentSchema.parse(rawAssessment);

      const duration = Date.now() - startTime;
      console.log('[VisionAnalysis] Bedrock Nova Lite completed', {
        duration,
        conditionScore: assessment.conditionScore,
        overallAssessment: assessment.overallAssessment,
      });

      // Convert assessment to multiplier
      const multiplier = this.assessmentToMultiplier(assessment);

      return {
        conditionScore: assessment.conditionScore,
        photoQualityScore: assessment.photoQualityScore,
        visibleDefects: assessment.visibleDefects,
        overallAssessment: assessment.overallAssessment,
        pricingImpact: assessment.pricingImpact,
        reasoning: assessment.reasoning,
        multiplier,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      console.error('[VisionAnalysis] Error:', {
        error: errorMessage,
        duration,
        type: error instanceof Error ? error.constructor.name : 'unknown',
      });

      // Graceful degradation - return neutral assessment
      return this.getDefaultAssessment();
    }
  }

  /**
   * Build structured prompt for Nova Lite
   *
   * @param context - Optional product context
   * @returns Formatted prompt string
   */
  private buildPrompt(context?: ProductContext): string {
    const contextInfo = context
      ? `\n\nProduct context:\n- Category: ${context.category || 'Unknown'}\n- Brand: ${context.brand || 'Unknown'}\n- Claimed condition: ${context.claimedCondition || 'Not specified'}`
      : '';

    return `Analyze this product image and assess its condition quality for resale pricing.${contextInfo}

Rate the following on a scale of 1-10:
1. Overall condition (wear, damage, cleanliness, completeness)
2. Photo quality (lighting, clarity, angles, presentation)
3. Visible defects (scratches, stains, structural issues, missing parts)

Provide your analysis in this exact JSON format:
{
  "conditionScore": <1-10>,
  "photoQualityScore": <1-10>,
  "visibleDefects": ["defect1", "defect2", ...],
  "overallAssessment": "excellent" | "good" | "fair" | "poor",
  "pricingImpact": "increase" | "neutral" | "decrease",
  "reasoning": "Brief explanation (1-2 sentences)"
}

Guidelines:
- conditionScore: 10 = perfect/new, 8-9 = like new, 6-7 = good, 4-5 = fair, 1-3 = poor
- photoQualityScore: 10 = professional, 7-9 = good amateur, 4-6 = acceptable, 1-3 = poor
- overallAssessment: Holistic evaluation considering both condition and photos
- pricingImpact: "increase" if condition better than expected, "decrease" if worse, "neutral" if as expected
- reasoning: Focus on key factors affecting resale value

Return ONLY the JSON object, no additional text.`;
  }

  /**
   * Convert assessment to pricing multiplier
   *
   * Maps overall assessment to a pricing multiplier with adjustment for photo quality.
   * All input validation is completed by Zod schema parsing before this method is called.
   *
   * @param assessment - Validated assessment object from Nova Lite
   * @returns Pricing multiplier (0.75-1.15)
   */
  private assessmentToMultiplier(assessment: BedrockAssessment): number {
    const multipliers: Record<
      'excellent' | 'good' | 'fair' | 'poor',
      number
    > = {
      excellent: 1.15, // 15% premium for exceptional condition
      good: 1.0, // Standard pricing
      fair: 0.9, // 10% discount for minor issues
      poor: 0.75, // 25% discount for significant issues
    };

    const baseMultiplier = multipliers[assessment.overallAssessment];

    // Adjust for photo quality (poor photos reduce confidence)
    const photoAdjustment =
      assessment.photoQualityScore < 5 ? 0.95 : 1.0;

    return baseMultiplier * photoAdjustment;
  }

  /**
   * Batch assess multiple images
   *
   * Analyzes multiple product images and returns the worst-case assessment
   * with averaged multipliers for conservative pricing.
   *
   * @param images - Array of base64 encoded images
   * @param context - Optional product context
   * @returns Combined quality assessment
   */
  async assessMultipleImages(
    images: string[],
    context?: ProductContext
  ): Promise<VisualQualityAssessment> {
    if (images.length === 0) {
      return {
        conditionScore: 5,
        photoQualityScore: 5,
        visibleDefects: [],
        overallAssessment: 'good',
        pricingImpact: 'neutral',
        reasoning: 'No images provided for assessment',
        multiplier: 1.0,
      };
    }

    // Assess all images in parallel
    const assessments = await Promise.all(
      images.map((img) => this.assessVisualQuality(img, context))
    );

    // Take the worst-case assessment (most conservative pricing)
    const worstAssessment = assessments.reduce((worst, current) => {
      return current.conditionScore < worst.conditionScore ? current : worst;
    });

    // Average the multipliers for final pricing impact
    const avgMultiplier =
      assessments.reduce((sum, a) => sum + a.multiplier, 0) /
      assessments.length;

    return {
      ...worstAssessment,
      multiplier: avgMultiplier,
      reasoning: `Analyzed ${images.length} images. ${worstAssessment.reasoning}`,
    };
  }
}
