import base64
import json
import re
import time
import uuid
from typing import List, Optional, Dict, Any, Tuple
import concurrent.futures

import boto3
from pydantic import BaseModel, Field

# DynamoDB marshalling/unmarshalling
from boto3.dynamodb.types import TypeSerializer, TypeDeserializer

# --- Simplified/Placeholder Models from other modules ---

class ImageFeatures(BaseModel):
    id: str
    embedding: Optional[List[float]] = None # Will be filled after Titan embedding
    # From Rekognition (simplified for now)
    rekognitionLabels: List[str] = Field(default_factory=list)
    rekognitionCategory: Optional[str] = None
    rekognitionBrand: Optional[str] = None
    rekognitionSize: Optional[str] = None
    rekognitionMaterial: Optional[str] = None
    rekognitionColors: Optional[List[str]] = None
    rekognitionApproved: bool = True
    rekognitionModerationReason: Optional[str] = None
    # Image properties
    width: Optional[int] = None
    height: Optional[int] = None
    aspectRatio: Optional[float] = None
    megapixels: Optional[float] = None
    fileSizeMB: Optional[float] = None

class SignalBreakdown(BaseModel):
    spatial: float = 0.0
    feature: float = 0.0
    semantic: float = 0.0
    composition: float = 0.0
    background: float = 0.0

class SimilarityScore(BaseModel):
    totalScore: float
    signalBreakdown: SignalBreakdown

class SimilarityThresholds(BaseModel):
    sameProduct: float = 0.92
    likelySame: float = 0.85
    possiblySame: float = 0.75

class MultiSignalSettings(BaseModel):
    enabled: bool = False
    weights: Dict[str, float] = {
        'spatial': 0.2, 'feature': 0.2, 'semantic': 0.2,
        'composition': 0.2, 'background': 0.2
    }
    thresholds: SimilarityThresholds = SimilarityThresholds()
    rekognition: Dict[str, Any] = {'enabled': False, 'minConfidence': 75, 'maxLabels': 15}
    titanEmbeddings: Dict[str, Any] = {'enabled': True, 'modelId': 'amazon.titan-embed-image-v1'}


class ImageInput(BaseModel):
    imageId: str
    buffer: bytes

class BatchEmbeddingResult(BaseModel):
    successCount: int
    failureCount: int
    totalTimeMs: int
    embeddings: Dict[str, Any] # Map of imageId to {embedding: List[float]}
    errors: List[Any] # List of error objects


# --- Product Identity Models ---

class ProductEmbedding(BaseModel):
    imageId: str
    embedding: List[float]
    productGroupId: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None

class ProductGroup(BaseModel):
    groupId: str
    primaryImageId: str
    imageIds: List[str]
    productName: Optional[str] = None
    category: Optional[str] = None
    confidence: float
    createdAt: str
    updatedAt: str
    tenant: str

class SimilarityMatch(BaseModel):
    imageId: str
    similarity: float
    matchType: Literal['SAME_PRODUCT', 'LIKELY_SAME', 'POSSIBLY_SAME', 'DIFFERENT']
    groupId: Optional[str] = None


# --- Configuration ---
TABLE_NAME = 'carousel-main-dev' # Placeholder, should come from env
DEFAULT_TENANT = 'carousel-labs'

# Similarity thresholds
SIMILARITY_THRESHOLDS = {
    'SAME_PRODUCT': 0.92,
    'LIKELY_SAME': 0.85,
    'POSSIBLY_SAME': 0.75,
    'DIFFERENT': 0.0,
}

MAX_IMAGE_SIZE = 20 * 1024 * 1024 # 20MB for Titan Multimodal

# DynamoDB marshall/unmarshall helper
_serializer = TypeSerializer()
_deserializer = TypeDeserializer()

def marshall(item: Dict[str, Any]) -> Dict[str, Any]:
    return {k: _serializer.serialize(v) for k, v in item.items()}

def unmarshall(item: Dict[str, Any]) -> Dict[str, Any]:
    return {k: _deserializer.deserialize(v) for k, v in item.items()}


# --- Helper Functions (internal to class or simplified) ---

def sanitize_tenant(tenant: str) -> str:
    sanitized = re.sub(r'[^a-zA-Z0-9_-]', '', tenant)
    if sanitized != tenant:
        print(f"Warning: Tenant ID sanitized: "{tenant}" -> "{sanitized}"")
    if not sanitized:
        raise ValueError('Invalid tenant ID: must contain alphanumeric characters')
    return sanitized

def cosine_similarity(a: List[float], b: List[float]) -> float:
    if not a or not b:
        raise ValueError('Embedding arrays cannot be empty')
    if len(a) != len(b):
        raise ValueError(f"Embedding dimensions must match: {len(a)} vs {len(b)}")

    dot_product = sum(x * y for x, y in zip(a, b))
    norm_a = sum(x * x for x in a) ** 0.5
    norm_b = sum(x * x for x in b) ** 0.5

    return dot_product / (norm_a * norm_b) if norm_a * norm_b != 0 else 0.0

def classify_similarity(similarity: float) -> Literal['SAME_PRODUCT', 'LIKELY_SAME', 'POSSIBLY_SAME', 'DIFFERENT']:
    if similarity >= SIMILARITY_THRESHOLDS['SAME_PRODUCT']: return 'SAME_PRODUCT'
    if similarity >= SIMILARITY_THRESHOLDS['LIKELY_SAME']: return 'LIKELY_SAME'
    if similarity >= SIMILARITY_THRESHOLDS['POSSIBLY_SAME']: return 'POSSIBLY_SAME'
    return 'DIFFERENT'

# Placeholder for getModelForTask
def get_model_for_task(task: str, required: bool = False) -> Dict[str, Any]:
    if task == 'embedding':
        return {'id': 'amazon.titan-embed-image-v1', 'config': {}}
    if required:
        raise ValueError(f"No model found for task: {task}")
    return {}

# Placeholder for batchExtractFeatures and calculateMultiSignalSimilarity
async def _batch_extract_features(images: List[Dict[str, Any]], region: str, settings: MultiSignalSettings) -> List[ImageFeatures]:
    # Simulate feature extraction
    return [ImageFeatures(id=img['id'], rekognitionLabels=['simulated_label']) for img in images]

async def _calculate_multi_signal_similarity(img1: ImageFeatures, img2: ImageFeatures, settings: MultiSignalSettings) -> SimilarityScore:
    # Simulate multi-signal similarity
    return SimilarityScore(totalScore=0.9, signalBreakdown=SignalBreakdown())

# Placeholder for generateBatchImageEmbeddings
async def _generate_batch_image_embeddings(image_inputs: List[ImageInput]) -> BatchEmbeddingResult:
    embeddings_map = {}
    errors = []
    for img_input in image_inputs:
        if len(img_input.buffer) > MAX_IMAGE_SIZE:
            errors.append({'imageId': img_input.imageId, 'error': 'Image too large'})
            continue
        # Simulate embedding generation
        embeddings_map[img_input.imageId] = {'embedding': [0.1] * 1024} # Dummy embedding
    return BatchEmbeddingResult(
        successCount=len(embeddings_map),
        failureCount=len(errors),
        totalTimeMs=1000, # Dummy time
        embeddings=embeddings_map,
        errors=errors
    )


class ProductIdentityGrouper:
    """
    Manages image embeddings, similarity calculations, and product grouping using
    DynamoDB and Bedrock's Titan Multimodal Embeddings.
    """
    def __init__(self, region_name: str = 'eu-west-1', table_name: str = TABLE_NAME):
        self.bedrock_client = boto3.client('bedrock-runtime', region_name=region_name)
        self.dynamo_client = boto3.client('dynamodb', region_name=region_name)
        self.table_name = table_name

    async def generate_image_embedding(self, image_buffer: bytes) -> List[float]:
        if len(image_buffer) > MAX_IMAGE_SIZE:
            raise ValueError(f"Image too large: {(len(image_buffer) / 1024 / 1024):.1f}MB (max 20MB)")
        if not image_buffer:
            raise ValueError('Image buffer is empty')

        embedding_model = get_model_for_task('embedding', True)
        
        base64_image = base64.b64encode(image_buffer).decode('utf-8')

        response = self.bedrock_client.invoke_model(
            modelId=embedding_model['id'],
            contentType='application/json',
            accept='application/json',
            body=json.dumps({
                'inputImage': base64_image,
                'embeddingConfig': {'outputEmbeddingLength': 1024},
            })
        )
        response_body = json.loads(response['body'].read().decode('utf-8'))

        if not response_body.get('embedding') or not isinstance(response_body['embedding'], list):
            raise ValueError(f"Invalid Bedrock response: missing or invalid embedding. Response: {json.dumps(response_body)[:200]}")
        if not response_body['embedding']:
            raise ValueError('Invalid Bedrock response: embedding array is empty')

        return response_body['embedding']

    async def store_embedding(
        self,
        image_id: str,
        embedding: List[float],
        tenant: str = DEFAULT_TENANT,
        metadata: Optional[Dict[str, Any]] = None
    ) -> None:
        safe_tenant = sanitize_tenant(tenant)
        pk = f"TENANT#{safe_tenant}#EMBEDDING"
        sk = f"IMAGE#{image_id}"

        item = {
            'PK': pk,
            'SK': sk,
            'imageId': image_id,
            'embedding': json.dumps(embedding), # Store as JSON string
            'metadata': metadata,
            'entityType': 'EMBEDDING',
            'createdAt': time.time(), # Using unix timestamp for consistency
            'ttl': int(time.time()) + (30 * 24 * 60 * 60), # 30 days TTL
        }
        self.dynamo_client.put_item(TableName=self.table_name, Item=marshall(item))

    async def get_embeddings(self, tenant: str = DEFAULT_TENANT, limit: int = 10000) -> List[ProductEmbedding]:
        safe_tenant = sanitize_tenant(tenant)
        pk = f"TENANT#{safe_tenant}#EMBEDDING"

        embeddings: List[ProductEmbedding] = []
        last_evaluated_key: Optional[Dict[str, Any]] = None
        page_size = 1000

        while True:
            response = self.dynamo_client.query(
                TableName=self.table_name,
                KeyConditionExpression='PK = :pk',
                ExpressionAttributeValues={':pk': {'S': pk}},
                Limit=min(page_size, limit - len(embeddings)),
                ExclusiveStartKey=last_evaluated_key,
            )

            for item in response.get('Items', []):
                data = unmarshall(item)
                try:
                    embeddings.append(ProductEmbedding(
                        imageId=data['imageId'],
                        embedding=json.loads(data['embedding']),
                        productGroupId=data.get('productGroupId'),
                        metadata=data.get('metadata'),
                    ))
                except (json.JSONDecodeError, KeyError) as e:
                    print(f"Skipping corrupted embedding for image {data.get('imageId')}: {e}")

            last_evaluated_key = response.get('LastEvaluatedKey')
            if not last_evaluated_key or len(embeddings) >= limit:
                break
        return embeddings

    async def find_similar_images(
        self,
        embedding: List[float],
        tenant: str = DEFAULT_TENANT,
        exclude_image_id: Optional[str] = None
    ) -> List[SimilarityMatch]:
        safe_tenant = sanitize_tenant(tenant)
        existing_embeddings = await self.get_embeddings(safe_tenant)

        matches: List[SimilarityMatch] = []

        for existing in existing_embeddings:
            if exclude_image_id and existing.imageId == exclude_image_id:
                continue
            
            try:
                similarity = cosine_similarity(embedding, existing.embedding)
                match_type = classify_similarity(similarity)

                if match_type != 'DIFFERENT':
                    matches.append(SimilarityMatch(
                        imageId=existing.imageId,
                        similarity=similarity,
                        matchType=match_type,
                        groupId=existing.productGroupId,
                    ))
            except ValueError as e:
                print(f"Error calculating similarity for {existing.imageId}: {e}")

        return sorted(matches, key=lambda x: x.similarity, reverse=True)

    async def create_product_group(
        self,
        image_ids: List[str],
        tenant: str = DEFAULT_TENANT,
        product_name: Optional[str] = None,
        category: Optional[str] = None
    ) -> ProductGroup:
        if not image_ids:
            raise ValueError('Cannot create product group: image_ids array is empty')

        safe_tenant = sanitize_tenant(tenant)
        group_id = f"pg_{uuid.uuid4()}" # Using uuid.uuid4() for collision-safe ID generation
        pk = f"TENANT#{safe_tenant}#PRODUCT_GROUP"
        sk = f"GROUP#{group_id}"

        group = ProductGroup(
            groupId=group_id,
            primaryImageId=image_ids[0],
            imageIds=image_ids,
            productName=product_name,
            category=category,
            confidence=1.0,
            createdAt=time.strftime('%Y-%m-%dT%H:%M:%S%Z', time.gmtime()),
            updatedAt=time.strftime('%Y-%m-%dT%H:%M:%S%Z', time.gmtime()),
            tenant=safe_tenant,
        )

        item = {
            'PK': pk,
            'SK': sk,
            **group.model_dump(),
            'entityType': 'PRODUCT_GROUP',
            'ttl': int(time.time()) + (90 * 24 * 60 * 60), # 90 days
        }
        self.dynamo_client.put_item(TableName=self.table_name, Item=marshall(item))

        for image_id in image_ids:
            await self.link_image_to_group(image_id, group_id, safe_tenant)
        
        return group

    async def link_image_to_group(
        self,
        image_id: str,
        group_id: str,
        tenant: str = DEFAULT_TENANT
    ) -> None:
        safe_tenant = sanitize_tenant(tenant)
        pk = f"TENANT#{safe_tenant}#EMBEDDING"
        sk = f"IMAGE#{image_id}"

        self.dynamo_client.update_item(
            TableName=self.table_name,
            Key={'PK': {'S': pk}, 'SK': {'S': sk}},
            UpdateExpression='SET #groupId = :groupId, #updatedAt = :updatedAt',
            ExpressionAttributeNames={
                '#groupId': 'productGroupId',
                '#updatedAt': 'updatedAt',
            },
            ExpressionAttributeValues=marshall({
                ':groupId': group_id,
                ':updatedAt': time.strftime('%Y-%m-%dT%H:%M:%S%Z', time.gmtime()),
            }),
        )

    async def add_image_to_group_record(
        self,
        image_id: str,
        group_id: str,
        tenant: str = DEFAULT_TENANT
    ) -> Optional[ProductGroup]:
        safe_tenant = sanitize_tenant(tenant)
        pk = f"TENANT#{safe_tenant}#PRODUCT_GROUP"
        sk = f"GROUP#{group_id}"

        try:
            response = self.dynamo_client.update_item(
                TableName=self.table_name,
                Key={'PK': {'S': pk}, 'SK': {'S': sk}},
                UpdateExpression='SET #imageIds = list_append(if_not_exists(#imageIds, :empty), :newImage), #updatedAt = :updatedAt',
                ConditionExpression='NOT contains(#imageIds, :imageId)',
                ExpressionAttributeNames={
                    '#imageIds': 'imageIds',
                    '#updatedAt': 'updatedAt',
                },
                ExpressionAttributeValues=marshall({
                    ':newImage': [image_id],
                    ':empty': [],
                    ':imageId': image_id,
                    ':updatedAt': time.strftime('%Y-%m-%dT%H:%M:%S%Z', time.gmtime()),
                }),
                ReturnValues='ALL_NEW',
            )
            return ProductGroup(**unmarshall(response['Attributes'])) if 'Attributes' in response else None
        except self.dynamo_client.exceptions.ConditionalCheckFailedException:
            print(f"Image {image_id} already in group {group_id}")
            return await self.get_product_group_by_id(group_id, safe_tenant)
        except Exception as e:
            raise e

    async def get_product_group_by_id(
        self,
        group_id: str,
        tenant: str = DEFAULT_TENANT
    ) -> Optional[ProductGroup]:
        safe_tenant = sanitize_tenant(tenant)
        pk = f"TENANT#{safe_tenant}#PRODUCT_GROUP"
        sk = f"GROUP#{group_id}"

        response = self.dynamo_client.get_item(
            TableName=self.table_name,
            Key={'PK': {'S': pk}, 'SK': {'S': sk}},
        )
        return ProductGroup(**unmarshall(response['Item'])) if 'Item' in response else None

    async def get_product_groups(
        self,
        tenant: str = DEFAULT_TENANT,
        limit: int = 100
    ) -> List[ProductGroup]:
        safe_tenant = sanitize_tenant(tenant)
        pk = f"TENANT#{safe_tenant}#PRODUCT_GROUP"

        response = self.dynamo_client.query(
            TableName=self.table_name,
            KeyConditionExpression='PK = :pk',
            ExpressionAttributeValues={':pk': {'S': pk}},
            Limit=limit,
            ScanIndexForward=False,
        )
        return [ProductGroup(**unmarshall(item)) for item in response.get('Items', [])]

    async def process_image_for_grouping(
        self,
        image_id: str,
        image_buffer: bytes,
        tenant: str = DEFAULT_TENANT,
        metadata: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]: # Simplified return type for now
        safe_tenant = sanitize_tenant(tenant)

        embedding = await self.generate_image_embedding(image_buffer)
        await self.store_embedding(image_id, embedding, safe_tenant, metadata)
        similar_images = await self.find_similar_images(embedding, safe_tenant, image_id)

        best_match = similar_images[0] if similar_images else None
        assigned_group: Optional[ProductGroup] = None
        is_new_group = False

        if best_match and best_match.matchType == 'SAME_PRODUCT' and best_match.groupId:
            try:
                await self.link_image_to_group(image_id, best_match.groupId, safe_tenant)
                assigned_group = await self.add_image_to_group_record(image_id, best_match.groupId, safe_tenant)
            except Exception as e:
                print(f"Failed to add image {image_id} to group {best_match.groupId}: {e}")
        elif best_match and (best_match.matchType == 'SAME_PRODUCT' or best_match.matchType == 'LIKELY_SAME'):
            group_image_ids = [image_id, best_match.imageId]
            assigned_group = await self.create_product_group(group_image_ids, safe_tenant)
            is_new_group = True

        return {
            'embedding': embedding,
            'similarImages': similar_images,
            'assignedGroup': assigned_group,
            'isNewGroup': is_new_group,
        }

    async def cluster_by_similarity(
        self,
        embeddings: List[ProductEmbedding], # Changed from generic dict to ProductEmbedding
        threshold: float = SIMILARITY_THRESHOLDS['SAME_PRODUCT'],
        use_multi_signal: bool = False,
        image_metadata_map: Optional[Dict[str, ImageFeatures]] = None,
        settings: Optional[MultiSignalSettings] = None
    ) -> List[List[str]]:
        clusters: List[List[str]] = []
        assigned = set()

        for item in embeddings:
            if item.imageId in assigned:
                continue

            cluster = [item.imageId]
            assigned.add(item.imageId)

            for other in embeddings:
                if other.imageId in assigned:
                    continue

                similarity: float
                if use_multi_signal and image_metadata_map and settings:
                    img1_meta = image_metadata_map.get(item.imageId)
                    img2_meta = image_metadata_map.get(other.imageId)
                    if img1_meta and img2_meta:
                        result = await _calculate_multi_signal_similarity(img1_meta, img2_meta, settings)
                        similarity = result.totalScore
                    else:
                        similarity = cosine_similarity(item.embedding, other.embedding)
                else:
                    similarity = cosine_similarity(item.embedding, other.embedding)

                if similarity >= threshold:
                    cluster.append(other.imageId)
                    assigned.add(other.imageId)
            clusters.append(cluster)
        return clusters


    async def batch_process_with_multi_signal(
        self,
        images: List[Dict[str, Any]], # List of dicts with id, buffer, metadata, width, height
        tenant: str = DEFAULT_TENANT,
        stage: str = 'dev',
        include_existing_embeddings: bool = True
    ) -> Dict[str, Any]: # Simplified return type for now
        safe_tenant = sanitize_tenant(tenant)

        # Placeholder for loadSettings
        # For simplicity, returning a dummy MultiSignalSettings
        settings = MultiSignalSettings(
            enabled=True,
            rekognition={'enabled': True},
            thresholds=SimilarityThresholds(sameProduct=SIMILARITY_THRESHOLDS['SAME_PRODUCT'])
        )

        print(f'[MultiSignal] Batch processing started, imageCount={len(images)}, multiSignalEnabled={settings.enabled}, rekognitionEnabled={settings.rekognition.get("enabled")}, tenant={safe_tenant}')

        # Step 1 & 2: Extract image features including Rekognition labels
        start_time = time.time() * 1000
        # Simulating batchExtractFeatures
        image_features = await _batch_extract_features(images, safe_tenant, settings) # Assuming region is safe_tenant for now
        print(f'[MultiSignal] Feature extraction complete in {time.time() * 1000 - start_time:.0f}ms')

        image_metadata_map = {features.id: features for features in image_features}

        # Step 3: Generate Titan embeddings
        new_embeddings_raw: List[ProductEmbedding] = [] # Raw embeddings
        ungrouped: List[str] = []

        print(f'[MultiSignal] Using batch embedding generation for {len(images)} images')
        image_inputs = [ImageInput(imageId=img['id'], buffer=img['buffer']) for img in images]
        
        embedding_start_time = time.time() * 1000
        batch_result = await _generate_batch_image_embeddings(image_inputs)

        print(f'[MultiSignal] Batch embedding complete: successCount={batch_result.successCount}, failureCount={batch_result.failureCount}, totalTimeMs={batch_result.totalTimeMs:.0f}ms')

        for image_id, embedding_data in batch_result.embeddings.items():
            # Find original metadata for this image to store with embedding
            original_image_metadata = next((img['metadata'] for img in images if img['id'] == image_id), None)
            new_embeddings_raw.append(ProductEmbedding(
                imageId=image_id,
                embedding=embedding_data['embedding'],
                metadata=original_image_metadata
            ))
            try:
                await self.store_embedding(image_id, embedding_data['embedding'], safe_tenant, original_image_metadata)
            except Exception as e:
                print(f"Failed to store embedding for {image_id}: {e}")
        
        for error in batch_result.errors:
            ungrouped.append(error['imageId'])

        # Step 4: Fetch existing embeddings if requested
        all_embeddings: List[ProductEmbedding] = list(new_embeddings_raw)
        existing_matched = 0

        if include_existing_embeddings:
            existing_embeddings = await self.get_embeddings(safe_tenant)
            new_image_ids = {e.imageId for e in new_embeddings_raw}
            for existing in existing_embeddings:
                if existing.imageId not in new_image_ids:
                    all_embeddings.append(existing)

        # Step 5: Cluster using multi-signal analysis
        threshold = settings.thresholds.sameProduct
        groups = await self.cluster_by_similarity(
            all_embeddings,
            threshold,
            settings.enabled,
            image_metadata_map,
            settings
        )

        # Step 6: Create product groups with signal breakdown
        created_groups: List[ProductGroup] = []
        new_image_ids_set = {e.imageId for e in new_embeddings_raw}

        for group_image_ids in groups:
            has_new_images = any(img_id in new_image_ids_set for img_id in group_image_ids)
            if not has_new_images:
                continue

            if len(group_image_ids) > 1:
                existing_in_group = [img_id for img_id in group_image_ids if img_id not in new_image_ids_set]
                existing_matched += len(existing_in_group)
                
                # Placeholder for productName and category
                product_group_name = f"Group of {len(group_image_ids)} images"
                product_group_category = "General"

                product_group = await self.create_product_group(group_image_ids, safe_tenant, product_name=product_group_name, category=product_group_category)

                # Calculate average similarity and signal breakdown for the group
                if settings.enabled and len(group_image_ids) > 1:
                    total_score = 0.0
                    signal_sum = SignalBreakdown()
                    comparisons = 0

                    for i in range(len(group_image_ids)):
                        for j in range(i + 1, len(group_image_ids)):
                            img1_meta = image_metadata_map.get(group_image_ids[i])
                            img2_meta = image_metadata_map.get(group_image_ids[j])

                            if img1_meta and img2_meta:
                                result = await _calculate_multi_signal_similarity(img1_meta, img2_meta, settings)
                                total_score += result.totalScore
                                signal_sum.spatial += result.signalBreakdown.spatial
                                signal_sum.feature += result.signalBreakdown.feature
                                signal_sum.semantic += result.signalBreakdown.semantic
                                signal_sum.composition += result.signalBreakdown.composition
                                signal_sum.background += result.signalBreakdown.background
                                comparisons += 1
                    
                    if comparisons > 0:
                        created_groups.append(ProductGroup(
                            **product_group.model_dump(),
                            confidence=total_score / comparisons # Using avg similarity as confidence
                            # signalBreakdown is not part of ProductGroup Pydantic model
                        ))
                    else:
                        created_groups.append(product_group)
                else:
                    created_groups.append(product_group)
            else:
                ungrouped.append(group_image_ids[0])

        print(f'[MultiSignal] Batch processing complete: groupsCreated={len(created_groups)}, ungroupedImages={len(ungrouped)}, existingMatched={existing_matched}')

        return {
            'groups': created_groups,
            'ungrouped': ungrouped,
            'processed': len(new_embeddings_raw),
            'existingMatched': existing_matched,
            'multiSignalEnabled': settings.enabled,
        }
