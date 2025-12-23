/**
 * Product Identity Module
 *
 * Exports for product grouping and similarity detection
 */

export {
  // Core functions
  generateImageEmbedding,
  findSimilarImages,
  processImageForGrouping,
  batchProcessForGrouping,
  createProductGroup,
  getProductGroups,

  // Utility functions
  cosineSimilarity,
  classifySimilarity,
  storeEmbedding,
  getEmbeddings,

  // Types
  type ProductEmbedding,
  type ProductGroup,
  type SimilarityMatch,

  // Constants
  SIMILARITY_THRESHOLDS,
} from './product-identity-service';
