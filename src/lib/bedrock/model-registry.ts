/**
 * Bedrock Model Registry
 *
 * Provides dynamic model selection based on task type and capabilities.
 * Uses AWS Foundational Models: Amazon Nova, Titan, and Meta Llama
 */

export type ModelTask =
  | 'image_analysis'      // Analyze image content
  | 'text_generation'     // Generate descriptions
  | 'translation'         // Translate text
  | 'embedding'           // Generate embeddings for similarity
  | 'image_generation';   // Generate/modify images

export type ModelFamily = 'mistral' | 'amazon' | 'stability' | 'meta' | 'cohere' | 'openai';

export interface ModelConfig {
  id: string;
  name: string;
  family: ModelFamily;
  tasks: ModelTask[];
  supportsImages: boolean;
  maxTokens: number;
  costPer1kTokens: number; // USD
  priority: number; // Lower = preferred
}

// Available Bedrock Foundational Models
const NOVA_PRO_MODEL_ID = process.env.BEDROCK_NOVA_PRO_PROFILE_ARN || 'amazon.nova-pro-v1:0';
const NOVA_PRO_ENABLED = Boolean(process.env.BEDROCK_NOVA_PRO_PROFILE_ARN);

export const BEDROCK_MODELS: Record<string, ModelConfig> = {
  // ============================================================================
  // Amazon Nova Models (Primary - Cost-Effective AWS Native)
  // ============================================================================

  // Nova Pro - Best quality for complex tasks
  'amazon.nova-pro-v1:0': {
    id: NOVA_PRO_MODEL_ID,
    name: 'Amazon Nova Pro',
    family: 'amazon',
    tasks: ['image_analysis', 'text_generation', 'translation'],
    supportsImages: true,
    maxTokens: 5120,
    costPer1kTokens: 0.0008,
    priority: 2, // Use for complex tasks
  },

  // Nova Lite - Fast, cost-effective for routine tasks
  'amazon.nova-lite-v1:0': {
    id: 'amazon.nova-lite-v1:0',
    name: 'Amazon Nova Lite',
    family: 'amazon',
    tasks: ['image_analysis', 'text_generation', 'translation'],
    supportsImages: true,
    maxTokens: 5120,
    costPer1kTokens: 0.00006,
    priority: 1, // Primary model - 90% of tasks
  },

  // Nova Micro - Ultra-fast for simple tasks
  'amazon.nova-micro-v1:0': {
    id: 'amazon.nova-micro-v1:0',
    name: 'Amazon Nova Micro',
    family: 'amazon',
    tasks: ['text_generation'],
    supportsImages: false,
    maxTokens: 5120,
    costPer1kTokens: 0.000035,
    priority: 1, // Cheapest for text-only
  },

  // Nova Canvas - Image generation / background removal
  'amazon.nova-canvas-v1:0': {
    id: 'amazon.nova-canvas-v1:0',
    name: 'Amazon Nova Canvas',
    family: 'amazon',
    tasks: ['image_generation'],
    supportsImages: true,
    maxTokens: 2048,
    costPer1kTokens: 0.0008,
    priority: 1,
  },

  // ============================================================================
  // Amazon Titan Models (Embeddings & Text)
  // ============================================================================

  // Titan Multimodal Embeddings - Best for image embeddings
  'amazon.titan-embed-image-v1': {
    id: 'amazon.titan-embed-image-v1',
    name: 'Titan Multimodal Embeddings',
    family: 'amazon',
    tasks: ['embedding'],
    supportsImages: true,
    maxTokens: 1024, // Embedding dimension
    costPer1kTokens: 0.0008,
    priority: 1, // Primary for image embeddings
  },

  // Titan Text Embeddings v2
  'amazon.titan-embed-text-v2:0': {
    id: 'amazon.titan-embed-text-v2:0',
    name: 'Titan Text Embeddings v2',
    family: 'amazon',
    tasks: ['embedding'],
    supportsImages: false,
    maxTokens: 1024,
    costPer1kTokens: 0.0001,
    priority: 2, // Fallback for text embeddings
  },

  // Titan Text Express
  'amazon.titan-text-express-v1': {
    id: 'amazon.titan-text-express-v1',
    name: 'Titan Text Express',
    family: 'amazon',
    tasks: ['text_generation'],
    supportsImages: false,
    maxTokens: 8192,
    costPer1kTokens: 0.0008,
    priority: 4, // Fallback
  },

  // Titan Text Lite
  'amazon.titan-text-lite-v1': {
    id: 'amazon.titan-text-lite-v1',
    name: 'Titan Text Lite',
    family: 'amazon',
    tasks: ['text_generation'],
    supportsImages: false,
    maxTokens: 4096,
    costPer1kTokens: 0.0003,
    priority: 3, // Fallback
  },

  // ============================================================================
  // Meta Llama Models (High Quality Alternative)
  // ============================================================================

  // Llama 3 70B - High quality for complex reasoning
  'meta.llama3-70b-instruct-v1:0': {
    id: 'meta.llama3-70b-instruct-v1:0',
    name: 'Meta Llama 3 70B',
    family: 'meta',
    tasks: ['text_generation', 'translation'],
    supportsImages: false,
    maxTokens: 8192,
    costPer1kTokens: 0.00265,
    priority: 3, // High quality fallback
  },

  // Llama 3 8B - Fast alternative
  'meta.llama3-8b-instruct-v1:0': {
    id: 'meta.llama3-8b-instruct-v1:0',
    name: 'Meta Llama 3 8B',
    family: 'meta',
    tasks: ['text_generation', 'translation'],
    supportsImages: false,
    maxTokens: 8192,
    costPer1kTokens: 0.0003,
    priority: 2, // Cost-effective alternative
  },

  // ============================================================================
  // Mistral Models (High Quality Text Generation)
  // ============================================================================

  // Pixtral Large - Vision analysis + descriptions
  'us.mistral.pixtral-large-2502-v1:0': {
    id: 'us.mistral.pixtral-large-2502-v1:0',
    name: 'Mistral Pixtral Large',
    family: 'mistral',
    tasks: ['image_analysis', 'text_generation'],
    supportsImages: true,
    maxTokens: 8192,
    costPer1kTokens: 0.004,
    priority: 1,
  },

  'mistral.mistral-large-2402-v1:0': {
    id: 'mistral.mistral-large-2402-v1:0',
    name: 'Mistral Large',
    family: 'mistral',
    tasks: ['text_generation', 'translation'],
    supportsImages: false,
    maxTokens: 8192,
    costPer1kTokens: 0.004,
    priority: 4, // Use for translation quality
  },

  'mistral.mixtral-8x7b-instruct-v0:1': {
    id: 'mistral.mixtral-8x7b-instruct-v0:1',
    name: 'Mixtral 8x7B',
    family: 'mistral',
    tasks: ['text_generation', 'translation'],
    supportsImages: false,
    maxTokens: 4096,
    costPer1kTokens: 0.00045,
    priority: 2, // Good cost/quality balance
  },

  // ============================================================================
  // Cohere Models (Embeddings)
  // ============================================================================

  'cohere.embed-multilingual-v3': {
    id: 'cohere.embed-multilingual-v3',
    name: 'Cohere Embed Multilingual',
    family: 'cohere',
    tasks: ['embedding'],
    supportsImages: false,
    maxTokens: 512,
    costPer1kTokens: 0.0001,
    priority: 3, // Fallback for multilingual embeddings
  },

  // =========================================================================
  // OpenAI GPT-OSS (Translation)
  // =========================================================================

  'openai.gpt-oss-120b-1:0': {
    id: 'openai.gpt-oss-120b-1:0',
    name: 'OpenAI GPT-OSS 120B',
    family: 'openai',
    tasks: ['translation'],
    supportsImages: false,
    maxTokens: 8192,
    costPer1kTokens: 0.004,
    priority: 1,
  },

  // ============================================================================
  // NOTE: Anthropic Claude models not available - using Nova Pro for expert tier
  // ============================================================================
};

/**
 * Get the best model for a specific task
 * BUG #6 FIX: Added secondary sort by model ID for deterministic results
 */
export function getModelForTask(task: ModelTask, requiresImages: boolean = false): ModelConfig | null {
  const candidates = Object.values(BEDROCK_MODELS)
    .filter(m => m.tasks.includes(task))
    .filter(m => !requiresImages || m.supportsImages)
    .sort((a, b) => {
      // Primary sort by priority (lower = better)
      if (a.priority !== b.priority) return a.priority - b.priority;
      // Secondary sort by model ID for deterministic tie-breaking
      return a.id.localeCompare(b.id);
    });

  return candidates[0] || null;
}

/**
 * Get all models that support a specific task
 * BUG #6 FIX: Added secondary sort by model ID for deterministic results
 */
export function getModelsForTask(task: ModelTask): ModelConfig[] {
  return Object.values(BEDROCK_MODELS)
    .filter(m => m.tasks.includes(task))
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.id.localeCompare(b.id);
    });
}

/**
 * Get model by ID
 */
export function getModelById(modelId: string): ModelConfig | null {
  return BEDROCK_MODELS[modelId] || null;
}

/**
 * Default model selections by task
 * Uses Amazon Nova as primary for cost optimization
 */
export const DEFAULT_MODELS = {
  image_analysis: 'us.mistral.pixtral-large-2502-v1:0', // Pixtral - vision analysis (cross-region)
  text_generation: 'us.mistral.pixtral-large-2502-v1:0', // Pixtral - descriptions (cross-region)
  translation: 'amazon.nova-lite-v1:0',         // Nova Lite - translation
  embedding: 'amazon.titan-embed-image-v1',     // Titan - best for image embeddings
  image_generation: 'amazon.nova-canvas-v1:0',  // Nova Canvas - image generation
};

/**
 * Tiered model selection for different complexity levels
 * Based on ai-enrichment-service patterns
 */
export const TIERED_MODELS = {
  // 90% of tasks - routine operations
  default: 'us.mistral.pixtral-large-2502-v1:0',
  // 8% of tasks - multi-step reasoning
  complex: 'us.mistral.pixtral-large-2502-v1:0',
  // 2% of tasks - critical decisions
  expert: 'us.mistral.pixtral-large-2502-v1:0',
  // Embeddings (image + text)
  embedding_image: 'amazon.titan-embed-image-v1',
  embedding_text: 'amazon.titan-embed-text-v2:0',
};

/**
 * Processing pipeline configuration
 */
export interface ProcessingPipeline {
  name: string;
  steps: {
    task: ModelTask;
    modelId?: string; // Override default
    required: boolean;
  }[];
}

export const PIPELINES: Record<string, ProcessingPipeline> = {
  // Full product analysis with grouping
  full_analysis: {
    name: 'Full Product Analysis',
    steps: [
      { task: 'embedding', required: true },           // Generate embedding for grouping
      { task: 'image_analysis', required: true },      // Analyze product
      { task: 'text_generation', required: false },    // Generate description
      { task: 'translation', required: false },        // Translate if needed
    ],
  },

  // Quick processing without grouping
  quick_process: {
    name: 'Quick Processing',
    steps: [
      { task: 'image_analysis', required: true },
    ],
  },

  // Grouping only - for batch imports
  grouping_only: {
    name: 'Grouping Only',
    steps: [
      { task: 'embedding', required: true },
    ],
  },

  // Full with translations
  multilingual: {
    name: 'Multilingual Analysis',
    steps: [
      { task: 'embedding', required: true },
      { task: 'image_analysis', required: true },
      { task: 'text_generation', required: true },
      { task: 'translation', required: true },
    ],
  },
};
