import { randomUUID } from 'crypto';
import { BaseHandler } from './base-handler';
import { UploadUrlsRequestSchema, type UploadUrlsRequest } from '../lib/types';
import { validateRequest } from '../lib/validation';
import { resolveTenantFromRequest } from '../lib/tenant/resolver';
import { createTenantCorsHeaders } from '../lib/cors';
import { validateJWTFromEvent, getCognitoConfigForTenantAsync } from '../lib/auth/jwt-validator';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3Client = new S3Client({
  requestHandler: new NodeHttpHandler({
    connectionTimeout: 5000,
    requestTimeout: 10000,
  }),
  // Disable automatic checksums for presigned URLs to work with browser SDK
  requestChecksumCalculation: 'WHEN_REQUIRED',
});
const tempImagesBucket = process.env.TEMP_IMAGES_BUCKET;
const UPLOAD_URL_TTL_SECONDS = 900;

export class UploadUrlsHandler extends BaseHandler {
  protected success(data: any, statusCode: number = 200, headers: Record<string, string> = {}): any {
    return this.createJsonResponse(data, statusCode, headers);
  }

  protected badRequest(error: any, headers: Record<string, string> = {}): any {
    return this.createErrorResponse(error.message || 'Bad Request', 400, headers, error);
  }

  protected internalError(error: any, headers: Record<string, string> = {}): any {
    return this.createErrorResponse(error.message || 'Internal Server Error', 500, headers, error);
  }

  private sanitizeFilename(filename: string): string {
    return filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  }

  private resolveBucket(): string {
    if (!tempImagesBucket) {
      throw new Error('TEMP_IMAGES_BUCKET is not configured');
    }
    const allowedPattern = /^bg-remover-temp-images-(dev|prod)$/;
    if (!allowedPattern.test(tempImagesBucket)) {
      throw new Error(`Invalid TEMP_IMAGES_BUCKET: ${tempImagesBucket}`);
    }
    return tempImagesBucket;
  }

  async handle(event: any): Promise<any> {
    const httpMethod = event.requestContext?.http?.method || event.httpMethod;

    if (httpMethod === 'OPTIONS') {
      const corsHeaders = createTenantCorsHeaders(event, 'unknown') as any;
      return this.createJsonResponse('', 200, {
        ...corsHeaders,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      });
    }

    if (httpMethod !== 'POST') {
      const corsHeaders = createTenantCorsHeaders(event, 'unknown') as any;
      return this.createErrorResponse('Method Not Allowed', 405, corsHeaders);
    }

    let corsHeaders = createTenantCorsHeaders(event, 'unknown') as any;

    try {
      const stage = process.env.STAGE || 'dev';
      const tenant = await resolveTenantFromRequest(event, stage);
      corsHeaders = createTenantCorsHeaders(event, tenant) as any;

      // Validate authentication using same approach as process-groups-handler
      // Load tenant-specific Cognito config for JWT validation
      const cognitoConfig = await getCognitoConfigForTenantAsync(tenant, stage);
      const authResult = await validateJWTFromEvent(event, cognitoConfig, {
        required: true,
        expectedTenant: tenant,
        enforceTenantMatch: true,
      });
      if (!authResult.isValid || !authResult.userId) {
        return this.createErrorResponse(
          'Valid JWT token required',
          401,
          corsHeaders,
          { error: authResult.error }
        );
      }

      const body = JSON.parse(event.body || '{}');
      const validation = validateRequest(UploadUrlsRequestSchema, body, 'upload-urls');
      if (!validation.success) {
        return this.badRequest({
          error: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          errors: validation.error?.details,
        }, corsHeaders);
      }

      const request = validation.data as UploadUrlsRequest;
      const bucket = this.resolveBucket();
      const uploadId = randomUUID();

      const files = await Promise.all(request.files.map(async (file, index) => {
        const safeFilename = this.sanitizeFilename(file.filename);
        const key = `temp/${tenant}/uploads/${uploadId}/${index}_${safeFilename}`;
        const command = new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          ContentType: file.contentType,
          // ServerSideEncryption removed - bucket default encryption handles this
          // Including it causes signature mismatch when browser doesn't send the header
        });
        const uploadUrl = await getSignedUrl(s3Client, command, {
          expiresIn: UPLOAD_URL_TTL_SECONDS,
        });

        return {
          photoId: file.photoId,
          uploadUrl,
          s3Key: key,
          s3Bucket: bucket,
        };
      }));

      return this.success({
        files,
        expiresIn: UPLOAD_URL_TTL_SECONDS,
      }, 200, corsHeaders);
    } catch (error) {
      console.error('[UploadUrls] Request failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return this.internalError({
        error: 'UPLOAD_URLS_FAILED',
        message: error instanceof Error ? error.message : 'Unknown error occurred',
      }, corsHeaders);
    }
  }
}

export const uploadUrls = async (event: any) => {
  const handler = new UploadUrlsHandler();
  return handler.handle(event);
};
