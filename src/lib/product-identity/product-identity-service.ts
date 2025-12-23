/**
 * Product Identity Service
 *
 * Identifies and groups images that belong to the same product using:
 * - Titan Multimodal Embeddings for image similarity
 * - Cosine similarity for matching
 * - DynamoDB for storing product groups
 *
 * Use cases:
 * - Multiple angles of same product
 * - Color variants
 * - Size variants
 * - Before/after processing
 */

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import {
  DynamoDBClient,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { getModelForTask } from '../bedrock/model-registry';

const bedrockClient = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'eu-west-1' });
const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION || 'eu-west-1' });

const TABLE_NAME = process.env.BG_REMOVER_TABLE_NAME || 'bg-remover-dev';
const DEFAULT_TENANT = process.env.TENANT || 'carousel-labs';

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

/**
 * Generate embedding for an image using Titan Multimodal
 */
export async function generateImageEmbedding(imageBuffer: Buffer): Promise<number[]> {
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
    return responseBody.embedding;
  } catch (error) {
    console.error('Failed to generate embedding:', error);
    throw error;
  }
}

/**
 * Calculate cosine similarity between two embedding vectors
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Embedding dimensions must match');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
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
 */
export async function storeEmbedding(
  imageId: string,
  embedding: number[],
  tenant: string = DEFAULT_TENANT,
  metadata?: ProductEmbedding['metadata']
): Promise<void> {
  const pk = `TENANT#${tenant}#EMBEDDING`;
  const sk = `IMAGE#${imageId}`;

  await dynamoClient.send(new PutItemCommand({
    TableName: TABLE_NAME,
    Item: marshall({
      pk,
      sk,
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
 */
export async function getEmbeddings(
  tenant: string = DEFAULT_TENANT,
  limit: number = 1000
): Promise<ProductEmbedding[]> {
  const pk = `TENANT#${tenant}#EMBEDDING`;

  const result = await dynamoClient.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: '#pk = :pk',
    ExpressionAttributeNames: { '#pk': 'pk' },
    ExpressionAttributeValues: { ':pk': { S: pk } },
    Limit: limit,
  }));

  return (result.Items || []).map(item => {
    const data = unmarshall(item);
    return {
      imageId: data.imageId,
      embedding: JSON.parse(data.embedding),
      productGroupId: data.productGroupId,
      metadata: data.metadata,
    };
  });
}

/**
 * Find similar images for a given embedding
 */
export async function findSimilarImages(
  embedding: number[],
  tenant: string = DEFAULT_TENANT,
  excludeImageId?: string
): Promise<SimilarityMatch[]> {
  const existingEmbeddings = await getEmbeddings(tenant);

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
 */
export async function createProductGroup(
  imageIds: string[],
  tenant: string = DEFAULT_TENANT,
  productName?: string,
  category?: string
): Promise<ProductGroup> {
  const groupId = `pg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const pk = `TENANT#${tenant}#PRODUCT_GROUP`;
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
    tenant,
  };

  await dynamoClient.send(new PutItemCommand({
    TableName: TABLE_NAME,
    Item: marshall({
      pk,
      sk,
      ...group,
      entityType: 'PRODUCT_GROUP',
      ttl: Math.floor(Date.now() / 1000) + (90 * 24 * 60 * 60), // 90 days
    }, { removeUndefinedValues: true }),
  }));

  // Update embeddings to reference this group
  for (const imageId of imageIds) {
    await linkImageToGroup(imageId, groupId, tenant);
  }

  return group;
}

/**
 * Link an image to a product group
 */
async function linkImageToGroup(
  imageId: string,
  groupId: string,
  tenant: string = DEFAULT_TENANT
): Promise<void> {
  const pk = `TENANT#${tenant}#EMBEDDING`;
  const sk = `IMAGE#${imageId}`;

  try {
    await dynamoClient.send(new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: { pk: { S: pk }, sk: { S: sk } },
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
  } catch (error) {
    console.error(`Failed to link image ${imageId} to group ${groupId}:`, error);
  }
}

/**
 * Get product groups for a tenant
 */
export async function getProductGroups(
  tenant: string = DEFAULT_TENANT,
  limit: number = 100
): Promise<ProductGroup[]> {
  const pk = `TENANT#${tenant}#PRODUCT_GROUP`;

  const result = await dynamoClient.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: '#pk = :pk',
    ExpressionAttributeNames: { '#pk': 'pk' },
    ExpressionAttributeValues: { ':pk': { S: pk } },
    Limit: limit,
    ScanIndexForward: false,
  }));

  return (result.Items || []).map(item => unmarshall(item) as ProductGroup);
}

/**
 * Process image and find/create product group
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
  // Generate embedding
  const embedding = await generateImageEmbedding(imageBuffer);

  // Store embedding
  await storeEmbedding(imageId, embedding, tenant, metadata);

  // Find similar images
  const similarImages = await findSimilarImages(embedding, tenant, imageId);

  // Check if should join existing group
  const bestMatch = similarImages[0];
  let assignedGroup: ProductGroup | undefined;
  let isNewGroup = false;

  if (bestMatch && bestMatch.matchType === 'SAME_PRODUCT' && bestMatch.groupId) {
    // Add to existing group
    await linkImageToGroup(imageId, bestMatch.groupId, tenant);

    // Get the group
    const groups = await getProductGroups(tenant);
    assignedGroup = groups.find(g => g.groupId === bestMatch.groupId);
  } else if (bestMatch && (bestMatch.matchType === 'SAME_PRODUCT' || bestMatch.matchType === 'LIKELY_SAME')) {
    // Create new group with matched images
    const groupImageIds = [imageId, bestMatch.imageId];
    assignedGroup = await createProductGroup(groupImageIds, tenant);
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
 */
export async function batchProcessForGrouping(
  images: { id: string; buffer: Buffer; metadata?: ProductEmbedding['metadata'] }[],
  tenant: string = DEFAULT_TENANT
): Promise<{
  groups: ProductGroup[];
  ungrouped: string[];
  processed: number;
}> {
  const embeddings: { id: string; embedding: number[] }[] = [];
  const ungrouped: string[] = [];

  // Generate all embeddings first
  for (const image of images) {
    try {
      const embedding = await generateImageEmbedding(image.buffer);
      embeddings.push({ id: image.id, embedding });
      await storeEmbedding(image.id, embedding, tenant, image.metadata);
    } catch (error) {
      console.error(`Failed to process image ${image.id}:`, error);
      ungrouped.push(image.id);
    }
  }

  // Group similar images using clustering
  const groups = clusterBySimlarity(embeddings);

  // Create product groups in DynamoDB
  const createdGroups: ProductGroup[] = [];
  for (const group of groups) {
    if (group.length > 1) {
      const productGroup = await createProductGroup(group, tenant);
      createdGroups.push(productGroup);
    } else {
      ungrouped.push(group[0]);
    }
  }

  return {
    groups: createdGroups,
    ungrouped,
    processed: embeddings.length,
  };
}

/**
 * Simple clustering algorithm for grouping images by similarity
 */
function clusterBySimlarity(
  embeddings: { id: string; embedding: number[] }[]
): string[][] {
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

      const similarity = cosineSimilarity(item.embedding, other.embedding);
      if (similarity >= SIMILARITY_THRESHOLDS.LIKELY_SAME) {
        cluster.push(other.id);
        assigned.add(other.id);
      }
    }

    clusters.push(cluster);
  }

  return clusters;
}

// Export thresholds for UI configuration
export { SIMILARITY_THRESHOLDS };
