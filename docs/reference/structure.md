---
title: bg-remover / AI Enrichment — Project Structure & Data Reference
description: Auto-generated scout output. Run /sentinels:scout to refresh.
generated: true
last_generated: 2026-04-28
---

# bg-remover / AI Enrichment Pipeline

> Background removal + AI enrichment for Hringekjan vendor product listings.
> Vendors upload photos → bg-remover strips background → ai-enrichment-service
> generates EN/IS titles, descriptions, pricing → vendor approves/rejects in UI.

## Stack

TypeScript · Node.js 22 · Lambda · DynamoDB (carousel-main) · Bedrock (Nova Lite/Pro) · EventBridge · SQS

## Entry Points

| Type | Path | Description |
|------|------|-------------|
| Approval handler | `src/handlers/metadata-approval-handler.ts` | Accept/reject AI suggestions — writes to carousel-main DynamoDB |
| Enrichment listener | `product-enrichment-listener-dev-processEnrichment` | SQS consumer bridging image and enrichment events |
| Generate description | `ai-enrichment-service-dev-generateDescription` | Calls Bedrock Nova Lite for EN/IS copy |
| Generate pricing | `ai-enrichment-service-dev-generatePricing` | Calls Bedrock Nova Pro for price suggestions |
| Approve description | `ai-enrichment-service-dev-approveDescription` | Human-in-the-loop approval write |
| Accept pricing | `ai-enrichment-service-dev-acceptPricing` | Human-in-the-loop pricing acceptance |

## DynamoDB — Where the Accept/Reject Data Lives

**Table:** `carousel-main-dev` / `carousel-main-prod`

**Entity pattern (single-table):**

| Attribute | Value |
|-----------|-------|
| `PK` | `TENANT#<tenantId>#PRODUCT#<productId>` |
| `SK` | `METADATA` |
| `status` | `APPROVED` \| `REJECTED` |
| `GSI2PK` | `TENANT#<tenantId>#PRODUCT_STATUS#<status>` |
| `enrichment.approvalStatus` | `approved` \| `rejected` |
| `enrichment.approvedAt` | ISO timestamp |
| `enrichment.approvedBy` | userId |
| `enrichment.userEdits` | array — non-empty means vendor edited before approving |

**GSIs available for querying:**

| Index | Hash | Range | Use for |
|-------|------|-------|---------|
| GSI2 | `GSI2PK` | `GSI2SK` | Query all APPROVED or REJECTED per tenant |
| tenantId-entityType-index | `tenantId` | `entityType` | Query by tenant across entity types |

## Queries for 30-Day Accept/Reject Metrics

```bash
# Count APPROVED for hringekjan (last 30 days via filter on enrichment.approvedAt)
aws dynamodb query \
  --table-name carousel-main-prod \
  --index-name GSI2 \
  --key-condition-expression "GSI2PK = :pk" \
  --filter-expression "#e.approvedAt >= :cutoff" \
  --expression-attribute-names '{"#e":"enrichment"}' \
  --expression-attribute-values '{
    ":pk":{"S":"TENANT#hringekjan#PRODUCT_STATUS#APPROVED"},
    ":cutoff":{"S":"2026-03-28T00:00:00.000Z"}
  }' \
  --select COUNT

# Count REJECTED
aws dynamodb query \
  --table-name carousel-main-prod \
  --index-name GSI2 \
  --key-condition-expression "GSI2PK = :pk" \
  --filter-expression "#e.approvedAt >= :cutoff" \
  --expression-attribute-names '{"#e":"enrichment"}' \
  --expression-attribute-values '{
    ":pk":{"S":"TENANT#hringekjan#PRODUCT_STATUS#REJECTED"},
    ":cutoff":{"S":"2026-03-28T00:00:00.000Z"}
  }' \
  --select COUNT

# Edited (approved but with userEdits non-empty) — requires scan or post-processing
# Pull all APPROVED items and filter where enrichment.userEdits length > 0
```

## Bedrock Cost Query (CloudWatch Logs Insights)

```
fields @timestamp, @message
| filter @message like /bedrock/ and @message like /hringekjan/
| stats sum(inputTokens) as totalInput, sum(outputTokens) as totalOutput by bin(1d)
| sort @timestamp desc
| limit 30
```

Log group: `/aws/lambda/ai-enrichment-service-dev-generateDescription`

## Docs Coverage

| Section | Status |
|---------|--------|
| docs/architecture/ | ❌ missing |
| docs/development/  | ❌ missing |
| docs/operations/   | ❌ missing |
| docs/reference/    | ✅ this file |
| docs/decisions/    | ❌ missing |

## Gaps

- No top-level README.md for the enrichment pipeline as a whole
- `userEdits` tracking is present but not consistently populated — edit rate may be undercounted
- No cost-per-operation metric logged directly; must derive from CloudWatch Logs Insights
