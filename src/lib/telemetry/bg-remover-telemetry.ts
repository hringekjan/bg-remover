/**
 * BG-Remover Telemetry Wrapper
 *
 * Provides domain-specific telemetry tracking for bg-remover agent operations.
 * Wraps @carousellabs/backend-kit/agent-telemetry with bg-remover specific helpers.
 *
 * @module bg-remover/lib/telemetry
 */

// Import from local type definitions instead of backend-kit package
import type { AgentTelemetry, AgentTaskMetrics } from '../../types/backend-kit';

const AGENT_ID = 'bg-remover';

/**
 * Cost calculation for bg-remover operations
 */
export interface BgRemoverCostParams {
  /** Image size in bytes */
  imageSize: number;
  /** Processing time in milliseconds */
  processingTime: number;
  /** Quality level (low/medium/high) */
  qualityLevel: 'low' | 'medium' | 'high';
  /** Number of images processed */
  imageCount?: number;
}

/**
 * Metadata for single image processing
 */
export interface ImageProcessingMetadata {
  imageSize: number;
  processingMode: 'single' | 'batch' | 'group';
  qualityLevel: string;
  outputFormat: string;
  pipelineType?: string;
  rekognitionLabels?: number;
}

/**
 * Metadata for batch job processing
 */
export interface BatchJobMetadata {
  batchId: string;
  imagesProcessed: number;
  successCount: number;
  failureCount: number;
  totalCost: number;
  durationMs: number;
  pipeline?: string;
  concurrencyUsed?: number;
  processingMode?: string;
}

/**
 * Calculate cost for bg-remover operations
 * Based on Bedrock Nova Lite pricing: $0.00008/1K input tokens + $0.00032/1K output tokens
 * Estimated ~500 input tokens + ~100 output tokens per image
 */
export function calculateBgRemoverCost(params: BgRemoverCostParams): number {
  const { imageSize, processingTime, qualityLevel, imageCount = 1 } = params;

  // Base cost per image (Bedrock Nova Lite)
  // Input: ~500 tokens * $0.00008/1K = $0.00004
  // Output: ~100 tokens * $0.00032/1K = $0.000032
  const bedrockCostPerImage = 0.00004 + 0.000032; // $0.000072

  // Quality multiplier
  const qualityMultipliers = {
    low: 0.5,
    medium: 1.0,
    high: 1.5,
  };
  const qualityMultiplier = qualityMultipliers[qualityLevel] || 1.0;

  // Size multiplier (large images cost more)
  const sizeMB = imageSize / (1024 * 1024);
  const sizeMultiplier = Math.max(1.0, sizeMB / 2); // 2MB baseline

  // Processing time overhead (Lambda cost)
  // Lambda cost: $0.0000166667/GB-sec for arm64
  // 1536MB memory = 1.5GB * processing time in seconds
  const processingTimeSec = processingTime / 1000;
  const lambdaCost = 0.0000166667 * 1.5 * processingTimeSec;

  // Total cost
  const totalCost = (bedrockCostPerImage * qualityMultiplier * sizeMultiplier + lambdaCost) * imageCount;

  // Round to 6 decimal places
  return Math.round(totalCost * 1000000) / 1000000;
}

/**
 * BG-Remover Telemetry Tracker
 * Singleton instance for tracking bg-remover operations
 */
class BgRemoverTelemetry {
  private telemetry: AgentTelemetry | null;
  private stage: string;
  private tenantId: string;

  constructor() {
    this.stage = process.env.STAGE || 'dev';
    this.tenantId = process.env.TENANT || 'carousel-labs';

    try {
      this.telemetry = new AgentTelemetry({
        stage: this.stage,
        tenantId: this.tenantId,
        eventBusName: process.env.EVENT_BUS_NAME || `${this.tenantId}-${this.stage}-agent-events`,
        enableCloudWatch: true,
        samplingRate: 1.0, // 100% sampling for production
      });
    } catch (error) {
      console.error('[BgRemoverTelemetry] Failed to initialize AgentTelemetry:', error);
      this.telemetry = null; // Graceful degradation
    }
  }

  /**
   * Record single image processing metrics
   */
  async recordImageProcessing(params: {
    taskId: string;
    success: boolean;
    responseTimeMs: number;
    costUsd: number;
    metadata?: Partial<ImageProcessingMetadata>;
    error?: {
      message: string;
      code?: string;
      stack?: string;
    };
  }): Promise<void> {
    if (!this.telemetry) {
      console.warn('[BgRemoverTelemetry] Telemetry not initialized, skipping image processing metric');
      return;
    }

    try {
      await this.telemetry.recordTask({
        agentId: AGENT_ID,
        taskId: params.taskId,
        status: params.success ? 'success' : 'failure',
        responseTimeMs: params.responseTimeMs,
        costUsd: params.costUsd,
        timestamp: new Date(),
        metadata: params.metadata,
        error: params.error,
      });
    } catch (error) {
      console.error('[BgRemoverTelemetry] Failed to record image processing:', error);
      // Don't throw - telemetry failures shouldn't break processing
    }
  }

  /**
   * Record batch job processing metrics
   */
  async recordBatchJob(params: BatchJobMetadata): Promise<void> {
    if (!this.telemetry) {
      console.warn('[BgRemoverTelemetry] Telemetry not initialized, skipping batch job metric');
      return;
    }

    try {
      await this.telemetry.recordTask({
        agentId: AGENT_ID,
        taskId: `batch-${params.batchId}`,
        status: params.failureCount === 0 ? 'success' : 'failure',
        responseTimeMs: params.durationMs,
        costUsd: params.totalCost,
        timestamp: new Date(),
        metadata: {
          batchId: params.batchId,
          imagesProcessed: params.imagesProcessed,
          successCount: params.successCount,
          failureCount: params.failureCount,
          pipeline: params.pipeline,
          concurrencyUsed: params.concurrencyUsed,
          processingMode: params.processingMode,
        },
      });
    } catch (error) {
      console.error('[BgRemoverTelemetry] Failed to record batch job:', error);
      // Don't throw - telemetry failures shouldn't break processing
    }
  }

  /**
   * Get aggregated metrics for a time window
   */
  async getMetrics(timeWindow: '1h' | '24h' | '7d' = '1h') {
    if (!this.telemetry) {
      console.warn('[BgRemoverTelemetry] Telemetry not initialized, returning empty metrics');
      return {
        agentId: AGENT_ID,
        timeWindow,
        totalTasks: 0,
        successfulTasks: 0,
        failedTasks: 0,
        successRate: 0,
        averageResponseTimeMs: 0,
        totalCostUsd: 0,
        averageCostPerTask: 0,
        p50ResponseTimeMs: 0,
        p95ResponseTimeMs: 0,
        p99ResponseTimeMs: 0,
        startTime: new Date(),
        endTime: new Date(),
      };
    }

    try {
      return await this.telemetry.getMetrics(AGENT_ID, timeWindow);
    } catch (error) {
      console.error('[BgRemoverTelemetry] Failed to get metrics:', error);
      // Return empty metrics on error
      return {
        agentId: AGENT_ID,
        timeWindow,
        totalTasks: 0,
        successfulTasks: 0,
        failedTasks: 0,
        successRate: 0,
        averageResponseTimeMs: 0,
        totalCostUsd: 0,
        averageCostPerTask: 0,
        p50ResponseTimeMs: 0,
        p95ResponseTimeMs: 0,
        p99ResponseTimeMs: 0,
        startTime: new Date(),
        endTime: new Date(),
      };
    }
  }

  /**
   * Health check - verify telemetry system is operational
   */
  async healthCheck(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy';
    metrics: {
      totalTasks: number;
      successRate: number;
      avgResponseTimeMs: number;
      totalCostUsd: number;
    };
  }> {
    if (!this.telemetry) {
      console.warn('[BgRemoverTelemetry] Telemetry not initialized, reporting unhealthy status');
      return {
        status: 'unhealthy',
        metrics: {
          totalTasks: 0,
          successRate: 0,
          avgResponseTimeMs: 0,
          totalCostUsd: 0,
        },
      };
    }

    try {
      const metrics = await this.telemetry.getMetrics(AGENT_ID, '1h');

      // Determine health based on success rate and recent activity
      let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
      if (metrics.successRate < 95) {
        status = 'degraded';
      }
      if (metrics.successRate < 50 || metrics.totalTasks === 0) {
        status = 'unhealthy';
      }

      return {
        status,
        metrics: {
          totalTasks: metrics.totalTasks,
          successRate: metrics.successRate,
          avgResponseTimeMs: metrics.averageResponseTimeMs,
          totalCostUsd: metrics.totalCostUsd,
        },
      };
    } catch (error) {
      console.error('[BgRemoverTelemetry] Health check failed:', error);
      return {
        status: 'unhealthy',
        metrics: {
          totalTasks: 0,
          successRate: 0,
          avgResponseTimeMs: 0,
          totalCostUsd: 0,
        },
      };
    }
  }

  /**
   * Publish metrics to EventBridge for agent-to-agent communication
   */
  async publishMetrics(timeWindow: '1h' | '24h' | '7d' = '1h'): Promise<void> {
    if (!this.telemetry) {
      console.warn('[BgRemoverTelemetry] Telemetry not initialized, skipping metrics publish');
      return;
    }

    try {
      await this.telemetry.publishMetrics(AGENT_ID, timeWindow);
    } catch (error) {
      console.error('[BgRemoverTelemetry] Failed to publish metrics:', error);
      // Don't throw - telemetry failures shouldn't break processing
    }
  }

  /**
   * Create a tracker for convenient operation tracking
   */
  createTracker(taskId: string) {
    if (!this.telemetry) {
      console.warn('[BgRemoverTelemetry] Telemetry not initialized, returning no-op tracker');
      // Return a no-op tracker that doesn't throw errors
      return {
        start: () => {},
        end: () => {},
        recordMetric: () => {},
        recordError: () => {},
      };
    }
    return this.telemetry.createTracker(AGENT_ID);
  }
}

// Export singleton instance
export const bgRemoverTelemetry = new BgRemoverTelemetry();

// Export types
export type { AgentTaskMetrics } from '@carousellabs/backend-kit';
