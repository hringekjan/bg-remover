# Seasonal Adjustment Algorithm - Quick Reference

## File Locations

```
Core Implementation:
  src/lib/pricing/seasonal-adjustment.ts         (Main algorithm)
  src/lib/pricing/pattern-storage.ts            (mem0 integration)
  src/handlers/pricing-insight-aggregator.ts    (Weekly Lambda)
  src/lib/pricing/__tests__/seasonal-adjustment.test.ts

Integration:
  src/lib/pricing/visual-similarity-pricing.ts  (Added: calculateSeasonallyAdjustedPrice)
  serverless.yml                                (Added: pricingInsightAggregator function)

Documentation:
  README_SEASONAL_ADJUSTMENT.md                 (Comprehensive guide)
  SEASONAL_ADJUSTMENT_DELIVERY.md               (Delivery summary)
  This file
```

## Quick Start

### Real-time Pricing

```typescript
import { VisualSimilarityPricingEngine } from './lib/pricing/visual-similarity-pricing';

const engine = new VisualSimilarityPricingEngine('carousel-labs', 'dev', {
  embeddingsBucket: 'my-bucket'
});

const similarProducts = await engine.findSimilarSoldProducts(embedding, 'coats');
const adjustedPrice = await engine.calculateSeasonallyAdjustedPrice(
  similarProducts,
  'coats',  // category
  'nike'    // brand (optional)
);
```

### Weekly Aggregation

Automatically runs every **Sunday at 2 AM UTC** via EventBridge. No manual setup needed.

To test manually:
```bash
aws lambda invoke \
  --function-name bg-remover-dev-pricingInsightAggregator \
  /tmp/response.json
```

## Key Methods

### SeasonalAdjustmentService

```typescript
// Get multiplier for current month (real-time)
const multiplier = await service.calculateSeasonalMultiplier(
  'coats',    // category
  'nike',     // brand (optional)
  12          // month 1-12 (defaults to current month)
);
// Returns: 0.5 to 1.5 (confidence-weighted)

// Detect pattern for batch analysis
const pattern = await service.detectSeasonalPattern(
  'coats',    // category
  'nike'      // brand (optional)
);
// Returns: SeasonalPattern with peak/off-season months, or null
```

### VisualSimilarityPricingEngine

```typescript
// Apply seasonal adjustment to base price
const adjustedPrice = await engine.calculateSeasonallyAdjustedPrice(
  similarProducts,  // SaleRecord[]
  'coats',          // category
  'nike'            // brand (optional)
);
// Returns: basePrice × seasonalMultiplier
```

## Configuration

### SSM Parameters

```
/tf/{stage}/platform/mem0/api-url
/tf/{stage}/{tenant}/services/bg-remover/mem0-api-key
```

### Environment Variables (Auto-loaded from SSM)

```
MEM0_API_URL        # From SSM
MEM0_API_KEY        # From SSM (SecureString)
SALES_TABLE_NAME    # Auto: bg-remover-{stage}-sales-intelligence
```

## Data Requirements

### For Real-time Multiplier Calculation

- **Minimum**: 30 sales in category (2-year window)
- **Minimum per month**: 5 sales to be considered
- **Calculation**: Monthly avg price ÷ annual avg price

### For Pattern Detection

- **Minimum**: 100 sales in category
- **Minimum per month**: 5 sales for peak/off-season classification
- **Storage**: Only if seasonality score > 0.15

## Multiplier Examples

| Category | Month | Days | Multiplier | Reasoning |
|----------|-------|------|------------|-----------|
| Coats | Dec | 20 | 1.50 | Peak winter (high price, fast sales) |
| Coats | Jul | 45 | 0.945 | Summer clearance (low price, slow) |
| Swimwear | Jul | 15 | 1.20 | Peak summer (high demand) |
| Swimwear | Jan | 50 | 0.55 | Off-season (low demand) |
| Handbags | May | 30 | 1.08 | Moderate demand (stable) |
| Handbags | Nov | 32 | 1.05 | Holiday season (slight bump) |

## Testing

```bash
# Run unit tests
npm test -- src/lib/pricing/__tests__/seasonal-adjustment.test.ts

# Run all tests
npm test

# Type check
npm run type-check

# Manual test
node -e "
const SeasonalAdjustmentService = require('./dist/lib/pricing/seasonal-adjustment').SeasonalAdjustmentService;
const service = new SeasonalAdjustmentService('test-tenant', 'test-table');
service.calculateSeasonalMultiplier('coats').then(m => console.log('Multiplier:', m));
"
```

## Deployment

```bash
# Check syntax
npm run type-check

# Deploy to dev
npm run deploy:dev

# Deploy specific function
npx serverless deploy function -f pricingInsightAggregator --stage dev

# View logs
aws logs tail /aws/lambda/bg-remover-dev-pricingInsightAggregator --follow
```

## Monitoring

### Check if weekly job ran

```bash
# Look for recent log entries
aws logs tail /aws/lambda/bg-remover-dev-pricingInsightAggregator \
  --since 1h --follow | grep "Completed successfully"

# Check mem0 for stored patterns
# Query mem0 API directly or check platform monitoring
```

### Validate Multipliers

```bash
# Multiplier should be between 0.5 and 1.5
# If multiplier is 1.0, it means:
#   - Insufficient data (<30 sales)
#   - Category has no clear seasonality
#   - Month has <5 sales

# Check DynamoDB for historical sales
aws dynamodb query \
  --table-name bg-remover-dev-sales-intelligence \
  --index-name GSI-1 \
  --key-condition-expression "GSI1PK = :pk" \
  --expression-attribute-values '{":pk":{"S":"TENANT#carousel-labs#CATEGORY#coats#SHARD#0"}}' \
  --region eu-west-1
```

## Troubleshooting

### Multiplier always 1.0

**Causes**:
- < 30 sales in category
- Month has < 5 sales
- Invalid category name (check spelling)

**Fix**: Seed test data or wait for sales to accumulate

### Pattern not in mem0

**Causes**:
- Seasonality score < 0.15 (weak pattern)
- Job hasn't run yet (weekly only)
- mem0 API key invalid
- Pattern was stored but not retrieved (check mem0 web UI)

**Fix**: Check CloudWatch logs for "Stored seasonal pattern" message

### High latency (>500ms)

**Causes**:
- DynamoDB scanning multiple shards
- S3 accessing cold embeddings
- Network latency

**Fix**: Verify DynamoDB throughput; check region; review cache metrics

### SSM Parameter Not Found

**Causes**:
- Parameter path wrong
- Stage/tenant mismatch
- Parameter not created

**Fix**: Verify SSM path; check stage variable; create parameter if needed

## Cost Estimation

### Per Real-time Request
- DynamoDB: 0.001 RCU ≈ $0.000025
- No S3 access (already cached)
- Compute: ~100ms Lambda ≈ $0.000002
- **Total**: ~$0.000027 per request

### Per Weekly Aggregation
- DynamoDB reads: ~25 RCU ≈ $0.0125
- Compute: 5-10 min Lambda ≈ $0.015
- mem0 API calls: ~$0.01
- **Total**: ~$0.035 per week

## Integration Examples

### With Product Lister

```typescript
// User uploads 5 coats for sale in December

async function suggestPrices(products: Product[]) {
  const engine = new VisualSimilarityPricingEngine('carousel-labs', 'dev');

  const suggestions = [];
  for (const product of products) {
    const similar = await engine.findSimilarSoldProducts(
      product.embedding,
      'coats'
    );

    const price = await engine.calculateSeasonallyAdjustedPrice(
      similar,
      'coats',
      product.brand
    );

    suggestions.push({
      productId: product.id,
      suggestedPrice: price,
      month: new Date().getMonth() + 1
    });
  }

  return suggestions;
}

// December suggestion: $150 × 1.50 = $225
// User can accept or adjust
```

### With Analytics Dashboard

```typescript
// Show seasonal patterns to sellers

async function getSeasonalAnalysis(category: string) {
  const service = new SeasonalAdjustmentService('carousel-labs', 'sales-table');

  const pattern = await service.detectSeasonalPattern(category);

  return {
    category,
    peakMonths: pattern.peakMonths.map(m => monthName(m)),
    offSeasonMonths: pattern.offSeasonMonths.map(m => monthName(m)),
    strength: pattern.seasonalityScore,
    recommendation: pattern.seasonalityScore > 0.5
      ? `${category} has strong seasonality. Adjust prices for peak/off-season.`
      : `${category} has weak seasonality. Price relatively stable year-round.`
  };
}

// Output:
// {
//   category: 'coats',
//   peakMonths: ['Nov', 'Dec', 'Jan', 'Feb'],
//   offSeasonMonths: ['Jun', 'Jul', 'Aug'],
//   strength: 0.68,
//   recommendation: 'Coats have strong seasonality...'
// }
```

## Performance Tuning

### Reduce Real-time Latency

```typescript
// Cache seasonal multiplier (5 min TTL)
const cache = new Map<string, {mult: number, expires: number}>();

async function getCachedMultiplier(cat: string, month: number) {
  const key = `${cat}-${month}`;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.mult;

  const mult = await service.calculateSeasonalMultiplier(cat, undefined, month);
  cache.set(key, {mult, expires: Date.now() + 5*60*1000});
  return mult;
}
```

### Reduce Weekly Aggregation Time

```typescript
// Process in parallel instead of sequential
const patterns = await Promise.all(
  categories.map(cat =>
    service.detectSeasonalPattern(cat)
      .then(p => patternStorage.storeSeasonalPattern(p))
  )
);
```

## References

- **Full Guide**: `README_SEASONAL_ADJUSTMENT.md`
- **Delivery Summary**: `SEASONAL_ADJUSTMENT_DELIVERY.md`
- **Source Code**: `src/lib/pricing/seasonal-adjustment.ts`
- **Tests**: `src/lib/pricing/__tests__/seasonal-adjustment.test.ts`
