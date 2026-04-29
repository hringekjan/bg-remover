import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';

/**
 * LCP Outcomes Metrics Emitter
 * 
 * Emits CloudWatch custom metrics for dual-write operations:
 * - mem0-success, mem0-failure
 * - ddb-success, ddb-failure
 * - dual-write-discrepancy (divergence indicator)
 * 
 * Namespace: lcp-outcomes
 * Dimensions: OutcomeType, Tenant, Stage
 */
export class OutcomesMetrics {
  private cloudWatch: CloudWatchClient;
  private namespace = 'lcp-outcomes';

  constructor(region: string = process.env.AWS_REGION || 'eu-west-1') {
    this.cloudWatch = new CloudWatchClient({ region });
  }

  /**
   * Emit metric data to CloudWatch
   */
  async putMetric(
    metricName: string,
    value: number,
    dimensions: Record<string, string>,
    unit: string = 'Count'
  ): Promise<void> {
    try {
      await this.cloudWatch.send(
        new PutMetricDataCommand({
          Namespace: this.namespace,
          MetricData: [
            {
              MetricName: metricName,
              Value: value,
              Unit: unit as any,
              Timestamp: new Date(),
              Dimensions: Object.entries(dimensions).map(([name, value]) => ({
                Name: name,
                Value: value,
              })),
            },
          ],
        })
      );
    } catch (error) {
      console.error(`Failed to emit metric ${metricName}:`, error);
    }
  }

  /**
   * Record successful mem0 write
   */
  async recordMem0Success(outcomeType: string, tenant: string, stage: string): Promise<void> {
    await this.putMetric('mem0-success', 1, {
      OutcomeType: outcomeType,
      Tenant: tenant,
      Stage: stage,
    });
  }

  /**
   * Record failed mem0 write
   */
  async recordMem0Failure(outcomeType: string, tenant: string, stage: string): Promise<void> {
    await this.putMetric('mem0-failure', 1, {
      OutcomeType: outcomeType,
      Tenant: tenant,
      Stage: stage,
    });
  }

  /**
   * Record successful DDB write
   */
  async recordDdbSuccess(outcomeType: string, tenant: string, stage: string): Promise<void> {
    await this.putMetric('ddb-success', 1, {
      OutcomeType: outcomeType,
      Tenant: tenant,
      Stage: stage,
    });
  }

  /**
   * Record failed DDB write
   */
  async recordDdbFailure(outcomeType: string, tenant: string, stage: string): Promise<void> {
    await this.putMetric('ddb-failure', 1, {
      OutcomeType: outcomeType,
      Tenant: tenant,
      Stage: stage,
    });
  }

  /**
   * Record dual-write discrepancy (one succeeded, one failed)
   */
  async recordDiscrepancy(outcomeType: string, tenant: string, stage: string): Promise<void> {
    await this.putMetric('dual-write-discrepancy', 1, {
      OutcomeType: outcomeType,
      Tenant: tenant,
      Stage: stage,
    });
  }
}

export default OutcomesMetrics;
