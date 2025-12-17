# Background Remover Service

A TypeScript microservice for automatically removing backgrounds from images using AWS Bedrock AI models.

## Purpose

This service processes images to remove backgrounds and generate bilingual product descriptions (English + Icelandic) for e-commerce/consignment store workflows.

## Features

- **AI-Powered Background Removal**: Uses Amazon Nova Canvas via AWS Bedrock
- **Bilingual Product Descriptions**: Generates descriptions in English and Icelandic
  - English: Generated using Mistral Pixtral Large vision model
  - Icelandic: Translated using OpenAI GPT-OSS Safeguard 20B via Bedrock
- **Image Enhancements**: Auto-trim, center subject, color enhancement using Sharp
- **Multiple Input Sources**: URL, base64, or file upload
- **Batch Processing**: Process multiple images concurrently

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     bg-remover Service                          │
├─────────────────────────────────────────────────────────────────┤
│  API Routes                                                     │
│  ├── /api/process     - Single image processing                │
│  ├── /api/batch       - Batch image processing                 │
│  ├── /api/status/:id  - Job status                             │
│  └── /api/health      - Health check                           │
├─────────────────────────────────────────────────────────────────┤
│  Bedrock Integration (lib/bedrock/)                            │
│  ├── client.ts        - Bedrock API client                     │
│  │   ├── removeBackgroundWithNovaCanvas()                      │
│  │   ├── generateProductDescription()  [Mistral Pixtral]       │
│  │   ├── translateToIcelandic()        [GPT-OSS Safeguard]     │
│  │   └── generateBilingualProductDescription()                 │
│  └── image-processor.ts - Processing pipeline                  │
├─────────────────────────────────────────────────────────────────┤
│  AWS Bedrock Models                                            │
│  ├── amazon.nova-canvas-v1:0         - Background removal      │
│  ├── us.mistral.pixtral-large-2502-v1:0 - Vision/description  │
│  └── openai.gpt-oss-safeguard-20b    - Icelandic translation  │
└─────────────────────────────────────────────────────────────────┘
```

## Quick Start

```bash
# Install dependencies
npm install

# Build the project
npm run build

# Run development server
npm run dev

# Run tests
npm test
```

## API Usage

### Process Single Image

```bash
curl -X POST http://localhost:3000/api/process \
  -H "Content-Type: application/json" \
  -d '{
    "imageUrl": "https://example.com/image.jpg",
    "generateDescription": true,
    "productName": "Blue Cotton Shirt"
  }'
```

### Response Format

```json
{
  "success": true,
  "jobId": "uuid",
  "outputUrl": "s3://bucket/processed/image.png",
  "processingTimeMs": 1234,
  "metadata": {
    "originalSize": 102400,
    "processedSize": 51200,
    "width": 1024,
    "height": 1024
  },
  "bilingualDescription": {
    "en": {
      "description": "A classic blue cotton button-up shirt with a relaxed fit.",
      "category": "Shirt",
      "color": "Blue",
      "features": ["Button-up", "Cotton", "Relaxed fit"],
      "condition": "Like New"
    },
    "is": {
      "description": "Klassísk blá bómullarskyrta með hnöppum og rúmgóðu sniði.",
      "category": "Skyrta",
      "color": "Blár",
      "features": ["Hnappaskyrta", "Bómull", "Rúmgott snið"],
      "condition": "Eins og nýtt"
    }
  }
}
```

## Configuration

### Environment Variables

```bash
# AWS Region for Bedrock
AWS_REGION=us-east-1

# S3 Configuration
S3_INPUT_BUCKET=bg-remover-input
S3_OUTPUT_BUCKET=bg-remover-output

# Processing defaults
MAX_IMAGE_SIZE_MB=10
DEFAULT_OUTPUT_FORMAT=png
DEFAULT_QUALITY=95
```

### SSM Parameter Paths

```
/tf/{stage}/{tenant}/services/bg-remover/config
/tf/{stage}/{tenant}/services/bg-remover/secrets
```

## Models Used

| Model | Purpose | Model ID |
|-------|---------|----------|
| Amazon Nova Canvas | Background removal | `amazon.nova-canvas-v1:0` |
| Mistral Pixtral Large | Vision analysis & English descriptions | `us.mistral.pixtral-large-2502-v1:0` |
| OpenAI GPT-OSS Safeguard 20B | Icelandic translation | `openai.gpt-oss-safeguard-20b` |
| Claude 3.5 Sonnet | Image analysis (optional) | `anthropic.claude-3-5-sonnet-20241022-v2:0` |

## Processing Options

```typescript
interface ImageProcessingOptions {
  format: 'png' | 'webp' | 'jpeg';
  quality: number;                // 1-100
  autoTrim?: boolean;             // Remove whitespace
  centerSubject?: boolean;        // Center and crop
  enhanceColors?: boolean;        // Boost saturation
  targetSize?: {                  // Resize
    width: number;
    height: number;
  };
  generateDescription?: boolean;  // Generate bilingual description
  productName?: string;           // Hint for description
}
```

## Development

```bash
# Type checking
npm run type-check

# Linting
npm run lint

# Build
npm run build
```

## Deployment

```bash
# Deploy to dev
TENANT=carousel-labs ./deploy.sh

# Deploy to production
TENANT=carousel-labs ./deploy.sh production
```
