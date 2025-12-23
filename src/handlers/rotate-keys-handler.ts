import { SecretRotator } from '../lib/security/secret-rotator';

export const rotateKeys = async (event: any) => {
  console.log('API Key rotation triggered', {
    source: event.source,
    time: new Date().toISOString(),
  });

  const stage = process.env.STAGE || 'dev';
  const tenant = process.env.TENANT || 'carousel-labs';

  try {
    // Initialize secret rotator
    const rotator = new SecretRotator({
      stage,
      tenant,
      gracePeriodHours: 24,
    });

    // Perform key rotation
    const rotationResult = await rotator.rotateAPIKey();

    console.info('API key rotation completed successfully', {
      tenant,
      stage,
      newKeyId: rotationResult.newKey.substring(0, 8) + '...', // Log partial key for debugging
      expiryTime: rotationResult.expiryTime,
      gracePeriodHours: rotationResult.gracePeriodHours,
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: 'API key rotation completed',
        tenant,
        stage,
        rotationTime: rotationResult.timestamp,
        expiryTime: rotationResult.expiryTime,
        gracePeriodHours: rotationResult.gracePeriodHours,
      }),
    };
  } catch (error) {
    console.error('API key rotation failed', {
      tenant,
      stage,
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        error: 'API key rotation failed',
        message: error instanceof Error ? error.message : 'Internal server error',
        tenant,
        stage,
      }),
    };
  }
};