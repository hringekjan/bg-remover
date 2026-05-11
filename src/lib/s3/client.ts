/**
 * S3 client for bg-remover image storage.
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const s3Client = new S3Client({});

const OUTPUT_BUCKET_DEV = 'carousel-bg-remover-output-dev';
const OUTPUT_BUCKET_PROD = 'carousel-bg-remover-output-prod';

export async function getOutputBucket(_tenant: string, stage?: string): Promise<string> {
  return stage === 'prod' ? OUTPUT_BUCKET_PROD : OUTPUT_BUCKET_DEV;
}

export function generateOutputKey(tenant: string, jobId: string, format: string): string {
  const ext = format === 'webp' ? 'webp' : format === 'jpeg' || format === 'jpg' ? 'jpg' : 'png';
  return `${tenant}/products/${jobId}/${Date.now()}.${ext}`;
}

export async function uploadProcessedImage(
  bucket: string,
  key: string,
  body: Buffer,
  contentType: string,
  metadata: Record<string, string>
): Promise<string> {
  await s3Client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    Metadata: metadata,
    ServerSideEncryption: 'AES256',
  }));
  return `https://${bucket}.s3.amazonaws.com/${key}`;
}
