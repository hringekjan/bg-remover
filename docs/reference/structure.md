---
title: bg-remover — Project Structure
description: Auto-generated scout output. Run /sentinels:scout to refresh.
generated: true
last_generated: 2026-05-11
---

# bg-remover

> TypeScript microservice for removing backgrounds from product images and generating bilingual (English + Icelandic) product descriptions for e-commerce/consignment-store workflows.

## Stack

TypeScript · Node 22 · Serverless Framework v4 · AWS Lambda (arm64, eu-west-1) · Next.js (app/ API routes) · Python (agentic/ layer) · DynamoDB · S3 · AWS Bedrock · AWS Rekognition

## Entry Points

| Type | Path | Description |
| ---- | ---- | ----------- |
| Main Lambda handler | `src/handler.ts` | Health function entry |
| Process handler | `src/handlers/process-handler.ts` | Single image processing |
| Process worker | `src/handlers/process-worker-handler.ts` | Async background worker (900s, concurrency 10) |
| Status handler | `src/handlers/status-handler.ts` | Job status polling |
| Batch status handler | `src/handlers/batch-status-handler.ts` | Batch request status |
| Process groups handler | `src/handlers/process-groups-handler.ts` | Multi-group processing |
| Upload URLs handler | `src/handlers/upload-urls-handler.ts` | Presigned S3 URL generation |
| IaC config | `serverless.yml` | Lambda + DynamoDB + S3 definitions |
| Package manifest | `package.json` | Node deps + scripts |
| Tests | `__tests__/` · `app/api/*/\_\_tests\_\_/` | Test suite roots |
| Docs | `docs/` | Service documentation |

## Lambda Functions & HTTP Routes

| Function | Route | Method | Auth |
| -------- | ----- | ------ | ---- |
| `health` | `/carousel/bg-remover/health` | ANY | none |
| `process` | `/carousel/bg-remover/process` | POST | required |
| `processWorker` | _(internal, invoked by process)_ | — | — |
| `status` | `/carousel/bg-remover/status/{jobId}` | GET | none |
| `processGroups` | `/carousel/bg-remover/process-groups` | POST | required |
| `batchStatus` | `/carousel/bg-remover/status/batch/{requestId}` | GET | none |
| `uploadUrls` | `/carousel/bg-remover/upload-urls` | POST | none |

> **BFF routing note:** The correct Next.js BFF route is `app/api/bg-remover/upload-urls/route.ts` (uses `BG_REMOVER_API_URL`). The legacy path `app/api/carousel/bg-remover/upload-urls/route.ts` is stale — it resolves to the shared platform gateway where the catch-all returns 404.

## AI Model Stack

| Capability | Model |
| ---------- | ----- |
| Background removal | `amazon.nova-canvas-v1:0` (Bedrock us-east-1) |
| Vision analysis + English description | `us.mistral.pixtral-large-2502-v1:0` (Bedrock us-east-1) |
| Icelandic translation | `openai.gpt-oss-120b-1:0` (Bedrock eu-west-1) |

## Key Commands

| Command | Description |
| ------- | ----------- |
| `npm install` | Install dependencies |
| `npm run build` | Compile TypeScript |
| `npm run dev` | Start development server |
| `npm test` | Run test suite |
| `serverless deploy --stage dev` | Deploy to dev (run from this directory) |

## Folder Tree

```
bg-remover/
├── __tests__/                      # Integration tests (config-loader etc.)
├── .claude/
│   ├── agents/                     # Local agent definitions (credits, JWT, security, etc.)
│   └── plans/                      # Implementation plans
├── agentic/                        # Python pydantic-ai agents layer
│   ├── ai_extractor_agent/         # AI data extraction agent
│   ├── background_remover_agent/   # Core BG removal agent
│   ├── image_analysis_agent/       # Image analysis agent
│   ├── image_processor_agent/      # Processing pipeline agent
│   ├── mistral_pixtral_analyzer_agent/ # Mistral vision agent
│   ├── product_grouper_agent/      # Product grouping agent
│   ├── rekognition_analyzer_agent/ # AWS Rekognition agent
│   ├── pydantic_ai/                # Shared pydantic-ai implementations
│   ├── artifacts/                  # Sample processed images
│   ├── agent_registry.py           # Agent registry
│   └── templates/                  # Agent scaffolding templates
├── app/
│   └── api/                        # Next.js API routes (BFF layer)
│       ├── batch/route.ts          # Batch processing BFF
│       ├── cluster/route.ts        # Cluster BFF
│       ├── create-product/route.ts # Single product creation BFF
│       ├── create-products/route.ts# Multi-product creation BFF
│       ├── group-images/route.ts   # Group images BFF
│       ├── health/route.ts         # Health BFF
│       ├── process/route.ts        # Process BFF
│       ├── process-groups/route.ts # Process groups BFF
│       ├── settings/route.ts       # Settings BFF
│       ├── status/[jobId]/         # Status polling BFF
│       └── stream/[jobId]/         # SSE streaming BFF
├── artifacts/                      # Phase execution artifacts + docs
├── docs/                           # Service documentation (ADR-006 structure)
│   ├── architecture/index.md
│   ├── business/index.md
│   ├── decisions/ADR-001-pricing-telemetry.md
│   ├── development/index.md
│   ├── operations/                 # WAVE3 runbooks + deployment guides
│   └── reference/                  # This file
├── package/                        # Sub-package (npm publish target)
├── scripts/                        # Utility scripts
├── src/                            # Lambda handler source
│   └── handlers/                   # Per-function handlers
├── serverless.yml                  # IaC — Lambda + DynamoDB + S3 definitions
├── package.json                    # Node deps + scripts
├── Dockerfile                      # Container build (Python deps layer)
├── requirements.txt                # Python deps (agentic layer)
└── README.md                       # Service overview
```

## Infrastructure

| Resource | Name | Purpose |
| -------- | ---- | ------- |
| DynamoDB | `carousel-main-{stage}` | Shared single-table |
| DynamoDB | `bg-remover-{stage}` | Service-owned table |
| DynamoDB | `event-tracking-{stage}` | Event tracking |
| S3 | `bg-remover-temp-images-{stage}` | Presigned upload staging (CORS: hringekjan.is + carousellabs.co) |
| S3 | `carousel-processed-images-{stage}` | Processed image store (tenant-path scoped) |
| S3 | `bg-remover-embeddings-{stage}` | Embedding store |
| SQS DLQ | `bg-remover-{stage}-process-worker-dlq` | processWorker dead-letter queue |

## Docs Coverage

| Section | Status |
| ------- | ------ |
| docs/architecture/ | ✅ exists |
| docs/business/ | ✅ exists |
| docs/development/ | ✅ exists |
| docs/operations/ | ✅ exists (WAVE3 runbooks) |
| docs/reference/ | ✅ exists |
| docs/decisions/ | ✅ exists (ADR-001) |

## Open Issues

- **Stale BFF route**: `app/api/carousel/bg-remover/upload-urls/route.ts` still routes through shared gateway → 404/401. Use `app/api/bg-remover/upload-urls/route.ts` instead. Observed 2026-05-11 on `carousel.dev.hringekjan.is/api/carousel/bg-remover/upload-urls` returning 401.
- **mem0 data residency (ADR-001)**: bg-remover writes pricing patterns to `api.mem0.ai` (cloud SaaS) — SOC 2 CC6.7 / GDPR Art. 5 violation. Fix gated on R4/R5 (approved 2026-04-28); migration target is DynamoDB-direct.
- **batchStatus 400**: `GET /carousel/bg-remover/status/batch/{requestId}` returning 400 — active investigation.

## `upload-urls` Auth Reference (2026-05-11)

`uploadUrls` is registered with `authorizer: null` at the HTTP API Gateway layer. **Authentication runs entirely inside the Lambda** via `validateJWTFromEvent({ required: true, enforceTenantMatch: true })`. Tenant resolution priority: `x-tenant-id` header → `Host` regex → `Origin` regex → env fallback.

For `carousel.dev.hringekjan.is`:
- Tenant resolves to `hringekjan` (hostname-suffix special case in `src/lib/tenant/resolver.ts`).
- Per-tenant Cognito config loaded from SSM `/tf/dev/hringekjan/services/carousel/cognito_config` → user pool `eu-west-1_PRuF4zx1a`, web client `17i0n22ret5j7pt5dr3u03gqkb`.

### 401 cause ranking

| Cause | Where to look |
| ----- | ------------- |
| Missing `Authorization: Bearer` header | Browser devtools request headers |
| Expired JWT (`exp` past) | Decode token; CloudWatch `[JWTValidator]` log |
| Token issued for `carousel-labs` pool (wrong `iss`) | Decode `iss` claim |
| `custom:tenant_id` claim ≠ `hringekjan` (`enforceTenantMatch`) | Decode payload |
| Tenant resolver fell back to `carousel-labs` | Add explicit `x-tenant-id: hringekjan` header as safety net |
| SSM read failure → handler uses default platform pool | Lambda IAM role + `[CognitoConfig]` FATAL log |
| Routing miss: no CF behavior for `/carousel/*` on hringekjan apex | Compare with `api.dev.carousellabs.co` per [[routing-asymmetry]]; if Lambda has no log entry the request never reached it |

Authoritative synthesis: `services/platform/agentic/brains/guardians/technical/syntheses/2026-05-11-bg-remover-upload-urls-auth-and-401-causes.md`.
