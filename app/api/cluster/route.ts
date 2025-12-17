/**
 * POST /api/cluster - Backend Image Clustering
 *
 * Analyzes multiple images to detect duplicates and group by color similarity.
 * Uses perceptual hashing and k-means clustering on color histograms.
 *
 * Request body:
 * - images: Array of { id: string, base64: string } or { id: string, url: string }
 * - options: ClusteringOptions (optional)
 *
 * Response:
 * - features: Extracted features for each image
 * - duplicateGroups: Groups of similar/duplicate images
 * - colorGroups: Groups based on dominant colors
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { clusterImages, type ClusteringResult, type ClusteringOptions } from '@/lib/clustering/similarity-service';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Request validation schema
const ClusterRequestSchema = z.object({
  images: z
    .array(
      z.object({
        id: z.string(),
        base64: z.string().optional(),
        url: z.string().url().optional(),
      }).refine(
        (data) => data.base64 || data.url,
        { message: 'Either base64 or url must be provided for each image' }
      )
    )
    .min(1)
    .max(100),
  options: z
    .object({
      detectDuplicates: z.boolean().optional(),
      groupByColor: z.boolean().optional(),
      duplicateThreshold: z.number().min(0).max(1).optional(),
      colorGroups: z.number().min(1).max(10).optional(),
      maxImagesPerGroup: z.number().min(1).max(50).optional(),
    })
    .optional(),
});

type ClusterRequest = z.infer<typeof ClusterRequestSchema>;

interface ClusterResponse {
  success: boolean;
  result?: ClusteringResult;
  processingTimeMs: number;
  error?: string;
}

/**
 * Fetch image from URL and return as buffer
 */
async function fetchImageAsBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch image from ${url}: ${response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function POST(request: NextRequest): Promise<NextResponse<ClusterResponse>> {
  const startTime = Date.now();

  try {
    // Parse and validate request
    const body = await request.json();
    const validatedRequest = ClusterRequestSchema.parse(body);

    console.log('Clustering request received', {
      imageCount: validatedRequest.images.length,
      options: validatedRequest.options,
    });

    // Convert images to buffers
    const imageBuffers = await Promise.all(
      validatedRequest.images.map(async (img) => {
        let buffer: Buffer;

        if (img.base64) {
          // Handle data URL format (data:image/png;base64,...)
          const base64Data = img.base64.includes(',')
            ? img.base64.split(',')[1]
            : img.base64;
          buffer = Buffer.from(base64Data, 'base64');
        } else if (img.url) {
          buffer = await fetchImageAsBuffer(img.url);
        } else {
          throw new Error(`Image ${img.id} has no base64 or url`);
        }

        return { id: img.id, buffer };
      })
    );

    // Perform clustering
    const result = await clusterImages(imageBuffers, validatedRequest.options as ClusteringOptions);

    const processingTimeMs = Date.now() - startTime;

    console.log('Clustering completed', {
      imageCount: validatedRequest.images.length,
      duplicateGroups: result.duplicateGroups.length,
      colorGroups: result.colorGroups.length,
      processingTimeMs,
    });

    return NextResponse.json({
      success: true,
      result,
      processingTimeMs,
    });
  } catch (error) {
    const processingTimeMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    console.error('Clustering failed', {
      error: errorMessage,
      processingTimeMs,
    });

    // Handle validation errors
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          success: false,
          error: `Validation error: ${error.errors.map((e) => e.message).join(', ')}`,
          processingTimeMs,
        },
        { status: 400 }
      );
    }

    return NextResponse.json(
      {
        success: false,
        error: errorMessage,
        processingTimeMs,
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
