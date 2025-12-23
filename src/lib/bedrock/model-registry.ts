/**
 * Bedrock Model Registry
 *
 * Provides dynamic model selection based on task type and capabilities.
 * Supports multiple model families: Claude, Mistral, Titan, Stable Diffusion
 */

export type ModelTask =
  | 'image_analysis'      // Analyze image content
  | 'text_generation'     // Generate descriptions
  | 'translation'         // Translate text
  | 'embedding'           // Generate embeddings for similarity
  | 'image_generation';   // Generate/modify images

export type ModelFamily = 'anthropic' | 'mistral' | 'amazon' | 'stability' | 'meta' | 'cohere';

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

// Available Bedrock models with capabilities
export const BEDROCK_MODELS: Record<string, ModelConfig> = {
  // Anthropic Claude - Best for complex reasoning and image analysis
  'anthropic.claude-3-5-sonnet-20241022-v2:0': {
    id: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    name: 'Claude 3.5 Sonnet v2',
    family: 'anthropic',
    tasks: ['image_analysis', 'text_generation', 'translation'],
    supportsImages: true,
    maxTokens: 8192,
    costPer1kTokens: 0.003,
    priority: 1,
  },
  'anthropic.claude-3-haiku-20240307-v1:0': {
    id: 'anthropic.claude-3-haiku-20240307-v1:0',
    name: 'Claude 3 Haiku',
    family: 'anthropic',
    tasks: ['image_analysis', 'text_generation', 'translation'],
    supportsImages: true,
    maxTokens: 4096,
    costPer1kTokens: 0.00025,
    priority: 2,
  },

  // Mistral - Good for text generation, cost-effective
  'mistral.mistral-large-2402-v1:0': {
    id: 'mistral.mistral-large-2402-v1:0',
    name: 'Mistral Large',
    family: 'mistral',
    tasks: ['text_generation', 'translation'],
    supportsImages: false,
    maxTokens: 8192,
    costPer1kTokens: 0.004,
    priority: 3,
  },
  'mistral.mistral-small-2402-v1:0': {
    id: 'mistral.mistral-small-2402-v1:0',
    name: 'Mistral Small',
    family: 'mistral',
    tasks: ['text_generation', 'translation'],
    supportsImages: false,
    maxTokens: 8192,
    costPer1kTokens: 0.001,
    priority: 4,
  },

  // Amazon Titan - Native AWS, good for embeddings
  'amazon.titan-embed-image-v1': {
    id: 'amazon.titan-embed-image-v1',
    name: 'Titan Multimodal Embeddings',
    family: 'amazon',
    tasks: ['embedding'],
    supportsImages: true,
    maxTokens: 128, // Embedding dimension
    costPer1kTokens: 0.0008,
    priority: 1,
  },
  'amazon.titan-text-express-v1': {
    id: 'amazon.titan-text-express-v1',
    name: 'Titan Text Express',
    family: 'amazon',
    tasks: ['text_generation'],
    supportsImages: false,
    maxTokens: 8192,
    costPer1kTokens: 0.0008,
    priority: 5,
  },

  // Meta Llama - Open source, good for general text
  'meta.llama3-2-90b-instruct-v1:0': {
    id: 'meta.llama3-2-90b-instruct-v1:0',
    name: 'Llama 3.2 90B',
    family: 'meta',
    tasks: ['text_generation', 'translation'],
    supportsImages: false,
    maxTokens: 8192,
    costPer1kTokens: 0.002,
    priority: 4,
  },

  // Cohere - Good for embeddings and text
  'cohere.embed-multilingual-v3': {
    id: 'cohere.embed-multilingual-v3',
    name: 'Cohere Embed Multilingual',
    family: 'cohere',
    tasks: ['embedding'],
    supportsImages: false,
    maxTokens: 512,
    costPer1kTokens: 0.0001,
    priority: 2,
  },
};

/**
 * Get the best model for a specific task
 */
export function getModelForTask(task: ModelTask, requiresImages: boolean = false): ModelConfig | null {
  const candidates = Object.values(BEDROCK_MODELS)
    .filter(m => m.tasks.includes(task))
    .filter(m => !requiresImages || m.supportsImages)
    .sort((a, b) => a.priority - b.priority);

  return candidates[0] || null;
}

/**
 * Get all models that support a specific task
 */
export function getModelsForTask(task: ModelTask): ModelConfig[] {
  return Object.values(BEDROCK_MODELS)
    .filter(m => m.tasks.includes(task))
    .sort((a, b) => a.priority - b.priority);
}

/**
 * Get model by ID
 */
export function getModelById(modelId: string): ModelConfig | null {
  return BEDROCK_MODELS[modelId] || null;
}

/**
 * Default model selections by task
 */
export const DEFAULT_MODELS = {
  image_analysis: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  text_generation: 'mistral.mistral-large-2402-v1:0',
  translation: 'anthropic.claude-3-haiku-20240307-v1:0',
  embedding: 'amazon.titan-embed-image-v1',
  image_generation: null, // Not currently supported
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
