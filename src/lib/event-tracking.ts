import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { PutItemCommand, QueryCommand, AttributeValue } from '@aws-sdk/client-dynamodb';

interface EventStatsResponse {
  byEventType: Record<string, {
    count: number;
    errorCount: number;
    avgLatency: number;
  }>;
}

export class EventTracker {
  private client: DynamoDBClient;

  constructor(client: DynamoDBClient) {
    this.client = client;
  }

  async recordEvent(
    tenantId: string,
    eventType: string,
    latencyMs?: number,
    error?: string
  ): Promise<void> {
    const timestamp = new Date().toISOString();

    const item: Record<string, AttributeValue> = {
      pk: { S: `SERVICE#bg-remover#TENANT#${tenantId}#METRICS` },
      sk: { S: `${timestamp}#${eventType}` },
      eventType: { S: eventType },
      timestamp: { S: timestamp },
    };

    if (latencyMs !== undefined) {
      item.latencyMs = { N: latencyMs.toString() };
    }

    if (error) {
      item.error = { S: error };
    }

    const command = new PutItemCommand({
      TableName: process.env.EVENT_TRACKING_TABLE || 'event-tracking-dev',
      Item: item
    });

    await this.client.send(command);
  }

  async getEventStats(
    tenantId: string,
    timeframeMs: number = 86400000 // Default: 24 hours
  ): Promise<EventStatsResponse> {
    const startTime = new Date(Date.now() - timeframeMs).toISOString();

    const TableName = process.env.EVENT_TRACKING_TABLE || 'event-tracking-dev';
    const pkValue = `SERVICE#bg-remover#TENANT#${tenantId}#METRICS`;

    console.log('[EventTracker] Querying DynamoDB:', {
      TableName,
      pk: pkValue,
      startTime: startTime,
      timeframeHours: timeframeMs / (1000 * 60 * 60)
    });

    // Use range query instead of begins_with to get all events from startTime onwards
    const command = new QueryCommand({
      TableName: TableName,
      KeyConditionExpression: 'pk = :pk AND sk >= :startTime',
      ExpressionAttributeValues: {
        ':pk': { S: pkValue },
        ':startTime': { S: startTime }
      }
    });

    let result;
    try {
      result = await this.client.send(command);
    } catch (error) {
      console.error('[EventTracker] DynamoDB query failed:', error);
      
      // If table doesn't exist or pk is missing, return empty stats
      if ((error as any)?.name === 'ResourceNotFoundException' || 
          (error as any)?.message?.includes('key schema element')) {
        console.log('[EventTracker] Table not found or schema mismatch, returning empty stats');
        result = { Items: [] };
      } else {
        throw error; // Re-throw other errors
      }
    }

    // Initialize stats object
    const byEventType: Record<string, {
      count: number;
      errorCount: number;
      avgLatency: number;
    }> = {};

    // Pre-populate with valid event types
    const validEventTypes = [
      'IMAGE_UPLOADED',
      'BACKGROUND_REMOVED',
      'PROCESSING_FAILED',
      'BATCH_COMPLETED',
      'QUALITY_CHECK'
    ];

    for (const eventType of validEventTypes) {
      byEventType[eventType] = {
        count: 0,
        errorCount: 0,
        avgLatency: 0
      };
    }

    // Process items
    if (result.Items) {
      for (const item of result.Items) {
        const eventType = item.eventType?.S || 'Unknown';

        // Skip unknown event types
        if (!validEventTypes.includes(eventType)) {
          continue;
        }

        // Increment count
        byEventType[eventType].count += 1;

        // Handle errors
        if (item.error?.S) {
          byEventType[eventType].errorCount += 1;
        }

        // Handle latency
        if (item.latencyMs?.N) {
          const latency = parseInt(item.latencyMs.N, 10);
          if (!isNaN(latency)) {
            // Update running average
            const currentAvg = byEventType[eventType].avgLatency;
            const currentCount = byEventType[eventType].count;

            // Simple incremental average calculation
            byEventType[eventType].avgLatency =
              ((currentAvg * (currentCount - 1)) + latency) / currentCount;
          }
        }
      }
    }

    return { byEventType };
  }
}
