# Vision Analysis Quick Reference

## Quick Start

### 1. Initialize Service

```typescript
import { VisionAnalysisService } from './lib/pricing/vision-analysis';

const visionAnalysis = new VisionAnalysisService();
// Uses us-east-1 by default
```

### 2. Analyze Single Image

```typescript
const assessment = await visionAnalysis.assessVisualQuality(
  base64ImageData,
  { category: 'Clothing', brand: 'Nike' }
);

// Returns:
// {
//   conditionScore: 8,        // 1-10
//   photoQualityScore: 7,     // 1-10
//   visibleDefects: [],
//   overallAssessment: 'good',
//   pricingImpact: 'neutral',
//   reasoning: '...',
//   multiplier: 1.0          // 0.75-1.15
// }
```

### 3. Analyze Multiple Images

```typescript
const assessment = await visionAnalysis.assessMultipleImages(
  [image1, image2, image3],
  { category: 'Electronics' }
);

// Returns worst-case assessment with averaged multiplier
```

### 4. Complete Pricing Suggestion

```typescript
import { VisualSimilarityPricingEngine } from './lib/pricing/visual-similarity-pricing';

const engine = new VisualSimilarityPricingEngine('carousel-labs', 'dev');

const suggestion = await engine.generatePriceSuggestion(
  productImage,
  embedding,
  { category: 'Clothing' }
);

// Response includes:
// - suggestedPrice
// - priceRange
// - factors.visualQualityAssessment
// - factors.visualQualityMultiplier
// - confidence, reasoning
```

---

## Assessment Scores

### Condition Score (1-10)

| Score | Level | Description |
|-------|-------|-------------|
| 9-10 | Excellent | Perfect or new condition |
| 7-8 | Good | Like new, minimal wear |
| 5-6 | Fair | Good condition, some wear |
| 3-4 | Poor | Noticeable damage |
| 1-2 | Bad | Significant damage |

### Photo Quality (1-10)

| Score | Level | Description |
|-------|-------|-------------|
| 9-10 | Professional | Excellent lighting, multiple angles |
| 7-8 | Good | Clear, well-lit amateur photos |
| 5-6 | Acceptable | Decent quality but could be better |
| 3-4 | Poor | Unclear, dark, or limited angles |
| 1-2 | Bad | Unsuitable for e-commerce |

### Pricing Multiplier (0.75-1.15)

| Assessment | Multiplier | Impact |
|-----------|-----------|--------|
| Excellent | 1.15 | +15% premium |
| Good | 1.00 | Standard pricing |
| Fair | 0.90 | -10% discount |
| Poor | 0.75 | -25% discount |

**Photo Quality Adjustment:** -5% if photoQuality < 5

---

## Configuration

### Environment Variables

```bash
BEDROCK_REGION=us-east-1          # Default: us-east-1
SALES_TABLE_NAME=sales-records    # DynamoDB table
EMBEDDINGS_BUCKET=embeddings-*    # S3 bucket
CACHE_MAX_SIZE_BYTES=419430400    # 400MB
CACHE_TTL_MS=300000               # 5 minutes
```

### Constructor Options

```typescript
new VisionAnalysisService({
  region: 'us-east-1'  // Bedrock region
});

new VisualSimilarityPricingEngine(tenantId, stage, {
  cacheMaxSizeBytes: 400 * 1024 * 1024,
  cacheTtlMs: 5 * 60 * 1000,
  dynamoDBTable: 'sales-records',
  embeddingsBucket: 'bucket-name',
  region: 'eu-west-1',           // AWS region
  bedrockRegion: 'us-east-1'     // Bedrock region
});
```

---

## Common Tasks

### Task: Get Visual Quality Assessment Only

```typescript
const assessment = await visionAnalysis.assessVisualQuality(image);

console.log(`Condition: ${assessment.conditionScore}/10`);
console.log(`Photos: ${assessment.photoQualityScore}/10`);
console.log(`Defects: ${assessment.visibleDefects.join(', ')}`);
console.log(`Multiplier: ${assessment.multiplier}x`);
```

### Task: Check for Specific Defects

```typescript
const assessment = await visionAnalysis.assessVisualQuality(image);

const hasStains = assessment.visibleDefects.some(d =>
  d.toLowerCase().includes('stain')
);
const hasTears = assessment.visibleDefects.some(d =>
  d.toLowerCase().includes('tear')
);

if (hasStains || hasTears) {
  console.log('Item has quality issues - apply discount');
}
```

### Task: Batch Process Product Catalog

```typescript
const products = [/* list of products with images */];

const assessments = await Promise.all(
  products.map(p =>
    visionAnalysis.assessVisualQuality(p.image, {
      category: p.category,
      brand: p.brand
    })
  )
);

// Process results
assessments.forEach((a, i) => {
  console.log(`Product ${i}: ${a.overallAssessment} (${a.multiplier}x)`);
});
```

### Task: Generate Full Price with Vision

```typescript
// Get embedding (already have from clustering)
const embedding = await getProductEmbedding(productImage);

// Generate complete pricing suggestion
const suggestion = await engine.generatePriceSuggestion(
  productImage,
  embedding,
  {
    category: product.category,
    brand: product.brand,
    condition: product.condition
  }
);

console.log(`Suggested: $${suggestion.suggestedPrice}`);
console.log(`Range: $${suggestion.priceRange.min} - $${suggestion.priceRange.max}`);
console.log(`Confidence: ${(suggestion.confidence * 100).toFixed(0)}%`);

// Show visual quality impact
const vq = suggestion.factors.visualQualityAssessment;
console.log(`Visual Quality: ${vq.overallAssessment}`);
console.log(`Photo Quality: ${vq.photoQualityScore}/10`);
console.log(`Pricing Impact: ${vq.pricingImpact}`);
```

---

## Error Handling

### Graceful Degradation

If Bedrock fails, service returns neutral assessment:

```typescript
const assessment = await visionAnalysis.assessVisualQuality(image);

// On error:
// {
//   conditionScore: 5,
//   photoQualityScore: 5,
//   visibleDefects: [],
//   overallAssessment: 'good',
//   pricingImpact: 'neutral',
//   reasoning: 'Vision analysis unavailable, using neutral assessment',
//   multiplier: 1.0
// }
```

### Handling Empty Results

```typescript
const assessment = await visionAnalysis.assessMultipleImages([]);

// Returns:
// {
//   multiplier: 1.0,
//   overallAssessment: 'good',
//   reasoning: 'No images provided for assessment',
//   ...
// }
```

---

## API Response Example

### Pricing Suggestion with Vision Analysis

```json
{
  "suggestedPrice": 45.99,
  "priceRange": {
    "min": 35.50,
    "max": 52.75
  },
  "confidence": 0.85,
  "currency": "USD",
  "factors": {
    "basePrice": 48.75,
    "seasonalMultiplier": 1.05,
    "conditionMultiplier": 0.95,
    "visualQualityMultiplier": 1.0,
    "visualQualityDetails": "Product in good condition with clear photos",
    "visualQualityAssessment": {
      "conditionScore": 8,
      "photoQualityScore": 7,
      "visibleDefects": [],
      "overallAssessment": "good",
      "pricingImpact": "neutral"
    },
    "similarProducts": [
      {
        "productId": "prod-123",
        "similarity": 0.92,
        "salePrice": 49.99,
        "saleDate": "2025-12-28T10:30:00Z",
        "condition": "good"
      }
    ]
  },
  "reasoning": "Based on 12 similar sold products. Visual quality assessment: Good condition with clear photos."
}
```

---

## Performance Benchmarks

| Operation | Latency | Cost |
|-----------|---------|------|
| Single image analysis | <1s | $0.000096 |
| Batch 3 images | <3s | $0.000288 |
| Full pricing suggestion | 1-2s | $0.000096 |
| 1000 images/month | - | $0.096 |
| 100K images/month | - | $9.60 |

---

## Troubleshooting

### Issue: "Model not found"
**Cause:** Bedrock Nova Lite not available in region
**Solution:** Use `us-east-1` region

### Issue: Invalid base64 image
**Cause:** Image not properly encoded
**Solution:** Verify Base64 encoding, check image format

### Issue: Empty defects list but low score
**Cause:** Nova Lite focuses on overall condition, not just defects
**Solution:** Check conditionScore and photoQualityScore values

### Issue: Multiplier is always 1.0
**Cause:** Service is degrading due to error
**Solution:** Check CloudWatch logs for Bedrock errors

---

## Testing

### Run Unit Tests
```bash
npm test -- vision-analysis.test.ts
```

### Test Single Image
```bash
# Use local image file
const imageData = fs.readFileSync('./test-image.jpg');
const base64 = imageData.toString('base64');
const assessment = await visionAnalysis.assessVisualQuality(base64);
```

---

## AWS Costs

### Cost Breakdown

- **Per Request:** $0.000096
- **Input Tokens (avg):** 500
- **Output Tokens (avg):** 100
- **Monthly 10K:** $0.96
- **Monthly 100K:** $9.60

### Cost Optimization Tips

1. Use smaller images (500KB-2MB)
2. Batch process during off-peak hours
3. Cache assessments for similar images
4. Monitor usage in CloudWatch Billing
5. Set up cost alerts for budget control

---

## Type Definitions

```typescript
interface VisualQualityAssessment {
  conditionScore: number;        // 1-10
  photoQualityScore: number;     // 1-10
  visibleDefects: string[];
  overallAssessment: 'excellent' | 'good' | 'fair' | 'poor';
  pricingImpact: 'increase' | 'neutral' | 'decrease';
  reasoning: string;
  multiplier: number;            // 0.75-1.15
}

interface ProductContext {
  category?: string;
  brand?: string;
  claimedCondition?: string;
}

interface PricingSuggestion {
  suggestedPrice: number;
  priceRange: { min: number; max: number };
  confidence: number;
  currency: string;
  factors: {
    basePrice: number;
    seasonalMultiplier: number;
    conditionMultiplier: number;
    visualQualityMultiplier: number;
    visualQualityDetails: string;
    visualQualityAssessment?: VisualQualityAssessment;
    similarProducts?: Array<{
      productId: string;
      similarity: number;
      salePrice: number;
      saleDate: string;
      condition: string;
    }>;
  };
  reasoning: string;
}
```

---

## Links

- [Full Documentation](./VISION_ANALYSIS_IMPLEMENTATION.md)
- [Delivery Summary](./BEDROCK_NOVA_LITE_DELIVERY.md)
- [Implementation Source](./src/lib/pricing/vision-analysis.ts)
- [Pricing Engine](./src/lib/pricing/visual-similarity-pricing.ts)
- [Unit Tests](./src/lib/pricing/__tests__/vision-analysis.test.ts)
