/**
 * BG Remover Mem0 Integration Service
 * Integrates BG Remover service with mem0 platform for metadata storage and analytics
 * Tracks processing costs, performance metrics, and AI-generated content
 */

import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { SmartGoLogger } from '../utils/logger';
import { SmartGoMetrics } from '../utils/metrics';
import { CloudWatchMetricsService, emitBusinessMetric, emitDataProcessingMetrics } from '@carousel-labs/mem0-platform';

// Mem0 Platform imports
import {
  RestApiService,
  type Product,
  type User
} from '@carousel-labs/mem0-platform';

export interface BgRemoverProcessingResult {
  jobId: string;
  outputUrl: string;
  processingTimeMs: number;
  metadata: {
    width: number;
    height: number;
    originalSize: number;
    processedSize: number;
  };
  productDescription?: any;
  multilingualDescription?: any;
  bilingualDescription?: any;
  creditsUsed: number;
  userId?: string;
  tenantId: string;
}

export interface BgRemoverMem0Config {
  tenant: string;
  stage: string;
  bgRemoverConfig: {
    apiKey: string;
    serviceUrl: string;
  };
  mem0Config: {
    baseUrl: string;
    jwtSecret: string;
    jwtExpiryHours: number;
  };
}

export interface JWTCache {
  token: string;
  expiresAt: number;
  tenant: string;
}

export class BgRemoverMem0Service {
  private ssmClient: SSMClient;
  private eventBridgeClient: EventBridgeClient;
  private logger: SmartGoLogger;
  private metrics: SmartGoMetrics;
  private mem0Api: RestApiService;
  private jwtCache: Map<string, JWTCache> = new Map();
  private cloudWatchMetrics: CloudWatchMetricsService;

  constructor(tenant: string, stage: string) {
    const region = process.env.AWS_REGION || 'eu-west-1';

    this.ssmClient = new SSMClient({ region });
    this.eventBridgeClient = new EventBridgeClient({ region });
    this.logger = new SmartGoLogger(tenant);
    this.metrics = new SmartGoMetrics(tenant);
    this.cloudWatchMetrics = new CloudWatchMetricsService(stage, region);

    // Initialize Mem0 API client
    this.mem0Api = new RestApiService({
      baseURL: process.env.MEM0_API_URL || 'https://api.mem0-platform.carousel-labs.com',
      tenant
    });
  }

  /**
   * Get JWT token for Mem0 API authentication with caching
   */
  private async getJWTToken(tenant: string): Promise<string> {
    const cached = this.jwtCache.get(tenant);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.token;
    }

    try {
      const jwtSecret = await this.getSSMParameter(
        `/tf/${process.env.STAGE || 'dev'}/${tenant}/secrets/bg-remover-jwt-secret`,
        process.env.JWT_SECRET
      );

      const payload = {
        tenant,
        service: 'bg-remover',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + (24 * 60 * 60) // 24 hours
      };

      const token = Buffer.from(JSON.stringify(payload)).toString('base64');

      const jwtCache: JWTCache = {
        token,
        expiresAt: payload.exp * 1000,
        tenant
      };

      this.jwtCache.set(tenant, jwtCache);
      return token;
    } catch (error) {
      this.logger.error('Failed to generate JWT token', { tenant, error: error.message });
      throw new Error('Authentication failed');
    }
  }

  /**
   * Authenticate with Mem0 platform
   */
  private async authenticateWithMem0(tenant: string): Promise<void> {
    const token = await this.getJWTToken(tenant);
    this.mem0Api.setAuthToken(token);
  }

  /**
   * Retrieve SSM parameter with fallback
   */
  private async getSSMParameter(
    parameterName: string,
    defaultValue?: string
  ): Promise<string> {
    try {
      const command = new GetParameterCommand({
        Name: parameterName,
        WithDecryption: true
      });

      const response = await this.ssmClient.send(command);
      return response.Parameter?.Value || defaultValue || '';
    } catch (error) {
      this.logger.warn(`Could not retrieve SSM parameter ${parameterName}:`, error);
      return defaultValue || '';
    }
  }

  /**
   * Store BG Remover processing result in Mem0 platform
   */
  async storeProcessingResult(result: BgRemoverProcessingResult): Promise<void> {
    const startTime = Date.now();

    try {
      await this.authenticateWithMem0(result.tenantId);

      // Create or update product with BG removal metadata
      const product: Product = {
        id: result.jobId, // Use jobId as product ID for tracking
        name: result.productDescription?.name || 'BG Removed Product',
        description: result.productDescription?.description || 'AI background removed product image',
        price: result.productDescription?.priceSuggestion?.price || 0,
        currency: 'EUR',
        category: result.productDescription?.category || 'processed-image',
        tags: ['bg-removed', 'ai-processed', 'carousel-labs'],
        images: [result.outputUrl],
        inventory: {
          quantity: 1,
          lowStockThreshold: 0
        },
        attributes: {
          processingTimeMs: result.processingTimeMs,
          originalSize: result.metadata.originalSize,
          processedSize: result.metadata.processedSize,
          width: result.metadata.width,
          height: result.metadata.height,
          creditsUsed: result.creditsUsed,
          userId: result.userId,
          jobId: result.jobId,
          processingTimestamp: new Date().toISOString(),
          aiModel: 'bedrock-claude-vision',
          service: 'bg-remover'
        },
        tenantId: result.tenantId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      await this.mem0Api.createProduct(product);

      // Emit business metric for BG removal processing
      await emitBusinessMetric({
        tenantId: result.tenantId,
        service: 'bg-remover',
        operation: 'processImage',
        creditsUsed: result.creditsUsed,
        success: true,
        metadata: {
          jobId: result.jobId,
          processingTimeMs: result.processingTimeMs,
          userId: result.userId,
          outputSize: result.metadata.processedSize
        }
      });

      // Emit data processing metrics
      await emitDataProcessingMetrics(
        result.tenantId,
        'bg-remover-processing',
        1, // recordsProcessed
        result.processingTimeMs,
        true // success
      );

      // Emit EventBridge event for downstream processing
      await this.emitProcessingEvent(result);

      this.logger.info('BG Remover processing result stored in Mem0', {
        tenant: result.tenantId,
        jobId: result.jobId,
        processingTimeMs: result.processingTimeMs,
        creditsUsed: result.creditsUsed,
        durationMs: Date.now() - startTime
      });
    } catch (error: any) {
      this.logger.error('Failed to store BG Remover processing result', {
        tenant: result.tenantId,
        jobId: result.jobId,
        error: error.message
      });

      // Emit error metric
      await emitBusinessMetric({
        tenantId: result.tenantId,
        service: 'bg-remover',
        operation: 'storeProcessingResult',
        success: false,
        errorType: error.name || 'StorageError',
        metadata: { jobId: result.jobId }
      });

      throw error;
    }
  }

  /**
   * Emit EventBridge event for BG Remover processing completion
   */
  private async emitProcessingEvent(result: BgRemoverProcessingResult): Promise<void> {
    try {
      const eventDetail = {
        jobId: result.jobId,
        outputUrl: result.outputUrl,
        processingTimeMs: result.processingTimeMs,
        metadata: result.metadata,
        creditsUsed: result.creditsUsed,
        userId: result.userId,
        tenantId: result.tenantId,
        timestamp: new Date().toISOString(),
        service: 'bg-remover',
        eventType: 'processing.completed'
      };

      const eventBridgeCommand = {
        Entries: [
          {
            Source: 'carousel.bg-remover.mem0',
            DetailType: 'BgRemoverProcessingCompleted',
            Detail: JSON.stringify(eventDetail),
          },
        ],
      };

      await this.eventBridgeClient.send(new PutEventsCommand(eventBridgeCommand));

      this.logger.debug('Emitted EventBridge event for BG Remover processing', {
        jobId: result.jobId,
        tenant: result.tenantId
      });
    } catch (error) {
      this.logger.warn('Failed to emit EventBridge event', {
        jobId: result.jobId,
        tenant: result.tenantId,
        error: error.message
      });
      // Don't throw - EventBridge failure shouldn't break the main flow
    }
  }

  /**
   * Track BG Remover usage analytics
   */
  async trackUsageAnalytics(config: BgRemoverMem0Config, timeRange: { start: string; end: string }): Promise<{
    totalJobs: number;
    totalCreditsUsed: number;
    averageProcessingTime: number;
    successRate: number;
    topUsers: Array<{ userId: string; jobsCount: number; creditsUsed: number }>;
    hourlyUsage: Array<{ hour: string; jobsCount: number }>;
  }> {
    try {
      await this.authenticateWithMem0(config.tenant);

      // This would query Mem0 analytics API for BG Remover usage data
      // For now, return mock analytics data
      const analytics = {
        totalJobs: 1250,
        totalCreditsUsed: 1250,
        averageProcessingTime: 4500, // 4.5 seconds
        successRate: 0.987, // 98.7%
        topUsers: [
          { userId: 'user-1', jobsCount: 150, creditsUsed: 150 },
          { userId: 'user-2', jobsCount: 120, creditsUsed: 120 },
          { userId: 'user-3', jobsCount: 95, creditsUsed: 95 }
        ],
        hourlyUsage: Array.from({ length: 24 }, (_, i) => ({
          hour: `${i.toString().padStart(2, '0')}:00`,
          jobsCount: Math.floor(Math.random() * 100) + 10
        }))
      };

      this.logger.info('Retrieved BG Remover usage analytics', {
        tenant: config.tenant,
        totalJobs: analytics.totalJobs,
        timeRange
      });

      return analytics;
    } catch (error: any) {
      this.logger.error('Failed to retrieve usage analytics', {
        tenant: config.tenant,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Get processing history for a user
   */
  async getUserProcessingHistory(
    config: BgRemoverMem0Config,
    userId: string,
    limit: number = 50,
    offset: number = 0
  ): Promise<{
    jobs: Array<{
      jobId: string;
      outputUrl: string;
      processingTimeMs: number;
      creditsUsed: number;
      createdAt: string;
      status: string;
    }>;
    totalCount: number;
    hasMore: boolean;
  }> {
    try {
      await this.authenticateWithMem0(config.tenant);

      // This would query Mem0 API for user's processing history
      // For now, return mock data
      const mockJobs = Array.from({ length: Math.min(limit, 20) }, (_, i) => ({
        jobId: `job-${offset + i + 1}`,
        outputUrl: `https://processed-images.s3.amazonaws.com/${config.tenant}/job-${offset + i + 1}.png`,
        processingTimeMs: 3000 + Math.random() * 3000,
        creditsUsed: 1,
        createdAt: new Date(Date.now() - (i * 24 * 60 * 60 * 1000)).toISOString(),
        status: 'completed'
      }));

      const result = {
        jobs: mockJobs,
        totalCount: 150, // Mock total count
        hasMore: offset + limit < 150
      };

      this.logger.info('Retrieved user processing history', {
        tenant: config.tenant,
        userId,
        jobsCount: result.jobs.length,
        totalCount: result.totalCount
      });

      return result;
    } catch (error: any) {
      this.logger.error('Failed to retrieve user processing history', {
        tenant: config.tenant,
        userId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Validate processing result before storage
   */
  validateProcessingResult(result: BgRemoverProcessingResult): boolean {
    if (!result.jobId || !result.outputUrl || !result.tenantId) {
      this.logger.error('Invalid processing result: missing required fields', {
        jobId: result.jobId,
        hasOutputUrl: !!result.outputUrl,
        tenantId: result.tenantId
      });
      return false;
    }

    if (result.creditsUsed < 0) {
      this.logger.error('Invalid processing result: negative credits used', {
        jobId: result.jobId,
        creditsUsed: result.creditsUsed
      });
      return false;
    }

    if (result.processingTimeMs <= 0) {
      this.logger.error('Invalid processing result: invalid processing time', {
        jobId: result.jobId,
        processingTimeMs: result.processingTimeMs
      });
      return false;
    }

    return true;
  }

  /**
   * Batch store multiple processing results
   */
  async batchStoreProcessingResults(results: BgRemoverProcessingResult[]): Promise<{
    successful: number;
    failed: number;
    errors: Array<{ jobId: string; error: string }>;
  }> {
    const startTime = Date.now();
    let successful = 0;
    let failed = 0;
    const errors: Array<{ jobId: string; error: string }> = [];

    this.logger.info('Starting batch storage of processing results', {
      tenant: results[0]?.tenantId,
      batchSize: results.length
    });

    // Process in batches to avoid overwhelming the API
    const batchSize = 10;
    for (let i = 0; i < results.length; i += batchSize) {
      const batch = results.slice(i, i + batchSize);

      const batchPromises = batch.map(async (result) => {
        try {
          if (!this.validateProcessingResult(result)) {
            throw new Error('Validation failed');
          }

          await this.storeProcessingResult(result);
          successful++;
        } catch (error: any) {
          failed++;
          errors.push({
            jobId: result.jobId,
            error: error.message
          });
        }
      });

      await Promise.all(batchPromises);
    }

    // Emit batch processing metrics
    await emitDataProcessingMetrics(
      results[0]?.tenantId || 'unknown',
      'bg-remover-batch-processing',
      successful,
      Date.now() - startTime,
      failed === 0
    );

    this.logger.info('Completed batch storage of processing results', {
      tenant: results[0]?.tenantId,
      total: results.length,
      successful,
      failed,
      durationMs: Date.now() - startTime
    });

    return { successful, failed, errors };
  }
}