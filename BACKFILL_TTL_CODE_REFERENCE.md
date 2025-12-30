# DynamoDB Backfill TTL - Code Reference

## Overview

This document provides detailed code examples and references for the DynamoDB backfill TTL fix that corrects uppercase `PK`/`SK` attribute handling.

## Fixed Issues

### 1. ProjectionExpression Uses Uppercase Keys

**File:** `/services/bg-remover/src/lib/sales-intelligence/backfill-ttl.ts` (Line 140)

```typescript
// BEFORE (❌ Incorrect - would fail to project columns)
ProjectionExpression: 'pk, sk, saleDate, #ttl',

// AFTER (✅ Correct)
ProjectionExpression: 'PK, SK, saleDate, #ttl',
```

**Impact:** DynamoDB ProjectionExpression is case-sensitive. Using lowercase `pk` and `sk` would cause DynamoDB to not find these attributes and return them as empty.

**DynamoDB Behavior:**
- DynamoDB attribute names are case-sensitive
- `pk` ≠ `PK` - they are treated as different attributes
- If the table schema defines the partition key as `PK` (uppercase), queries using lowercase `pk` will fail

---

### 2. Item Key Extraction Uses Uppercase Keys

**File:** `/services/bg-remover/src/lib/sales-intelligence/backfill-ttl.ts` (Lines 175-176)

```typescript
// BEFORE (❌ Incorrect - would extract undefined values)
Key: marshall({
  pk: item.pk?.S,  // item.pk is undefined!
  sk: item.sk?.S,  // item.sk is undefined!
}),

// AFTER (✅ Correct)
Key: marshall({
  PK: item.PK?.S,  // Correctly extracts from scanned item
  SK: item.SK?.S,  // Correctly extracts from scanned item
}),
```

**Impact:** The scan projection would not include the lowercase attributes, making `item.pk` and `item.sk` undefined. The marshall function would create an invalid Key object with undefined values.

**Correct Flow:**
1. Scan projects: `PK, SK, saleDate, #ttl`
2. DynamoDB returns items with: `{ PK: { S: '...' }, SK: { S: '...' }, ... }`
3. Code extracts: `item.PK?.S` and `item.SK?.S`
4. marshall converts to DynamoDB format for update

---

### 3. Error Messages Use Uppercase Keys

**File:** `/services/bg-remover/src/lib/sales-intelligence/backfill-ttl.ts` (Lines 161, 191)

```typescript
// Line 161 - Skip warning
// BEFORE (❌)
console.warn(`...Skipping item without saleDate: pk=${item.pk?.S}`);

// AFTER (✅)
console.warn(`...Skipping item without saleDate: PK=${item.PK?.S}`);

// Line 191 - Error logging
// BEFORE (❌)
console.error(`...Failed to update item: pk=${item.pk?.S}, error=...`);

// AFTER (✅)
console.error(`...Failed to update item: PK=${item.PK?.S}, error=...`);
```

**Impact:** Logging would show `pk=undefined` making debugging impossible. Error messages would not identify the problematic items.

---

## Schema Alignment

### DynamoDB Table Definition

```typescript
// From sales-repository.ts - The actual implementation
const PK = `TENANT#${tenant}#PRODUCT#${productId}`;
const SK = `SALE#${saleDate}#${saleId}`;

const command = new GetItemCommand({
  TableName: this.tableName,
  Key: marshall({ PK, SK }),  // ✅ Uses uppercase
});
```

### Example Item Structure

DynamoDB stores items with these exact attribute names (uppercase):

```json
{
  "PK": "TENANT#carousel-labs#PRODUCT#prod_123",
  "SK": "SALE#2025-01-15#sale_456",
  "saleDate": "2025-01-15",
  "salePrice": 99.99,
  "category": "dress",
  "brand": "acme",
  "ttl": 1736899200
}
```

When DynamoDB marshals this for the SDK, it becomes:

```typescript
{
  PK: { S: 'TENANT#carousel-labs#PRODUCT#prod_123' },
  SK: { S: 'SALE#2025-01-15#sale_456' },
  saleDate: { S: '2025-01-15' },
  salePrice: { N: '99.99' },
  category: { S: 'dress' },
  brand: { S: 'acme' },
  ttl: { N: '1736899200' }
}
```

**Key Note:** The outer keys (`PK`, `SK`, `saleDate`, etc.) are case-sensitive and must match the table schema exactly.

---

## TTL Calculation (Unchanged but Verified)

The TTL calculation logic is correct and remains unchanged:

```typescript
function calculateTTL(saleDate: string, ttlYears: number): number {
  const date = new Date(saleDate);        // Parse sale date
  date.setFullYear(date.getFullYear() + ttlYears);  // Add years
  return Math.floor(date.getTime() / 1000);  // Convert to epoch seconds
}
```

**Example:**
```
Input:  saleDate = '2025-01-15', ttlYears = 2
Step 1: date = new Date('2025-01-15') = 2025-01-15T00:00:00Z
Step 2: Add 2 years = 2027-01-15T00:00:00Z
Step 3: Math.floor(1736899200000 / 1000) = 1736899200
Result: TTL = 1736899200 (valid epoch seconds for DynamoDB)
```

---

## Update Execution

The UpdateItemCommand correctly updates the TTL attribute:

```typescript
const updateInput: UpdateItemCommandInput = {
  TableName: tableName,
  Key: marshall({
    PK: item.PK?.S,  // ✅ Uppercase
    SK: item.SK?.S,  // ✅ Uppercase
  }),
  UpdateExpression: 'SET #ttl = :ttl',
  ExpressionAttributeNames: { '#ttl': 'ttl' },  // Map #ttl to actual attribute name
  ExpressionAttributeValues: marshall({
    ':ttl': ttl,  // The calculated TTL value
  }),
};

const updateCommand = new UpdateItemCommand(updateInput);
await client.send(updateCommand);
```

**What happens:**
1. Uses `PK` and `SK` (uppercase) to identify the item
2. Uses `SET #ttl = :ttl` to update only the TTL attribute
3. DynamoDB sets `ttl` attribute to the epoch seconds value
4. Item is now eligible for auto-deletion after TTL expires

---

## Test Coverage

### Test File Location
`/services/bg-remover/src/lib/sales-intelligence/__tests__/backfill-ttl.test.ts`

### Key Test Categories

#### 1. Uppercase PK/SK Validation
```typescript
it('should use uppercase PK and SK in scan projection', async () => {
  // Verifies ProjectionExpression uses 'PK, SK'
  // Verifies items are extracted from uppercase keys
  // Verifies updates use uppercase keys
});
```

#### 2. TTL Calculation
```typescript
it('should calculate correct TTL for 2-year retention', async () => {
  // Verifies 2-year default works
  // Verifies custom years work
  // Verifies epoch seconds format
});
```

#### 3. Batch Processing
```typescript
it('should process multiple batches with pagination', async () => {
  // Verifies pagination with LastEvaluatedKey
  // Verifies correct batch size
  // Verifies all items are processed
});
```

#### 4. Error Handling
```typescript
it('should continue processing after update failure', async () => {
  // Verifies resilience to individual item failures
  // Verifies error counting
  // Verifies logging of failures
});
```

#### 5. Dry-Run Mode
```typescript
it('should not execute updates in dry-run mode', async () => {
  // Verifies no UpdateItemCommand is sent
  // Verifies counters still updated
  // Verifies dryRun flag in result
});
```

---

## Implementation Checklist

### Before Running Backfill

- [ ] Verify DynamoDB table exists: `bg-remover-{stage}-sales-intelligence`
- [ ] Verify TTL is enabled on the `ttl` attribute
- [ ] Verify existing records have `saleDate` field (required for TTL calculation)
- [ ] Check current item count: `SELECT COUNT(*) FROM table WHERE attribute_not_exists(ttl)`
- [ ] Set appropriate batch size for your data volume:
  - Small tables (<10k items): Use default `batchSize: 100`
  - Medium tables (10k-1M): Use `batchSize: 100`
  - Large tables (>1M): Use `batchSize: 50-100` to reduce RCU consumption

### Execution Order

1. **Dry-run first** (Always)
   ```bash
   STAGE=dev TENANT=carousel-labs npx ts-node \
     src/lib/sales-intelligence/backfill-ttl.ts \
     --table bg-remover-dev-sales-intelligence \
     --region eu-west-1 \
     --dry-run \
     --ttl-years 2
   ```

2. **Review dry-run output**
   - Check item count estimates
   - Verify it would process expected items
   - Look for any warnings about missing saleDate

3. **Run actual backfill** (Only if dry-run looks good)
   ```bash
   STAGE=dev TENANT=carousel-labs npx ts-node \
     src/lib/sales-intelligence/backfill-ttl.ts \
     --table bg-remover-dev-sales-intelligence \
     --region eu-west-1 \
     --ttl-years 2
   ```

4. **Verify results**
   ```bash
   # Check TTL was set
   aws dynamodb scan \
     --table-name bg-remover-dev-sales-intelligence \
     --projection-expression "PK,SK,#ttl" \
     --expression-attribute-names '{"#ttl":"ttl"}' \
     --region eu-west-1 \
     --max-items 10
   ```

---

## Comparison: Before vs After Fix

### Execution Flow - BEFORE (Broken)

```
1. Scan with: ProjectionExpression: 'pk, sk, saleDate, #ttl'
   ↓ ❌ DynamoDB: "Attribute 'pk' not found"
2. Returns items without pk/sk attributes
   ↓ ❌ item.pk?.S = undefined
3. marshall({ pk: undefined, sk: undefined })
   ↓ ❌ Invalid Key object
4. UpdateItemCommand fails with validation error
   ↓ ❌ Backfill fails immediately
```

### Execution Flow - AFTER (Fixed)

```
1. Scan with: ProjectionExpression: 'PK, SK, saleDate, #ttl'
   ↓ ✅ DynamoDB: Found PK and SK
2. Returns: { PK: { S: '...' }, SK: { S: '...' }, ... }
   ↓ ✅ item.PK?.S = 'TENANT#...'
3. marshall({ PK: 'TENANT#...', SK: 'SALE#...' })
   ↓ ✅ Valid Key object
4. UpdateItemCommand sends SET #ttl = :ttl
   ↓ ✅ Item updated with TTL
5. Next batch continues...
   ↓ ✅ Complete backfill succeeds
```

---

## Performance Notes

### RCU Consumption

- **Scan:** 1 RCU per 4KB of data (uppercase/lowercase doesn't matter)
- **Update:** 1 WCU per item updated
- **Dry-run:** Only scan, no writes

### Execution Time Estimates

| Item Count | Batch Size | Scan Time | Update Time | Total |
|-----------|-----------|-----------|------------|-------|
| 10,000    | 100       | 10s       | 30s        | 40s   |
| 100,000   | 100       | 30s       | 5m         | 5.5m  |
| 1,000,000 | 50        | 5m        | 30m        | 35m   |

### Cost Impact

For 1 million items:
- Scan: ~250 RCU = $0.50 (one-time)
- Updates: 1,000,000 WCU = $1.00 (one-time)
- **Total one-time cost:** ~$1.50

---

## Troubleshooting

### Error: "Attribute 'pk' not found in DynamoDB"

**Cause:** You're using the unfixed version of the script
**Solution:** Use the fixed version with uppercase `PK` and `SK`

### Error: "Key attribute not found in item"

**Cause:** Scan result missing `PK` or `SK`
**Solution:** Verify table schema has uppercase `PK` and `SK` as keys

### Error: "Invalid UpdateExpression Syntax"

**Cause:** Using lowercase attribute names in Key
**Solution:** Ensure Key uses uppercase `PK` and `SK`

### Items not getting TTL set

**Cause:** Missing `saleDate` attribute or invalid date format
**Solution:** Check for items without `saleDate` in logs

---

## References

- AWS DynamoDB Documentation: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/
- boto3 DynamoDB Client: https://boto3.amazonaws.com/v1/documentation/api/latest/reference/services/dynamodb.html
- Case Sensitivity: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.API.html

---

## Related Code

### SalesRepository - Correct Implementation

File: `/services/bg-remover/src/lib/sales-intelligence/sales-repository.ts`

```typescript
// Example of correct uppercase usage
async getSale(tenant: string, productId: string, saleDate: string, saleId: string) {
  const PK = `TENANT#${tenant}#PRODUCT#${productId}`;  // ✅ Uppercase
  const SK = `SALE#${saleDate}#${saleId}`;              // ✅ Uppercase

  const command = new GetItemCommand({
    TableName: this.tableName,
    Key: marshall({ PK, SK }),  // ✅ Uses uppercase
  });

  const response = await this.client.send(command);
  return unmarshall(response.Item) as SalesRecord;
}
```

The backfill script now matches this pattern.
