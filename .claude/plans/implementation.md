# BG-Remover Service - Next.js/TypeScript Implementation Plan

## Overview

Rewrite the existing Python bg-remover service as a CarouselLabs native Next.js 15 + TypeScript service using AWS Bedrock (Claude 3.5 Sonnet) for AI-powered background removal.

## Architecture

```
                    ┌─────────────────────────────────────────────────────┐
                    │                   bg-remover Service                 │
                    ├─────────────────────────────────────────────────────┤
                    │                                                     │
S3 Source Images    │  ┌─────────────────────────────────────────────┐   │
     │              │  │        Next.js 15 API Routes                 │   │
     ▼              │  │                                              │   │
┌──────────┐        │  │  POST /api/process                          │   │
│ SmartGo  │───────▶│  │   - Receive image URL or base64             │   │
│ Products │        │  │   - Call AWS Bedrock (Claude 3.5 Sonnet)    │   │
│  Bucket  │        │  │   - Process background removal              │   │
└──────────┘        │  │   - Store result in S3                      │   │
                    │  │   - Return processed image URL              │   │
                    │  │                                              │   │
                    │  │  POST /api/batch                            │   │
                    │  │   - Process multiple images                  │   │
                    │  │   - Queue-based processing                   │   │
                    │  │                                              │   │
                    │  │  GET /api/status/{jobId}                    │   │
                    │  │   - Check processing status                  │   │
                    │  └─────────────────────────────────────────────┘   │
                    │                        │                            │
                    │                        ▼                            │
                    │  ┌─────────────────────────────────────────────┐   │
                    │  │              AWS Bedrock                     │   │
                    │  │       (Claude 3.5 Sonnet Vision)            │   │
                    │  │                                              │   │
                    │  │  - Analyze image for subject detection       │   │
                    │  │  - Generate segmentation mask                │   │
                    │  │  - Apply background removal                  │   │
                    │  └─────────────────────────────────────────────┘   │
                    │                        │                            │
                    │                        ▼                            │
                    │  ┌─────────────────────────────────────────────┐   │
                    │  │              S3 Output Bucket                │   │
                    │  │    (bg-remover-{stage}-{tenant}-output)     │   │
                    │  └─────────────────────────────────────────────┘   │
                    │                                                     │
                    └─────────────────────────────────────────────────────┘
```

## Integration with SmartGo → Shopify Pipeline

```
SmartGo API
    │
    ▼
smartgo-connector (delta-sync)
    │
    ├──► S3: smartgo-s3tables-{stage}-{tenant}/products/*.json
    │
    ├──► SQS: shopify-{stage}-products-queue.fifo
    │         (Protected Fields: images EXCLUDED on updates)
    │
    └──► bg-remover trigger (optional)
              │
              ▼
         bg-remover service
              │
              ├──► Process image with Bedrock
              │
              └──► Store in S3: bg-remover-{stage}-{tenant}-output/
                        │
                        ▼
                  Shopify Product Images
                  (via image_processor service or direct upload)
```

## Technology Stack

- **Runtime**: Next.js 15 (App Router)
- **Language**: TypeScript (strict mode)
- **AI Model**: AWS Bedrock - Claude 3.5 Sonnet (vision capabilities)
- **Image Processing**: Sharp (for image manipulation)
- **Storage**: AWS S3 (input/output buckets)
- **Deployment**: Serverless Framework 4.x or AWS Lambda via Next.js
- **Authentication**: SSM Parameter Store for credentials
- **Design System**: CarouselLabs design tokens (carousel-labs theme)

## SSM Parameter Structure

```
/tf/{stage}/{tenant}/services/bg-remover/config
/tf/{stage}/{tenant}/services/bg-remover/secrets
/tf/{stage}/{tenant}/services/bg-remover/deployment_outputs
```

## Project Structure

```
bg-remover/
├── .claude/
│   └── plans/
│       └── implementation.md
├── app/
│   ├── api/
│   │   ├── process/
│   │   │   └── route.ts          # Single image processing endpoint
│   │   ├── batch/
│   │   │   └── route.ts          # Batch processing endpoint
│   │   ├── status/
│   │   │   └── [jobId]/
│   │   │       └── route.ts      # Job status endpoint
│   │   └── health/
│   │       └── route.ts          # Health check endpoint
│   ├── layout.tsx
│   └── page.tsx                  # UI for manual uploads
├── lib/
│   ├── bedrock/
│   │   ├── client.ts             # Bedrock client wrapper
│   │   └── image-processor.ts    # Background removal logic
│   ├── s3/
│   │   ├── client.ts             # S3 client
│   │   └── operations.ts         # Upload/download operations
│   ├── config/
│   │   └── loader.ts             # SSM config loader
│   └── types/
│       └── index.ts              # TypeScript types
├── components/
│   ├── ImageUploader.tsx         # Drag-and-drop uploader
│   ├── ProcessingStatus.tsx      # Status display
│   └── ResultsGallery.tsx        # Processed images gallery
├── serverless.yml                # Serverless deployment config
├── package.json
├── tsconfig.json
└── next.config.js
```

## API Endpoints

### POST /api/process
Process a single image for background removal.

**Request:**
```json
{
  "imageUrl": "https://s3.eu-west-1.amazonaws.com/...",
  "outputFormat": "png",
  "quality": 95,
  "tenant": "carousel-labs"
}
```

**Response:**
```json
{
  "success": true,
  "jobId": "uuid",
  "outputUrl": "https://s3.eu-west-1.amazonaws.com/bg-remover-output/...",
  "processingTimeMs": 2340
}
```

### POST /api/batch
Process multiple images in batch.

**Request:**
```json
{
  "images": [
    { "imageUrl": "...", "productId": "123" },
    { "imageUrl": "...", "productId": "456" }
  ],
  "tenant": "carousel-labs",
  "callbackUrl": "https://api.carousellabs.co/webhooks/bg-remover"
}
```

### GET /api/status/{jobId}
Check processing status for async jobs.

## Implementation Phases

### Phase 1: Project Setup ✅ COMPLETED
- [x] Clone existing bg-remover repository
- [x] Initialize Next.js 15 project with TypeScript
- [x] Configure tsconfig with strict mode
- [x] Create basic project structure

### Phase 2: Core Processing ✅ COMPLETED
- [x] Implement Bedrock client wrapper (`lib/bedrock/client.ts`)
- [x] Create image processing logic with Claude Vision (`lib/bedrock/image-processor.ts`)
- [x] Implement S3 upload/download operations (`lib/s3/client.ts`)
- [x] Add SSM config loader (`lib/config/loader.ts`)

### Phase 3: API Routes ✅ COMPLETED
- [x] POST /api/process - single image processing
- [x] POST /api/batch - batch processing with concurrency control
- [x] GET /api/status/{jobId} - job status
- [x] GET /api/health - health check

### Phase 4: UI Components ✅ COMPLETED
- [x] Basic UI for manual image upload (`app/page.tsx`)
- [x] Processing status display
- [x] Results display with download link

### Phase 5: Deployment ✅ COMPLETED
- [x] Serverless.yml configuration with all endpoints
- [x] Lambda packaging configuration
- [x] S3 output bucket CloudFormation resource
- [x] CloudFormation outputs for all endpoints

### Phase 6: Integration (Pending)
- [ ] Connect to SmartGo product sync (event trigger)
- [ ] Publish processed images to Shopify (optional)
- [ ] Set up S3 event triggers (optional)

## Checklist

- [x] Initialize Next.js 15 project
- [x] Set up TypeScript strict mode
- [x] Create Bedrock client for Claude 3.5 Sonnet
- [x] Implement background removal with Vision API
- [x] Create S3 operations for input/output
- [x] Build API routes (process, batch, status, health)
- [x] Create basic UI for manual testing
- [x] Configure serverless.yml for Lambda deployment
- [ ] Set up SSM parameters (requires deployment)
- [ ] Test with SmartGo product images
- [ ] Integrate with shopify-connector (optional)

## Files Created

```
bg-remover/
├── package.json                  # Dependencies (Next.js 15, AWS SDK, Sharp, Zod)
├── tsconfig.json                 # TypeScript strict configuration
├── next.config.ts                # Next.js config with standalone output
├── serverless.yml                # Lambda deployment with 4 functions
├── lib/
│   ├── types/index.ts            # Zod schemas and TypeScript interfaces
│   ├── config/loader.ts          # SSM configuration loader
│   ├── bedrock/
│   │   ├── client.ts             # Bedrock Claude 3.5 Sonnet wrapper
│   │   └── image-processor.ts    # Background removal with Sharp
│   └── s3/
│       └── client.ts             # S3 upload/download/presigned URLs
└── app/
    ├── layout.tsx                # Root layout
    ├── page.tsx                  # Manual upload UI
    └── api/
        ├── process/route.ts      # Single image processing
        ├── batch/route.ts        # Batch processing with concurrency
        ├── status/[jobId]/route.ts # Job status endpoint
        └── health/route.ts       # Health check endpoint
```

## Deployment Instructions

1. Create SSM parameters:
   ```bash
   aws ssm put-parameter \
     --name "/tf/dev/carousel-labs/services/bg-remover/config" \
     --type "String" \
     --value '{"bedrock":{"modelId":"anthropic.claude-3-5-sonnet-20241022-v2:0","region":"us-east-1","maxTokens":4096},"s3":{"inputBucket":"smartgo-s3tables-dev-carousel-labs","outputBucket":"bg-remover-dev-carousel-labs-output","region":"eu-west-1"},"processing":{"maxImageSizeMb":10,"supportedFormats":["png","jpg","jpeg","webp"],"defaultQuality":95}}'
   ```

2. Build and deploy:
   ```bash
   npm run build
   TENANT=carousel-labs npx serverless deploy --stage dev --region eu-west-1
   ```

3. Test endpoints:
   - Health: `GET /bg-remover/health`
   - Process: `POST /bg-remover/process`
   - Batch: `POST /bg-remover/batch`
   - Status: `GET /bg-remover/status/{jobId}`
