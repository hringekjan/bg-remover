import { Logger } from '@aws-lambda-powertools/logger';

// Fallback to mock implementation if Powertools is not available yet
let SSMProvider: any;
let ssmProvider: any;

try {
  // Try to import AWS Powertools Parameters
  const { SSMProvider: PT_SSMProvider } = require('@aws-lambda-powertools/parameters/ssm');
  SSMProvider = PT_SSMProvider;
  ssmProvider = new SSMProvider({
    maxCacheAge: 300  // 5 minutes in seconds
  });
} catch (error) {
  // If Powertools Parameters is not available, use fallback mock
  console.warn('@aws-lambda-powertools/parameters not available, using fallback implementation');
  
  SSMProvider = class {
    constructor(options: any) {}
    async get(path: string, options?: any) {
      return '{}';
    }
  };
  
  ssmProvider = new SSMProvider({ maxCacheAge: 300 });
}

// Initialize Powertools Logger
const logger = new Logger({ serviceName: 'bg-remover-config-loader' });

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

/**
 * Load service configuration from SSM Parameter Store using AWS Powertools Parameters
 * 
 * This implementation uses AWS Powertools Parameters for more reliable and faster
 * configuration loading with built-in caching and error handling.
 * 
 * @param stage - Deployment stage (dev, prod)
 * @param tenant - Tenant identifier (defaults to TENANT env var)
 * @returns Loaded configuration object
 * @throws Error if SSM parameters cannot be loaded
 */
export async function loadConfig(
  stage?: string,
  tenant?: string
): Promise<LoadedConfig> {
  const resolvedStage = stage || process.env.STAGE || process.env.SLS_STAGE || 'dev';
  const resolvedTenant = tenant || process.env.TENANT || 'carousel-labs';

  const startTime = Date.now();

  try {
    logger.debug('Loading bg-remover configuration', {
      stage: resolvedStage,
      tenant: resolvedTenant
    });

    // Build SSM parameter paths
    const basePath = `/tf/${resolvedStage}/${resolvedTenant}/services/bg-remover`;
    const configPath = `${basePath}/config`;
    const secretsPath = `${basePath}/secrets`;
    const settingsPath = `${basePath}/settings`;

    // Load all parameters in parallel
    const [configResult, secretsResult, settingsResult] = await Promise.all([
      ssmProvider.get(configPath).catch((err: any) => {
        logger.warn('Failed to load config parameter, using defaults', {
          path: configPath,
          error: err instanceof Error ? err.message : String(err)
        });
        return '{}';
      }),
      ssmProvider.get(secretsPath, { decrypt: true }).catch((err: any) => {
        logger.warn('Failed to load secrets parameter, using defaults', {
          path: secretsPath,
          error: err instanceof Error ? err.message : String(err)
        });
        return '{}';
      }),
      ssmProvider.get(settingsPath).catch((err: any) => {
        logger.warn('Failed to load settings parameter, using defaults', {
          path: settingsPath,
          error: err instanceof Error ? err.message : String(err)
        });
        return undefined;
      })
    ]);

    // Parse parameters
    let config: BgRemoverConfig = {};
    let secrets: BgRemoverSecrets = {};
    let settings: BgRemoverSettings | undefined;

    if (configResult) {
      try {
        config = JSON.parse(configResult);
      } catch (parseError) {
        logger.warn('Failed to parse config parameter, using empty config', {
          path: configPath,
          error: parseError instanceof Error ? parseError.message : String(parseError)
        });
      }
    }

    if (secretsResult) {
      try {
        secrets = JSON.parse(secretsResult);
      } catch (parseError) {
        logger.warn('Failed to parse secrets parameter, using empty secrets', {
          path: secretsPath,
          error: parseError instanceof Error ? parseError.message : String(parseError)
        });
      }
    }

    if (settingsResult) {
      try {
        settings = JSON.parse(settingsResult);
      } catch (parseError) {
        logger.warn('Failed to parse settings parameter, using undefined', {
          path: settingsPath,
          error: parseError instanceof Error ? parseError.message : String(parseError)
        });
      }
    }

    const result: LoadedConfig = { config, secrets, settings };

    logger.info('Configuration loaded successfully', {
      durationMs: Date.now() - startTime,
      stage: resolvedStage,
      tenant: resolvedTenant,
      hasConfig: Object.keys(config).length > 0,
      hasSecrets: Object.keys(secrets).length > 0,
      hasSettings: settings !== undefined
    });

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error('Failed to load bg-remover configuration', {
      stage: resolvedStage,
      tenant: resolvedTenant,
      error: error instanceof Error ? error.message : String(error),
      durationMs: duration
    });
    
    throw new Error(
      `Failed to load bg-remover config from SSM: ${error instanceof Error ? error.message : String(error)}`
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
  logger.info('Clearing SSM parameter cache');
  ssmProvider.flushCache();
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
    size: ssmProvider['cache']?.size || 0,
    keys: Array.from(ssmProvider['cache']?.keys() || []),
    ttl: 300
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
    logger.debug('Retrieving SSM parameter', { parameterPath: paramPath });

    const value = await ssmProvider.get(paramPath);

    if (!value) {
      logger.debug('Parameter not found', { parameterPath: paramPath });
      return null;
    }

    return JSON.parse(value) as T;
  } catch (error) {
    logger.warn('Failed to load SSM parameter', {
      parameterPath: paramPath,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

// Default Export for backward compatibility
export default {
  loadConfig,
  getPhotoroomApiKey,
  getRemoveBgApiKey,
  getServiceApiKey,
  clearConfigCache,
  getConfigCacheStats,
  loadParameter,
};
