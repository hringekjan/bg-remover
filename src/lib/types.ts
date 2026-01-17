// src/lib/types.ts
import { z } from 'zod';

// Custom validation functions
const isValidBase64 = (str: string) => {
  try {
    // Check if it's valid base64 format (base64 regex + can be decoded)
    const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
    if (!base64Regex.test(str)) return false;

    // Try to decode it
    atob(str);
    return true;
  } catch {
    return false;
  }
};

/**
 * Validate that base64 string contains valid image data (PNG, JPEG, WebP, or HEIC)
 * Uses magic bytes detection for security
 */
const isValidImageBase64 = (base64: string): boolean => {
  try {
    // Decode base64 to get first 12 bytes for magic byte detection
    const buffer = Buffer.from(base64.substring(0, Math.min(base64.length, 100)), 'base64');

    // Check magic bytes for common image formats
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (buffer.length >= 8 &&
        buffer[0] === 0x89 && buffer[1] === 0x50 &&
        buffer[2] === 0x4E && buffer[3] === 0x47) {
      return true;
    }

    // JPEG: FF D8 FF
    if (buffer.length >= 3 &&
        buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
      return true;
    }

    // WebP: RIFF ... WEBP (bytes 0-3: RIFF, bytes 8-11: WEBP)
    if (buffer.length >= 12 &&
        buffer[0] === 0x52 && buffer[1] === 0x49 &&
        buffer[2] === 0x46 && buffer[3] === 0x46 &&
        buffer[8] === 0x57 && buffer[9] === 0x45 &&
        buffer[10] === 0x42 && buffer[11] === 0x50) {
      return true;
    }

    // HEIC/HEIF: ftyp at bytes 4-7 followed by heic/mif1/msf1/heix/hevx
    if (buffer.length >= 12 &&
        buffer[4] === 0x66 && buffer[5] === 0x74 &&
        buffer[6] === 0x79 && buffer[7] === 0x70) {
      return true;
    }

    return false;
  } catch (error) {
    console.warn('Failed to validate image magic bytes:', error instanceof Error ? error.message : 'Unknown error');
    return false;
  }
};

/**
 * Check if an IP address is in a private/reserved range (SSRF protection)
 * Covers all RFC 1918 private ranges and other reserved addresses
 */
const isPrivateOrReservedIP = (hostname: string): boolean => {
  // Localhost variations
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    return true;
  }

  // Zero address
  if (hostname === '0.0.0.0' || hostname === '0.0.0.0') {
    return true;
  }

  // Check for IPv4 private ranges
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b, c, d] = ipv4Match.map(Number);

    // Validate octets
    if ([a, b, c, d].some(octet => octet > 255)) {
      return true; // Invalid IP, treat as private
    }

    // 10.0.0.0/8 (Class A private)
    if (a === 10) return true;

    // 172.16.0.0/12 (Class B private) - 172.16.x.x to 172.31.x.x
    if (a === 172 && b >= 16 && b <= 31) return true;

    // 192.168.0.0/16 (Class C private)
    if (a === 192 && b === 168) return true;

    // 127.0.0.0/8 (Loopback)
    if (a === 127) return true;

    // 169.254.0.0/16 (Link-local)
    if (a === 169 && b === 254) return true;

    // 100.64.0.0/10 (Carrier-grade NAT)
    if (a === 100 && b >= 64 && b <= 127) return true;

    // 192.0.0.0/24 (IETF Protocol Assignments)
    if (a === 192 && b === 0 && c === 0) return true;

    // 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 (Documentation)
    if (a === 192 && b === 0 && c === 2) return true;
    if (a === 198 && b === 51 && c === 100) return true;
    if (a === 203 && b === 0 && c === 113) return true;

    // 224.0.0.0/4 (Multicast)
    if (a >= 224 && a <= 239) return true;

    // 240.0.0.0/4 (Reserved)
    if (a >= 240) return true;

    // 255.255.255.255 (Broadcast)
    if (a === 255 && b === 255 && c === 255 && d === 255) return true;
  }

  // Check for IPv6 private/reserved ranges
  const hostname_lower = hostname.toLowerCase();
  if (
    hostname_lower === '::' ||
    hostname_lower.startsWith('::ffff:127.') ||
    hostname_lower.startsWith('::ffff:10.') ||
    hostname_lower.startsWith('::ffff:192.168.') ||
    hostname_lower.startsWith('fe80:') || // Link-local
    hostname_lower.startsWith('fc') || // Unique local address (fc00::/7)
    hostname_lower.startsWith('fd') // Unique local address (fc00::/7)
  ) {
    return true;
  }

  return false;
};

const isValidImageUrl = (url: string) => {
  try {
    const parsedUrl = new URL(url);

    // Only allow HTTP/HTTPS URLs
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return false;
    }

    // SSRF Protection: Block private/reserved IP addresses
    const hostname = parsedUrl.hostname;
    if (isPrivateOrReservedIP(hostname)) {
      console.warn('SSRF protection: blocked private/reserved IP', { hostname, url: url.substring(0, 100) });
      return false;
    }

    // Block common internal hostnames
    const blockedHostnames = [
      'localhost',
      'metadata.google.internal', // GCP metadata
      '169.254.169.254', // AWS/Azure metadata (covered above but explicit)
      'metadata.azure.com',
      'kubernetes.default',
      'kubernetes.default.svc',
    ];

    if (blockedHostnames.some(blocked => hostname === blocked || hostname.endsWith('.' + blocked))) {
      console.warn('SSRF protection: blocked internal hostname', { hostname, url: url.substring(0, 100) });
      return false;
    }

    return true;
  } catch {
    return false;
  }
};

const MAX_BASE64_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_URL_LENGTH = 2048;

// Multilingual processing request schema
export const ProcessRequestSchema = z.object({
  imageUrl: z.string()
    .max(MAX_URL_LENGTH, 'URL too long')
    .refine(isValidImageUrl, 'Invalid or insecure image URL')
    .optional(),
  imageBase64: z.string()
    .refine((val) => val.length <= MAX_BASE64_SIZE, 'Base64 image too large (max 10MB)')
    .refine(isValidBase64, 'Invalid base64 format')
    .refine(isValidImageBase64, 'Invalid image format - must be PNG, JPEG, WebP, or HEIC')
    .optional(),
  outputFormat: z.enum(['png', 'jpeg', 'webp'], {
    errorMap: () => ({ message: 'Output format must be png, jpeg, or webp' })
  }).default('png'),
  quality: z.number()
    .int('Quality must be an integer')
    .min(1, 'Quality must be between 1 and 100')
    .max(100, 'Quality must be between 1 and 100')
    .optional(),
  productId: z.string()
    .max(100, 'Product ID too long')
    .regex(/^[a-zA-Z0-9_-]+$/, 'Product ID contains invalid characters')
    .optional(),
  autoTrim: z.boolean().optional(),
  centerSubject: z.boolean().optional(),
  enhanceColors: z.boolean().optional(),
  targetWidth: z.number()
    .int('Width must be an integer')
    .min(16, 'Width must be at least 16px')
    .max(4096, 'Width cannot exceed 4096px')
    .optional(),
  targetHeight: z.number()
    .int('Height must be an integer')
    .min(16, 'Height must be at least 16px')
    .max(4096, 'Height cannot exceed 4096px')
    .optional(),
  generateDescription: z.boolean().optional(),
  productName: z.string()
    .max(200, 'Product name too long')
    .optional(),
  // Multilingual support
  languages: z.array(z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'Invalid language code format (e.g., en, is, en-US)'))
    .optional()
    .default(['en', 'is']),
  generatePriceSuggestion: z.boolean().optional().default(false),
  generateRatingSuggestion: z.boolean().optional().default(false),
}).refine(data => data.imageUrl || data.imageBase64, {
  message: "Either imageUrl or imageBase64 must be provided",
  path: ["imageUrl"],
}).refine(data => !(data.imageUrl && data.imageBase64), {
  message: "Cannot provide both imageUrl and imageBase64",
  path: ["imageUrl"],
}).refine(data => {
  // If dimensions are provided, both must be present
  const hasWidth = data.targetWidth !== undefined;
  const hasHeight = data.targetHeight !== undefined;
  return (hasWidth && hasHeight) || (!hasWidth && !hasHeight);
}, {
  message: "Both targetWidth and targetHeight must be provided together",
  path: ["targetWidth"],
});

// Language code type for dynamic language support
export type LanguageCode = string;

// Product condition enum
export type ProductCondition = 'new_with_tags' | 'like_new' | 'very_good' | 'good' | 'fair';

// Price suggestion data
export type PriceSuggestion = {
  suggestedPrice: number;
  currency: string;
  confidence: number; // 0-1 score
  priceRange: {
    min: number;
    max: number;
  };
  factors: {
    condition: ProductCondition;
    brand?: string;
    category?: string;
    marketDemand?: 'low' | 'medium' | 'high';
    seasonality?: string;
    rarity?: 'common' | 'uncommon' | 'rare' | 'vintage';
  };
};

// Rating suggestion data
export type RatingSuggestion = {
  overallRating: number; // 1-5 stars
  confidence: number; // 0-1 score
  breakdown: {
    quality: number; // 1-5
    condition: number; // 1-5
    value: number; // 1-5
    authenticity: number; // 1-5
    description: string;
  };
  factors: {
    materialQuality: 'poor' | 'fair' | 'good' | 'excellent';
    craftsmanship: 'poor' | 'fair' | 'good' | 'excellent';
    authenticity: 'questionable' | 'likely' | 'confirmed';
    marketValue: 'undervalued' | 'fair' | 'overpriced';
  };
};

// Enhanced product description
export type ProductDescription = {
  short: string;
  long: string;
  keywords: string[];
  category?: string;
  colors?: string[];
  condition?: ProductCondition;
  stylingTip?: string;
  priceSuggestion?: PriceSuggestion;
  ratingSuggestion?: RatingSuggestion;
};

// Multilingual product descriptions (replaces BilingualProductDescription)
export type MultilingualProductDescription = {
  [languageCode: LanguageCode]: ProductDescription;
};

// Backwards compatibility alias
export type BilingualProductDescription = MultilingualProductDescription;

export type ProcessResult = {
  success: boolean;
  jobId?: string;
  outputUrl?: string;
  error?: string;
  processingTimeMs?: number;
  metadata?: {
    width: number;
    height: number;
    originalSize: number;
    processedSize: number;
  };
  productDescription?: ProductDescription;
  multilingualDescription?: MultilingualProductDescription;
  bilingualDescription?: BilingualProductDescription; // Backwards compatibility
};

export const createProcessResult = (
  success: boolean,
  jobId?: string,
  outputUrl?: string,
  error?: string,
  processingTimeMs?: number,
  metadata?: { width: number; height: number; originalSize: number; processedSize: number },
  productDescription?: ProductDescription,
  multilingualDescription?: MultilingualProductDescription,
  bilingualDescription?: BilingualProductDescription, // Backwards compatibility
): ProcessResult => ({
  success,
  jobId,
  outputUrl,
  error,
  processingTimeMs,
  metadata,
  productDescription,
  multilingualDescription,
  bilingualDescription,
});

// Status endpoint validation
export const JobStatusParamsSchema = z.object({
  jobId: z.string()
    .uuid('Invalid job ID format - must be a valid UUID')
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Job ID must be a valid UUID'),
});

// Health check response schema
export const HealthResponseSchema = z.object({
  status: z.enum(['healthy', 'degraded', 'unhealthy']),
  service: z.string(),
  version: z.string(),
  timestamp: z.string().datetime(),
  uptime: z.number().int().positive(),
  checks: z.array(z.object({
    name: z.string(),
    status: z.enum(['pass', 'fail']),
    message: z.string().optional(),
  })),
});

// Job status response schema
export const JobStatusResponseSchema = z.object({
  jobId: z.string().uuid(),
  status: z.enum(['pending', 'processing', 'completed', 'failed']),
  progress: z.number().min(0).max(100).optional(),
  result: z.object({
    success: z.boolean(),
    outputUrl: z.string().url().optional(),
    error: z.string().optional(),
    processingTimeMs: z.number().int().positive().optional(),
    metadata: z.object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      originalSize: z.number().int().positive(),
      processedSize: z.number().int().positive(),
    }).optional(),
  }).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});

// Error response schema
export const ErrorResponseSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
  details: z.any().optional(),
});

// Success response schema for process endpoint
export const ProcessSuccessResponseSchema = z.object({
  success: z.literal(true),
  jobId: z.string().uuid(),
  outputUrl: z.string(),
  processingTimeMs: z.number().int().positive(),
  metadata: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    originalSize: z.number().int().positive(),
    processedSize: z.number().int().positive(),
  }),
  productDescription: z.any().optional(),
  multilingualDescription: z.record(z.object({
    short: z.string(),
    long: z.string(),
    keywords: z.array(z.string()),
    category: z.string().optional(),
    colors: z.array(z.string()).optional(),
    condition: z.enum(['new_with_tags', 'like_new', 'very_good', 'good', 'fair']).optional(),
    priceSuggestion: z.object({
      suggestedPrice: z.number(),
      currency: z.string(),
      confidence: z.number().min(0).max(1),
      priceRange: z.object({
        min: z.number(),
        max: z.number(),
      }),
      factors: z.record(z.any()),
    }).optional(),
    ratingSuggestion: z.object({
      overallRating: z.number().min(1).max(5),
      confidence: z.number().min(0).max(1),
      breakdown: z.object({
        quality: z.number().min(1).max(5),
        condition: z.number().min(1).max(5),
        value: z.number().min(1).max(5),
        authenticity: z.number().min(1).max(5),
        description: z.string(),
      }),
      factors: z.record(z.any()),
    }).optional(),
  })).optional(),
  bilingualDescription: z.record(z.any()).optional(), // Backwards compatibility
});

/**
 * Group Images Request Schema - Phase 1: Upload & Group
 * Accepts multiple images, generates thumbnails, and groups by similarity
 */
export const GroupImagesRequestSchema = z.object({
  images: z.array(z.object({
    imageId: z.string()
      .regex(/^img_[a-f0-9-]+$/, 'Invalid image ID format')
      .optional(), // Optional - backend generates if not provided
    imageBase64: z.string()
      .refine((val) => val.length <= MAX_BASE64_SIZE, 'Base64 image too large (max 10MB)')
      .refine(isValidBase64, 'Invalid base64 format')
      .refine(isValidImageBase64, 'Invalid image format - must be PNG, JPEG, WebP, or HEIC'),
    filename: z.string()
      .max(255, 'Filename too long')
      .optional(),
    metadata: z.object({
      uploadedAt: z.string().optional(),
      originalSize: z.number().optional(),
    }).optional(),
  }))
  .min(1, 'At least one image is required')
  .max(100, 'Maximum 100 images per batch'),
  thumbnailSize: z.object({
    width: z.number().int().min(64).max(512).default(256),
    height: z.number().int().min(64).max(512).default(256),
  }).optional(),
  similarityThreshold: z.number()
    .min(0.7, 'Threshold must be between 0.7 and 1.0')
    .max(1.0, 'Threshold must be between 0.7 and 1.0')
    .optional()
    .default(0.92), // SAME_PRODUCT threshold from product-identity-service
  includeExistingEmbeddings: z.boolean().optional().default(true),
});

export type GroupImagesRequest = z.infer<typeof GroupImagesRequestSchema>;

/**
 * Process Groups Request Schema - Phase 3: Process Approved Groups
 * Processes full-quality images for approved product groups
 */
export const ProcessGroupsRequestSchema = z.object({
  groups: z.array(z.object({
    groupId: z.string()
      .regex(/^pg_[a-f0-9-]+$/, 'Invalid group ID format'),
    imageIds: z.array(z.string()).min(1).max(5),
    productName: z.string().max(200).optional(),
  }))
  .min(1, 'At least one group is required')
  .max(50, 'Maximum 50 groups per batch'),
  originalImages: z.record(z.string(), z.string()) // imageId -> base64
    .refine((images) => Object.keys(images).length > 0, 'At least one original image required'),
  processingOptions: z.object({
    outputFormat: z.enum(['png', 'jpeg', 'webp']).default('png'),
    quality: z.number().int().min(1).max(100).optional(),
    autoTrim: z.boolean().optional(),
    centerSubject: z.boolean().optional(),
    enhanceColors: z.boolean().optional(),
    generateDescription: z.boolean().default(true),
    languages: z.array(z.string()).default(['en', 'is']),
    generatePriceSuggestion: z.boolean().default(false),
    generateRatingSuggestion: z.boolean().default(false),
  }).optional(),
});

export type ProcessGroupsRequest = z.infer<typeof ProcessGroupsRequestSchema>;

// Batch processing types
export const BatchRequestSchema = z.object({
  images: z.array(z.object({
    url: z.string().url().optional(),
    base64: z.string().optional(),
    productId: z.string().optional(),
  })).min(1, 'At least one image is required'),
  outputFormat: z.enum(['png', 'jpeg', 'webp']).default('png'),
  quality: z.number().int().min(1).max(100).default(90),
  tenant: z.string().min(1, 'Tenant is required'),
  concurrency: z.number().int().min(1).max(10).default(3),
});

export type BatchTask = z.infer<typeof BatchRequestSchema>;

export interface BatchResult {
  batchId: string;
  status: 'processing' | 'completed' | 'failed' | 'partial';
  totalImages: number;
  processedImages: number;
  successfulImages: number;
  failedImages: number;
  results: ProcessResult[];
  startTime: string;
  endTime?: string;
  processingTimeMs?: number;
  error?: string;
}
