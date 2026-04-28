---
title: ADR-001 — Pricing telemetry emission contract
status: proposed
date: 2026-04-28
deciders: HOP-Architect (sentinel), Event-Architect (sentinel)
related:
  - ../../../../../lcp-api/docs/reference/prd-carousel-learnings.md
  - ../../../../../agentic/brains/pages/syntheses/2026-04-28-carousel-learning-loop-architecture.md
---

# ADR-001 — Pricing telemetry emission contract

## Context

bg-remover is the producer-side of the [[carousel-learning-loop-architecture]] learning loop. Today its `pricingCalculator` Lambda computes a suggested price and writes it to `carousel-main` DDB. Quality scores (`edgeScore`, `backgroundScore`, `translationScore`) and `ctxFingerprint` are also computed but their persistence path is inconsistent.

For Layer 1 (DDB-stream-driven), the producer side is a no-op — `vendor-approval-recorder` reads what's already on the row. For Layer 2 (event-driven), the producer must emit a typed event with the full contract.

This ADR commits bg-remover to a stable telemetry contract so downstream consumers ([[lcp-api]], [[mem0]], [[lcp-analytics]]) can rely on field shape across both layers.

A complicating factor surfaced by the frontend scout (see [[2026-04-28-frontend-interaction-scout]]): there are **two pricing-calculate paths**:

1. `bg-remover/serverless.yml` `pricingCalculator` Lambda — server-side, called by `processWorker`
2. `services/platform/carousel/app/web/app/api/connectors/mem0/pricing/calculate/route.ts` — Next.js handler, UI-callable

Both paths must emit the same telemetry shape, or the loop signal becomes unreliable depending on which entry point the vendor used.

## Decision

bg-remover commits to writing the following fields on every pricing calculation, regardless of entry point:

### Required fields on `carousel-main` product row

| Field | Type | Source | Layer 1 | Layer 2 |
|-------|------|--------|---------|---------|
| `enrichment.suggestedPrice` | number (ISK) | `pricingCalculator` | required | required |
| `enrichment.qualityScores.edgeScore` | number 0-100 | bg-remover vision pipeline | required | required |
| `enrichment.qualityScores.backgroundScore` | number 0-100 | bg-remover vision pipeline | required | required |
| `enrichment.qualityScores.translationScore` | number 0-100 | bg-remover description pipeline | required | required |
| `enrichment.ctxFingerprint` | string (sha256 hex) | hash of inputs influencing pricing | required | required |
| `enrichment.patternMatched` | boolean | true if mem0 pattern lookup hit | required | required |
| `enrichment.pricingSource` | enum | `pricing_calculator_lambda` \| `connector_route` | required | required |
| `enrichment.priceCalculatedAt` | ISO 8601 timestamp | server time at calculation | required | required |

### Required fields on Layer 2 event payload (when topology activates)

`bg_remover.product.processed.v1`:

```typescript
{
  eventId: string;            // UUID idempotency key
  eventType: "bg_remover.product.processed";
  version: "1.0";
  timestamp: string;          // ISO 8601
  tenantId: string;           // mandatory tenant isolation
  source: "bg-remover-lambda" | "carousel-app-web-route";
  correlationId?: string;     // distributed tracing
  payload: {
    productId: string;
    suggestedPrice: number;
    qualityScores: { edgeScore, backgroundScore, translationScore };
    ctxFingerprint: string;
    patternMatched: boolean;
    bilingualDescription?: { en: string; is: string };
  };
}
```

Schema versioning: `1.0` is initial. Additive changes increment minor. Breaking changes increment major and require N-1 support window of 6 months per Event-Architect §6.

### Both paths must emit identical shape

The `services/platform/carousel/app/web/.../pricing/calculate` Next.js route MUST call the same `pricingCalculator` core logic (extract to shared lib if needed) and write the same fields. The `pricingSource` discriminator captures which path was used — useful for debugging, not for analytics divergence.

## Consequences

- **Layer 1 ships unchanged.** `vendor-approval-recorder` reads these fields off the product row.
- **Layer 2 producer is bounded.** Adding event emission means wrapping existing DDB writes in a fire-and-forget EventBridge `PutEvents` call. ~30 lines of code.
- **The Next.js connector route must align with the Lambda.** Either consolidate into shared lib (preferred) or document deviation explicitly. Resolves frontend scout F3 ambiguity.
- **`ctxFingerprintBoostApplied` (analytics field)** is computed downstream from `patternMatched=true` AND `ctxFingerprint matched a published pattern`. Producer doesn't set the boost flag — that's `lcp-analytics`'s job.

## Risks

- **Field drift between Lambda and Next.js route.** Mitigation: shared lib + integration test asserting both paths produce identical row shape for the same input.
- **Schema evolution discipline.** The 6-month N-1 window only works if we track consumers. Layer 2 introduces an event registry to enforce this; until then, Layer 1 consumers (`vendor-approval-recorder`) read direct from the row, so they break loudly on missing fields.
- **`pricingSource` enum growth.** Each new entry point (mobile app? batch importer?) adds a value. Acceptable, but new values need backfill consideration.

## Open question (must answer before this ADR is accepted)

Are the two `pricing/calculate` paths meant to do the same thing, or do they serve different use cases? The frontend scout flagged this. Possible answers:

- **Same logic, two entry points** → consolidate into shared lib immediately
- **Different logic** (e.g., Lambda is automatic, route is manual override with looser validation) → document the distinction here, both still emit telemetry

This is recorded in PRD §11 open questions and must be resolved by a human before Layer 1 ships.

## See Also

- [[carousel-learning-loop-architecture]] — full synthesis
- [[2026-04-28-architect-review-events]] — Layer 2 event schema design
- [[2026-04-28-frontend-interaction-scout]] — surfaced the dual-path issue
- [[bg-remover]] · [[carousel]] · [[lcp-api]] · [[mem0]]
