import { randomBytes } from 'crypto';
import { SSMClient, PutParameterCommand, GetParameterCommand } from '@aws-sdk/client-ssm';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

export interface KeyRotationEvent {
  tenant: string;
  stage: string;
  oldKey?: string;
  newKey: string;
  expiryTime: string;
  gracePeriodHours: number;
  timestamp: string;
}

export interface SecretRotatorConfig {
  region?: string;
  stage: string;
  tenant: string;
  gracePeriodHours?: number;
}

export class SecretRotator {
  private ssmClient: SSMClient;
  private eventBridgeClient: EventBridgeClient;
  private config: Required<SecretRotatorConfig>;

  constructor(config: SecretRotatorConfig) {
    this.config = {
      region: config.region || process.env.AWS_REGION || 'eu-west-1',
      stage: config.stage,
      tenant: config.tenant,
      gracePeriodHours: config.gracePeriodHours || 24,
    };

    this.ssmClient = new SSMClient({ region: this.config.region });
    this.eventBridgeClient = new EventBridgeClient({ region: this.config.region });
  }

  /**
   * Generates a secure API key using crypto.randomBytes
   * Returns a base64-encoded string suitable for API authentication
   */
  generateSecureAPIKey(): string {
    try {
      // Generate 32 bytes (256 bits) of random data for high security
      const randomData = randomBytes(32);
      // Convert to base64 for URL-safe API key format
      const apiKey = randomData.toString('base64')
        .replace(/\+/g, '-')  // URL-safe
        .replace(/\//g, '_')  // URL-safe
        .replace(/=/g, '');   // Remove padding

      console.info('Generated secure API key', {
        tenant: this.config.tenant,
        stage: this.config.stage,
        keyLength: apiKey.length,
      });

      return apiKey;
    } catch (error) {
      console.error('Failed to generate secure API key', {
        tenant: this.config.tenant,
        stage: this.config.stage,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error('Failed to generate secure API key');
    }
  }

  /**
   * Updates SSM parameter with new API key
   * Stores both current and previous keys during grace period
   */
  async updateSSMParameter(newKey: string, oldKey?: string): Promise<void> {
    const ssmPath = `/tf/${this.config.stage}/${this.config.tenant}/services/bg-remover/admin-api-keys`;

    try {
      // Prepare parameter value with current and previous keys
      const parameterValue = JSON.stringify({
        current: newKey,
        previous: oldKey,
        lastRotation: new Date().toISOString(),
        gracePeriodHours: this.config.gracePeriodHours,
      });

      const command = new PutParameterCommand({
        Name: ssmPath,
        Value: parameterValue,
        Type: 'SecureString',
        Overwrite: true,
        Description: `API keys for Carousel service - ${this.config.tenant} (${this.config.stage})`,
      });

      await this.ssmClient.send(command);

      console.info('Updated SSM parameter with new API key', {
        tenant: this.config.tenant,
        stage: this.config.stage,
        ssmPath,
        hasOldKey: !!oldKey,
        gracePeriodHours: this.config.gracePeriodHours,
      });
    } catch (error) {
      console.error('Failed to update SSM parameter', {
        tenant: this.config.tenant,
        stage: this.config.stage,
        ssmPath,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(`Failed to update SSM parameter: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Schedules key expiry by calculating grace period end time
   * Returns the expiry timestamp for scheduling cleanup
   */
  scheduleKeyExpiry(): string {
    const expiryTime = new Date();
    expiryTime.setHours(expiryTime.getHours() + this.config.gracePeriodHours);

    const expiryTimestamp = expiryTime.toISOString();

    console.info('Scheduled key expiry', {
      tenant: this.config.tenant,
      stage: this.config.stage,
      gracePeriodHours: this.config.gracePeriodHours,
      expiryTime: expiryTimestamp,
    });

    return expiryTimestamp;
  }

  /**
   * Broadcasts key rotation event via EventBridge
   * Notifies all services about the key rotation
   */
  async broadcastKeyRotation(event: KeyRotationEvent): Promise<void> {
    try {
      const eventDetail = {
        ...event,
        service: 'bg-remover',
        eventType: 'ApiKeyRotated',
      };

      const command = new PutEventsCommand({
        Entries: [
          {
            Source: 'carousel.bg-remover.secret-rotator',
            DetailType: 'CarouselApiKeyRotated',
            Detail: JSON.stringify(eventDetail),
          },
        ],
      });

      await this.eventBridgeClient.send(command);

      console.info('Broadcasted key rotation event', {
        tenant: this.config.tenant,
        stage: this.config.stage,
        eventType: 'CarouselApiKeyRotated',
        expiryTime: event.expiryTime,
        gracePeriodHours: event.gracePeriodHours,
      });
    } catch (error) {
      console.error('Failed to broadcast key rotation event', {
        tenant: this.config.tenant,
        stage: this.config.stage,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(`Failed to broadcast key rotation: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Performs complete API key rotation workflow
   * Generates new key, updates SSM, schedules expiry, and broadcasts event
   */
  async rotateAPIKey(): Promise<KeyRotationEvent> {
    console.info('Starting API key rotation', {
      tenant: this.config.tenant,
      stage: this.config.stage,
    });

    try {
      // Get current key before rotation (for grace period)
      let oldKey: string | undefined;
      try {
        const currentParam = await this.ssmClient.send(new GetParameterCommand({
          Name: `/tf/${this.config.stage}/${this.config.tenant}/services/bg-remover/admin-api-keys`,
          WithDecryption: true,
        }));

        if (currentParam.Parameter?.Value) {
          const parsed = JSON.parse(currentParam.Parameter.Value);
          oldKey = parsed.current;
        }
      } catch (error) {
        // Parameter might not exist on first rotation - that's OK
        console.info('No existing API key found (first rotation)', {
          tenant: this.config.tenant,
          stage: this.config.stage,
        });
      }

      // Generate new secure key
      const newKey = this.generateSecureAPIKey();

      // Update SSM with new key
      await this.updateSSMParameter(newKey, oldKey);

      // Schedule expiry
      const expiryTime = this.scheduleKeyExpiry();

      // Create rotation event
      const rotationEvent: KeyRotationEvent = {
        tenant: this.config.tenant,
        stage: this.config.stage,
        oldKey,
        newKey,
        expiryTime,
        gracePeriodHours: this.config.gracePeriodHours,
        timestamp: new Date().toISOString(),
      };

      // Broadcast rotation event
      await this.broadcastKeyRotation(rotationEvent);

      console.info('API key rotation completed successfully', {
        tenant: this.config.tenant,
        stage: this.config.stage,
        hasOldKey: !!oldKey,
        expiryTime,
      });

      return rotationEvent;
    } catch (error) {
      console.error('API key rotation failed', {
        tenant: this.config.tenant,
        stage: this.config.stage,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(`API key rotation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Retrieves current API key from SSM
   * Returns the current active key
   */
  async getCurrentAPIKey(): Promise<string | null> {
    try {
      const command = new GetParameterCommand({
        Name: `/tf/${this.config.stage}/${this.config.tenant}/services/bg-remover/admin-api-keys`,
        WithDecryption: true,
      });

      const response = await this.ssmClient.send(command);

      if (response.Parameter?.Value) {
        const parsed = JSON.parse(response.Parameter.Value);
        return parsed.current || null;
      }

      return null;
    } catch (error) {
      if ((error as any).name === 'ParameterNotFound') {
        console.info('API key parameter not found', {
          tenant: this.config.tenant,
          stage: this.config.stage,
        });
        return null;
      }

      console.error('Failed to retrieve current API key', {
        tenant: this.config.tenant,
        stage: this.config.stage,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(`Failed to retrieve API key: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}