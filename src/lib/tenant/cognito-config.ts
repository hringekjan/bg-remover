/**
 * Tenant-specific Cognito configuration loader
 * Loads Cognito User Pool settings from SSM parameters based on tenant ID
 */

import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { CognitoConfig } from '../auth/jwt-validator';

const ssmClient = new SSMClient({ region: process.env.AWS_REGION || 'eu-west-1' });

// Cache tenant Cognito configs to avoid repeated SSM calls
const cognitoConfigCache = new Map<string, CognitoConfig>();

interface TenantCognitoConfig {
  userPoolId: string;
  webClientId: string;
  region: string;
  domain: string;
  scopes: string[];
  callbackUrls: string[];
  logoutUrls: string[];
  identityProviders: string[];
}

/**
 * Load tenant-specific Cognito configuration from SSM
 *
 * @param tenant - Tenant ID (e.g., 'hringekjan', 'carousel-labs')
 * @param stage - Deployment stage ('dev' or 'prod')
 * @returns CognitoConfig for JWT validation
 */
export async function loadTenantCognitoConfig(
  tenant: string,
  stage: string = process.env.STAGE || 'dev'
): Promise<CognitoConfig> {
  const cacheKey = `${stage}-${tenant}`;

  // Return cached config if available
  if (cognitoConfigCache.has(cacheKey)) {
    console.log('Using cached Cognito config for tenant:', { tenant, stage });
    return cognitoConfigCache.get(cacheKey)!;
  }

  // Define paramName outside try block so it's accessible in catch
  const paramName = `/tf/${stage}/${tenant}/services/carousel/cognito_config`;

  try {
    // Load from SSM: /tf/{stage}/{tenant}/services/carousel/cognito_config
    console.log('Loading Cognito config from SSM:', { paramName });

    const command = new GetParameterCommand({
      Name: paramName,
      WithDecryption: true,
    });

    const response = await ssmClient.send(command);

    if (!response.Parameter?.Value) {
      throw new Error(`No Cognito config found in SSM parameter: ${paramName}`);
    }

    const tenantConfig: TenantCognitoConfig = JSON.parse(response.Parameter.Value);

    // Convert to CognitoConfig format for JWT validator
    const cognitoConfig: CognitoConfig = {
      userPoolId: tenantConfig.userPoolId,
      region: tenantConfig.region,
      issuer: `https://cognito-idp.${tenantConfig.region}.amazonaws.com/${tenantConfig.userPoolId}`,
      audience: [tenantConfig.webClientId], // Client ID is the audience
    };

    // Cache for future requests
    cognitoConfigCache.set(cacheKey, cognitoConfig);
    console.log('[CognitoConfig] ✅ Loaded and cached tenant config:', {
      tenant,
      stage,
      userPoolId: cognitoConfig.userPoolId,
      issuer: cognitoConfig.issuer,
      hasAudience: !!cognitoConfig.audience,
      cacheKey,
      timestamp: new Date().toISOString(),
    });

    return cognitoConfig;
  } catch (error) {
    console.error('[CognitoConfig] ❌ Failed to load tenant config from SSM:', {
      tenant,
      stage,
      paramName,
      errorType: error instanceof Error ? error.constructor.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    });

    // Only allow fallback in dev with explicit opt-in
    if (stage === 'dev' && process.env.ALLOW_COGNITO_FALLBACK === 'true') {
      console.warn('[CognitoConfig] ⚠️  DEV MODE: Falling back to platform config');
      console.warn('[CognitoConfig] ⚠️  This should NOT happen in production!');
      const platformConfig: CognitoConfig = {
        userPoolId: process.env.COGNITO_USER_POOL_ID || 'eu-west-1_SfkX8eTc3',
        region: process.env.AWS_REGION || 'eu-west-1',
        issuer: process.env.COGNITO_ISSUER_URL ||
          `https://cognito-idp.eu-west-1.amazonaws.com/${process.env.COGNITO_USER_POOL_ID || 'eu-west-1_SfkX8eTc3'}`,
      };
      return platformConfig;
    }

    // Production: Fail loudly with clear error
    throw new Error(
      `[CognitoConfig] FATAL: Cognito config not found for tenant '${tenant}' ` +
      `at SSM parameter: ${paramName}. ` +
      `This tenant cannot authenticate. Create SSM parameter before deployment.`
    );
  }
}

/**
 * Clear the Cognito config cache (useful for testing)
 */
export function clearCognitoConfigCache(): void {
  cognitoConfigCache.clear();
}
