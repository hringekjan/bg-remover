/**
 * POST /api/process - Single Image Background Removal
 *
 * Processes a single image to remove its background using
 * AWS Bedrock Claude Vision for intelligent subject detection
 * and Sharp for image manipulation.
 *
 * Credit Validation:
 * - Requires valid userId for credit billing
 * - Returns 402 Payment Required if insufficient credits
 * - Debits 1 credit per image processed
 * - Refunds on processing failure
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID, timingSafeEqual } from 'crypto';
import { ProcessRequestSchema, type ProcessResult, type ProductDescription, type BilingualProductDescription } from '@/lib/types';
import { resolveTenantFromRequest, loadTenantConfig } from '@/lib/tenant/resolver';
import {
  processImageFromUrl,
  processImageFromBase64,
  createProcessResult,
} from '@/lib/bedrock/image-processor';
import { uploadProcessedImage, generateOutputKey } from '@/lib/s3/client';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { validateAndDebitCredits, refundCredits } from '@/src/lib/credits/client';
import { loadAdminApiKeys } from '@carousellabs/backend-kit';
import { jwtVerify, createRemoteJWKSet } from 'jose';
import { errors as joseErrors } from 'jose';

/**
 * Load admin API keys from SSM Parameter Store (SecureString)
 * Uses backend-kit's internal 5-minute TTL cache for optimal security and performance.
 * No local caching needed - secrets-loader handles this internally.
 *
 * @returns Array of valid admin API keys
 */
async function getAdminApiKeys(): Promise<string[]> {
  const stage = process.env.STAGE || 'dev';
  const tenant = process.env.TENANT || 'carousel-labs';

  // secrets-loader handles caching internally with 5-min TTL
  // No need for duplicate local cache
  return await loadAdminApiKeys(stage, tenant);
}

/**
 * Timing-safe string comparison to prevent timing attacks on API key validation.
 * Always compares in constant time regardless of where strings differ.
 */
function timingSafeCompare(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }

  const aBuffer = Buffer.from(a, 'utf8');
  const bBuffer = Buffer.from(b, 'utf8');

  // If lengths differ, still perform comparison to prevent timing leak
  if (aBuffer.length !== bBuffer.length) {
    const maxLen = Math.max(aBuffer.length, bBuffer.length);
    const paddedA = Buffer.alloc(maxLen, 0);
    const paddedB = Buffer.alloc(maxLen, 0);
    aBuffer.copy(paddedA);
    bBuffer.copy(paddedB);
    timingSafeEqual(paddedA, paddedB);
    return false;
  }

  return timingSafeEqual(aBuffer, bBuffer);
}

/**
 * Check if provided API key matches any admin key using timing-safe comparison.
 * Keys are loaded from SSM Parameter Store (SecureString with KMS encryption)
 *
 * @param apiKey - API key to validate
 * @returns Promise<boolean> - True if valid admin key
 */
async function isValidAdminApiKey(apiKey: string): Promise<boolean> {
  const adminKeys = await getAdminApiKeys();

  // Perform timing-safe comparison against all admin keys
  // This ensures constant time regardless of which key (if any) matches
  let isValid = false;
  for (const adminKey of adminKeys) {
    if (timingSafeCompare(apiKey, adminKey)) {
      isValid = true;
      // Continue loop to maintain constant time
    }
  }
  return isValid;
}

/**
 * JWT validation result
 */
interface JWTValidationResult {
  valid: boolean;
  userId?: string;
  tenantId?: string;
  email?: string;
  groups?: string[];
  error?: string;
}

/**
 * Cache for JWKS remote key sets by issuer
 * Using createRemoteJWKSet from jose which handles caching internally
 */
const jwksSetCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/**
 * Get or create a JWKS remote key set for signature verification
 */
async function getJWKSRemoteKeySet(issuer: string) {
  if (!jwksSetCache.has(issuer)) {
    try {
      const jwksUrl = `${issuer}/.well-known/jwks.json`;
      const jwksSet = createRemoteJWKSet(new URL(jwksUrl), {
        timeoutDuration: 5000, // 5 second timeout for JWKS fetch
      });
      jwksSetCache.set(issuer, jwksSet);
    } catch (error) {
      console.error(`Failed to create JWKS key set for issuer ${issuer}:`, error);
      throw error;
    }
  }
  return jwksSetCache.get(issuer)!;
}

/**
 * Validate JWT token with RS256 signature verification
 *
 * SECURITY: Implements complete JWT validation including:
 * - RS256 signature verification using Cognito's JWKS
 * - Issuer validation (must be Cognito)
 * - Algorithm verification (must be RS256)
 * - Expiration and issued-at claims validation
 * - Required claims validation (sub)
 *
 * Environment variables required:
 * - JWKS_URL: Cognito JWKS endpoint (e.g., https://cognito-idp.{region}.amazonaws.com/{poolId}/.well-known/jwks.json)
 * - JWT_ISSUER: Cognito issuer URL (e.g., https://cognito-idp.{region}.amazonaws.com/{poolId})
 *
 * @param token - JWT token to validate
 * @returns Validation result with userId or error
 */
async function validateJWT(token: string): Promise<JWTValidationResult> {
  if (!token || typeof token !== 'string') {
    return { valid: false, error: 'Token is not a non-empty string' };
  }

  try {
    // Step 1: Quick structural validation
    const parts = token.split('.');
    if (parts.length !== 3) {
      return { valid: false, error: 'Invalid token format (expected 3 parts)' };
    }

    // Step 2: Decode header and payload (unverified) to get issuer
    let header: { kid?: string; alg?: string; [key: string]: unknown };
    let payload: {
      sub?: string;
      email?: string;
      'cognito:groups'?: string[];
      'custom:tenant_id'?: string;
      exp?: number;
      iat?: number;
      iss?: string;
    };

    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
      payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    } catch (error) {
      return { valid: false, error: 'Invalid base64url encoding' };
    }

    // Step 3: Validate header
    if (!header.kid) {
      return { valid: false, error: 'Missing key ID (kid) in header' };
    }

    if (header.alg !== 'RS256') {
      return { valid: false, error: `Invalid algorithm "${header.alg}" (must be RS256)` };
    }

    // Step 4: Validate issuer format (must be Cognito)
    if (!payload.iss) {
      return { valid: false, error: 'Missing issuer (iss) claim' };
    }

    if (!payload.iss.includes('cognito-idp')) {
      return { valid: false, error: `Invalid issuer "${payload.iss}" (must be Cognito)` };
    }

    // Step 5: Verify RS256 signature using jose with JWKS
    try {
      const jwksSet = await getJWKSRemoteKeySet(payload.iss);

      // jwtVerify validates signature, expiration, issued-at, and algorithm
      const verified = await jwtVerify(token, jwksSet, {
        issuer: payload.iss,
        algorithms: ['RS256'],
      });

      const verifiedPayload = verified.payload as typeof payload;

      // Extract user data
      const userId = verifiedPayload.sub;
      if (!userId) {
        return { valid: false, error: 'Missing sub claim in verified token' };
      }

      const tenantId = verifiedPayload['custom:tenant_id'] || process.env.TENANT || 'carousel-labs';
      const groups = verifiedPayload['cognito:groups'] || [];

      return {
        valid: true,
        userId,
        tenantId,
        email: verifiedPayload.email,
        groups,
      };
    } catch (verificationError) {
      // Handle specific JWT verification errors
      if (verificationError instanceof joseErrors.JWTClaimValidationFailed) {
        return {
          valid: false,
          error: `JWT claim validation failed: ${verificationError.claim} - ${verificationError.message}`,
        };
      }
      if (verificationError instanceof joseErrors.JWTExpired) {
        return { valid: false, error: `JWT expired: ${verificationError.message}` };
      }
      return {
        valid: false,
        error: verificationError instanceof Error ? verificationError.message : 'JWT verification failed',
      };
    }
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Unknown validation error',
    };
  }
}

/**
 * Extract user ID from request using hierarchy:
 * 1. X-User-Id header (for service-to-service calls with validated JWT)
 * 2. Authorization header (JWT with signature verification)
 *
 * SECURITY: JWT tokens are now validated with signature verification.
 * The bodyUserId parameter has been REMOVED to prevent security bypass.
 */
async function extractUserId(request: NextRequest): Promise<{ userId: string | null; error?: string }> {
  // Priority 1: X-User-Id header (from trusted service-to-service calls)
  const headerUserId = request.headers.get('x-user-id')?.trim();
  if (headerUserId) {
    return { userId: headerUserId };
  }

  // Priority 2: Validate Authorization JWT with signature verification
  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const validation = await validateJWT(token);

    if (!validation.valid) {
      console.warn('JWT validation failed:', validation.error);
      return { userId: null, error: validation.error };
    }

    return { userId: validation.userId || null };
  }

  return { userId: null, error: 'No authentication provided' };
}

/**
 * Check if request should bypass credit validation
 * Uses timing-safe comparison for API key validation to prevent timing attacks.
 * API keys loaded from SSM Parameter Store (SecureString with KMS encryption)
 */
async function shouldBypassCreditValidation(request: NextRequest, skipFlag?: boolean): Promise<boolean> {
  // Check for admin API key using timing-safe comparison
  const apiKey = request.headers.get('x-api-key');
  if (apiKey && await isValidAdminApiKey(apiKey)) {
    return true;
  }

  // Check for explicit skip flag (must be combined with admin key or internal call)
  if (skipFlag && apiKey && await isValidAdminApiKey(apiKey)) {
    return true;
  }

  // Dev environment can skip for testing (with explicit flag)
  if (process.env.NODE_ENV === 'development' && skipFlag) {
    console.warn('Credit validation bypassed in development mode');
    return true;
  }

  return false;
}

export const runtime = 'nodejs';
export const maxDuration = 60; // 60 seconds timeout

// Extended ProcessResult with credit information
interface ProcessResultWithCredits extends ProcessResult {
  creditsUsed?: number;
  creditsRemaining?: number;
  transactionId?: string;
}

export async function POST(request: NextRequest): Promise<NextResponse<ProcessResultWithCredits>> {
  const startTime = Date.now();
  const jobId = randomUUID();
  let creditTransactionId: string | undefined;
  let creditsDebited = false;

  try {
    // Resolve tenant from request (header, domain, or default)
    const stage = process.env.STAGE || 'dev';
    const tenant = await resolveTenantFromRequest(request, stage);

    // Parse and validate request body
    const body = await request.json();
    const validatedRequest = ProcessRequestSchema.parse(body);

    const {
      imageUrl,
      imageBase64,
      outputFormat,
      quality,
      productId,
      autoTrim,
      centerSubject,
      enhanceColors,
      targetWidth,
      targetHeight,
      generateDescription,
      productName,
      userId: bodyUserId,
      skipCreditValidation,
    } = validatedRequest;

    // Extract and validate user ID for credit billing
    const userIdResult = await extractUserId(request);
    const userId = userIdResult.userId;
    const bypassCredits = await shouldBypassCreditValidation(request, skipCreditValidation);

    console.log('Processing image request', {
      jobId,
      tenant,
      productId,
      hasUrl: !!imageUrl,
      hasBase64: !!imageBase64,
      outputFormat,
      userId: userId ? `${userId.substring(0, 8)}...` : 'anonymous',
      bypassCredits,
      authError: userIdResult.error,
    });

    // Credit validation and debit (unless bypassed)
    let creditsUsed = 0;
    let creditsRemaining: number | undefined;

    if (!bypassCredits) {
      if (!userId) {
        console.warn('No userId provided for credit validation', {
          jobId,
          tenant,
          authError: userIdResult.error,
        });
        return NextResponse.json(
          {
            success: false,
            jobId,
            error: userIdResult.error || 'User identification required for credit billing. Provide X-User-Id header or valid Authorization token.',
            processingTimeMs: Date.now() - startTime,
          },
          { status: 401 }
        );
      }

      // Validate and debit credits before processing
      const creditResult = await validateAndDebitCredits(tenant, userId, 1, jobId, productId);

      if (!creditResult.success) {
        console.warn('Credit validation failed', {
          jobId,
          tenant,
          userId: userId.substring(0, 8) + '...',
          error: creditResult.error,
          errorCode: creditResult.errorCode,
        });

        return NextResponse.json(
          {
            success: false,
            jobId,
            error: creditResult.error || 'Insufficient credits',
            processingTimeMs: Date.now() - startTime,
          },
          { status: creditResult.httpStatus || 402 }
        );
      }

      creditsDebited = true;
      creditTransactionId = creditResult.transactionId;
      creditsUsed = creditResult.creditsUsed || 1;
      creditsRemaining = creditResult.newBalance;

      console.log('Credits debited successfully', {
        jobId,
        transactionId: creditTransactionId,
        creditsUsed,
        creditsRemaining,
      });
    }

    // Load tenant-specific configuration
    const config = await loadTenantConfig(tenant, stage);

    // Process the image
    let result: {
      outputBuffer: Buffer;
      metadata: {
        width: number;
        height: number;
        originalSize: number;
        processedSize: number;
      };
      productDescription?: ProductDescription;
      bilingualDescription?: BilingualProductDescription;
    };

    const processingOptions = {
      format: outputFormat,
      quality,
      autoTrim,
      centerSubject,
      enhanceColors,
      targetSize: targetWidth && targetHeight ? { width: targetWidth, height: targetHeight } : undefined,
      generateDescription,
      productName,
    };

    if (imageUrl) {
      result = await processImageFromUrl(imageUrl, processingOptions);
    } else if (imageBase64) {
      result = await processImageFromBase64(imageBase64, 'image/png', processingOptions);
    } else {
      return NextResponse.json(
        createProcessResult(false, undefined, undefined, 'No image provided', Date.now() - startTime),
        { status: 400 }
      );
    }

    // For dev: Return base64 data URL instead of uploading to S3
    // In production, this would upload to S3 and return a presigned URL
    const contentType = outputFormat === 'png' ? 'image/png' :
                       outputFormat === 'webp' ? 'image/webp' : 'image/jpeg';

    const base64Image = result.outputBuffer.toString('base64');
    const outputUrl = `data:${contentType};base64,${base64Image}`;

    const processingTimeMs = Date.now() - startTime;

    console.log('Image processed successfully', {
      jobId,
      processingTimeMs,
      outputSize: base64Image.length,
      originalSize: result.metadata.originalSize,
      processedSize: result.metadata.processedSize,
    });

    // Emit CarouselImageProcessed event
    try {
      const eventBridge = new EventBridgeClient({ region: 'eu-west-1' });
      const eventDetail = {
        file_hash: jobId,
        original_filename: imageUrl ? imageUrl.split('/').pop() || 'input.png' : 'input.png',
        output_filename: 'output.png',
        output_path: '/processed',
        output_key: `processed/${jobId}.png`,
        model_name: 'bedrock-claude-vision',
        processing_time_ms: processingTimeMs,
        timestamp: new Date().toISOString(),
        tenant_id: tenant,
        metadata: result.metadata
      };
      const event = {
        Source: 'carousel.bg-remover',
        DetailType: 'CarouselImageProcessed',
        Detail: JSON.stringify(eventDetail)
      };
      await eventBridge.send(new PutEventsCommand({ Entries: [event] }));
      console.log('CarouselImageProcessed event emitted', { jobId });
    } catch (error) {
      console.error('Failed to emit CarouselImageProcessed event', { jobId, error });
    }

    // 🔧 FIX: Don't return full bilingualDescription (causes 413 Content Too Large)
    // Return only short summaries to keep response under 10MB
    const descriptionSummary = result.bilingualDescription ? {
      en: {
        short: result.bilingualDescription.en?.short || result.productDescription?.short || '',
        category: result.bilingualDescription.en?.category || result.productDescription?.category,
        colors: result.bilingualDescription.en?.colors || result.productDescription?.colors
      },
      is: {
        short: result.bilingualDescription.is?.short || '',
        category: result.bilingualDescription.is?.category,
        colors: result.bilingualDescription.is?.colors
      }
    } : undefined;

    return NextResponse.json({
      success: true,
      jobId,
      outputUrl,
      processingTimeMs,
      metadata: result.metadata,
      productDescription: result.productDescription,
      descriptionSummary,  // Only short descriptions (not full long text)
      // Note: Full descriptions available via GET /status/{jobId} endpoint
      // Credit information
      creditsUsed: creditsUsed > 0 ? creditsUsed : undefined,
      creditsRemaining,
      transactionId: creditTransactionId,
    });

  } catch (error) {
    const processingTimeMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    console.error('Image processing failed', {
      jobId,
      error: errorMessage,
      processingTimeMs,
      creditsDebited,
    });

    // Attempt to refund credits if processing failed after debit
    if (creditsDebited && creditTransactionId) {
      const userIdResult = await extractUserId(request);
      const userId = userIdResult.userId;
      const tenant = request.headers.get('x-tenant-id') || 'carousel-labs';

      if (userId) {
        try {
          const refundResult = await refundCredits(tenant, userId, 1, jobId, creditTransactionId);
          if (refundResult.success) {
            console.log('Credits refunded after processing failure', {
              jobId,
              originalTransactionId: creditTransactionId,
              refundTransactionId: refundResult.transactionId,
            });
          } else {
            console.error('Failed to refund credits after processing failure', {
              jobId,
              originalTransactionId: creditTransactionId,
              error: refundResult.error,
            });
          }
        } catch (refundError) {
          console.error('Exception during credit refund', {
            jobId,
            originalTransactionId: creditTransactionId,
            error: refundError instanceof Error ? refundError.message : String(refundError),
          });
        }
      }
    }

    // Handle validation errors
    if (error instanceof Error && error.name === 'ZodError') {
      return NextResponse.json(
        createProcessResult(false, undefined, undefined, `Validation error: ${errorMessage}`, processingTimeMs),
        { status: 400 }
      );
    }

    return NextResponse.json(
      createProcessResult(false, undefined, undefined, errorMessage, processingTimeMs),
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
