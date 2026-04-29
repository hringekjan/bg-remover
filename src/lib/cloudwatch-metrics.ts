/**
 * CloudWatch Metrics Helper for bg-remover dual-write operations
 *
 * Emits custom metrics to CloudWatch for monitoring:
 * - Mem0 write success/failure
 * - DynamoDB write success/failure
 * - Divergence detection (one succeeds, one fails)
 * - Overall dual-write success rate
 * - Operation duration
 */

import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';

/**
 * Metric types for dual-write operations
 */
export enum MetricType {
  // Individual write success/failure
  Mem0WriteSuccess = 'bg-remover/mem0/write-success',
  Mem0WriteFailure = 'bg-remover/mem0/write-failure',
  DDBWriteSuccess = 'bg-remover/ddb/write-success',
  DDBWriteFailure = 'bg-remover/ddb/write-failure',

  // Overall dual-write status
  DualWriteSuccess = 'bg-remover/dual-write-success',
  DualWriteFailure = 'bg-remover/dual-write-failure',

  // Divergence — critical for monitoring consistency
  DivergenceDetected = 'bg-remover/divergence-detected',

  // Performance
  DualWriteDuration = 'bg-remover/dual-write-duration',
  Mem0WriteDuration = 'bg-remover/mem0/write-duration',
  DDBWriteDuration = 'bg-remover/ddb/write-duration',
}

/**
 * Dimension for CloudWatch metrics
 */
interface MetricDimension {
  [key: string]: string;
}

/**
 * Creates a CloudWatch metrics client for bg-remover
 */
export function createCloudWatchMetrics(namespace: string) {
  const client = new CloudWatchClient({ region: process.env.AWS_REGION || 'eu-west-1' });

  return {
    /**
     * Put a metric data point to CloudWatch
     * @param metricType — MetricType enum value
     * @param value — numeric value (count or duration)
     * @param dimensions — optional key-value dimensions
     */
    async putMetric(
      metricType: MetricType | string,
      value: number,
      dimensions?: MetricDimension
    ): Promise<void> {
      try {
        const dims = dimensions
          ? Object.entries(dimensions).map(([name, value]) => ({ Name: name, Value: value }))
          : [];

        const command = new PutMetricDataCommand({
          Namespace: namespace,
          MetricData: [
            {
              MetricName: metricType,
              Value: value,
              Unit: metricType.includes('duration') ? 'Milliseconds' : 'Count',
              Timestamp: new Date(),
              Dimensions: dims.length > 0 ? dims : undefined,
            },
          ],
        });

        await client.send(command);
      } catch (error) {
        console.error(`Failed to emit metric ${metricType}:`, error);
        // Don't throw — metrics emission should not block operations
      }
    },

    /**
     * Batch put multiple metrics
     * @param metrics — array of { metricType, value, dimensions? }
     */
    async putMetrics(
      metrics: Array<{
        metricType: MetricType | string;
        value: number;
        dimensions?: MetricDimension;
      }>
    ): Promise<void> {
      try {
        const metricData = metrics.map((m) => ({
          MetricName: m.metricType,
          Value: m.value,
          Unit: m.metricType.includes('duration') ? 'Milliseconds' : 'Count',
          Timestamp: new Date(),
          Dimensions: m.dimensions
            ? Object.entries(m.dimensions).map(([name, value]) => ({ Name: name, Value: value }))
            : undefined,
        }));

        const command = new PutMetricDataCommand({
          Namespace: namespace,
          MetricData,
        });

        await client.send(command);
      } catch (error) {
        console.error('Failed to emit metrics batch:', error);
      }
    },
  };
}

/**
 * Helper to format divergence summary for logging
 */
export function formatDivergenceSummary(
  outcomeId: string,
  mem0Success: boolean,
  ddbSuccess: boolean,
  mem0Error?: string,
  ddbError?: string
): string {
  return [
    `Outcome ID: ${outcomeId}`,
    `Mem0: ${mem0Success ? '✓' : '✗'} ${mem0Error ? `(${mem0Error})` : ''}`,
    `DDB:  ${ddbSuccess ? '✓' : '✗'} ${ddbError ? `(${ddbError})` : ''}`,
  ].join('\n');
}

/**
 * CloudWatch Alarm creation helper (for infrastructure-as-code)
 * Can be called during bootstrap or monitoring setup
 */
export function createDivergenceAlarmYaml(stage: string): string {
  return `
    DivergenceAlarm:
      Type: AWS::CloudWatch::Alarm
      Properties:
        AlarmName: bg-remover-divergence-alarm-${stage}
        AlarmDescription: Alert when dual-write divergence is detected
        MetricName: ${MetricType.DivergenceDetected}
        Namespace: bg-remover
        Statistic: Sum
        Period: 300
        EvaluationPeriods: 1
        Threshold: 1
        ComparisonOperator: GreaterThanOrEqualToThreshold
        TreatMissingData: notBreaching
        AlarmActions:
          - !Ref AlertTopic
`;
}
