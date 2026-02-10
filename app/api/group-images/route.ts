import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { GroupImagesRequestSchema, type GroupImagesRequest } from '@/src/lib/types';
import { validateRequest } from '@/src/lib/validation';
import { resolveTenantFromRequest } from '@/src/lib/tenant/resolver';
import { batchProcessForGrouping } from '@/src/lib/product-identity/product-identity-service';
import { getServiceEndpoint } from '@/src/lib/tenant/config';
import { loadConfig } from '@/src/lib/config/loader';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';

const s3Client = new S3Client({});
const tempImagesBucket = process.env.TEMP_IMAGES_BUCKET;

const streamToBuffer = async (stream: Readable | Uint8Array | Buffer): Promise<Buffer> => {
  if (Buffer.isBuffer(stream)) {
    return stream;
  }
  if (stream instanceof Uint8Array) {
    return Buffer.from(stream);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

const ensureAllowedBucket = (bucket: string): string => {
  const allowedPattern = /^bg-remover-temp-images-(dev|prod)$/;
  if (!allowedPattern.test(bucket)) {
    throw new Error(`Invalid image bucket: ${bucket}`);
  }
  return bucket;
};

const resolveImageBase64 = async (
  image: GroupImagesRequest['images'][number],
  requestId: string
): Promise<string> => {
  if (image.imageBase64) {
    return image.imageBase64;
  }
  if (!image.s3Key) {
    throw new Error('Image data missing: no imageBase64 or s3Key provided');
  }
  const bucket = image.s3Bucket || tempImagesBucket;
  if (!bucket) {
    throw new Error('TEMP_IMAGES_BUCKET is not configured');
  }
  const safeBucket = ensureAllowedBucket(bucket);
  const response = await s3Client.send(new GetObjectCommand({
    Bucket: safeBucket,
    Key: image.s3Key,
  }));
  if (!response.Body) {
    throw new Error(`Empty S3 response for ${image.s3Key}`);
  }
  const buffer = await streamToBuffer(response.Body as Readable);
  return buffer.toString('base64');
};

/**
 * Group Images API - Sync Handler (Next.js Route Handler)
 * 
 * Sync workflow for compatibility:
 * 1. Accept grouping request
 * 2. Process images synchronously
 * 3. Return groups directly in response
 */

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  let tenant: string | undefined;

  try {
    // Convert NextRequest to event-like object for resolver
    const event = {
      headers: Object.fromEntries(request.headers.entries()),
      pathParameters: {},
    };
    const stage = process.env.STAGE || 'dev';

    // Extract tenant from request
    tenant = await resolveTenantFromRequest(event, stage);

    console.log('[GroupImages] Starting grouping request', {
      tenant,
      stage,
      requestId,
    });

    // Parse and validate request
    const body = await request.json();
    const validation = validateRequest(GroupImagesRequestSchema, body, 'group-images');

    if (!validation.success) {
      return NextResponse.json(
        {
          error: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          errors: validation.error?.details,
        },
        { status: 400 }
      );
    }

    const groupRequest = validation.data as GroupImagesRequest;
    const {
      images,
      thumbnailSize = { width: 256, height: 256 },
      similarityThreshold = 0.92,
      includeExistingEmbeddings = true,
    } = groupRequest;

    console.log('[GroupImages] Request validated', {
      imageCount: images.length,
      thumbnailSize,
      similarityThreshold,
      includeExistingEmbeddings,
      tenant,
    });

    // Load config
    const { secrets } = await loadConfig(stage, tenant);
    if (!secrets.serviceApiKey) {
      throw new Error('Image optimizer API key not configured');
    }
    const serviceApiKey = secrets.serviceApiKey;

    // Generate thumbnails for all images
    const thumbnails: { id: string; buffer: Buffer; metadata: any }[] = [];
    const imageOptimizerUrl = await getServiceEndpoint('image-optimizer', tenant);

    const thumbnailPromises = images.map(async (image, index) => {
      const imageId = image.imageId || `img_${randomUUID()}`;

      try {
        const imageBase64 = await resolveImageBase64(image, requestId);
        const thumbnailResponse = await fetch(imageOptimizerUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Tenant-Id': tenant || 'carousel-labs',
            'x-api-key': serviceApiKey,
          },
          body: JSON.stringify({
            imageBase64,
            outputFormat: 'jpeg',
            quality: 75,
            targetSize: thumbnailSize,
          }),
        });

        if (!thumbnailResponse.ok) {
          console.warn('[GroupImages] Thumbnail failed, continuing', {
            imageId,
            status: thumbnailResponse.status,
          });
          return null;
        }

        const thumbnailData = await thumbnailResponse.json();
        const thumbnailBuffer = Buffer.from(thumbnailData.outputBase64, 'base64');

        return {
          id: imageId,
          buffer: thumbnailBuffer,
          metadata: {
            filename: image.filename,
            uploadedAt: image.metadata?.uploadedAt || new Date().toISOString(),
            originalSize: image.metadata?.originalSize,
            thumbnailSize: thumbnailData.metadata,
          },
        };
      } catch (error) {
        console.warn('[GroupImages] Thumbnail error, continuing', {
          imageId,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    });

    // Execute all thumbnails in parallel
    const thumbnailResults = await Promise.allSettled(thumbnailPromises);
    const successfulThumbnails = thumbnailResults
      .map((result, index) => result.status === 'fulfilled' ? result.value : null)
      .filter((thumbnail): thumbnail is NonNullable<typeof thumbnail> => thumbnail !== null);

    thumbnails.push(...successfulThumbnails);

    console.log('[GroupImages] Thumbnails completed', {
      requested: images.length,
      successful: thumbnails.length,
    });

    // If all thumbnails failed, return fallback
    if (thumbnails.length === 0) {
      const fallbackGroups = images.map((image, i) => {
        const imageId = image.imageId || `img_${randomUUID()}`;
        return {
          groupId: `pg_${randomUUID()}`,
          imageIds: [imageId],
          imageCount: 1,
          thumbnails: [],
          confidence: 1.0,
          primaryImageId: imageId,
          productName: '',
          category: '',
          metadata: {
            filename: image.filename,
            uploadedAt: image.metadata?.uploadedAt || new Date().toISOString(),
            originalSize: image.metadata?.originalSize,
            fallbackMode: true,
          },
        };
      });

      return NextResponse.json({
        success: true,
        groups: fallbackGroups,
        summary: {
          totalImages: images.length,
          processedImages: images.length,
          groupsFound: 0,
          singleImageProducts: images.length,
          existingMatched: 0,
          similarityThreshold,
          fallbackMode: true,
          warning: 'Image similarity grouping unavailable - created individual groups for each image',
        },
        requestId,
      });
    }

    console.log('[GroupImages] All thumbnails generated', {
      total: thumbnails.length,
      tenant,
    });

    // Process for grouping using Titan embeddings on thumbnails
    const groupingResult = await batchProcessForGrouping(
      thumbnails,
      tenant,
      includeExistingEmbeddings
    );

    console.log('[GroupImages] Grouping completed', {
      groupsFound: groupingResult.groups.length,
      ungrouped: groupingResult.ungrouped.length,
      processed: groupingResult.processed,
      existingMatched: groupingResult.existingMatched,
      tenant,
    });

    // Prepare response with groups and thumbnails
    const groupsWithThumbnails = groupingResult.groups.map(group => {
      const groupThumbnails = group.imageIds.map(imageId => {
        const thumbnail = thumbnails.find(t => t.id === imageId);
        return thumbnail ? {
          imageId,
          thumbnail: thumbnail.buffer.toString('base64'),
          filename: thumbnail.metadata.filename,
          dimensions: thumbnail.metadata.thumbnailSize,
        } : null;
      }).filter(Boolean);

      return {
        groupId: group.groupId,
        imageIds: group.imageIds,
        imageCount: group.imageIds.length,
        thumbnails: groupThumbnails,
        confidence: group.confidence,
        primaryImageId: group.primaryImageId,
        productName: group.productName,
        category: group.category,
      };
    });

    // Include ungrouped images (single-image products)
    const ungroupedWithThumbnails = groupingResult.ungrouped.map(imageId => {
      const thumbnail = thumbnails.find(t => t.id === imageId);
      if (!thumbnail) return null;

      return {
        groupId: `pg_${randomUUID()}`, // Create single-image group
        imageIds: [imageId],
        imageCount: 1,
        thumbnails: [{
          imageId,
          thumbnail: thumbnail.buffer.toString('base64'),
          filename: thumbnail.metadata.filename,
          dimensions: thumbnail.metadata.thumbnailSize,
        }],
        confidence: 1.0, // Single image = 100% confidence
        primaryImageId: imageId,
      };
    }).filter(Boolean);

    const allGroups = [...groupsWithThumbnails, ...ungroupedWithThumbnails];

    return NextResponse.json({
      success: true,
      groups: allGroups,
      summary: {
        totalImages: images.length,
        processedImages: thumbnails.length,
        groupsFound: groupingResult.groups.length,
        singleImageProducts: groupingResult.ungrouped.length,
        existingMatched: groupingResult.existingMatched,
        similarityThreshold,
      },
      requestId,
    });

  } catch (error: any) {
    console.error('[GroupImages] Request failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      requestId,
    });

    return NextResponse.json(
      {
        error: 'GROUPING_FAILED',
        message: error instanceof Error ? error.message : 'Unknown error occurred',
        requestId,
      },
      { status: 500 }
    );
  }
}

// OPTIONS for CORS preflight
export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Tenant-Id',
    },
  });
}
