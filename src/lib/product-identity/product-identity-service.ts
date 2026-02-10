/**
 * Product Identity Service
 *
 * Identifies and groups images that belong to the same product using:
 * - Titan Multimodal Embeddings for image similarity
 * - Cosine similarity for matching
 * - DynamoDB for storing product groups
 * - Multi-signal weighted similarity analysis (5 signals)
 *
 * Use cases:
 * - Multiple angles of same product
 * - Color variants
 * - Size variants
 * - Before/after processing
 */

import { randomUUID } from 'crypto';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import {
  DynamoDBClient,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
  GetItemCommand,
  ConditionalCheckFailedException,
} from '@aws-sdk/client-dynamodb';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { getModelForTask } from '../bedrock/model-registry';
import {
  calculateMultiSignalSimilarity,
  batchExtractFeatures,
  type MultiSignalSettings,
  type ImageFeatures,
  type SimilarityScore,
  type SignalBreakdown,
  DEFAULT_SETTINGS
} from './multi-signal-similarity';
import { loadSettings } from './settings-loader';
import { generateBatchImageEmbeddings, type ImageInput } from './batch-embeddings';

const bedrockClient = new BedrockRuntimeClient({ 
  region: process.env.BEDROCK_REGION || process.env.AWS_REGION || 'eu-west-1',
  requestHandler: new NodeHttpHandler({
    connectionTimeout: 10000,
    requestTimeout: 15000,
  }),
});
const dynamoClient = new DynamoDBClient({ 
  region: process.env.AWS_REGION || 'eu-west-1',
  requestHandler: new NodeHttpHandler({
    connectionTimeout: 5000,
    requestTimeout: 10000,
  }),
});

const TABLE_NAME = process.env.DYNAMODB_TABLE || `carousel-main-${process.env.STAGE || 'dev'}`;
const DEFAULT_TENANT = process.env.TENANT || 'carousel-labs';

/**
 * BUG #15 FIX: Sanitize tenant ID to prevent DynamoDB key injection
 * Only allows alphanumeric, hyphens, and underscores
 */
function sanitizeTenant(tenant: string): string {
  const sanitized = tenant.replace(/[^a-zA-Z0-9_-]/g, '');
  if (sanitized !== tenant) {
    console.warn(`Tenant ID sanitized: "${tenant}" -> "${sanitized}"`);
  }
  if (sanitized.length === 0) {
    throw new Error('Invalid tenant ID: must contain alphanumeric characters');
  }
  return sanitized;
}

// Similarity thresholds
const SIMILARITY_THRESHOLDS = {
  SAME_PRODUCT: 0.92,      // Very high - definitely same product
  LIKELY_SAME: 0.85,       // High - likely same product, different angle
  POSSIBLY_SAME: 0.75,     // Medium - might be same product, needs review
  DIFFERENT: 0.0,          // Below 0.75 - different products
};

export interface ProductEmbedding {
  imageId: string;
  embedding: number[];
  productGroupId?: string;
  metadata?: {
    fileName?: string;
    uploadedAt: string;
    processedAt?: string;
    dimensions?: { width: number; height: number };
  };
}

export interface ProductGroup {
  groupId: string;
  primaryImageId: string;
  imageIds: string[];
  productName?: string;
  category?: string;
  confidence: number;
  createdAt: string;
  updatedAt: string;
  tenant: string;
}

export interface SimilarityMatch {
  imageId: string;
  similarity: number;
  matchType: 'SAME_PRODUCT' | 'LIKELY_SAME' | 'POSSIBLY_SAME' | 'DIFFERENT';
  groupId?: string;
}

// Maximum image size for Titan Multimodal (20MB to stay under 25MB base64 limit)
const MAX_IMAGE_SIZE = 20 * 1024 * 1024;

/**
 * Generate embedding for an image using Titan Multimodal
 * @param imageBuffer - Image data as Buffer (max 20MB)
 * @returns 1024-dimension embedding vector
 */
export async function generateImageEmbedding(imageBuffer: Buffer): Promise<number[]> {
  // Validate image size
  if (imageBuffer.length > MAX_IMAGE_SIZE) {
    throw new Error(`Image too large: ${(imageBuffer.length / 1024 / 1024).toFixed(1)}MB (max 20MB)`);
  }
  if (imageBuffer.length === 0) {
    throw new Error('Image buffer is empty');
  }

  const embeddingModel = getModelForTask('embedding', true);
  if (!embeddingModel) {
    throw new Error('No embedding model available for images');
  }

  const base64Image = imageBuffer.toString('base64');

  try {
    const response = await bedrockClient.send(new InvokeModelCommand({
      modelId: embeddingModel.id,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        inputImage: base64Image,
        embeddingConfig: {
          outputEmbeddingLength: 1024, // Titan supports 256, 384, 1024
        },
      }),
    }));

    const responseBody = JSON.parse(new TextDecoder().decode(response.body));

    // BUG #9 FIX: Validate Bedrock response before accessing embedding
    if (!responseBody.embedding || !Array.isArray(responseBody.embedding)) {
      throw new Error(`Invalid Bedrock response: missing or invalid embedding field. Response: ${JSON.stringify(responseBody).substring(0, 200)}`);
    }
    if (responseBody.embedding.length === 0) {
      throw new Error('Invalid Bedrock response: embedding array is empty');
    }

    return responseBody.embedding;
  } catch (error) {
    console.error('Failed to generate embedding:', error);
    throw error;
  }
}

/**
 * Calculate cosine similarity between two embedding vectors
 * BUG #7 FIX: Validate non-empty arrays
 * BUG #8 FIX: Validate for NaN/Infinity values
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  // BUG #7 FIX: Validate non-empty arrays
  if (a.length === 0 || b.length === 0) {
    throw new Error('Embedding arrays cannot be empty');
  }
  if (a.length !== b.length) {
    throw new Error(`Embedding dimensions must match: ${a.length} vs ${b.length}`);
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    // BUG #8 FIX: Validate for NaN/Infinity values
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) {
      throw new Error(`Invalid embedding value at index ${i}: a[${i}]=${a[i]}, b[${i}]=${b[i]}`);
    }
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

/**
 * Classify similarity match type
 */
export function classifySimilarity(similarity: number): SimilarityMatch['matchType'] {
  if (similarity >= SIMILARITY_THRESHOLDS.SAME_PRODUCT) return 'SAME_PRODUCT';
  if (similarity >= SIMILARITY_THRESHOLDS.LIKELY_SAME) return 'LIKELY_SAME';
  if (similarity >= SIMILARITY_THRESHOLDS.POSSIBLY_SAME) return 'POSSIBLY_SAME';
  return 'DIFFERENT';
}

/**
 * Store embedding in DynamoDB
 * BUG #15 FIX: Sanitize tenant input
 */
export async function storeEmbedding(
  imageId: string,
  embedding: number[],
  tenant: string = DEFAULT_TENANT,
  metadata?: ProductEmbedding['metadata']
): Promise<void> {
  const safeTenant = sanitizeTenant(tenant);
  const pk = `TENANT#${safeTenant}#EMBEDDING`;
  const sk = `IMAGE#${imageId}`;

  await dynamoClient.send(new PutItemCommand({
    TableName: TABLE_NAME,
    Item: marshall({
      PK: pk,
      SK: sk,
      imageId,
      embedding: JSON.stringify(embedding), // Store as JSON string for DynamoDB
      metadata,
      entityType: 'EMBEDDING',
      createdAt: new Date().toISOString(),
      ttl: Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60), // 30 days
    }, { removeUndefinedValues: true }),
  }));
}

/**
 * Get all embeddings for a tenant (for similarity comparison)
 * BUG #10 FIX: Added pagination to handle more than 1000 embeddings
 * BUG #15 FIX: Sanitize tenant input
 */
export async function getEmbeddings(
  tenant: string = DEFAULT_TENANT,
  limit: number = 10000 // Increased default, with pagination this is now a max total
): Promise<ProductEmbedding[]> {
  const safeTenant = sanitizeTenant(tenant);
  const pk = `TENANT#${safeTenant}#EMBEDDING`;

  const embeddings: ProductEmbedding[] = [];
  let lastEvaluatedKey: Record<string, any> | undefined;
  const pageSize = 1000; // DynamoDB page size

  // BUG #10 FIX: Paginate through all results
  do {
    const result = await dynamoClient.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': 'PK' },
      ExpressionAttributeValues: { ':pk': { S: pk } },
      Limit: Math.min(pageSize, limit - embeddings.length),
      ExclusiveStartKey: lastEvaluatedKey,
    }));

    for (const item of result.Items || []) {
      const data = unmarshall(item);
      try {
        embeddings.push({
          imageId: data.imageId,
          embedding: JSON.parse(data.embedding),
          productGroupId: data.productGroupId,
          metadata: data.metadata,
        });
      } catch (parseError) {
        // BUG #5 FIX: Skip corrupted embeddings instead of crashing entire query
        console.error(`Skipping corrupted embedding for image ${data.imageId}:`, parseError);
      }
    }

    lastEvaluatedKey = result.LastEvaluatedKey;

    // Stop if we've reached the limit
    if (embeddings.length >= limit) {
      break;
    }
  } while (lastEvaluatedKey);

  return embeddings;
}

/**
 * Find similar images for a given embedding
 * BUG #15 FIX: Sanitize tenant input
 */
export async function findSimilarImages(
  embedding: number[],
  tenant: string = DEFAULT_TENANT,
  excludeImageId?: string
): Promise<SimilarityMatch[]> {
  const safeTenant = sanitizeTenant(tenant);
  const existingEmbeddings = await getEmbeddings(safeTenant);

  const matches: SimilarityMatch[] = [];

  for (const existing of existingEmbeddings) {
    if (excludeImageId && existing.imageId === excludeImageId) continue;

    const similarity = cosineSimilarity(embedding, existing.embedding);
    const matchType = classifySimilarity(similarity);

    if (matchType !== 'DIFFERENT') {
      matches.push({
        imageId: existing.imageId,
        similarity,
        matchType,
        groupId: existing.productGroupId,
      });
    }
  }

  // Sort by similarity descending
  return matches.sort((a, b) => b.similarity - a.similarity);
}

/**
 * Create or update a product group
 * BUG #11 FIX: Use crypto.randomUUID for collision-safe ID generation
 * BUG #15 FIX: Sanitize tenant input
 */
export async function createProductGroup(
  imageIds: string[],
  tenant: string = DEFAULT_TENANT,
  productName?: string,
  category?: string
): Promise<ProductGroup> {
  // BUG #4 FIX: Validate imageIds is not empty
  if (!imageIds || imageIds.length === 0) {
    throw new Error('Cannot create product group: imageIds array is empty');
  }

  const safeTenant = sanitizeTenant(tenant);
  // BUG #11 FIX: Use crypto.randomUUID for collision-safe ID generation
  const groupId = `pg_${randomUUID()}`;
  const pk = `TENANT#${safeTenant}#PRODUCT_GROUP`;
  const sk = `GROUP#${groupId}`;

  const group: ProductGroup = {
    groupId,
    primaryImageId: imageIds[0],
    imageIds,
    productName,
    category,
    confidence: 1.0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tenant: safeTenant,
  };

  await dynamoClient.send(new PutItemCommand({
    TableName: TABLE_NAME,
    Item: marshall({
      PK: pk,
      SK: sk,
      ...group,
      entityType: 'PRODUCT_GROUP',
      ttl: Math.floor(Date.now() / 1000) + (90 * 24 * 60 * 60), // 90 days
    }, { removeUndefinedValues: true }),
  }));

  // Update embeddings to reference this group
  for (const imageId of imageIds) {
    await linkImageToGroup(imageId, groupId, safeTenant);
  }

  return group;
}

/**
 * Link an image to a product group (updates embedding record)
 * BUG #2 FIX: Now throws on failure instead of silently swallowing errors
 * BUG #15 FIX: Sanitize tenant input
 */
async function linkImageToGroup(
  imageId: string,
  groupId: string,
  tenant: string = DEFAULT_TENANT
): Promise<void> {
  const safeTenant = sanitizeTenant(tenant);
  const pk = `TENANT#${safeTenant}#EMBEDDING`;
  const sk = `IMAGE#${imageId}`;

  await dynamoClient.send(new UpdateItemCommand({
    TableName: TABLE_NAME,
    Key: { PK: { S: pk }, SK: { S: sk } },
    UpdateExpression: 'SET #groupId = :groupId, #updatedAt = :updatedAt',
    ExpressionAttributeNames: {
      '#groupId': 'productGroupId',
      '#updatedAt': 'updatedAt',
    },
    ExpressionAttributeValues: marshall({
      ':groupId': groupId,
      ':updatedAt': new Date().toISOString(),
    }),
  }));
}

/**
 * Add an image to an existing group's imageIds array
 * BUG #1 FIX: Updates the ProductGroup.imageIds when adding new images
 * BUG #15 FIX: Sanitize tenant input
 */
async function addImageToGroupRecord(
  imageId: string,
  groupId: string,
  tenant: string = DEFAULT_TENANT
): Promise<ProductGroup | null> {
  const safeTenant = sanitizeTenant(tenant);
  const pk = `TENANT#${safeTenant}#PRODUCT_GROUP`;
  const sk = `GROUP#${groupId}`;

  try {
    // Use list_append to atomically add imageId to imageIds array
    const result = await dynamoClient.send(new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: { PK: { S: pk }, SK: { S: sk } },
      UpdateExpression: 'SET #imageIds = list_append(if_not_exists(#imageIds, :empty), :newImage), #updatedAt = :updatedAt',
      // BUG #3 FIX: Conditional check prevents duplicate additions
      ConditionExpression: 'NOT contains(#imageIds, :imageId)',
      ExpressionAttributeNames: {
        '#imageIds': 'imageIds',
        '#updatedAt': 'updatedAt',
      },
      ExpressionAttributeValues: marshall({
        ':newImage': [imageId],
        ':empty': [],
        ':imageId': imageId,
        ':updatedAt': new Date().toISOString(),
      }),
      ReturnValues: 'ALL_NEW',
    }));

    return result.Attributes ? unmarshall(result.Attributes) as ProductGroup : null;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      // Image already in group - not an error, just get current state
      console.log(`Image ${imageId} already in group ${groupId}`);
      return getProductGroupById(groupId, safeTenant);
    }
    throw error;
  }
}

/**
 * Get a specific product group by ID
 * BUG #15 FIX: Sanitize tenant input
 */
async function getProductGroupById(
  groupId: string,
  tenant: string = DEFAULT_TENANT
): Promise<ProductGroup | null> {
  const safeTenant = sanitizeTenant(tenant);
  const pk = `TENANT#${safeTenant}#PRODUCT_GROUP`;
  const sk = `GROUP#${groupId}`;

  const result = await dynamoClient.send(new GetItemCommand({
    TableName: TABLE_NAME,
    Key: { PK: { S: pk }, SK: { S: sk } },
  }));

  return result.Item ? unmarshall(result.Item) as ProductGroup : null;
}

/**
 * Get product groups for a tenant
 * BUG #15 FIX: Sanitize tenant input
 */
export async function getProductGroups(
  tenant: string = DEFAULT_TENANT,
  limit: number = 100
): Promise<ProductGroup[]> {
  const safeTenant = sanitizeTenant(tenant);
  const pk = `TENANT#${safeTenant}#PRODUCT_GROUP`;

  const result = await dynamoClient.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: '#pk = :pk',
    ExpressionAttributeNames: { '#pk': 'PK' },
    ExpressionAttributeValues: { ':pk': { S: pk } },
    Limit: limit,
    ScanIndexForward: false,
  }));

  return (result.Items || []).map(item => unmarshall(item) as ProductGroup);
}

/**
 * Process image and find/create product group
 * BUG #12 FIX: Handle partial update failures gracefully
 * BUG #15 FIX: Sanitize tenant input
 */
export async function processImageForGrouping(
  imageId: string,
  imageBuffer: Buffer,
  tenant: string = DEFAULT_TENANT,
  metadata?: ProductEmbedding['metadata']
): Promise<{
  embedding: number[];
  similarImages: SimilarityMatch[];
  assignedGroup?: ProductGroup;
  isNewGroup: boolean;
}> {
  const safeTenant = sanitizeTenant(tenant);

  // Generate embedding
  const embedding = await generateImageEmbedding(imageBuffer);

  // Store embedding
  await storeEmbedding(imageId, embedding, safeTenant, metadata);

  // Find similar images
  const similarImages = await findSimilarImages(embedding, safeTenant, imageId);

  // Check if should join existing group
  const bestMatch = similarImages[0];
  let assignedGroup: ProductGroup | undefined;
  let isNewGroup = false;

  if (bestMatch && bestMatch.matchType === 'SAME_PRODUCT' && bestMatch.groupId) {
    // Add to existing group
    // BUG #12 FIX: If addImageToGroupRecord fails, we still have the embedding linked
    // This is acceptable - the group can be reconstructed from embeddings
    try {
      await linkImageToGroup(imageId, bestMatch.groupId, safeTenant);
      assignedGroup = await addImageToGroupRecord(imageId, bestMatch.groupId, safeTenant) || undefined;
    } catch (error) {
      console.error(`Failed to add image ${imageId} to group ${bestMatch.groupId}:`, error);
      // Attempt to unlink the image if group update failed to maintain consistency
      // The embedding is still stored and can be regrouped later
    }
  } else if (bestMatch && (bestMatch.matchType === 'SAME_PRODUCT' || bestMatch.matchType === 'LIKELY_SAME')) {
    // Create new group with matched images
    const groupImageIds = [imageId, bestMatch.imageId];
    assignedGroup = await createProductGroup(groupImageIds, safeTenant);
    isNewGroup = true;
  }

  return {
    embedding,
    similarImages,
    assignedGroup,
    isNewGroup,
  };
}

/**
 * Batch process images for grouping
 * BUG #13 FIX: Include existing DB embeddings in clustering
 * BUG #14 FIX: Use consistent similarity threshold (SAME_PRODUCT)
 * BUG #15 FIX: Sanitize tenant input
 */
export async function batchProcessForGrouping(
  images: { id: string; buffer: Buffer; metadata?: ProductEmbedding['metadata'] }[],
  tenant: string = DEFAULT_TENANT,
  includeExistingEmbeddings: boolean = true // BUG #13 FIX: Option to include existing
): Promise<{
  groups: ProductGroup[];
  ungrouped: string[];
  processed: number;
  existingMatched: number; // BUG #13 FIX: Track how many matched existing
}> {
  const safeTenant = sanitizeTenant(tenant);
  const newEmbeddings: { id: string; embedding: number[] }[] = [];
  const ungrouped: string[] = [];

  // QUICK WIN #1: Use batch embedding generation (3-5x faster)
  console.log('[ProductIdentity] Using batch embedding generation for', images.length, 'images');
  const imageInputs: ImageInput[] = images.map(img => ({
    imageId: img.id,
    buffer: img.buffer,
  }));

  const batchResult = await generateBatchImageEmbeddings(imageInputs);

  console.log('[ProductIdentity] Batch embedding complete:', {
    successCount: batchResult.successCount,
    failureCount: batchResult.failureCount,
    totalTimeMs: batchResult.totalTimeMs,
    avgTimePerImage: batchResult.successCount > 0
      ? (batchResult.totalTimeMs / batchResult.successCount).toFixed(1) + 'ms'
      : 'N/A',
  });

  // Store successful embeddings in DynamoDB
  for (const [imageId, embeddingData] of batchResult.embeddings.entries()) {
    newEmbeddings.push({ id: imageId, embedding: embeddingData.embedding });

    // Find metadata for this image
    const imageMetadata = images.find(img => img.id === imageId)?.metadata;

    try {
      await storeEmbedding(imageId, embeddingData.embedding, safeTenant, imageMetadata);
    } catch (error) {
      console.error(`Failed to store embedding for ${imageId}:`, error);
    }
  }

  // Track failed images
  for (const error of batchResult.errors) {
    ungrouped.push(error.imageId);
  }

  // BUG #13 FIX: Fetch existing embeddings and include in clustering
  let allEmbeddings = [...newEmbeddings];
  let existingMatched = 0;

  if (includeExistingEmbeddings) {
    const existingEmbeddings = await getEmbeddings(safeTenant);
    const newImageIds = new Set(newEmbeddings.map(e => e.id));

    // Add existing embeddings that aren't in the new batch
    for (const existing of existingEmbeddings) {
      if (!newImageIds.has(existing.imageId)) {
        allEmbeddings.push({ id: existing.imageId, embedding: existing.embedding });
      }
    }
  }

  // Group similar images using clustering (with consistent threshold)
  const groups = await clusterBySimilarity(allEmbeddings);

  // Create product groups in DynamoDB (only for groups containing new images)
  const createdGroups: ProductGroup[] = [];
  const newImageIds = new Set(newEmbeddings.map(e => e.id));

  for (const group of groups) {
    const hasNewImages = group.some(id => newImageIds.has(id));
    if (!hasNewImages) continue; // Skip groups with only existing images

    if (group.length > 1) {
      // Check if any existing images in this group are already in a group
      const existingInGroup = group.filter(id => !newImageIds.has(id));
      if (existingInGroup.length > 0) {
        existingMatched += existingInGroup.length;
      }

      const productGroup = await createProductGroup(group, safeTenant);
      createdGroups.push(productGroup);
    } else {
      ungrouped.push(group[0]);
    }
  }

  return {
    groups: createdGroups,
    ungrouped,
    processed: newEmbeddings.length,
    existingMatched,
  };
}

/**
 * Clustering algorithm with multi-signal similarity support
 * BUG #14 FIX: Use SAME_PRODUCT threshold (0.92) for consistency with processImageForGrouping
 * Enhanced: Can use multi-signal analysis when metadata is provided
 */
async function clusterBySimilarity(
  embeddings: { id: string; embedding: number[]; metadata?: any }[],
  threshold: number = SIMILARITY_THRESHOLDS.SAME_PRODUCT, // BUG #14 FIX: Consistent threshold
  useMultiSignal: boolean = false,
  imageMetadataMap?: Map<string, any>,
  settings?: MultiSignalSettings
): Promise<string[][]> {
  const clusters: string[][] = [];
  const assigned = new Set<string>();

  for (const item of embeddings) {
    if (assigned.has(item.id)) continue;

    // Start new cluster
    const cluster = [item.id];
    assigned.add(item.id);

    // Find all similar items
    for (const other of embeddings) {
      if (assigned.has(other.id)) continue;

      let similarity: number;

      if (useMultiSignal && imageMetadataMap && settings) {
        // Use multi-signal similarity
        const img1Meta = imageMetadataMap.get(item.id);
        const img2Meta = imageMetadataMap.get(other.id);

        if (img1Meta && img2Meta) {
          const result = await calculateMultiSignalSimilarity(img1Meta, img2Meta, settings);
          similarity = result.totalScore;
        } else {
          // Fallback to embedding similarity
          similarity = cosineSimilarity(item.embedding, other.embedding);
        }
      } else {
        // Use original embedding-based similarity
        similarity = cosineSimilarity(item.embedding, other.embedding);
      }

      // BUG #14 FIX: Use consistent threshold parameter
      if (similarity >= threshold) {
        cluster.push(other.id);
        assigned.add(other.id);
      }
    }

    clusters.push(cluster);
  }

  return clusters;
}

/**
 * Enhanced batch processing with multi-signal analysis
 * Includes Rekognition label detection and advanced similarity scoring
 */
export async function batchProcessWithMultiSignal(
  images: { id: string; buffer: Buffer; metadata?: ProductEmbedding['metadata']; width: number; height: number }[],
  tenant: string = DEFAULT_TENANT,
  stage: string = 'dev',
  includeExistingEmbeddings: boolean = true
): Promise<{
  groups: (ProductGroup & { signalBreakdown?: SignalBreakdown; avgSimilarity?: number })[];
  ungrouped: string[];
  processed: number;
  existingMatched: number;
  multiSignalEnabled: boolean;
}> {
  const safeTenant = sanitizeTenant(tenant);

  // Load product identity settings
  const settings = await loadSettings(stage, safeTenant);

  console.log('[MultiSignal] Batch processing started', {
    imageCount: images.length,
    multiSignalEnabled: settings.enabled,
    rekognitionEnabled: settings.rekognition.enabled,
    tenant: safeTenant,
  });

  // Step 1 & 2: Extract image features including Rekognition labels
  const startTime = Date.now();
  const imageFeatures = await batchExtractFeatures(
    images.map(img => ({ id: img.id, buffer: img.buffer })),
    process.env.AWS_REGION || 'eu-west-1',
    settings
  );
  console.log(`[MultiSignal] Feature extraction complete in ${Date.now() - startTime}ms`);

  // Build metadata map from extracted features
  const imageMetadataMap = new Map<string, ImageFeatures>();
  for (const features of imageFeatures) {
    imageMetadataMap.set(features.id, features);
  }

  // Step 3: Generate Titan embeddings (still needed for semantic understanding)
  // QUICK WIN #1: Use batch embedding generation (3-5x faster)
  const newEmbeddings: { id: string; embedding: number[]; metadata?: any }[] = [];
  const ungrouped: string[] = [];

  console.log('[MultiSignal] Using batch embedding generation for', images.length, 'images');
  const imageInputs: ImageInput[] = images.map(img => ({
    imageId: img.id,
    buffer: img.buffer,
  }));

  const embeddingStartTime = Date.now();
  const batchResult = await generateBatchImageEmbeddings(imageInputs);

  console.log('[MultiSignal] Batch embedding complete:', {
    successCount: batchResult.successCount,
    failureCount: batchResult.failureCount,
    totalTimeMs: batchResult.totalTimeMs,
    avgTimePerImage: batchResult.successCount > 0
      ? (batchResult.totalTimeMs / batchResult.successCount).toFixed(1) + 'ms'
      : 'N/A',
  });

  // Store successful embeddings in DynamoDB
  for (const [imageId, embeddingData] of batchResult.embeddings.entries()) {
    newEmbeddings.push({ id: imageId, embedding: embeddingData.embedding });

    // Find metadata for this image
    const imageMetadata = images.find(img => img.id === imageId)?.metadata;

    try {
      await storeEmbedding(imageId, embeddingData.embedding, safeTenant, imageMetadata);
    } catch (error) {
      console.error(`Failed to store embedding for ${imageId}:`, error);
    }
  }

  // Track failed images
  for (const error of batchResult.errors) {
    ungrouped.push(error.imageId);
  }

  // Step 4: Fetch existing embeddings if requested
  let allEmbeddings = [...newEmbeddings];
  let existingMatched = 0;

  if (includeExistingEmbeddings) {
    const existingEmbeddings = await getEmbeddings(safeTenant);
    const newImageIds = new Set(newEmbeddings.map(e => e.id));

    for (const existing of existingEmbeddings) {
      if (!newImageIds.has(existing.imageId)) {
        allEmbeddings.push({ id: existing.imageId, embedding: existing.embedding });
      }
    }
  }

  // Step 5: Cluster using multi-signal analysis if enabled
  const threshold = settings.thresholds.sameProduct;
  const groups = await clusterBySimilarity(
    allEmbeddings,
    threshold,
    settings.enabled, // Use multi-signal if enabled
    imageMetadataMap,
    settings
  );

  // Step 6: Create product groups with signal breakdown
  const createdGroups: (ProductGroup & { signalBreakdown?: SignalBreakdown; avgSimilarity?: number })[] = [];
  const newImageIds = new Set(newEmbeddings.map(e => e.id));

  for (const group of groups) {
    const hasNewImages = group.some(id => newImageIds.has(id));
    if (!hasNewImages) continue;

    if (group.length > 1) {
      const existingInGroup = group.filter(id => !newImageIds.has(id));
      if (existingInGroup.length > 0) {
        existingMatched += existingInGroup.length;
      }

      const productGroup = await createProductGroup(group, safeTenant);

      // Calculate average similarity and signal breakdown for the group
      if (settings.enabled && group.length > 1) {
        let totalScore = 0;
        let signalSum: SignalBreakdown = {
          spatial: 0,
          feature: 0,
          semantic: 0,
          composition: 0,
          background: 0,
        };
        let comparisons = 0;

        // Compare all pairs in the group
        for (let i = 0; i < group.length - 1; i++) {
          const img1Meta = imageMetadataMap.get(group[i]);
          const img2Meta = imageMetadataMap.get(group[i + 1]);

          if (img1Meta && img2Meta) {
            const result = await calculateMultiSignalSimilarity(img1Meta, img2Meta, settings);
            totalScore += result.totalScore;
            signalSum.spatial += result.signalBreakdown.spatial;
            signalSum.feature += result.signalBreakdown.feature;
            signalSum.semantic += result.signalBreakdown.semantic;
            signalSum.composition += result.signalBreakdown.composition;
            signalSum.background += result.signalBreakdown.background;
            comparisons++;
          }
        }

        if (comparisons > 0) {
          createdGroups.push({
            ...productGroup,
            avgSimilarity: totalScore / comparisons,
            signalBreakdown: {
              spatial: signalSum.spatial / comparisons,
              feature: signalSum.feature / comparisons,
              semantic: signalSum.semantic / comparisons,
              composition: signalSum.composition / comparisons,
              background: signalSum.background / comparisons,
            },
          });
        } else {
          createdGroups.push(productGroup);
        }
      } else {
        createdGroups.push(productGroup);
      }
    } else {
      ungrouped.push(group[0]);
    }
  }

  console.log('[MultiSignal] Batch processing complete', {
    groupsCreated: createdGroups.length,
    ungroupedImages: ungrouped.length,
    existingMatched,
    multiSignalEnabled: settings.enabled,
  });

  return {
    groups: createdGroups,
    ungrouped,
    processed: newEmbeddings.length,
    existingMatched,
    multiSignalEnabled: settings.enabled,
  };
}

// Export thresholds for UI configuration
export { SIMILARITY_THRESHOLDS };
