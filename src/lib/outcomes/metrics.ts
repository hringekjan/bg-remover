import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';

/**
 * LCP Outcomes Metrics Emitter
 *
 * Emits CloudWatch custom metrics for triple-write operations (Layer 2 dual-write):
 * - carousel-main-success, carousel-main-failure (primary: DynamoDB)
 * - lcp-api-success, lcp-api-failure (secondary: LCP-API for 48h validation)
 * - mem0-success, mem0-failure (knowledge store)
 * - dual-write-discrepancy (divergence indicator)
 * - dual-write-complete (both primary and secondary succeeded)
 *
 * Validation window: 2026-04-29 to 2026-05-01 (48h)
 * Success criteria: < 1% divergence between carousel-main and LCP-API
 *
 * Namespace: bg-remover/outcomes
 * Dimensions: OutcomeType, TenantId, Stage
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

  /**
   * Record successful LCP-API write (secondary/Layer 2)
   */
  async recordLcpApiSuccess(outcomeType: string, tenantId: string, stage: string): Promise<void> {
    await this.putMetric('lcp-api-success', 1, {
      OutcomeType: outcomeType,
      TenantId: tenantId,
      Stage: stage,
    });
  }

  /**
   * Record failed LCP-API write (secondary/Layer 2)
   */
  async recordLcpApiFailure(outcomeType: string, tenantId: string, stage: string): Promise<void> {
    await this.putMetric('lcp-api-failure', 1, {
      OutcomeType: outcomeType,
      TenantId: tenantId,
      Stage: stage,
    });
  }

  /**
   * Record successful dual-write completion (both primary and secondary succeeded)
   */
  async recordDualWriteComplete(outcomeType: string, tenantId: string, stage: string): Promise<void> {
    await this.putMetric('dual-write-complete', 1, {
      OutcomeType: outcomeType,
      TenantId: tenantId,
      Stage: stage,
    });
  }
}

export default OutcomesMetrics;
