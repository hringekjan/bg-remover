/**
 * SmartGo Database Client
 *
 * Handles connection, authentication, and queries to SmartGo database.
 * Configuration is loaded from SSM Parameter Store for secure credential management.
 *
 * NOTE: This is a template for SmartGo database integration.
 * Actual implementation depends on:
 * - SmartGo database type (PostgreSQL, MySQL, etc.)
 * - Network connectivity (VPC, security groups)
 * - Authentication method (password, IAM, etc.)
 */

import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

/**
 * SmartGo database configuration structure
 */
export interface SmartGoConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  // Optional: API endpoint if using REST API instead of direct DB
  apiEndpoint?: string;
  apiKey?: string;
  // Optional: Connection pool settings
  maxConnections?: number;
  connectionTimeoutMs?: number;
  queryTimeoutMs?: number;
}

/**
 * SmartGo sale record from database
 */
export interface SmartGoSaleRecord {
  id: string; // Product ID
  tenantId: string;
  category: string;
  brand: string;
  condition: string;
  soldPrice: number;
  soldDate: string; // YYYY-MM-DD
  imageUrl: string;
  description: string;
  // Optional fields
  listingPrice?: number;
  daysToSell?: number;
  vendorId?: string;
}

/**
 * Load SmartGo database configuration from SSM Parameter Store
 *
 * SSM Parameter Path:
 * /tf/{stage}/smartgo/database/config
 *
 * Example configuration:
 * {
 *   "host": "smartgo-db.c9akciq32.us-east-1.rds.amazonaws.com",
 *   "port": 5432,
 *   "database": "smartgo_prod",
 *   "username": "smartgo_user",
 *   "password": "encrypted-password",
 *   "maxConnections": 10,
 *   "connectionTimeoutMs": 5000,
 *   "queryTimeoutMs": 30000
 * }
 */
export async function loadSmartGoConfig(stage: string = process.env.STAGE || 'dev'): Promise<SmartGoConfig> {
  const ssm = new SSMClient({ region: process.env.AWS_REGION || 'eu-west-1' });

  try {
    const paramName = `/tf/${stage}/smartgo/database/config`;
    const response = await ssm.send(
      new GetParameterCommand({
        Name: paramName,
        WithDecryption: true,
      })
    );

    if (!response.Parameter?.Value) {
      throw new Error(`Empty configuration for parameter: ${paramName}`);
    }

    const config = JSON.parse(response.Parameter.Value) as SmartGoConfig;

    // Validate required fields
    if (!config.host || !config.port || !config.database) {
      throw new Error('Missing required SmartGo configuration fields');
    }

    console.log('[SmartGoClient] Configuration loaded', {
      host: config.host,
      port: config.port,
      database: config.database,
      maxConnections: config.maxConnections || 10,
    });

    return config;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[SmartGoClient] Failed to load configuration', {
      stage,
      error: errorMessage,
    });
    throw new Error(`SmartGo configuration load failed: ${errorMessage}`);
  }
}

/**
 * Query SmartGo database for sales records
 *
 * This is a template implementation that needs to be completed with:
 * - Actual database connection (pg, mysql2, etc.)
 * - Proper connection pooling
 * - Error handling and retry logic
 * - Query parameterization to prevent SQL injection
 *
 * NOTE: Current implementation is a placeholder and returns empty array.
 * Must be implemented when SmartGo database connection is available.
 *
 * @param config SmartGo database configuration
 * @param sinceDate Query sales from this date onwards
 * @returns Array of sale records
 */
export async function querySmartGoSales(
  config: SmartGoConfig,
  sinceDate: Date
): Promise<SmartGoSaleRecord[]> {
  const dateString = sinceDate.toISOString().split('T')[0]; // YYYY-MM-DD

  console.log('[SmartGoClient] Querying SmartGo database', {
    host: config.host,
    database: config.database,
    sinceDate: dateString,
  });

  // PLACEHOLDER: Database connection not yet configured
  // To enable SmartGo sync:
  // 1. Add database credentials to SSM: /tf/{stage}/smartgo/database/config
  // 2. Install database driver: npm install pg
  // 3. Implement the PostgreSQL query below

  console.warn('[SmartGoClient] Database connection not configured - returning empty result set');
  console.warn(
    '[SmartGoClient] To enable SmartGo sales sync, configure database in SSM Parameter Store'
  );
  console.warn('[SmartGoClient] SSM path: /tf/${process.env.STAGE || "dev"}/smartgo/database/config');

  // TODO: Implement actual SmartGo database query
  // Example PostgreSQL implementation:
  /*
  import pg from 'pg';

  const pool = new pg.Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.username,
    password: config.password,
    max: config.maxConnections || 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: config.connectionTimeoutMs || 5000,
  });

  try {
    const query = `
      SELECT
        id,
        tenant_id as "tenantId",
        category,
        brand,
        condition,
        sold_price as "soldPrice",
        sold_date as "soldDate",
        image_url as "imageUrl",
        description,
        listing_price as "listingPrice",
        days_to_sell as "daysToSell",
        vendor_id as "vendorId"
      FROM smartgo.products
      WHERE sold_date >= $1::date
        AND sold_date < $2::date
        AND status = 'SOLD'
        AND image_url IS NOT NULL
      ORDER BY sold_date DESC, id
      LIMIT 1000
    `;

    const result = await pool.query(query, [
      dateString,
      new Date(sinceDate.getTime() + 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    ]);

    console.log('[SmartGoClient] Query successful', {
      rowCount: result.rows.length,
      sinceDate: dateString,
    });

    return result.rows as SmartGoSaleRecord[];
  } finally {
    await pool.end();
  }
  */

  // Placeholder: return empty array
  // Will be implemented when SmartGo database connection is established
  return [];
}

/**
 * Query SmartGo via REST API (alternative to direct database connection)
 *
 * Some SmartGo instances may expose a REST API for data retrieval.
 * This function provides an API-based alternative to direct database access.
 *
 * @param config SmartGo configuration (must include apiEndpoint and apiKey)
 * @param sinceDate Query sales from this date onwards
 * @returns Array of sale records
 */
export async function querySmartGoSalesViaAPI(
  config: SmartGoConfig,
  sinceDate: Date
): Promise<SmartGoSaleRecord[]> {
  if (!config.apiEndpoint || !config.apiKey) {
    throw new Error('API configuration missing (apiEndpoint or apiKey)');
  }

  const dateString = sinceDate.toISOString().split('T')[0]; // YYYY-MM-DD

  console.log('[SmartGoClient] Querying SmartGo via API', {
    endpoint: config.apiEndpoint,
    sinceDate: dateString,
  });

  try {
    const url = new URL(`${config.apiEndpoint}/api/v1/products`);
    url.searchParams.set('soldDate.gte', dateString);
    url.searchParams.set('status', 'SOLD');
    url.searchParams.set('limit', '1000');

    // Use AbortController for fetch timeout (Node.js 22 compatible)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

    try {
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Accept': 'application/json',
          'User-Agent': 'SmartGo-S3-Exporter/1.0',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`API request failed: HTTP ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as { data: SmartGoSaleRecord[] };

      console.log('[SmartGoClient] API query successful', {
        rowCount: data.data?.length || 0,
        sinceDate: dateString,
      });

      return data.data || [];
    } catch (fetchError) {
      clearTimeout(timeoutId);
      throw fetchError;
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[SmartGoClient] API query failed', {
      endpoint: config.apiEndpoint,
      error: errorMessage,
    });
    throw new Error(`SmartGo API query failed: ${errorMessage}`);
  }
}

/**
 * Validate SmartGo configuration
 *
 * Checks that:
 * - Required fields are present
 * - Values are in valid format
 * - Either database config OR API config is complete
 */
export function validateSmartGoConfig(config: SmartGoConfig): boolean {
  // Check minimum required fields
  if (!config.host || !config.database) {
    console.error('[SmartGoClient] Missing required configuration fields');
    return false;
  }

  // Must have either database credentials OR API credentials
  const hasDbConfig = !!(config.username && config.password);
  const hasApiConfig = !!(config.apiEndpoint && config.apiKey);

  if (!hasDbConfig && !hasApiConfig) {
    console.error('[SmartGoClient] Must provide either database or API credentials');
    return false;
  }

  // Validate port range
  if (config.port && (config.port < 1 || config.port > 65535)) {
    console.error('[SmartGoClient] Invalid port number:', config.port);
    return false;
  }

  return true;
}
