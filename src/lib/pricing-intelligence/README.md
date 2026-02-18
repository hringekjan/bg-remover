# Pricing Intelligence Module

## Overview

The Pricing Intelligence module provides intelligent pricing suggestions for the bg-remover service by analyzing historical sales data, product attributes, and market patterns.

## Core Features

### 1. Category Baseline Analysis
Calculates pricing baselines from historical sales data grouped by product category.

```typescript
import { CategoryBaselineAnalyzer } from './pricing-intelligence';

const baseline = CategoryBaselineAnalyzer.calculateBaseline(sales, 'clothing');
// Output: { avgPrice: 8200, medianPrice: 8000, sampleSize: 50, ... }
```

### 2. Product Name Analysis
Extracts brand names, condition hints, and quality indicators from product titles.

```typescript
import { analyzeProductName } from './pricing-intelligence';

const analysis = analyzeProductName('Boss jakki með merkjum nýtt');
// Output: { brand: 'Boss', condition: 'new_with_tags', keywords: ['boss', 'jakki'], ... }
```

### 3. Recency-Weighted Calculations
Applies exponential decay weighting to prioritize recent sales.

```typescript
import { RecencyWeightEngine } from './pricing-intelligence';

const engine = new RecencyWeightEngine({ halfLifeDays: 30 });
const stats = engine.calculateStats(historicalSales);
// Output: { weightedAvg: 8500, weightedMedian: 8000, totalWeight: 45.2, ... }
```

### 4. Complete Pricing Service
Orchestrates all components for a unified pricing suggestion.

```typescript
import { PricingIntelligenceService } from './pricing-intelligence';

const service = new PricingIntelligenceService();
const suggestion = await service.getSuggestion({
  productName: 'Boss jakki með merkjum',
  category: 'outerwear',
});
// Output: { suggestedPrice: 18000, minPrice: 13500, maxPrice: 22500, confidence: 'high', ... }
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    PricingIntelligenceService                    │
├─────────────────────────────────────────────────────────────────┤
│  1. Parse product name (brand, condition, size, color)         │
│  2. Determine category (from request or parsed)                │
│  3. Query historical sales from DynamoDB                        │
│  4. Calculate category baseline                                 │
│  5. Apply recency weighting                                    │
│  6. Extract brand/condition adjustments                         │
│  7. Apply seasonal multipliers                                  │
│  8. Calculate final price with confidence                      │
└─────────────────────────────────────────────────────────────────┘
```

## Usage Example

```typescript
import { PricingIntelligenceService } from './pricing-intelligence';

const service = new PricingIntelligenceService();

// Get pricing suggestion
const suggestion = await service.getSuggestion({
  productName: 'Boss jakki með merkjum - nýtt',
  category: 'outerwear',
});

console.log('Suggested Price:', suggestion.suggestedPrice, 'ISK');
console.log('Range:', suggestion.minPrice, '-', suggestion.maxPrice, 'ISK');
console.log('Confidence:', suggestion.confidence);
console.log('Explanation:', suggestion.explanation);
```

## API Reference

### PricingIntelligenceService

#### `getSuggestion(request: PricingRequest): Promise<PricingSuggestion>`
Generates a pricing suggestion for a product.

#### `getSuggestionWithMockData(request: PricingRequest, mockSales: HistoricalSale[]): Promise<PricingSuggestion>`
Generates a pricing suggestion using mock sales data (for testing).

### CategoryBaselineAnalyzer

#### `calculateBaseline(sales: HistoricalSale[], category: string): CategoryBaseline`
Calculates baseline statistics for a category.

#### `parseCategoryFromName(productName: string): string`
Parses category from product name using keyword matching.

### RecencyWeightEngine

#### `calculateStats(sales: HistoricalSale[]): WeightedStats`
Calculates weighted statistics for sales data.

#### `getConfidence(sales: HistoricalSale[]): number`
Returns confidence score based on data freshness.

### analyzeProductName

Extracts metadata from product name:
- `brand`: Extracted brand name
- `condition`: Detected condition (new_with_tags, like_new, very_good, good, fair)
- `size`: Extracted size (numeric or letter)
- `color`: Detected color
- `productType`: Detected product type
- `keywords`: All extracted keywords

## Configuration

### Recency Weight Configuration

```typescript
const config = {
  halfLifeDays: 30,        // Weight halves every 30 days
  maxAgeDays: 365,         // Ignore sales older than 1 year
  minWeightThreshold: 0.05, // Ignore weights below 5%
};
```

### AI Pricing Configuration

```typescript
const aiConfig = {
  enabled: false,           // Enable AI integration
  aiWeight: 0.3,          // Weight for AI prediction
  statisticalWeight: 0.7,   // Weight for statistical prediction
  confidenceThreshold: 0.5, // Minimum confidence for AI
};
```

## Integration with bg-remover

The module integrates with the existing bg-remover service to provide pricing suggestions during product listing:

```typescript
// In your handler
import { PricingIntelligenceService } from '../lib/pricing-intelligence';

const pricingService = new PricingIntelligenceService();

async function handleProductListing(productData) {
  const suggestion = await pricingService.getSuggestion({
    productName: productData.name,
    category: productData.category,
  });

  return {
    suggestedPrice: suggestion.suggestedPrice,
    priceRange: {
      min: suggestion.minPrice,
      max: suggestion.maxPrice,
    },
    confidence: suggestion.confidence,
  };
}
```

## DynamoDB Schema

The module queries the existing sales table:

```
Table: carousel-main-{stage}
PK: TENANT#${tenantId}#SALE#${saleId}
SK: METADATA
GSI1PK: TENANT#${tenantId}#SALES
GSI1SK: ${saleDate}
```

## Testing

Run tests with:

```bash
npm test -- src/lib/pricing-intelligence/__tests__/
```

## Future Enhancements

1. **AI Integration**: Connect to Bedrock for AI-powered price predictions
2. **mem0 Learning**: Store learned patterns in mem0 for continuous improvement
3. **Market Analysis**: Add competitor pricing analysis
4. **Demand Forecasting**: Predict future price trends

## Dependencies

- @aws-sdk/client-dynamodb
- @aws-sdk/lib-dynamodb
