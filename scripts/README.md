# BG Remover Maintenance Scripts

## cleanup-jobs-without-gsi2.ts

Removes old BG_REMOVER_JOB records that were created before the GSI2 implementation.

### Background

The batch status endpoint (`/bg-remover/status/batch/{requestId}`) uses GSI2 for efficient queries:
- **GSI2PK:** `REQUEST#{requestId}`
- **GSI2SK:** `TENANT#{tenant}#JOB#{jobId}`

Jobs created before the GSI2 implementation (deployed 2026-02-09) don't have these attributes and have a 7-day TTL.

### Usage

```bash
# Dry run (see what would be deleted)
npx tsx scripts/cleanup-jobs-without-gsi2.ts --tenant hringekjan

# Actually delete old jobs
npx tsx scripts/cleanup-jobs-without-gsi2.ts --tenant hringekjan --execute
```

### Recommendation

**Let TTL handle cleanup naturally (7 days).** Only run this script if you need immediate cleanup.
