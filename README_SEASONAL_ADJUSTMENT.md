# Seasonal Adjustment Algorithm - Phase 4.4 Implementation

## Overview

This document describes the Seasonal Adjustment Algorithm implementation for intelligent, data-driven seasonal pricing. The system analyzes historical sales data to identify peak/off-season patterns, calculates confidence-weighted multipliers, and persists learned patterns in mem0 for future use.

**Key Achievement**: Shifts from hardcoded seasonal rules (e.g., "winter coats = 1.15x in Dec") to learned patterns discovered from actual sales data.

## Architecture

### Core Components

```
┌─────────────────────────────────────────────────────────────┐
│ VisualSimilarityPricingEngine (Entry Point)                  │
│ ┌───────────────────────────────────────────────────────┐   │
│ │ calculateSeasonallyAdjustedPrice()                     │   │
│ │ - Takes similar products list                          │   │
│ │ - Applies seasonal multiplier                          │   │
│ │ - Returns adjusted base price                          │   │
│ └───────────────────────────────────────────────────────┘   │
└────────────┬──────────────────────────────────────────────────┘
             │
             └─> SeasonalAdjustmentService
                 ├─ calculateSeasonalMultiplier()
                 │  ├─ Fetch 2-year historical sales
                 │  ├─ Analyze by month (1-12)
                 │  ├─ Calculate confidence weighting
                 │  └─ Return 0.5x to 1.5x multiplier
                 │
                 └─ detectSeasonalPattern()
                    ├─ Query ≥100 historical sales
                    ├─ Identify peak months (high price + fast sales)
                    ├─ Identify off-season months (low price + slow sales)
                    ├─ Calculate seasonality score (0-1)
                    └─ Return complete pattern
                       │
                       └─> PatternStorageService
                           └─ storeSeasonalPattern()
                              └─ Format as mem0 memory
                              └─ Persist for future reference
```

### Data Flow

**Real-time Pricing** (when product is listed):
```
1. Find similar sold products (visual similarity)
2. Calculate average price of similar products
3. Get seasonal multiplier for current month
   ├─ Query historical sales (2 years)
   ├─ Analyze by month
   ├─ Calculate confidence
   └─ Return multiplier (e.g., 1.15x for Dec, 0.65x for July)
4. Apply multiplier: avg_price × seasonal_multiplier
5. Return adjusted price suggestion
```

**Weekly Aggregation** (Sunday 2 AM UTC):
```
1. Fetch top product categories by sales volume
2. For each category:
   ├─ Detect seasonal pattern (requires ≥100 sales)
   ├─ Store in mem0 if seasonality strong (score > 0.15)
   ├─ For each top brand in category:
   │  ├─ Detect brand-specific pattern
   │  └─ Store if seasonality strong (score > 0.20)
3. Log metrics (categories processed, patterns found)
```

## File Structure

```
src/lib/pricing/
├── seasonal-adjustment.ts           # Core seasonal analysis engine
│   ├─ SeasonalAdjustmentService
│   ├─ calculateSeasonalMultiplier() - Real-time multiplier calculation
│   └─ detectSeasonalPattern()       - Batch pattern detection
│
├── pattern-storage.ts               # mem0 integration
│   └─ PatternStorageService
│      └─ storeSeasonalPattern()     - Persist patterns to mem0
│
└── __tests__/
    └── seasonal-adjustment.test.ts  # Unit tests

src/handlers/
└── pricing-insight-aggregator.ts    # Weekly Lambda job
   └─ handler()                      # EventBridge scheduled handler
   └─ getTopCategories()             # Fetch categories to analyze
   └─ getTopBrandsForCategory()      # Fetch brands within category
```

## Usage

### Real-time Pricing (Product Lister)

```typescript
import { VisualSimilarityPricingEngine } from './lib/pricing/visual-similarity-pricing';

const pricingEngine = new VisualSimilarityPricingEngine(
  'carousel-labs',  // tenantId
  'dev',           // stage
  {
    embeddingsBucket: 'my-embeddings-bucket',
    region: 'eu-west-1'
  }
);

// Find similar products
const similarProducts = await pricingEngine.findSimilarSoldProducts(
  queryEmbedding,
  'coats'  // category
);

// Get seasonally-adjusted price
const adjustedPrice = await pricingEngine.calculateSeasonallyAdjustedPrice(
  similarProducts,
  'coats',      // category
  'nike'        // brand (optional)
);

console.log(`Suggested price: $${adjustedPrice}`);
// Example: Winter coat in December: 150 (base) × 1.15 (seasonal) = 172.50
// Example: Winter coat in July:     150 (base) × 0.65 (seasonal) = 97.50
```

### Scheduled Pattern Analysis

Automatically runs every Sunday at 2 AM UTC via EventBridge:

```yaml
# serverless.yml
functions:
  pricingInsightAggregator:
    handler: src/handlers/pricing-insight-aggregator.handler
    events:
      - schedule:
          rate: cron(0 2 ? * SUN)  # Every Sunday at 2 AM UTC
```

## Algorithm Details

### Seasonal Multiplier Calculation

```
1. Fetch historical sales (last 2 years)
   - Requirement: ≥30 sales for meaningful analysis

2. Group sales by month (1-12)
   - Calculate monthly statistics:
     * avgPrice: average sale price
     * avgDaysToSell: inventory turnover metric
     * saleCount: number of sales

3. Calculate annual averages
   - annualAvgPrice = mean(all monthly averages)
   - annualAvgDaysToSell = mean(all monthly turnover)

4. Calculate raw multiplier
   - rawMultiplier = currentMonthAvgPrice / annualAvgPrice

5. Apply confidence weighting
   - confidence = min(currentMonthSaleCount / 20, 1.0)
   - adjustedMultiplier = 1.0 + (rawMultiplier - 1.0) × confidence

6. Clamp to reasonable range
   - finalMultiplier = max(0.5, min(1.5, adjustedMultiplier))

Result: 0.5x to 1.5x multiplier (no extreme adjustments)
```

**Example: Winter Coats in December**

```
Historical sales (2 years):
  December: [150, 155, 160, 145, 158] = avg $153.60, 25 sales
  July:     [75, 70, 80, 65] = avg $72.50, 4 sales
  Other:    Various prices, ~20 sales per month

Annual average: ~$100

December multiplier:
  raw = 153.60 / 100 = 1.536
  confidence = min(25 / 20, 1.0) = 1.0 (high confidence)
  adjusted = 1.0 + (1.536 - 1.0) × 1.0 = 1.536
  final = min(1.5, 1.536) = 1.50 (clamped)

July multiplier:
  raw = 72.50 / 100 = 0.725
  confidence = min(4 / 20, 1.0) = 0.2 (low confidence)
  adjusted = 1.0 + (0.725 - 1.0) × 0.2 = 0.945
  final = 0.945
```

### Seasonal Pattern Detection

**Requirements**:
- Minimum 100 sales (reliable pattern)
- Seasonality score > 0.15 to be significant

**Peak Month Criteria**:
- Price > 1.1x annual average
- Days to sell < 0.8x annual average (20% faster)
- ≥5 sales in month

**Off-Season Criteria**:
- Price < 0.9x annual average
- Days to sell > 1.2x annual average (20% slower)
- ≥5 sales in month

**Seasonality Score** (0-1):
```
Coefficient of Variation = stdDev(monthly_multipliers) / mean(monthly_multipliers)
Score = min(CV / 0.3, 1.0)

0.0-0.15: No seasonality (stable year-round)
0.15-0.30: Weak seasonality (10-15% variation)
0.30-0.60: Moderate seasonality (15-30% variation)
0.60-1.00: Strong seasonality (30%+ variation)
```

**Example: Swimwear**

```
Pattern detected:
  Category: swimwear
  Peak months: [6, 7, 8] (June, July, August)
    Average multiplier: 1.18x
  Off-season months: [12, 1, 2] (December, January, February)
    Average multiplier: 0.52x
  Seasonality score: 0.68 (strong)
  Sample size: 240 sales

Stored in mem0 as:
"swimwear: Peak season Jun, Jul, Aug (avg 1.18x), off-season Dec, Jan, Feb (avg 0.52x).
 Seasonality strength: 0.68 (0-1 scale), based on 240 historical sales."
```

## Environment Configuration

### Required SSM Parameters

```bash
# For weekly aggregation job
/tf/{stage}/platform/mem0/api-url              # mem0 API endpoint
/tf/{stage}/{tenant}/services/bg-remover/mem0-api-key  # mem0 API key

# For real-time pricing
/tf/{stage}/${env:TENANT}/services/bg-remover/config   # Service config
```

### Lambda Function Configuration

```yaml
pricingInsightAggregator:
  memorySize: 1024       # 1GB for batch analysis
  timeout: 900           # 15 minutes max
  schedule: cron(0 2 ? * SUN)  # Every Sunday 2 AM
```

## Testing

### Unit Tests

```bash
npm test -- src/lib/pricing/__tests__/seasonal-adjustment.test.ts
```

**Test Coverage**:
- ✅ Seasonal multiplier calculation
- ✅ Peak/off-season detection
- ✅ Confidence weighting
- ✅ Edge cases (insufficient data, errors)
- ✅ Pattern detection with brand-specific analysis

### Integration Testing

```bash
# Deploy to dev
npm run deploy:dev

# Trigger manual weekly job
aws lambda invoke \
  --function-name bg-remover-dev-pricingInsightAggregator \
  --region eu-west-1 \
  /tmp/response.json

# Check results
aws logs tail /aws/lambda/bg-remover-dev-pricingInsightAggregator --follow
```

### Manual Testing

```typescript
const service = new SeasonalAdjustmentService(
  'test-tenant',
  'sales-intelligence-dev'
);

// Test real-time multiplier
const multiplier = await service.calculateSeasonalMultiplier('coats', 'nike', 12);
console.log(`December multiplier: ${multiplier}`);

// Test pattern detection
const pattern = await service.detectSeasonalPattern('swimwear');
console.log('Pattern:', pattern);
```

## Performance

### Real-time Pricing (Per Request)

| Operation | Latency | Cost |
|-----------|---------|------|
| Query DynamoDB (2y sales) | 100-200ms | $0.001 |
| Analyze by month | <10ms | $0.000 |
| Apply seasonal multiplier | <1ms | $0.000 |
| **Total per request** | **100-250ms** | **$0.001** |

### Weekly Aggregation (Per Sunday)

| Operation | Duration | Cost |
|-----------|----------|------|
| Process 8 categories × 3 brands | 5-10 minutes | $0.02 |
| Store 24 patterns in mem0 | 1-2 seconds | $0.01 |
| DynamoDB reads | 20-30 RCU | $0.005 |
| **Total per week** | **5-10 min** | **$0.035** |

## Monitoring

### CloudWatch Metrics

```
Custom Metrics:
- SeasonalAdjustment/MultiplierCalculated (monthly, by category)
- SeasonalAdjustment/PatternsDetected (weekly)
- SeasonalAdjustment/HighConfidenceMultiplier (%)
- SeasonalAdjustment/ProcessingTime (ms)

Logs:
- [SeasonalAdjustment] Calculated multiplier
- [PricingInsightAggregator] Completed successfully
- [PatternStorage] Stored seasonal pattern
```

### Example Dashboard

```
Category      | Multiplier | Confidence | Peak Months | Off-season
-----|----------|------------|------------|------------|----
Coats         | 1.32       | 95%        | Nov-Feb    | Jul-Sep
Swimwear      | 1.15       | 88%        | Jun-Aug    | Dec-Feb
Handbags      | 1.05       | 72%        | Sep-Nov    | Feb-Apr
Dresses       | 1.08       | 85%        | Mar-May    | Aug-Oct
```

## Failure Handling

### Insufficient Data

```typescript
// < 30 sales in month -> return 1.0 (no adjustment)
// < 100 sales overall -> don't store pattern
// < 5 sales in month -> ignore that month for peak/off-season
```

### API Failures

```typescript
// DynamoDB query fails -> return 1.0 (fail safe)
// mem0 storage fails -> log warning, continue
// Network timeout -> return 1.0 (fail safe)
```

### Outliers

```typescript
// Clamped multiplier range: 0.5x - 1.5x
// Prevents extreme adjustments due to edge cases
// Example: Clearance sale (0.2x) not allowed in multiplier
```

## Future Enhancements

1. **Machine Learning Integration**
   - Use ARIMA models for sales forecasting
   - Predict peak/off-season months
   - Account for trend shifts over time

2. **External Data Integration**
   - Weather patterns (e.g., early winter = earlier peak)
   - Holiday calendars (e.g., Black Friday)
   - Competitor pricing data

3. **Brand Strategy Optimization**
   - Different multipliers for premium vs budget brands
   - Brand-category combinations (e.g., luxury coats vs casual)
   - Brand growth/decline trends

4. **Dynamic Category Analysis**
   - Real-time category discovery from sales
   - Automatic threshold adjustments
   - A/B testing of seasonal adjustments

5. **Cross-Tenant Learning**
   - Shared patterns across tenants
   - Category benchmarking
   - Best practices sharing

## Troubleshooting

### Pattern Not Being Detected

```bash
# Check if category has enough sales (≥100)
aws dynamodb query \
  --table-name bg-remover-dev-sales-intelligence \
  --index-name GSI-1 \
  --key-condition-expression "GSI1PK = :pk" \
  --expression-attribute-values '{ ":pk": { "S": "TENANT#carousel-labs#CATEGORY#coats#SHARD#0" } }' \
  --region eu-west-1 | jq '.Items | length'

# Check seasonality score
# If score < 0.15, category has weak seasonal patterns
```

### Multiplier Looks Wrong

```bash
# Check historical sales for the month
aws dynamodb query \
  --table-name bg-remover-dev-sales-intelligence \
  --index-name GSI-1 \
  --key-condition-expression "GSI1PK = :pk AND GSI1SK BETWEEN :start AND :end" \
  --region eu-west-1

# Verify prices
# Calculate: monthAvgPrice / annualAvgPrice
# Check: is January higher than July for coats?
```

### Weekly Job Not Running

```bash
# Check EventBridge rule
aws events list-rules --name-prefix "bg-remover" --region eu-west-1

# Check CloudWatch Logs
aws logs tail /aws/lambda/bg-remover-dev-pricingInsightAggregator --follow

# Check SSM parameters
aws ssm get-parameter --name /tf/dev/platform/mem0/api-url --region eu-west-1
```

## References

- [Sales Intelligence Implementation](./README_SALES_INTELLIGENCE.md)
- [Visual Similarity Pricing](./README.md)
- [mem0 API Documentation](https://docs.mem0.ai/)
- [DynamoDB Query Patterns](./docs/sales-intelligence-architecture.md)

## Support

For questions or issues:
1. Check CloudWatch Logs: `/aws/lambda/bg-remover-dev-*`
2. Review test cases: `src/lib/pricing/__tests__/`
3. Check mem0 stored patterns
4. Review DynamoDB table for data quality
