---
title: "BG-Remover Service - User Flow Diagram"
---

# BG-Remover Service - User Flow Diagram

## Purpose

BG-Remover is the **AI-powered image processing pipeline** for the Carousel consignment marketplace:

```
Raw Product Photos → Professional Marketplace Listings
```

**Core Capabilities:**
- Image optimization (background removal, quality enhancement)
- AI product analysis (category, condition, colors, keywords)
- Bilingual descriptions (English + Icelandic)
- Price & rating suggestions
- **Product Identity Grouping** - Automatically groups multiple images of the same product

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                                   USER FLOW                                      │
└─────────────────────────────────────────────────────────────────────────────────┘

┌──────────────┐     ┌─────────────────┐     ┌──────────────────────────────────┐
│              │     │                 │     │         AWS Cloud (eu-west-1)    │
│    User      │     │  Carousel UI    │     │                                  │
│   Browser    │◄───►│  (Next.js App)  │◄───►│  ┌────────────────────────────┐  │
│              │     │                 │     │  │   API Gateway (Shared)     │  │
└──────────────┘     └─────────────────┘     │  │   api.dev.carousellabs.co  │  │
                                             │  └─────────────┬──────────────┘  │
                                             │                │                 │
                                             │  ┌─────────────▼──────────────┐  │
                                             │  │      BG-Remover Service    │  │
                                             │  │   (Lambda Functions)       │  │
                                             │  │                            │  │
                                             │  │  ┌─────────┐ ┌──────────┐  │  │
                                             │  │  │ Health  │ │ Process  │  │  │
                                             │  │  └─────────┘ └────┬─────┘  │  │
                                             │  │  ┌─────────┐      │        │  │
                                             │  │  │ Status  │      │        │  │
                                             │  │  └─────────┘      │        │  │
                                             │  │  ┌─────────┐      │        │  │
                                             │  │  │Settings │      │        │  │
                                             │  │  └─────────┘      │        │  │
                                             │  └───────────────────┼────────┘  │
                                             │                      │           │
                    ┌────────────────────────┼──────────────────────┼───────────┤
                    │                        │                      │           │
       ┌────────────▼─────────────┐  ┌───────▼───────┐  ┌───────────▼────────┐  │
       │     DynamoDB Table       │  │   Bedrock     │  │    EventBridge     │  │
       │   (Single-Table Design)  │  │  Claude 3.5   │  │  (Image Events)    │  │
       │                          │  │    Sonnet     │  │                    │  │
       │  • Jobs (pk/sk)          │  └───────────────┘  └────────────────────┘  │
       │  • Rate Limits           │                                             │
       │  • TTL Cleanup           │                                             │
       └──────────────────────────┘                                             │
                                                                                │
└───────────────────────────────────────────────────────────────────────────────┘
```

## User Flow Sequence

```
┌────────┐          ┌────────────┐        ┌─────────────┐        ┌──────────────┐
│  User  │          │ Carousel   │        │ API Gateway │        │  BG-Remover  │
│        │          │    UI      │        │   + Auth    │        │   Lambda     │
└───┬────┘          └─────┬──────┘        └──────┬──────┘        └──────┬───────┘
    │                     │                      │                      │
    │  1. Login           │                      │                      │
    ├────────────────────►│                      │                      │
    │                     │  Cognito Auth        │                      │
    │                     ├─────────────────────►│                      │
    │  JWT Token          │                      │                      │
    │◄────────────────────┤                      │                      │
    │                     │                      │                      │
    │  2. Upload Image    │                      │                      │
    ├────────────────────►│                      │                      │
    │                     │  POST /bg-remover/   │                      │
    │                     │  process             │                      │
    │                     │  + Bearer Token      │                      │
    │                     ├─────────────────────►│                      │
    │                     │                      │  Validate JWT        │
    │                     │                      ├─────────────────────►│
    │                     │                      │                      │
    │                     │                      │  Check Rate Limit    │
    │                     │                      │  (DynamoDB)          │
    │                     │                      │◄─────────────────────┤
    │                     │                      │                      │
    │                     │                      │  Process Image       │
    │                     │                      │  (Bedrock Claude)    │
    │                     │                      │◄─────────────────────┤
    │                     │                      │                      │
    │                     │  { jobId: "..." }    │  Store Job Status    │
    │                     │◄─────────────────────┤  (DynamoDB)          │
    │                     │                      │◄─────────────────────┤
    │  Show Progress      │                      │                      │
    │◄────────────────────┤                      │                      │
    │                     │                      │                      │
    │  3. Poll Status     │                      │                      │
    ├────────────────────►│                      │                      │
    │                     │  GET /bg-remover/    │                      │
    │                     │  status/{jobId}      │                      │
    │                     ├─────────────────────►│                      │
    │                     │                      │  Get Job (DynamoDB)  │
    │                     │                      ├─────────────────────►│
    │                     │  { status, result }  │                      │
    │                     │◄─────────────────────┤◄─────────────────────┤
    │  Show Result        │                      │                      │
    │◄────────────────────┤                      │                      │
    │                     │                      │                      │
    │  4. Download Image  │                      │                      │
    ├────────────────────►│                      │                      │
    │                     │  Presigned S3 URL    │                      │
    │  Processed Image    │◄─────────────────────┤                      │
    │◄────────────────────┤                      │                      │
    │                     │                      │                      │
```

## Data Flow Summary

### Authentication Flow
1. User logs in via Carousel UI (Next.js)
2. Cognito validates credentials and issues JWT token
3. JWT stored in browser, sent with all API requests

### Image Processing Flow
1. **Request**: User uploads image URL via `POST /bg-remover/process`
2. **Auth**: API Gateway validates JWT token
3. **Rate Limit**: Lambda checks DynamoDB rate limit counters
4. **Process**: If allowed, sends image to Bedrock Claude 3.5 Sonnet
5. **Store**: Job status saved to DynamoDB with TTL (24h cleanup)
6. **Event**: EventBridge emits `CarouselImageProcessed` event
7. **Response**: Returns jobId for status polling

### Status Polling Flow
1. Client polls `GET /bg-remover/status/{jobId}`
2. Lambda retrieves job from DynamoDB
3. Returns current status (pending/processing/completed/failed)
4. On completion, includes presigned S3 URL for processed image

## Security Controls

| Control | Implementation |
|---------|----------------|
| Authentication | Cognito JWT validation on all endpoints (except /health) |
| Rate Limiting | DynamoDB-backed sliding window (100 req/min default) |
| Tenant Isolation | DynamoDB pk prefix pattern: `TENANT#{tenant}#...` |
| Data Expiry | TTL on all records (24 hours) |
| SSRF Protection | URL allowlist validation |
| Input Validation | Zod schema validation on all inputs |

## Product Identity Grouping (NEW)

```
Image Upload → Titan Embedding → Similarity Check → Group Assignment
     │               │                  │                  │
     ▼               ▼                  ▼                  ▼
  [Image 1]    [1024-dim vector]   [Cosine ≥0.92]   [Product Group]
  [Image 2]    [1024-dim vector]   [Match Found]    [Images: 1,2]
```

**Similarity Thresholds:**
- `≥0.92` - Same product (auto-group)
- `≥0.85` - Likely same (suggest group)
- `≥0.75` - Possibly same (review needed)

## Multi-Model Pipeline

| Task           | Primary Model           | Fallback          |
|----------------|-------------------------|-------------------|
| Embedding      | Titan Multimodal        | Cohere Embed      |
| Image Analysis | Claude 3.5 Sonnet v2    | Claude 3 Haiku    |
| Description    | Mistral Large           | Titan Text        |
| Translation    | Claude 3 Haiku          | Mistral Small     |

## DynamoDB Single-Table Design

```
┌────────────────────────────────────────────────────────────────────┐
│                       bg-remover-dev Table                         │
├───────────────────────────────────┬────────────────────────────────┤
│              pk                   │              sk                │
├───────────────────────────────────┼────────────────────────────────┤
│ TENANT#carousel-labs#JOB          │ JOB#abc-123                    │
│ TENANT#carousel-labs#RATELIMIT    │ ACTION#process#WINDOW#1703...  │
│ TENANT#carousel-labs#EMBEDDING    │ IMAGE#img-001                  │
│ TENANT#carousel-labs#EMBEDDING    │ IMAGE#img-002                  │
│ TENANT#carousel-labs#PRODUCT_GROUP│ GROUP#pg_1703...               │
└───────────────────────────────────┴────────────────────────────────┘
```

**Entity Types:**
- `JOB` - Processing job status (TTL: 24h)
- `RATELIMIT` - Rate limiting counters
- `EMBEDDING` - Image embeddings for similarity (TTL: 30 days)
- `PRODUCT_GROUP` - Grouped product images (TTL: 90 days)

**Cost Optimization**: Single table saves ~48% vs separate tables + GSI
