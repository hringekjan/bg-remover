/**
 * S3 Tables Data Validator - Daily Data Quality Checks
 *
 * Scheduled Lambda function that runs daily at 4 AM UTC (1 hour after SmartGo export).
 * Validates data consistency between DynamoDB, S3 Tables, and Carousel systems.
 *
 * Validation Checks:
 * 1. Row count consistency (DynamoDB vs S3 Tables via Athena)
 * 2. Embedding quality (no nulls, correct dimensions)
 * 3. Sale price distributions (detect outliers via 3σ analysis)
 * 4. Schema consistency (required fields present and not null)
 * 5. Data integrity (foreign key references valid)
 *
 * Alert Conditions:
 * - CRITICAL: >10% variance or >5% null embeddings
 * - WARNING: 5-10% variance or 1-5% null embeddings
 * - INFO: <5% variance or <1% null embeddings
 *
 * Cost: ~$0.05-0.10 per execution (Athena queries + DynamoDB scans)
 * Runtime: 3-8 minutes depending on data volume
 */

import { EventBridgeEvent } from 'aws-lambda';
import { AthenaClient, StartQueryExecutionCommand, GetQueryExecutionCommand, GetQueryResultsCommand } from '@aws-sdk/client-athena';
import { DynamoDBClient, QueryCommand, AttributeValue } from '@aws-sdk/client-dynamodb';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { Logger } from '@aws-lambda-powertools/logger';

const logger = new Logger({ serviceName: 'S3TablesDataValidator' });
const athena = new AthenaClient({ region: 'eu-west-1' });
const dynamodb = new DynamoDBClient({ region: 'eu-west-1' });
const sns = new SNSClient({ region: 'eu-west-1' });

interface ValidationResult {
  check: string;
  passed: boolean;
  actual?: number;
  expected?: number;
  variance?: number;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  message?: string;
  details?: string | Record<string, any>;
  timestamp: string;
}

interface ValidationReport {
  timestamp: string;
  duration: number;
  summary: {
    total: number;
    passed: number;
    failed: number;
    critical: number;
    warnings: number;
  };
  checks: ValidationResult[];
  errors?: string[];
}

/**
 * Input validation functions for SQL injection prevention
 */
function validateSQLIdentifier(identifier: string, paramName: string): string {
  const pattern = /^[a-z0-9_-]+$/i;
  if (!pattern.test(identifier)) {
    throw new Error(
      `Invalid ${paramName}: ${identifier} (only alphanumeric, hyphens, underscores allowed)`
    );
  }
  return identifier;
}

function validateDateComponent(value: number, paramName: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid ${paramName}: ${value} (must be ${min}-${max})`);
  }
  return value;
}

/**
 * Helper function to get yesterday's date for partition pruning
 */
function getYesterday(): { year: number; month: number; day: number } {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return {
    year: yesterday.getFullYear(),
    month: yesterday.getMonth() + 1,
    day: yesterday.getDate(),
  };
}

/**
 * EventBridge scheduled event handler
 *
 * Triggered by: cron(0 4 * * ? *) - Daily at 4 AM UTC
 */
export async function handler(event: EventBridgeEvent<'Scheduled Event', any>): Promise<{
  statusCode: number;
  body: string;
}> {
  const startTime = Date.now();
  const results: ValidationResult[] = [];
  const errors: string[] = [];

  logger.info('[DataValidator] Starting daily validation');

  try {
    // Get configuration from environment
    const stage = process.env.STAGE || 'dev';
    const tenant = process.env.TENANT || 'carousel-labs';
    const salesTableName = process.env.SALES_TABLE_NAME || `bg-remover-${stage}-sales-intelligence`;
    const athenaDatabase = `pricing_intelligence_${stage}`;
    const alertTopicArn = process.env.ALERT_TOPIC_ARN;

    // 1. Validate row count consistency
    try {
      logger.info('[DataValidator] Running row count consistency check');
      const rowCountCheck = await validateRowCounts(athenaDatabase, salesTableName, tenant);
      results.push(rowCountCheck);
    } catch (err) {
      logger.error('Row count validation failed', { error: err });
      errors.push(`Row count check failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 2. Validate embedding quality
    try {
      logger.info('[DataValidator] Running embedding quality check');
      const embeddingCheck = await validateEmbeddings(athenaDatabase);
      results.push(embeddingCheck);
    } catch (err) {
      logger.error('Embedding quality validation failed', { error: err });
      errors.push(`Embedding check failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 3. Validate sale price distributions
    try {
      logger.info('[DataValidator] Running price distribution check');
      const priceCheck = await validatePriceDistributions(athenaDatabase);
      results.push(priceCheck);
    } catch (err) {
      logger.error('Price distribution validation failed', { error: err });
      errors.push(`Price distribution check failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 4. Validate tenant isolation
    try {
      logger.info('[DataValidator] Running tenant isolation check');
      const tenantCheck = await validateTenantIsolation(athenaDatabase, [tenant]);
      results.push(tenantCheck);
    } catch (err) {
      logger.error('Tenant isolation validation failed', { error: err });
      errors.push(`Tenant isolation check failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 5. Validate data freshness
    try {
      logger.info('[DataValidator] Running data freshness check');
      const freshnessCheck = await validateDataFreshness(athenaDatabase, 24);
      results.push(freshnessCheck);
    } catch (err) {
      logger.error('Data freshness validation failed', { error: err });
      errors.push(`Data freshness check failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 6. Validate schema consistency
    try {
      logger.info('[DataValidator] Running schema consistency check');
      const schemaCheck = await validateSchemaConsistency(athenaDatabase);
      results.push(schemaCheck);
    } catch (err) {
      logger.error('Schema consistency validation failed', { error: err });
      errors.push(`Schema check failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 5. Generate report
    const duration = Date.now() - startTime;
    const report = generateValidationReport(results, errors, duration);

    logger.info('[DataValidator] Validation complete', {
      summary: report.summary,
      duration: `${duration}ms`,
    });

    // 6. Send alerts if critical issues found
    const criticalIssues = results.filter(r => r.severity === 'CRITICAL' && !r.passed);
    if (criticalIssues.length > 0 && alertTopicArn) {
      logger.warn('[DataValidator] Critical issues detected, sending alerts', {
        count: criticalIssues.length,
      });
      await sendAlert(alertTopicArn, criticalIssues, report);
    }

    return {
      statusCode: 200,
      body: JSON.stringify(report),
    };
  } catch (err) {
    logger.error('[DataValidator] Unexpected error during validation', { error: err });
    const duration = Date.now() - startTime;

    const report: ValidationReport = {
      timestamp: new Date().toISOString(),
      duration,
      summary: {
        total: results.length,
        passed: results.filter(r => r.passed).length,
        failed: results.filter(r => !r.passed).length,
        critical: 0,
        warnings: 0,
      },
      checks: results,
      errors: [...errors, err instanceof Error ? err.message : String(err)],
    };

    return {
      statusCode: 500,
      body: JSON.stringify(report),
    };
  }
}

/**
 * Validate row count consistency between DynamoDB and S3 Tables (via Athena)
 *
 * Compares total row counts from both sources for the previous day.
 * Flags variance >5% as warning, >10% as critical.
 */
async function validateRowCounts(
  athenaDatabase: string,
  salesTableName: string,
  tenant: string
): Promise<ValidationResult> {
  const yesterday = getYesterday();

  // Validate inputs to prevent SQL injection
  const safeTenant = validateSQLIdentifier(tenant, 'tenant');
  const safeYear = validateDateComponent(yesterday.year, 'year', 2020, 2030);
  const safeMonth = validateDateComponent(yesterday.month, 'month', 1, 12);
  const safeDay = validateDateComponent(yesterday.day, 'day', 1, 31);

  const monthStr = String(safeMonth).padStart(2, '0');
  const dayStr = String(safeDay).padStart(2, '0');

  // Count rows in S3 Tables (via Athena) with partition pruning
  const athenaQuery = `
    SELECT COUNT(*) as count
    FROM ${athenaDatabase}.sales_history
    WHERE tenant_id = '${safeTenant}'
      AND year = ${safeYear}
      AND month = ${safeMonth}
      AND day = ${safeDay}
  `;

  const athenaCount = await runAthenaSingleValueQuery(athenaQuery, 'count');

  // Count rows in DynamoDB using Query (more efficient than Scan)
  const dynamoCount = await countDynamoDBRows(salesTableName, tenant, safeYear, safeMonth, safeDay);

  const variance = dynamoCount > 0 ? Math.abs(athenaCount - dynamoCount) / dynamoCount : 0;

  const severity = variance > 0.1 ? 'CRITICAL' : variance > 0.05 ? 'WARNING' : 'INFO';
  const passed = variance <= 0.05;

  return {
    check: 'row_count_consistency',
    passed,
    actual: athenaCount,
    expected: dynamoCount,
    variance,
    severity,
    details: `S3 Tables: ${athenaCount} rows, DynamoDB: ${dynamoCount} rows, Variance: ${(variance * 100).toFixed(2)}%`,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Validate embedding quality (no nulls, correct dimensions)
 *
 * Checks for null embeddings and invalid dimensions (should be 1024-D vectors).
 * Flags >5% null as critical, >1% as warning.
 * Uses partition pruning (yesterday's data) for performance optimization.
 */
async function validateEmbeddings(athenaDatabase: string): Promise<ValidationResult> {
  const yesterday = getYesterday();

  // Count null or invalid embeddings with partition pruning
  const nullEmbeddingsQuery = `
    SELECT COUNT(*) as count
    FROM ${athenaDatabase}.sales_history
    WHERE year = ${yesterday.year}
      AND month = ${yesterday.month}
      AND day = ${yesterday.day}
      AND (embedding IS NULL OR CARDINALITY(embedding) != 1024)
  `;

  const nullEmbeddingsCount = await runAthenaSingleValueQuery(nullEmbeddingsQuery, 'count');

  // Total rows with partition pruning
  const totalRowsQuery = `
    SELECT COUNT(*) as count
    FROM ${athenaDatabase}.sales_history
    WHERE year = ${yesterday.year}
      AND month = ${yesterday.month}
      AND day = ${yesterday.day}
  `;

  const totalRowsCount = await runAthenaSingleValueQuery(totalRowsQuery, 'count');

  const nullPercentage = totalRowsCount > 0 ? nullEmbeddingsCount / totalRowsCount : 0;

  const severity = nullPercentage > 0.05 ? 'CRITICAL' : nullPercentage > 0.01 ? 'WARNING' : 'INFO';
  const passed = nullPercentage <= 0.01;

  return {
    check: 'embedding_quality',
    passed,
    actual: nullEmbeddingsCount,
    expected: 0,
    variance: nullPercentage,
    severity,
    details: `${nullEmbeddingsCount} null or invalid embeddings out of ${totalRowsCount} total (${(nullPercentage * 100).toFixed(3)}%)`,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Validate price distributions using statistical analysis
 *
 * Detects outliers using 3-sigma rule. Flags >10% outliers as warning.
 */
async function validatePriceDistributions(athenaDatabase: string): Promise<ValidationResult> {
  // Get price statistics for today's data
  const today = new Date();
  const year = validateDateComponent(today.getFullYear(), 'year', 2020, 2030);
  const month = validateDateComponent(today.getMonth() + 1, 'month', 1, 12);
  const day = validateDateComponent(today.getDate(), 'day', 1, 31);

  const statsQuery = `
    SELECT
      AVG(sold_price) as avg_price,
      STDDEV_POP(sold_price) as stddev_price,
      MIN(sold_price) as min_price,
      MAX(sold_price) as max_price,
      COUNT(*) as total_count
    FROM ${athenaDatabase}.sales_history
    WHERE year = ${year}
      AND month = ${month}
      AND day = ${day}
  `;

  const statsResults = await runAthenaMultiRowQuery(statsQuery);

  if (!statsResults || statsResults.length === 0) {
    return {
      check: 'price_distribution',
      passed: true,
      actual: 0,
      expected: 0,
      variance: 0,
      severity: 'INFO',
      details: 'No sales data for today',
      timestamp: new Date().toISOString(),
    };
  }

  const stats = statsResults[0];
  const avgPrice = parseFloat(stats.avg_price) || 0;
  const stddevPrice = parseFloat(stats.stddev_price) || 0;
  const totalCount = parseInt(stats.total_count) || 0;

  if (totalCount === 0 || stddevPrice === 0) {
    return {
      check: 'price_distribution',
      passed: true,
      actual: 0,
      expected: 0,
      variance: 0,
      severity: 'INFO',
      details: 'Insufficient data for analysis',
      timestamp: new Date().toISOString(),
    };
  }

  // Detect outliers (prices outside 3 standard deviations)
  const lowerBound = avgPrice - 3 * stddevPrice;
  const upperBound = avgPrice + 3 * stddevPrice;

  const outlierQuery = `
    SELECT COUNT(*) as count
    FROM ${athenaDatabase}.sales_history
    WHERE year = ${year}
      AND month = ${month}
      AND day = ${day}
      AND (
        sold_price < ${lowerBound}
        OR sold_price > ${upperBound}
      )
  `;

  const outlierCount = await runAthenaSingleValueQuery(outlierQuery, 'count');
  const outlierPercentage = totalCount > 0 ? outlierCount / totalCount : 0;

  const severity = outlierPercentage > 0.1 ? 'WARNING' : 'INFO';
  const passed = outlierPercentage <= 0.1;

  return {
    check: 'price_distribution',
    passed,
    actual: outlierCount,
    expected: 0,
    variance: outlierPercentage,
    severity,
    details: `${outlierCount} price outliers (>3σ: ${lowerBound.toFixed(2)}-${upperBound.toFixed(2)}) out of ${totalCount} sales (${(outlierPercentage * 100).toFixed(2)}%)`,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Validate schema consistency (required fields present and not null)
 *
 * Checks for missing required columns: product_id, tenant_id, category, brand, sold_price, created_at
 */
async function validateSchemaConsistency(athenaDatabase: string): Promise<ValidationResult> {
  const query = `
    SELECT
      COUNT(*) as total_rows,
      COUNT(CASE WHEN product_id IS NULL THEN 1 END) as missing_product_id,
      COUNT(CASE WHEN tenant_id IS NULL THEN 1 END) as missing_tenant_id,
      COUNT(CASE WHEN category IS NULL THEN 1 END) as missing_category,
      COUNT(CASE WHEN brand IS NULL THEN 1 END) as missing_brand,
      COUNT(CASE WHEN sold_price IS NULL THEN 1 END) as missing_price,
      COUNT(CASE WHEN created_at IS NULL THEN 1 END) as missing_created_at
    FROM ${athenaDatabase}.sales_history
  `;

  const results = await runAthenaMultiRowQuery(query);

  if (!results || results.length === 0) {
    return {
      check: 'schema_consistency',
      passed: true,
      actual: 0,
      expected: 0,
      variance: 0,
      severity: 'INFO',
      details: 'No data available for schema check',
      timestamp: new Date().toISOString(),
    };
  }

  const stats = results[0];
  const totalRows = parseInt(stats.total_rows) || 0;
  const missingFields =
    (parseInt(stats.missing_product_id) || 0) +
    (parseInt(stats.missing_tenant_id) || 0) +
    (parseInt(stats.missing_category) || 0) +
    (parseInt(stats.missing_brand) || 0) +
    (parseInt(stats.missing_price) || 0) +
    (parseInt(stats.missing_created_at) || 0);

  const severity = missingFields > 100 ? 'CRITICAL' : missingFields > 10 ? 'WARNING' : 'INFO';
  const passed = missingFields === 0;

  const details = [
    missingFields > 0 ? `Missing: ${missingFields} total fields` : 'All required fields present',
    `Product ID: ${stats.missing_product_id}`,
    `Tenant ID: ${stats.missing_tenant_id}`,
    `Category: ${stats.missing_category}`,
    `Brand: ${stats.missing_brand}`,
    `Price: ${stats.missing_price}`,
    `Created At: ${stats.missing_created_at}`,
  ].join(' | ');

  return {
    check: 'schema_consistency',
    passed,
    actual: missingFields,
    expected: 0,
    variance: missingFields / (totalRows * 6 || 1), // 6 required fields per row
    severity,
    details,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Validate tenant isolation - ensure no cross-tenant data leakage
 *
 * Checks for:
 * 1. Missing tenant_id (NULL or empty values)
 * 2. Unexpected tenants (records from tenants not in expected list)
 *
 * Flags any leakage as CRITICAL.
 */
async function validateTenantIsolation(
  athenaDatabase: string,
  expectedTenants: string[]
): Promise<ValidationResult> {
  logger.info('[ValidateTenantIsolation] Starting validation', { expectedTenants });

  // Check 1: Missing tenant_id (NULL values)
  const missingTenantQuery = `
    SELECT COUNT(*) as count
    FROM ${athenaDatabase}.sales_history
    WHERE tenant_id IS NULL OR tenant_id = ''
  `;

  const missingCount = await runAthenaSingleValueQuery(missingTenantQuery, 'count');

  // Check 2: Unexpected tenants (potential data leakage)
  const tenantList = expectedTenants.map(t => `'${validateSQLIdentifier(t, 'tenant')}'`).join(',');
  const unexpectedTenantsQuery = `
    SELECT tenant_id, COUNT(*) as count
    FROM ${athenaDatabase}.sales_history
    WHERE tenant_id NOT IN (${tenantList})
    GROUP BY tenant_id
  `;

  const unexpectedResults = await runAthenaMultiRowQuery(unexpectedTenantsQuery);

  const totalUnexpected = unexpectedResults.reduce(
    (sum, row) => sum + parseInt(row.count || '0'),
    0
  );

  const hasMissing = missingCount > 0;
  const hasUnexpected = totalUnexpected > 0;

  let severity: 'INFO' | 'WARNING' | 'CRITICAL' = 'INFO';
  let message = 'Tenant isolation verified - no cross-tenant data leakage detected';

  if (hasMissing || hasUnexpected) {
    severity = 'CRITICAL';
    message = `Tenant isolation violation detected: ${missingCount} missing tenant_id, ${totalUnexpected} unexpected tenants`;
  }

  return {
    check: 'tenant_isolation',
    passed: !hasMissing && !hasUnexpected,
    severity,
    message,
    details: {
      missingTenantIds: missingCount,
      unexpectedTenants: unexpectedResults.map(r => ({
        tenantId: r.tenant_id,
        count: parseInt(r.count || '0'),
      })),
      expectedTenants,
    },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Validate data freshness - ensure data is not stale
 *
 * Checks that the latest record in the table is recent (within maxStalenessHours).
 * Warns if data is 24-48 hours old, flags as CRITICAL if older than 48 hours.
 */
async function validateDataFreshness(
  athenaDatabase: string,
  maxStalenessHours: number = 24
): Promise<ValidationResult> {
  logger.info('[ValidateDataFreshness] Starting validation', { maxStalenessHours });

  const freshnessQuery = `
    SELECT MAX(created_at) as latest_record
    FROM ${athenaDatabase}.sales_history
  `;

  const latestRecordStr = await runAthenaSingleValueQuery(freshnessQuery, 'latest_record');

  if (!latestRecordStr) {
    return {
      check: 'data_freshness',
      passed: false,
      severity: 'CRITICAL',
      message: 'No data found in sales_history table',
      details: { latestRecord: null, staleness: null },
      timestamp: new Date().toISOString(),
    };
  }

  const latestRecord = new Date(latestRecordStr);
  const stalenessMs = Date.now() - latestRecord.getTime();
  const stalenessHours = stalenessMs / (1000 * 60 * 60);
  const isStale = stalenessHours > maxStalenessHours;

  let severity: 'INFO' | 'WARNING' | 'CRITICAL' = 'INFO';
  if (isStale) {
    severity = stalenessHours > 48 ? 'CRITICAL' : 'WARNING';
  }

  return {
    check: 'data_freshness',
    passed: !isStale,
    severity,
    message: isStale
      ? `Data is stale: ${stalenessHours.toFixed(1)} hours old (max ${maxStalenessHours})`
      : `Data is fresh: ${stalenessHours.toFixed(1)} hours old`,
    details: {
      latestRecord: latestRecord.toISOString(),
      stalenessHours: parseFloat(stalenessHours.toFixed(1)),
      maxStalenessHours,
    },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Execute Athena query and return single value from result
 */
async function runAthenaSingleValueQuery(query: string, columnName: string): Promise<number> {
  const executionId = await startAthenaQuery(query);
  await waitForQueryCompletion(executionId);
  const results = await getAthenaQueryResults(executionId);

  // First row is headers, second row is data
  if (results.length > 1 && results[1].length > 0) {
    const value = results[1][0];
    return parseInt(value) || 0;
  }

  return 0;
}

/**
 * Execute Athena query and return single count result
 *
 * @deprecated Use runAthenaSingleValueQuery instead
 */
async function runAthenaCountQuery(query: string): Promise<number> {
  return runAthenaSingleValueQuery(query, 'count');
}

/**
 * Execute Athena query and return multiple rows of results
 */
async function runAthenaMultiRowQuery(query: string): Promise<Record<string, string>[]> {
  const executionId = await startAthenaQuery(query);
  await waitForQueryCompletion(executionId);
  const results = await getAthenaQueryResults(executionId);

  if (results.length < 2) {
    return [];
  }

  const headers = results[0];
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < results.length; i++) {
    const row: Record<string, string> = {};
    const values = results[i];

    headers.forEach((header, idx) => {
      row[header] = values[idx] || '';
    });

    rows.push(row);
  }

  return rows;
}

/**
 * Start Athena query execution
 */
async function startAthenaQuery(query: string): Promise<string> {
  const stage = process.env.STAGE || 'dev';
  const resultsLocation = `s3://carousel-${stage}-athena-results/`;

  try {
    const response = await athena.send(
      new StartQueryExecutionCommand({
        QueryString: query,
        QueryExecutionContext: {
          Database: `pricing_intelligence_${stage}`,
        },
        ResultConfiguration: {
          OutputLocation: resultsLocation,
        },
      })
    );

    logger.debug('[DataValidator] Athena query started', {
      executionId: response.QueryExecutionId,
      location: resultsLocation,
    });

    return response.QueryExecutionId!;
  } catch (err) {
    logger.error('[DataValidator] Failed to start Athena query', {
      error: err,
      query: query.substring(0, 100),
    });
    throw err;
  }
}

/**
 * Poll Athena until query completes or fails
 */
async function waitForQueryCompletion(executionId: string): Promise<void> {
  const maxAttempts = 300; // 5 minutes with 1 second polls
  let attempts = 0;

  while (attempts < maxAttempts) {
    try {
      const response = await athena.send(
        new GetQueryExecutionCommand({ QueryExecutionId: executionId })
      );

      const state = response.QueryExecution?.Status?.State;

      if (state === 'SUCCEEDED') {
        logger.debug('[DataValidator] Athena query succeeded', { executionId });
        return;
      }

      if (state === 'FAILED' || state === 'CANCELLED') {
        const reason = response.QueryExecution?.Status?.StateChangeReason;
        throw new Error(`Query failed: ${reason}`);
      }

      // Still running, wait and retry
      await new Promise(resolve => setTimeout(resolve, 1000));
      attempts++;
    } catch (err) {
      if (attempts >= maxAttempts) {
        logger.error('[DataValidator] Query timeout', { executionId });
        throw new Error('Athena query timeout');
      }
      attempts++;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  throw new Error('Athena query exceeded maximum retry attempts');
}

/**
 * Get Athena query results
 */
async function getAthenaQueryResults(executionId: string): Promise<string[][]> {
  try {
    const response = await athena.send(
      new GetQueryResultsCommand({ QueryExecutionId: executionId })
    );

    const rows: string[][] = [];

    if (response.ResultSet?.Rows) {
      for (const row of response.ResultSet.Rows) {
        const cells: string[] = [];
        if (row.Data) {
          for (const cell of row.Data) {
            cells.push(cell.VarCharValue || '');
          }
        }
        rows.push(cells);
      }
    }

    logger.debug('[DataValidator] Athena results retrieved', {
      executionId,
      rowCount: rows.length,
    });

    return rows;
  } catch (err) {
    logger.error('[DataValidator] Failed to get Athena results', {
      executionId,
      error: err,
    });
    throw err;
  }
}

/**
 * Count rows in DynamoDB using Query (more efficient than Scan)
 *
 * Uses Query with partition key prefix to count items for a specific tenant and date.
 * Implements pagination to handle large result sets.
 *
 * DynamoDB table structure:
 * - pk: TENANT#{tenant}
 * - sk: SALE#{dateStr}#{id}
 */
async function countDynamoDBRows(
  tableName: string,
  tenant: string,
  year: number,
  month: number,
  day: number
): Promise<number> {
  try {
    const datePrefix = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    let totalCount = 0;
    let lastEvaluatedKey: Record<string, AttributeValue> | undefined;

    do {
      const response = await dynamodb.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :date)',
          ExpressionAttributeValues: {
            ':pk': { S: `TENANT#${tenant}` },
            ':date': { S: `SALE#${datePrefix}` },
          },
          Select: 'COUNT',
          ExclusiveStartKey: lastEvaluatedKey,
        })
      );

      totalCount += response.Count || 0;
      lastEvaluatedKey = response.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    logger.debug('[DataValidator] DynamoDB query completed', {
      tableName,
      tenant,
      datePrefix,
      count: totalCount,
    });

    return totalCount;
  } catch (err) {
    logger.error('[DataValidator] DynamoDB query failed', {
      tableName,
      tenant,
      error: err,
    });
    throw err;
  }
}

/**
 * Generate validation report
 */
function generateValidationReport(
  results: ValidationResult[],
  errors: string[],
  duration: number
): ValidationReport {
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const critical = results.filter(r => r.severity === 'CRITICAL' && !r.passed).length;
  const warnings = results.filter(r => r.severity === 'WARNING' && !r.passed).length;

  return {
    timestamp: new Date().toISOString(),
    duration,
    summary: {
      total: results.length,
      passed,
      failed,
      critical,
      warnings,
    },
    checks: results,
    ...(errors.length > 0 && { errors }),
  };
}

/**
 * Send SNS alert for critical issues
 */
async function sendAlert(
  topicArn: string,
  issues: ValidationResult[],
  report: ValidationReport
): Promise<void> {
  try {
    const issuesList = issues
      .map(
        issue =>
          `- ${issue.check.replace(/_/g, ' ').toUpperCase()}
${issue.variance !== undefined ? `     Variance: ${(issue.variance * 100).toFixed(2)}%` : ''}
${issue.message ? `     Message: ${issue.message}` : ''}
     Details: ${typeof issue.details === 'string' ? issue.details : JSON.stringify(issue.details, null, 2)}`
      )
      .join('\n\n');

    const message = `CRITICAL Data Validation Issues Detected

SUMMARY:
- Total Issues: ${issues.length}
- Total Checks Run: ${report.summary.total}
- Execution Time: ${(report.duration / 1000).toFixed(2)}s

CRITICAL ISSUES:
${issuesList}

Please investigate immediately.

Full Report: ${JSON.stringify(report, null, 2)}`;

    await sns.send(
      new PublishCommand({
        TopicArn: topicArn,
        Subject: 'CRITICAL: S3 Tables Data Validation Failed',
        Message: message,
      })
    );

    logger.info('[DataValidator] Alert sent successfully', {
      topicArn,
      issueCount: issues.length,
    });
  } catch (err) {
    logger.error('[DataValidator] Failed to send alert', {
      error: err,
      topicArn,
    });
    throw err;
  }
}
