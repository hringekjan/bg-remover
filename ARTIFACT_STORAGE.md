# Artifact Storage Implementation

This document describes the implementation of central artifact storage using S3 with versioning, encryption, and lifecycle policies.

## Overview

The artifact storage system provides a centralized location for storing processed artifacts with:
- Versioning enabled for all objects
- Server-side encryption (AES-256)
- Lifecycle policies (90-day transition to Glacier)
- IAM role-based access control

## Bucket Configuration

### Naming Convention
```
lcp-artifacts-<tenant-id>```
```

### Features
1. **Versioning**: Enabled to preserve multiple versions of artifacts
2. **Encryption**: AES-256 encryption for all stored objects
3. **Lifecycle Policies**: 
   - Objects older than 90 days are transitioned to Glacier storage
   - Non-current versions also transition to Glacier after 90 days
4. **Access Control**: Bucket policy allowing module-level access

## Implementation Details

### Files Created
- `lib/s3/artifact-storage.ts` - Main implementation for artifact storage operations
- `lib/s3/client.ts` - Extended S3 client with artifact functions
- `scripts/create-artifact-bucket.ts` - Utility script for bucket creation

### Functions Provided
- `createArtifactStorageBucket(bucketName, tenantId)` - Creates and configures the bucket
- `uploadArtifact(bucket, key, body)` - Uploads artifacts to S3
- `downloadArtifact(bucket, key)` - Downloads artifacts from S3

## Usage Examples

### Uploading Artifacts
```typescript
const artifactKey = `artifacts/${Date.now()}-artifact.json`;
const artifactData = Buffer.from('{"message": "sample artifact"}');
await uploadArtifact(bucket, artifactKey, artifactData);
```

### Creating Bucket
```bash
npm run create-artifact-bucket -- <tenant-id>```
```

## IAM Roles

IAM roles should be configured for each module that needs to access artifacts:
- **Read Access**: `s3:GetObject`
- **Write Access**: `s3:PutObject`, `s3:DeleteObject`
- **Module-specific policies**: Should restrict access to specific buckets and prefixes