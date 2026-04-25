/**
 * API Route Handler for Searchable Content Visualization
 * 
 * This handler serves the searchable content visualization data
 * for the BG-Remover service.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthHeaders } from '@/lib/utils/auth-headers';
import { getApiBaseUrl } from '@/lib/utils/api-url-detection';

// Define the response type
export interface SearchableContentVisualizationResponse {
  sources: Record<string, {
    stores: Record<string, {
      source: string;
      store: string;
      contentType: string;
      itemCount: number;
      lastUpdated: number;
      accessLevel: 'public' | 'private' | 'restricted';
      description: string;
    }>;
    totalItems: number;
    accessLevel: 'public' | 'private' | 'restricted';
  }>;
  summary: {
    totalSources: number;
    totalStores: number;
    totalItems: number;
    accessLevels: Record<string, number>;
  };
}

/**
 * GET handler for searchable content visualization
 * 
 * @param request - Next.js request object
 * @returns Response with visualization data
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    // Extract auth headers
    const authHeaders = getAuthHeaders(request);
    
    // In a real implementation, we would fetch this data from a service
    // For now, returning mock data
    
    const visualizationData: SearchableContentVisualizationResponse = {
      sources: {
        's3': {
          stores: {
            'product-images': {
              source: 's3',
              store: 'product-images',
              contentType: 'image',
              itemCount: 15000,
              lastUpdated: Date.now() - 86400000,
              accessLevel: 'private',
              description: 'Product images stored in S3 bucket'
            },
            'background-images': {
              source: 's3',
              store: 'background-images',
              contentType: 'image',
              itemCount: 5000,
              lastUpdated: Date.now() - 3600000,
              accessLevel: 'private',
              description: 'Background removal results stored in S3'
            },
            'metadata': {
              source: 's3',
              store: 'metadata',
              contentType: 'json',
              itemCount: 20000,
              lastUpdated: Date.now() - 172800000,
              accessLevel: 'restricted',
              description: 'Product metadata stored in S3'
            }
          },
          totalItems: 40000,
          accessLevel: 'private'
        },
        'dynamodb': {
          stores: {
            'jobs': {
              source: 'dynamodb',
              store: 'jobs',
              contentType: 'json',
              itemCount: 10000,
              lastUpdated: Date.now() - 300000,
              accessLevel: 'private',
              description: 'Job tracking information'
            },
            'settings': {
              source: 'dynamodb',
              store: 'settings',
              contentType: 'json',
              itemCount: 50,
              lastUpdated: Date.now() - 2592000000,
              accessLevel: 'restricted',
              description: 'Service settings and configurations'
            }
          },
          totalItems: 10050,
          accessLevel: 'private'
        },
        'carousel-api': {
          stores: {
            'products': {
              source: 'carousel-api',
              store: 'products',
              contentType: 'json',
              itemCount: 50000,
              lastUpdated: Date.now() - 1800000,
              accessLevel: 'public',
              description: 'Product catalog from Carousel API'
            },
            'categories': {
              source: 'carousel-api',
              store: 'categories',
              contentType: 'json',
              itemCount: 200,
              lastUpdated: Date.now() - 604800000,
              accessLevel: 'public',
              description: 'Product categories from Carousel API'
            }
          },
          totalItems: 50200,
          accessLevel: 'public'
        }
      },
      summary: {
        totalSources: 3,
        totalStores: 6,
        totalItems: 100250,
        accessLevels: {
          public: 50200,
          private: 50050,
          restricted: 50
        }
      }
    };

    return NextResponse.json(visualizationData, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders
      }
    });
  } catch (error) {
    console.error('Error fetching visualization data:', error);
    return NextResponse.json(
      { 
        error: 'Failed to fetch visualization data',
        message: error instanceof Error ? error.message : 'Unknown error occurred'
      },
      { 
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
}