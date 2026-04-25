# CloudFront Origin Path Mappings

## Overview
This document outlines the CloudFront origin path mappings for the bg-remover service to ensure proper routing of static assets and API requests.

## S3 Bucket Structure
All assets should be stored in the following S3 bucket structure:
```
<s3-bucket-name>```/
├── images/
│   ├── processed/
│   └── originals/
├── api/
│   └── v1/
└── static/
    ├── css/
    ├── js/
    └── assets/
```

## CloudFront Origin Paths
- `/process-image` → S3 bucket root (for image processing endpoint)
- `/cost-breakdown` → S3 bucket root (for cost breakdown endpoint)
- `/static/*` → S3 bucket `static/` prefix
- `/api/v1/*` → S3 bucket `api/v1/` prefix

## Path Normalization Rules
1. All paths must begin with a forward slash
2. S3 keys should not begin with a forward slash
3. Parameterized paths should be normalized to consistent formats
4. Cache behavior priorities are set to avoid overlap

## Expected Behavior
- All static assets should load without origin path mismatch errors
- API endpoints properly route to respective handlers
- S3 object keys follow consistent naming conventions