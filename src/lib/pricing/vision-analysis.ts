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
 * - Circuit breaker pattern for resilience
 * - Externalized configuration
 *
 * Cost: $0.000096 per request
 * Latency: <1s per image
 */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { Logger } from '@aws-lambda-powertools/logger';
import { z } from 'zod';

/**
 * Configuration interface for vision analysis service
 */
export interface VisionAnalysisConfig {
  region: string;
  timeout: number;
  maxResponseSize: number;
  simpleCategories: string[];
  complexCategories: string[];
  defaultModel: string;
  novaMicroModel: string;
  novaLiteModel: string;
  titanEmbedModel: string;
  circuitBreaker: {
    failureThreshold: number;
    successThreshold: number;
    timeout: number;
  };
}

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: VisionAnalysisConfig = {
  region: 'us-east-1',
  timeout: 10000,
  maxResponseSize: 10 * 1024, // 10KB
  simpleCategories: [
    'electronics', 'computers', 'phones', 'tablets',
    'books', 'media', 'video games', 'accessories',
    'office supplies', 'cables', 'chargers'
  ],
  complexCategories: [
    'clothing', 'shoes', 'furniture', 'home decor',
    'jewelry', 'art', 'antiques', 'collectibles'
  ],
  defaultModel: 'us.amazon.nova-lite-v1:0',
  novaMicroModel: 'amazon.nova-micro-v1:0',
  novaLiteModel: 'us.amazon.nova-lite-v1:0',
  titanEmbedModel: 'amazon.titan-embed-image-v1',
  circuitBreaker: {
    failureThreshold: 5,
    successThreshold: 2,
    timeout: 30000, // 30 seconds
  },
};

/**
 * Load configuration from environment or use defaults
 */
function loadConfig(): VisionAnalysisConfig {
  return {
    region: process.env.AWS_REGION || process.env.BEDROCK_REGION || DEFAULT_CONFIG.region,
    timeout: parseInt(process.env.VISION_TIMEOUT_MS || '') || DEFAULT_CONFIG.timeout,
    maxResponseSize: parseInt(process.env.VISION_MAX_RESPONSE_SIZE || '') || DEFAULT_CONFIG.maxResponseSize,
    simpleCategories: parseEnvArray(process.env.VISION_SIMPLE_CATEGORIES) || DEFAULT_CONFIG.simpleCategories,
    complexCategories: parseEnvArray(process.env.VISION_COMPLEX_CATEGORIES) || DEFAULT_CONFIG.complexCategories,
    defaultModel: process.env.VISION_DEFAULT_MODEL || DEFAULT_CONFIG.defaultModel,
    novaMicroModel: process.env.VISION_NOVA_MICRO_MODEL || DEFAULT_CONFIG.novaMicroModel,
    novaLiteModel: process.env.VISION_NOVA_LITE_MODEL || DEFAULT_CONFIG.novaLiteModel,
    titanEmbedModel: process.env.VISION_TITAN_MODEL || DEFAULT_CONFIG.titanEmbedModel,
    circuitBreaker: {
      failureThreshold: parseInt(process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD || '') || DEFAULT_CONFIG.circuitBreaker.failureThreshold,
      successThreshold: parseInt(process.env.CIRCUIT_BREAKER_SUCCESS_THRESHOLD || '') || DEFAULT_CONFIG.circuitBreaker.successThreshold,
      timeout: parseInt(process.env.CIRCUIT_BREAKER_TIMEOUT || '') || DEFAULT_CONFIG.circuitBreaker.timeout,
    },
  };
}

/**
 * Parse comma-separated environment variable into array
 */
function parseEnvArray(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

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
 * Circuit breaker state
 */
enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

/**
 * Simple circuit breaker implementation
 */
class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount: number = 0;
  private successCount: number = 0;
  private lastFailureTime: number = 0;

  constructor(private readonly config: VisionAnalysisConfig['circuitBreaker']) {}

  /**
   * Execute function with circuit breaker protection
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      if (Date.now() - this.lastFailureTime > this.config.timeout) {
        this.state = CircuitState.HALF_OPEN;
        this.successCount = 0;
      } else {
        throw new Error('Circuit breaker is OPEN');
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.failureCount = 0;
    if (this.state === CircuitState.HALF_OPEN) {
      this.successCount++;
      if (this.successCount >= this.config.successThreshold) {
        this.state = CircuitState.CLOSED;
      }
    }
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.failureCount >= this.config.failureThreshold) {
      this.state = CircuitState.OPEN;
    }
  }

  getState(): string {
    return this.state;
  }
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
 * Multiplier configuration for assessment levels
 */
const MULTIPLIERS: Record<'excellent' | 'good' | 'fair' | 'poor', number> = {
  excellent: 1.15,
  good: 1.0,
  fair: 0.9,
  poor: 0.75,
};

/**
 * VisionAnalysisService - Bedrock Nova Lite for visual quality assessment
 */
export class VisionAnalysisService {
  private readonly config: VisionAnalysisConfig;
  private readonly logger: Logger;
  private readonly circuitBreaker: CircuitBreaker;

  /**
   * Initialize vision analysis service with configurable timeout
   */
  constructor(
    options: { config?: Partial<VisionAnalysisConfig>; logger?: Logger } = {}
  ) {
    this.config = { ...DEFAULT_CONFIG, ...options.config, circuitBreaker: { ...DEFAULT_CONFIG.circuitBreaker, ...options.config?.circuitBreaker } };
    this.logger = options.logger || new Logger({ serviceName: 'vision-analysis' });
    this.circuitBreaker = new CircuitBreaker(this.config.circuitBreaker);

    const bedrock = new BedrockRuntimeClient({
      region: this.config.region,
      requestHandler: {
        requestTimeout: this.config.timeout,
      },
      maxAttempts: 3,
      retryMode: 'adaptive',
    });

    // Use Object.defineProperty to make bedrock private but accessible
    Object.defineProperty(this, 'bedrock', { value: bedrock, writable: true, configurable: true });

    this.logger.info('VisionAnalysisService initialized', {
      region: this.config.region,
      timeout: `${this.config.timeout}ms`,
      circuitBreaker: this.config.circuitBreaker,
    });
  }

  /**
   * Get Bedrock client (for testing)
   */
  protected getBedrockClient(): BedrockRuntimeClient {
    return (this as any).bedrock as BedrockRuntimeClient;
  }

  /**
   * Select optimal Bedrock model based on product context for cost optimization
   *
   * Cost-based routing strategy:
   * - Nova Micro: 15% cheaper than Lite, suitable for simple goods (electronics, books, etc.)
   * - Nova Lite: Default choice for most products (balanced cost/performance)
   */
  protected selectBedrockModel(context?: ProductContext): string {
    if (context?.category) {
      const category = context.category.toLowerCase();

      // Simple goods: Use Nova Micro for cost savings
      if (this.config.simpleCategories.some(cat => category.includes(cat))) {
        this.logger.info('Using Nova Micro for simple category', {
          category,
          costSavings: '~15%'
        });
        return this.config.novaMicroModel;
      }

      // Complex goods: Use Nova Lite for detailed analysis
      if (this.config.complexCategories.some(cat => category.includes(cat))) {
        this.logger.info('Using Nova Lite for complex category', {
          category,
          reason: 'Detailed condition assessment needed'
        });
        return this.config.novaLiteModel;
      }
    }

    // Default: Use Nova Lite for balanced cost/performance
    return this.config.defaultModel;
  }

  /**
   * Returns default assessment for error cases
   */
  protected getDefaultAssessment(): VisualQualityAssessment {
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
   * Build structured prompt for Nova Lite
   */
  protected buildPrompt(context?: ProductContext): string {
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
   */
  protected assessmentToMultiplier(assessment: BedrockAssessment): number {
    const baseMultiplier = MULTIPLIERS[assessment.overallAssessment];
    const photoAdjustment = assessment.photoQualityScore < 5 ? 0.95 : 1.0;
    return baseMultiplier * photoAdjustment;
  }

  /**
   * Assess visual quality using Bedrock Nova Lite
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
        base64 = imageInput;
        validateBase64Image(base64);
        mediaType = detectImageFormat(base64);
      } else {
        base64 = imageInput.base64;
        mediaType = imageInput.mediaType;
        validateBase64Image(base64);
      }

      const prompt = this.buildPrompt(context);
      const selectedModel = this.selectBedrockModel(context);

      const response = await this.circuitBreaker.execute(() =>
        this.getBedrockClient().send(
          new InvokeModelCommand({
            modelId: selectedModel,
            contentType: 'application/json',
            accept: 'application/json',
            body: JSON.stringify({
              messages: [{
                role: 'user',
                content: [
                  { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
                  { type: 'text', text: prompt },
                ],
              }],
              inferenceConfig: { maxTokens: 500, temperature: 0.3, topP: 0.9 },
            }),
          })
        )
      );

      if (!response.body) {
        throw new Error('Empty response body from Bedrock');
      }

      const bodyString = await new Response(response.body as any).text();

      if (bodyString.length > this.config.maxResponseSize) {
        this.logger.warn('Response too large, using default assessment', {
          size: bodyString.length,
          maxSize: this.config.maxResponseSize,
        });
        return this.getDefaultAssessment();
      }

      const result = JSON.parse(bodyString);
      const responseText = result.output?.message?.content?.[0]?.text || result.content?.[0]?.text || '';

      if (!responseText) {
        throw new Error('No assessment text in Bedrock response');
      }

      const rawAssessment = JSON.parse(responseText);
      const assessment = BedrockAssessmentSchema.parse(rawAssessment);

      const duration = Date.now() - startTime;
      this.logger.info('Bedrock analysis completed', {
        model: selectedModel,
        duration,
        conditionScore: assessment.conditionScore,
        overallAssessment: assessment.overallAssessment,
        circuitState: this.circuitBreaker.getState(),
      });

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

      this.logger.error('Vision analysis error', {
        error: errorMessage,
        duration,
        circuitState: this.circuitBreaker.getState(),
      });

      // Graceful degradation - return neutral assessment
      return this.getDefaultAssessment();
    }
  }

  /**
   * Batch assess multiple images
   */
  async assessMultipleImages(
    images: string[],
    context?: ProductContext
  ): Promise<VisualQualityAssessment> {
    if (images.length === 0) {
      return this.getDefaultAssessment();
    }

    const assessments = await Promise.all(
      images.map((img) => this.assessVisualQuality(img, context))
    );

    const worstAssessment = assessments.reduce((worst, current) => {
      return current.conditionScore < worst.conditionScore ? current : worst;
    });

    const avgMultiplier = assessments.reduce((sum, a) => sum + a.multiplier, 0) / assessments.length;

    return {
      ...worstAssessment,
      multiplier: avgMultiplier,
      reasoning: `Analyzed ${images.length} images. ${worstAssessment.reasoning}`,
    };
  }

  /**
   * Generate embedding for product image using Titan Embeddings
   */
  async generateEmbedding(imageInput: ImageInput | string): Promise<number[]> {
    const startTime = Date.now();

    try {
      let base64: string;
      let mediaType: ImageMediaType;

      if (typeof imageInput === 'string') {
        base64 = imageInput;
        validateBase64Image(base64);
        mediaType = detectImageFormat(base64);
      } else {
        base64 = imageInput.base64;
        mediaType = imageInput.mediaType;
        validateBase64Image(base64);
      }

      const response = await this.circuitBreaker.execute(() =>
        this.getBedrockClient().send(
          new InvokeModelCommand({
            modelId: this.config.titanEmbedModel,
            contentType: 'application/json',
            accept: 'application/json',
            body: JSON.stringify({ inputImage: base64 }),
          })
        )
      );

      if (!response.body) {
        throw new Error('Empty response body from Bedrock Titan Embeddings');
      }

      const bodyString = await new Response(response.body as any).text();
      const result = JSON.parse(bodyString);
      const embedding: number[] = result.embedding;

      if (!Array.isArray(embedding)) {
        throw new Error('Response does not contain embedding array');
      }

      if (embedding.length !== 1024) {
        throw new Error(`Invalid embedding dimensions: expected 1024, got ${embedding.length}`);
      }

      if (!embedding.every((v) => typeof v === 'number')) {
        throw new Error('Embedding contains non-numeric values');
      }

      const duration = Date.now() - startTime;
      this.logger.info('Embedding generated', {
        duration,
        dimensions: embedding.length,
        magnitude: Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0)),
        circuitState: this.circuitBreaker.getState(),
      });

      return embedding;
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.logger.error('Embedding generation failed', {
        error: errorMessage,
        duration,
      });

      throw error;
    }
  }

  /**
   * Generate embeddings for multiple images in batch
   */
  async generateBatchEmbeddings(
    images: (ImageInput | string)[]
  ): Promise<Array<{ image: ImageInput | string; embedding?: number[]; error?: string }>> {
    const results = await Promise.allSettled(
      images.map((img) => this.generateEmbedding(img))
    );

    return results.map((result, index) => {
      if (result.status === 'fulfilled') {
        return { image: images[index], embedding: result.value };
      } else {
        const error = result.reason;
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { image: images[index], error: errorMessage };
      }
    });
  }

  /**
   * Get circuit breaker state for monitoring
   */
  getCircuitBreakerState(): string {
    return this.circuitBreaker.getState();
  }
}
