/**
 * SSM-backed Configuration Loader for bg-remover service
 *
 * Loads service configuration and secrets from AWS SSM Parameter Store.
 * Follows CarouselLabs multi-tenant SSM path conventions:
 *   /tf/{stage}/{tenant}/services/bg-remover/config
 *   /tf/{stage}/{tenant}/services/bg-remover/secrets
 *   /tf/{stage}/{tenant}/services/bg-remover/settings
 *
 * @module config/loader
 */

import { SSMClient, GetParametersCommand, GetParameterCommand } from '@aws-sdk/client-ssm';

// ============================================================================
// Types
// ============================================================================

/**
 * bg-remover service configuration from SSM
 */
export interface BgRemoverConfig {
  /** API base URL for external services */
  apiBaseUrl?: string;
  /** S3 bucket for storing processed images */
  outputBucket?: string;
  /** Rate limits configuration */
  rateLimits?: {
    requestsPerMinute?: number;
    requestsPerDay?: number;
    maxConcurrent?: number;
  };
  /** Feature flags */
  features?: {
    enableCredits?: boolean;
    enableMem0?: boolean;
    enableClassification?: boolean;
  };
  /** Any additional configuration */
  [key: string]: unknown;
}

/**
 * bg-remover service secrets from SSM
 */
export interface BgRemoverSecrets {
  /** PhotoRoom API key for background removal */
  photoroomApiKey?: string;
  /** Alternative: remove.bg API key */
  removeBgApiKey?: string;
  /** Internal service API key */
  serviceApiKey?: string;
  /** Any additional secrets */
  [key: string]: unknown;
}

/**
 * Settings for similarity detection (persisted to SSM)
 */
export interface BgRemoverSettings {
  similarityThreshold?: number;
  minConfidence?: number;
  enabled?: boolean;
  [key: string]: unknown;
}

/**
 * Complete loaded configuration
 */
export interface LoadedConfig {
  config: BgRemoverConfig;
  secrets: BgRemoverSecrets;
  settings?: BgRemoverSettings;
}

interface ConfigCacheEntry {
  data: LoadedConfig;
  timestamp: number;
}

// ============================================================================
// Configuration
// ============================================================================

const CONFIG_CACHE_TTL = parseInt(process.env.CONFIG_CACHE_TTL || '300000', 10); // 5 minutes
const SERVICE_NAME = 'bg-remover';

// ============================================================================
// SSM Client (lazy-initialized)
// ============================================================================

let ssmClient: SSMClient | null = null;

function getSSMClient(): SSMClient {
  if (!ssmClient) {
    ssmClient = new SSMClient({
      region: process.env.AWS_REGION || 'eu-west-1',
      maxAttempts: 3,
      retryMode: 'adaptive',
    });
  }
  return ssmClient;
}

// ============================================================================
// Cache
// ============================================================================

const configCache = new Map<string, ConfigCacheEntry>();

function getCacheKey(stage: string, tenant: string): string {
  return `${stage}:${tenant}`;
}

function isCacheValid(entry?: ConfigCacheEntry): boolean {
  if (!entry) return false;
  return Date.now() - entry.timestamp < CONFIG_CACHE_TTL;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Load service configuration from SSM Parameter Store
 *
 * Loads config, secrets, and settings parameters with caching.
 * Fails fast if required parameters are missing.
 *
 * @param stage - Deployment stage (dev, prod)
 * @param tenant - Tenant identifier (defaults to TENANT env var)
 * @returns Loaded configuration object
 * @throws Error if SSM parameters cannot be loaded
 *
 * @example
 * ```typescript
 * const { config, secrets } = await loadConfig('dev', 'carousel-labs');
 * const apiKey = secrets.photoroomApiKey;
 * ```
 */
export async function loadConfig(
  stage?: string,
  tenant?: string
): Promise<LoadedConfig> {
  // Resolve stage and tenant from environment if not provided
  const resolvedStage = stage || process.env.STAGE || process.env.SLS_STAGE || 'dev';
  const resolvedTenant = tenant || process.env.TENANT || 'carousel-labs';

  const cacheKey = getCacheKey(resolvedStage, resolvedTenant);
  const cached = configCache.get(cacheKey);

  // Return cached if valid
  if (cached && isCacheValid(cached)) {
    console.log(JSON.stringify({
      level: 'debug',
      msg: 'config.cache.hit',
      service: SERVICE_NAME,
      stage: resolvedStage,
      tenant: resolvedTenant,
    }));
    return cached.data;
  }

  console.log(JSON.stringify({
    level: 'info',
    msg: 'config.loading',
    service: SERVICE_NAME,
    stage: resolvedStage,
    tenant: resolvedTenant,
  }));

  // Build SSM parameter paths
  const basePath = `/tf/${resolvedStage}/${resolvedTenant}/services/${SERVICE_NAME}`;
  const configPath = `${basePath}/config`;
  const secretsPath = `${basePath}/secrets`;
  const settingsPath = `${basePath}/settings`;

  const startTime = Date.now();

  try {
    // Batch load config, secrets, and settings
    const response = await getSSMClient().send(
      new GetParametersCommand({
        Names: [configPath, secretsPath, settingsPath],
        WithDecryption: true,
      })
    );

    const loadDuration = Date.now() - startTime;

    // Parse parameters
    const params = new Map<string, unknown>();
    for (const param of response.Parameters || []) {
      if (param.Name && param.Value) {
        try {
          params.set(param.Name, JSON.parse(param.Value));
        } catch (parseError) {
          console.warn(JSON.stringify({
            level: 'warn',
            msg: 'config.parse.error',
            path: param.Name,
            error: parseError instanceof Error ? parseError.message : String(parseError),
          }));
          params.set(param.Name, {});
        }
      }
    }

    // Log any invalid parameters
    if (response.InvalidParameters && response.InvalidParameters.length > 0) {
      console.warn(JSON.stringify({
        level: 'warn',
        msg: 'config.invalid.parameters',
        paths: response.InvalidParameters,
      }));
    }

    const config = (params.get(configPath) as BgRemoverConfig) || {};
    const secrets = (params.get(secretsPath) as BgRemoverSecrets) || {};
    const settings = (params.get(settingsPath) as BgRemoverSettings) || undefined;

    const result: LoadedConfig = { config, secrets, settings };

    // Cache the result
    configCache.set(cacheKey, {
      data: result,
      timestamp: Date.now(),
    });

    console.log(JSON.stringify({
      level: 'info',
      msg: 'config.loaded',
      service: SERVICE_NAME,
      stage: resolvedStage,
      tenant: resolvedTenant,
      loadDurationMs: loadDuration,
      hasConfig: Object.keys(config).length > 0,
      hasSecrets: Object.keys(secrets).length > 0,
      hasSettings: settings !== undefined,
    }));

    return result;
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      msg: 'config.load.failed',
      service: SERVICE_NAME,
      stage: resolvedStage,
      tenant: resolvedTenant,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startTime,
    }));
    throw new Error(
      `Failed to load config from SSM: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Get the PhotoRoom API key from secrets
 *
 * Fails fast if the API key is not configured.
 *
 * @param stage - Deployment stage
 * @param tenant - Tenant identifier
 * @returns PhotoRoom API key
 * @throws Error if API key is not found
 */
export async function getPhotoroomApiKey(
  stage?: string,
  tenant?: string
): Promise<string> {
  const { secrets } = await loadConfig(stage, tenant);

  const apiKey = secrets.photoroomApiKey;
  if (!apiKey) {
    throw new Error(
      'PhotoRoom API key not configured. Set photoroomApiKey in SSM secrets parameter.'
    );
  }

  return apiKey;
}

/**
 * Get the remove.bg API key from secrets (alternative provider)
 *
 * @param stage - Deployment stage
 * @param tenant - Tenant identifier
 * @returns remove.bg API key or undefined if not configured
 */
export async function getRemoveBgApiKey(
  stage?: string,
  tenant?: string
): Promise<string | undefined> {
  const { secrets } = await loadConfig(stage, tenant);
  return secrets.removeBgApiKey;
}

/**
 * Get the internal service API key
 *
 * This key is used for service-to-service authentication.
 *
 * @param stage - Deployment stage
 * @param tenant - Tenant identifier
 * @returns Service API key
 * @throws Error if API key is not found
 */
export async function getServiceApiKey(
  stage?: string,
  tenant?: string
): Promise<string> {
  const { secrets } = await loadConfig(stage, tenant);

  const apiKey = secrets.serviceApiKey;
  if (!apiKey) {
    throw new Error(
      'Service API key not configured. Set serviceApiKey in SSM secrets parameter.'
    );
  }

  return apiKey;
}

/**
 * Clear the configuration cache
 *
 * Call this when you need to force reload configuration,
 * such as after secrets rotation.
 */
export function clearConfigCache(): void {
  configCache.clear();
  console.log(JSON.stringify({
    level: 'info',
    msg: 'config.cache.cleared',
    service: SERVICE_NAME,
  }));
}

/**
 * Get cache statistics for monitoring
 */
export function getConfigCacheStats(): {
  size: number;
  keys: string[];
  ttl: number;
} {
  return {
    size: configCache.size,
    keys: Array.from(configCache.keys()),
    ttl: CONFIG_CACHE_TTL,
  };
}

/**
 * Load a single SSM parameter (used for dynamic settings)
 *
 * @param paramPath - Full SSM parameter path
 * @returns Parsed parameter value or null if not found
 */
export async function loadParameter<T = unknown>(paramPath: string): Promise<T | null> {
  try {
    const response = await getSSMClient().send(
      new GetParameterCommand({
        Name: paramPath,
        WithDecryption: true,
      })
    );

    if (response.Parameter?.Value) {
      return JSON.parse(response.Parameter.Value) as T;
    }

    return null;
  } catch (error) {
    console.warn(JSON.stringify({
      level: 'warn',
      msg: 'parameter.load.failed',
      path: paramPath,
      error: error instanceof Error ? error.message : String(error),
    }));
    return null;
  }
}

// ============================================================================
// Default Export for backward compatibility
// ============================================================================

export default {
  loadConfig,
  getPhotoroomApiKey,
  getRemoveBgApiKey,
  getServiceApiKey,
  clearConfigCache,
  getConfigCacheStats,
  loadParameter,
};
