import { test, expect, request } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

// Mock the S3 client for local testing, if needed.
// For actual E2E against AWS, it will use real credentials.
const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'eu-west-1',
});

const API_BASE_URL = process.env.BG_REMOVER_API_URL ?? 'http://localhost:3000';
const DEFAULT_TENANT = process.env.TENANT || 'carousel-labs';

test.describe('BG Remover End-to-End Workflow', () => {
  let apiRequest;

  test.beforeAll(async () => {
    apiRequest = await request.newContext({
      baseURL: API_BASE_URL,
      extraHTTPHeaders: {
        'x-tenant-id': DEFAULT_TENANT,
        ...(process.env.BG_REMOVER_AUTH_TOKEN && { 'Authorization': `Bearer ${process.env.BG_REMOVER_AUTH_TOKEN}` }),

      },
    });
  });

  test.afterAll(async () => {
    await apiRequest.dispose();
  });

  test('should complete the full background removal workflow', async () => {
    const testImagePath = path.resolve(__dirname, '../../test-data/test-image.png');
    const imageBuffer = fs.readFileSync(testImagePath);
    const imageFileName = `test-image-${Date.now()}.png`;

    let jobId: string;
    let uploadUrl: string;
    let s3Key: string;

    // 1. Get presigned upload URL
    console.log('Step 1: Requesting presigned upload URL...');
    const uploadUrlsResponse = await apiRequest.post('/bg-remover/upload-urls', {
      data: {
        imageCount: 1,
        tenantId: DEFAULT_TENANT,
      },
    });

    expect(uploadUrlsResponse.status()).toBe(200);
    const uploadUrlsJson = await uploadUrlsResponse.json();
    expect(uploadUrlsJson).toHaveProperty('jobId');
    expect(uploadUrlsJson).toHaveProperty('urls');
    expect(uploadUrlsJson.urls).toHaveLength(1);

    jobId = uploadUrlsJson.jobId;
    uploadUrl = uploadUrlsJson.urls[0].uploadUrl;
    s3Key = new URL(uploadUrl).pathname.substring(1); // Extract key from URL

    console.log(`Job ID: ${jobId}, S3 Key: ${s3Key}`);
    expect(jobId).toMatch(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/); // UUID format

    // 2. Upload image to S3 using the presigned URL
    console.log('Step 2: Uploading image to S3...');
    const s3UploadResponse = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'image/png',
      },
      body: imageBuffer,
    });
    expect(s3UploadResponse.status).toBe(200);
    console.log('Image uploaded to S3 successfully.');

    // 3. Trigger processing (S3 event should trigger this, but we can call a handler directly if needed)
    // For now, we assume S3 event is configured and will trigger uploadEventRouter -> uploadEventConsumer
    // and eventually groupImagesWorker and processWorker.

    // 4. Poll job status until completion
    console.log('Step 4: Polling job status...');
    let jobStatusResponseJson: any;
    let status = 'pending';
    const startTime = Date.now();
    const timeout = 60 * 1000; // 60 seconds timeout

    while (status !== 'completed' && status !== 'failed' && (Date.now() - startTime) < timeout) {
      const jobStatusResponse = await apiRequest.get(`/bg-remover/status/${jobId}`);
      expect(jobStatusResponse.status()).toBe(200);
      jobStatusResponseJson = await jobStatusResponse.json();
      status = jobStatusResponseJson.status;
      console.log(`Current job status: ${status} (progress: ${jobStatusResponseJson.progress || 0}%)`);
      if (status !== 'completed' && status !== 'failed') {
        await new Promise(resolve => setTimeout(resolve, 5000)); // Wait for 5 seconds
      }
    }

    expect(status).toBe('completed');
    expect(jobStatusResponseJson).toHaveProperty('result');
    expect(jobStatusResponseJson.result).toHaveProperty('success', true);
    expect(jobStatusResponseJson.result).toHaveProperty('outputUrl');
    expect(jobStatusResponseJson.result.outputUrl).toMatch(/^https:\/\/.+\.(png|jpeg|jpg|webp)$/i);
    console.log(`Job completed. Output URL: ${jobStatusResponseJson.result.outputUrl}`);

    // Optional: Verify the output image (e.g., download and check headers/size)
    const outputImageResponse = await fetch(jobStatusResponseJson.result.outputUrl);
    expect(outputImageResponse.status).toBe(200);
    const outputImageBuffer = await outputImageResponse.buffer();
    expect(outputImageBuffer.byteLength).toBeGreaterThan(1000); // Expect a reasonably sized image
    console.log(`Output image downloaded, size: ${outputImageBuffer.byteLength} bytes`);
  });
});
