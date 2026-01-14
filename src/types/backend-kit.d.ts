/**
 * Type augmentation for @carousellabs/backend-kit
 * Provides type definitions until backend-kit build:types is fixed
 */

declare module '@carousellabs/backend-kit' {
  import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
  import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
  import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

  // Agent Task Metrics
  export interface AgentTaskMetrics {
    agentId: string;
    taskId: string;
    status: 'success' | 'failure' | 'timeout' | 'error';
    responseTimeMs: number;
    costUsd: number;
    timestamp: Date;
    metadata?: Record<string, any>;
    error?: {
      message: string;
      stack?: string;
      code?: string;
    };
  }

  // Aggregated Metrics
  export interface AggregatedMetrics {
    agentId: string;
    timeWindow: '1h' | '24h' | '7d' | '30d';
    totalTasks: number;
    successfulTasks: number;
    failedTasks: number;
    successRate: number;
    averageResponseTimeMs: number;
    p50ResponseTimeMs: number;
    p95ResponseTimeMs: number;
    p99ResponseTimeMs: number;
    totalCostUsd: number;
    averageCostPerTask: number;
    startTime: Date;
    endTime: Date;
  }

  // Agent Telemetry Options
  export interface AgentTelemetryOptions {
    dynamoClient?: DynamoDBDocumentClient;
    stage?: string;
    eventBusName?: string;
    region?: string;
    samplingRate?: number;
    tenantId?: string;
    enableCloudWatch?: boolean;
  }

  // Agent Telemetry Class
  export class AgentTelemetry {
    constructor(options?: AgentTelemetryOptions);
    recordTask(metrics: AgentTaskMetrics): Promise<void>;
    getMetrics(agentId: string, timeWindow?: '1h' | '24h' | '7d' | '30d'): Promise<AggregatedMetrics>;
    publishMetrics(agentId: string, timeWindow?: '1h' | '24h' | '7d'): Promise<void>;
    createTracker(agentId: string): {
      startOperation: (taskId: string, metadata?: Record<string, any>) => {
        endOperation: (result: {
          success: boolean;
          errorMessage?: string;
          errorCode?: string;
          errorStack?: string;
          costUsd?: number;
          additionalMetrics?: Record<string, any>;
        }) => Promise<void>;
      };
    };
  }

  // Re-export all other backend-kit exports (for compatibility)
  export * from '@carousellabs/backend-kit';
}
