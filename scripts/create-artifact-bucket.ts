#!/usr/bin/env node

/**
 * Script to create artifact storage bucket with required configurations
 * Usage: npm run create-artifact-bucket -- <tenant-id>
 */

import { createArtifactStorageBucket } from "../lib/s3/artifact-storage";

async function main() {
  const tenantId = process.argv[2];
  
  if (!tenantId) {
    console.error("Tenant ID is required");
    process.exit(1);
  }
  
  const bucketName = `lcp-artifacts-${tenantId}`;
  
  try {
    console.log(`Creating artifact storage bucket: ${bucketName}`);
    await createArtifactStorageBucket(bucketName, tenantId);
    console.log("Successfully created artifact storage bucket!");
  } catch (error) {
    console.error("Failed to create artifact storage bucket:", error);
    process.exit(1);
  }
}

main().catch(console.error);