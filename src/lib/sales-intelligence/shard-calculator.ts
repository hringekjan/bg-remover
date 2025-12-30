/**
 * Shard Calculator for Sales Intelligence Table
 *
 * Deterministic shard assignment for DynamoDB write distribution.
 * Uses consistent hashing to ensure the same input always maps to same shard,
 * enabling efficient queries across all shards.
 *
 * Sharding Strategy:
 * - Category GSI: 10 shards (0-9) for write distribution
 * - Embedding GSI: 5 shards (0-4) for read distribution
 *
 * @module lib/sales-intelligence/shard-calculator
 */

/**
 * Calculate shard for Category-Season GSI (10 shards)
 *
 * Used when writing to GSI1 for category trend analysis.
 * Distributes writes evenly to avoid hotspots.
 *
 * Sharding approach:
 * 1. Use sale ID as hash input (unique per sale)
 * 2. Take last character for distribution
 * 3. Modulo 10 for shard assignment
 *
 * Example:
 * - saleId: "sale_abc123" → last char: "3" → shard: 3 % 10 = 3
 * - saleId: "sale_xyz999" → last char: "9" → shard: 9 % 10 = 9
 *
 * Benefits:
 * - O(1) calculation, no hashing overhead
 * - Deterministic: same saleId always produces same shard
 * - Even distribution: assumes UUIDs have random character distribution
 *
 * @param saleId - Unique identifier for the sale
 * @returns Shard number (0-9)
 */
export function getCategoryShard(saleId: string): number {
  if (!saleId || saleId.length === 0) {
    throw new Error('saleId cannot be empty');
  }

  const lastChar = saleId.slice(-1);
  const charCode = lastChar.charCodeAt(0);

  // Use modulo 10 for category shards
  return charCode % 10;
}

/**
 * Calculate shard for Embedding Product Lookup GSI (5 shards)
 *
 * Used when querying GSI2 for product embeddings.
 * Shards based on product ID hash for better read distribution.
 *
 * Sharding approach:
 * 1. Iterate through all characters in productId
 * 2. Build a numeric hash (bitwise operations)
 * 3. Modulo 5 for shard assignment
 *
 * Hash function rationale:
 * - Similar to Java's String.hashCode() for consistency
 * - Converts to 32-bit integer to avoid precision loss
 * - Uses bitwise OR (|= 0) to ensure 32-bit arithmetic
 *
 * Example:
 * - productId: "prod_12345" → hash: 123456 → shard: 123456 % 5 = 1
 * - productId: "prod_67890" → hash: 234567 → shard: 234567 % 5 = 2
 *
 * Benefits:
 * - Stable hashing: same productId always produces same shard
 * - Even distribution across 5 shards
 * - Works with any productId format (UUID, slug, numeric, etc.)
 *
 * @param productId - Unique identifier for the product
 * @returns Shard number (0-4)
 */
export function getEmbeddingShard(productId: string): number {
  if (!productId || productId.length === 0) {
    throw new Error('productId cannot be empty');
  }

  let hash = 0;

  // Hash the productId string to a number
  for (let i = 0; i < productId.length; i++) {
    const charCode = productId.charCodeAt(i);
    hash = (hash << 5) - hash + charCode;
    hash |= 0; // Convert to 32-bit integer
  }

  // Use modulo 5 for embedding shards
  return Math.abs(hash) % 5;
}

/**
 * Calculate shard for Brand GSI (sparse, no sharding needed)
 *
 * Brand GSI is sparse (only records with brand attribute),
 * so it doesn't need sharding. Returns 0 for consistency.
 *
 * Note: While we don't shard the brand GSI, we could add sharding
 * in the future if brand queries become write-heavy. Current strategy
 * is to only use this for read queries on brand dimension.
 *
 * @param _brandId - Brand identifier (unused, kept for API consistency)
 * @returns Shard number (always 0, no sharding needed)
 */
export function getBrandShard(_brandId: string): number {
  // Brand GSI is sparse, no sharding needed
  return 0;
}

/**
 * Verify shard assignment correctness
 *
 * Used in tests and during development to ensure shards are properly distributed.
 * Analyzes a batch of IDs and returns distribution statistics.
 *
 * Example usage:
 * ```typescript
 * const stats = verifyShardDistribution(
 *   Array.from({ length: 1000 }, (_, i) => `sale_${i}`),
 *   getCategoryShard,
 *   10
 * );
 * console.log(stats.distribution); // { 0: 102, 1: 98, ... }
 * console.log(stats.stdDev); // Should be < 10 for even distribution
 * ```
 *
 * @param ids - Array of IDs to analyze
 * @param shardFn - Function to calculate shard for an ID
 * @param shardCount - Total number of shards
 * @returns Distribution statistics
 */
export function verifyShardDistribution(
  ids: string[],
  shardFn: (id: string) => number,
  shardCount: number
): {
  distribution: Record<number, number>;
  stdDev: number;
  avgItemsPerShard: number;
  maxDeviation: number;
} {
  const distribution: Record<number, number> = {};

  // Initialize shard counters
  for (let i = 0; i < shardCount; i++) {
    distribution[i] = 0;
  }

  // Count items per shard
  for (const id of ids) {
    const shard = shardFn(id);
    if (shard < 0 || shard >= shardCount) {
      throw new Error(`Shard function returned invalid shard: ${shard}`);
    }
    distribution[shard]++;
  }

  // Calculate statistics
  const counts = Object.values(distribution);
  const avgItemsPerShard = ids.length / shardCount;

  // Standard deviation
  const variance =
    counts.reduce((sum, count) => sum + Math.pow(count - avgItemsPerShard, 2), 0) /
    shardCount;
  const stdDev = Math.sqrt(variance);

  // Maximum deviation from average
  const maxDeviation = Math.max(...counts) - Math.min(...counts);

  return {
    distribution,
    stdDev,
    avgItemsPerShard,
    maxDeviation,
  };
}

/**
 * Helper to build GSI1 Partition Key
 *
 * Encapsulates the key construction logic for consistency.
 * Used when writing to GSI1 for category trend analysis.
 *
 * Format: TENANT#{tenant}#CATEGORY#{category}#SHARD#{shard}
 *
 * @param tenant - Tenant identifier
 * @param category - Product category
 * @param shard - Shard number (0-9)
 * @returns GSI1 partition key
 */
export function buildGSI1PK(tenant: string, category: string, shard: number): string {
  if (!tenant || tenant.length === 0) throw new Error('tenant cannot be empty');
  if (!category || category.length === 0) throw new Error('category cannot be empty');
  if (shard < 0 || shard > 9) throw new Error('shard must be 0-9');

  return `TENANT#${tenant}#CATEGORY#${category}#SHARD#${shard}`;
}

/**
 * Validate date format and actual date validity
 *
 * Ensures date is in YYYY-MM-DD format AND is a valid calendar date:
 * - Month must be 01-12
 * - Day must be valid for the month (1-31 for most, 1-30 for some, 1-29 for Feb)
 *
 * @param dateStr - Date string to validate (YYYY-MM-DD)
 * @returns true if valid date, false otherwise
 */
export function isValidDate(dateStr: string): boolean {
  // Check format
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return false;
  }

  const [yearStr, monthStr, dayStr] = dateStr.split('-');
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);
  const day = parseInt(dayStr, 10);

  // Validate month (1-12)
  if (month < 1 || month > 12) {
    return false;
  }

  // Validate day (1-31)
  if (day < 1 || day > 31) {
    return false;
  }

  // Validate actual date (rejects Feb 31, Apr 31, etc.)
  const date = new Date(`${dateStr}T00:00:00Z`);
  if (isNaN(date.getTime())) {
    return false;
  }

  // Check that the parsed date matches the input
  const utcYear = date.getUTCFullYear();
  const utcMonth = String(date.getUTCMonth() + 1).padStart(2, '0');
  const utcDay = String(date.getUTCDate()).padStart(2, '0');

  return `${utcYear}-${utcMonth}-${utcDay}` === dateStr;
}

/**
 * Helper to build GSI1 Sort Key
 *
 * Format: DATE#{saleDate}#PRICE#{paddedPrice}
 *
 * Price is zero-padded to 10 digits for proper numeric sorting in DynamoDB.
 * Examples:
 * - Price $9.99 → "0000000999"
 * - Price $99.99 → "0000009999"
 * - Price $999.99 → "0000099999"
 *
 * @param saleDate - Sale date (YYYY-MM-DD format)
 * @param salePrice - Sale price in cents (e.g., 999 for $9.99)
 * @returns GSI1 sort key
 * @throws Error if saleDate is not a valid date
 */
export function buildGSI1SK(saleDate: string, salePrice: number): string {
  if (!isValidDate(saleDate)) {
    throw new Error(
      `saleDate must be a valid date in YYYY-MM-DD format (got: ${saleDate}). ` +
      'Month must be 01-12 and day must be valid for the month (e.g., no Feb 31).'
    );
  }
  if (salePrice < 0) throw new Error('salePrice cannot be negative');

  // Pad price to 10 digits for numeric sorting
  const paddedPrice = String(Math.floor(salePrice * 100)).padStart(10, '0');

  return `DATE#${saleDate}#PRICE#${paddedPrice}`;
}

/**
 * Helper to build GSI2 Partition Key
 *
 * Format: TENANT#{tenant}#EMBTYPE#PRODUCT#SHARD#{shard}
 *
 * @param tenant - Tenant identifier
 * @param shard - Shard number (0-4)
 * @returns GSI2 partition key
 */
export function buildGSI2PK(tenant: string, shard: number): string {
  if (!tenant || tenant.length === 0) throw new Error('tenant cannot be empty');
  if (shard < 0 || shard > 4) throw new Error('shard must be 0-4');

  return `TENANT#${tenant}#EMBTYPE#PRODUCT#SHARD#${shard}`;
}

/**
 * Helper to build GSI2 Sort Key
 *
 * Format: DATE#{saleDate}
 *
 * @param saleDate - Sale date (YYYY-MM-DD format)
 * @returns GSI2 sort key
 * @throws Error if saleDate is not a valid date
 */
export function buildGSI2SK(saleDate: string): string {
  if (!isValidDate(saleDate)) {
    throw new Error(
      `saleDate must be a valid date in YYYY-MM-DD format (got: ${saleDate}). ` +
      'Month must be 01-12 and day must be valid for the month (e.g., no Feb 31).'
    );
  }

  return `DATE#${saleDate}`;
}

/**
 * Helper to build GSI3 Partition Key (Brand GSI)
 *
 * Format: TENANT#{tenant}#BRAND#{brand}
 *
 * @param tenant - Tenant identifier
 * @param brand - Brand name
 * @returns GSI3 partition key
 */
export function buildGSI3PK(tenant: string, brand: string): string {
  if (!tenant || tenant.length === 0) throw new Error('tenant cannot be empty');
  if (!brand || brand.length === 0) throw new Error('brand cannot be empty');

  return `TENANT#${tenant}#BRAND#${brand}`;
}

/**
 * Helper to build GSI3 Sort Key
 *
 * Format: DATE#{saleDate}#PRICE#{paddedPrice}
 *
 * Same format as GSI1SK for consistency.
 *
 * @param saleDate - Sale date (YYYY-MM-DD format)
 * @param salePrice - Sale price in cents
 * @returns GSI3 sort key
 * @throws Error if saleDate is not a valid date
 */
export function buildGSI3SK(saleDate: string, salePrice: number): string {
  if (!isValidDate(saleDate)) {
    throw new Error(
      `saleDate must be a valid date in YYYY-MM-DD format (got: ${saleDate}). ` +
      'Month must be 01-12 and day must be valid for the month (e.g., no Feb 31).'
    );
  }
  if (salePrice < 0) throw new Error('salePrice cannot be negative');

  const paddedPrice = String(Math.floor(salePrice * 100)).padStart(10, '0');

  return `DATE#${saleDate}#PRICE#${paddedPrice}`;
}
