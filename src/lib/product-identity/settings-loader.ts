/**
 * Settings Loader for Product Identity Multi-Signal Analysis
 *
 * Loads configuration from SSM Parameter Store with fallback to defaults
 */

import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { MultiSignalSettings, DEFAULT_SETTINGS } from './multi-signal-similarity';

const ssmCache = new Map<string, { value: MultiSignalSettings; timestamp: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Load product identity settings from SSM Parameter Store
 */
export async function loadSettings(
  tenant: string,
  stage: string,
  region: string = 'eu-west-1'
): Promise<MultiSignalSettings> {
  const paramName = `/tf/${stage}/${tenant}/services/bg-remover/product-identity-settings`;
  const cacheKey = `${region}:${paramName}`;

  // Check cache
  const cached = ssmCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.value;
  }

  // Load from SSM
  const ssmClient = new SSMClient({ region });

  try {
    const command = new GetParameterCommand({
      Name: paramName,
      WithDecryption: false,
    });

    const response = await ssmClient.send(command);
    const value = response.Parameter?.Value;

    if (!value) {
      console.warn(`[SettingsLoader] No value found for parameter: ${paramName}, using defaults`);
      return DEFAULT_SETTINGS;
    }

    const settings = JSON.parse(value) as MultiSignalSettings;

    // Cache the result
    ssmCache.set(cacheKey, { value: settings, timestamp: Date.now() });

    return settings;
  } catch (error) {
    console.warn(`[SettingsLoader] Failed to load settings from SSM: ${paramName}`, error);
    return DEFAULT_SETTINGS;
  }
}

/**
 * Save product identity settings to SSM Parameter Store
 */
export async function saveSettings(
  tenant: string,
  stage: string,
  settings: MultiSignalSettings,
  region: string = 'eu-west-1'
): Promise<boolean> {
  const paramName = `/tf/${stage}/${tenant}/services/bg-remover/product-identity-settings`;
  const ssmClient = new SSMClient({ region });

  try {
    const command = new PutParameterCommand({
      Name: paramName,
      Value: JSON.stringify(settings, null, 2),
      Type: 'String',
      Overwrite: true,
      Description: 'Product identity multi-signal analysis settings',
    });

    await ssmClient.send(command);

    // Invalidate cache
    const cacheKey = `${region}:${paramName}`;
    ssmCache.delete(cacheKey);

    return true;
  } catch (error) {
    console.error(`[SettingsLoader] Failed to save settings to SSM: ${paramName}`, error);
    return false;
  }
}
