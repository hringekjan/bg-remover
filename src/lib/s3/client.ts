/**
 * S3 Client for BG Remover Service
 * 
 * This module provides S3 upload functionality integrated with context scope monitoring.
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { ContextScope } from '@carousellabs/context-scope';

const s3Client = new S3Client({ 
  region: process.env.REGION || 'us-east-1' 
});

/**
 * Upload processed image to S3 with context scope integration
 * 
 * @param bucket - S3 bucket name
 * @param key - S3 object key
 * @param imageData - Image data buffer
 * @returns Promise resolving when upload is complete
 */
export const uploadProcessedImage = async (
  bucket: string, 
  key: string, 
  imageData: Buffer
): Promise<void> => {
  const scope = new ContextScope();
  
  try {
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: imageData,
      ContentType: 'image/jpeg'
    });

    await s3Client.send(command);
    
    // Track success in context scope
    scope.setMetric('imageUploadSuccess', 1);
  } catch (error) {
    // Track failure in context scope
    scope.setMetric('imageUploadError', 1);
    throw error;
  }
};

/**
 * Upload artifact to S3 with context scope integration
 * 
 * @param bucket - S3 bucket name
 * @param key - S3 object key
 * @param artifactData - Artifact data buffer
 * @returns Promise resolving when upload is complete
 */
export const uploadArtifact = async (
  bucket: string, 
  key: string, 
  artifactData: Buffer
): Promise<void> => {
  const scope = new ContextScope();
  
  try {
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: artifactData,
      ContentType: 'application/json'
    });

    await s3Client.send(command);
    
    // Track success in context scope
    scope.setMetric('artifactUploadSuccess', 1);
  } catch (error) {
    // Track failure in context scope
    scope.setMetric('artifactUploadError', 1);
    throw error;
  }
};