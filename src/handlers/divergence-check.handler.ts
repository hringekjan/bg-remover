/**
 * Divergence Check Handler
 *
 * Runs every 6 hours to compare outcomes written to carousel-main vs lcp-outcomes.
 * Identifies divergences (one-sided failures, data mismatches) and emits metrics/alerts.
 *
 * Timeline: 2026-04-29 to 2026-05-01 (48h validation window)
 * Success Criteria: divergence < 1%, no critical incidents
 */

import { DynamoDBClient, QueryCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';

interface DivergenceCheckEvent {
  checkWindow?: number; // hours to look back (default: 6)
}

interface OutcomeRecord {
  id: string;
  tenantId: string;
  saleId: string;
  classification: string;
  accuracy?: number;
  qualityScores?: { overallAccuracy?: number };
  createdAt: string;
  outcomeType: string;
}

interface DivergenceCheckResult {
  checkWindow: number;
  timeRange: { start: string; end: string };
  carouselMainCount: number;
  lcpApiCount: number;
  matchedCount: number;
  divergenceCount: number;
  divergencePercentage: number;
  divergenceEvents: Array<{
    saleId: string;
    outcomeId: string;
    reason: string; // 'missing_lcp' | 'missing_carousel' | 'field_mismatch' | 'type_mismatch'
    carouselData?: Partial<OutcomeRecord>;
    lcpData?: Partial<OutcomeRecord>;
  }>;
  status: 'PASS' | 'WARN' | 'FAIL';
  recommendations: string[];
}

const ddbClient = new DynamoDBClient({ region: process.env.AWS_REGION || 'eu-west-1' });
const cwClient = new CloudWatchClient({ region: process.env.AWS_REGION || 'eu-west-1' });
const snsClient = new SNSClient({ region: process.env.AWS_REGION || 'eu-west-1' });

const CAROUSEL_MAIN_TABLE = process.env.CAROUSEL_MAIN_TABLE || 'carousel-main-dev';
const LCP_OUTCOMES_TABLE = process.env.LCP_OUTCOMES_TABLE || 'lcp-outcomes-dev';
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const DIVERGENCE_ALERT_TOPIC = process.env.DIVERGENCE_ALERT_TOPIC_ARN;

/**
 * Lambda handler for divergence check
 */
export async function handler(event: DivergenceCheckEvent): Promise<DivergenceCheckResult> {
  const checkWindow = event.checkWindow ?? 6; // Default: 6 hours
  const now = new Date();
  const windowStart = new Date(now.getTime() - checkWindow * 60 * 60 * 1000);

  console.log(`Starting divergence check for past ${checkWindow} hours`);
  console.log(`Window: ${windowStart.toISOString()} to ${now.toISOString()}`);

  try {
    // Query outcomes from both systems
    const [carouselOutcomes, lcpOutcomes] = await Promise.all([
      queryOutcomesFromCarouselMain(windowStart, now),
      queryOutcomesFromLcpApi(windowStart, now),
    ]);

    console.log(`Found ${carouselOutcomes.length} outcomes in carousel-main`);
    console.log(`Found ${lcpOutcomes.length} outcomes in lcp-outcomes`);

    // Compare outcomes
    const divergences = compareOutcomes(carouselOutcomes, lcpOutcomes);

    const divergencePercentage =
      carouselOutcomes.length > 0
        ? (divergences.length / carouselOutcomes.length) * 100
        : 0;

    const matchedCount = carouselOutcomes.length - divergences.length;

    // Determine status
    let status: 'PASS' | 'WARN' | 'FAIL' = 'PASS';
    const recommendations: string[] = [];

    if (divergencePercentage >= 1.0) {
      status = 'FAIL';
      recommendations.push(
        'Divergence >= 1% detected. Rollback dual-write and investigate root cause.',
        'Check CloudWatch dashboard for per-system write success rates.',
        'Review DLQ depths for failed outcome writes.'
      );
    } else if (divergencePercentage >= 0.5) {
      status = 'WARN';
      recommendations.push(
        'Divergence 0.5–1% detected. Monitor closely for escalation.',
        'Sample divergent records below — investigate for patterns.'
      );
    }

    const result: DivergenceCheckResult = {
      checkWindow,
      timeRange: { start: windowStart.toISOString(), end: now.toISOString() },
      carouselMainCount: carouselOutcomes.length,
      lcpApiCount: lcpOutcomes.length,
      matchedCount,
      divergenceCount: divergences.length,
      divergencePercentage,
      divergenceEvents: divergences.slice(0, 10), // Top 10 for logging
      status,
      recommendations,
    };

    // Emit metrics
    await emitMetrics(result);

    // Log result with searchable marker
    console.log(`DIVERGENCE_CHECK_COMPLETE`, JSON.stringify(result, null, 2));

    if (divergences.length > 0) {
      console.warn(
        `DIVERGENCE_DETECTED divergenceCount=${divergences.length} ` +
          `percentageOfCarouselMain=${divergencePercentage.toFixed(2)}%`
      );
    }

    // Trigger alert if status is WARN or FAIL
    if (status !== 'PASS') {
      await sendAlert(result, divergences);
    }

    return result;
  } catch (error) {
    console.error('Divergence check failed:', error);
    throw error;
  }
}

/**
 * Query outcomes from carousel-main created in time window
 * Uses GSI on createdAt for efficient range query
 */
async function queryOutcomesFromCarouselMain(
  windowStart: Date,
  windowEnd: Date
): Promise<OutcomeRecord[]> {
  const outcomes: OutcomeRecord[] = [];
  let exclusiveStartKey: any = undefined;

  const startTimeStr = windowStart.toISOString();
  const endTimeStr = windowEnd.toISOString();

  // Query all tenants (may need pagination for large time windows)
  try {
    while (true) {
      const command = new QueryCommand({
        TableName: CAROUSEL_MAIN_TABLE,
        IndexName: 'CreatedAtIndex', // Assumes GSI on createdAt
        KeyConditionExpression: 'createdAt BETWEEN :start AND :end',
        ExpressionAttributeValues: {
          ':start': { S: startTimeStr },
          ':end': { S: endTimeStr },
        },
        ProjectionExpression: 'id,tenantId,saleId,classification,accuracy,qualityScores,createdAt,outcomeType',
        Limit: 1000,
        ExclusiveStartKey: exclusiveStartKey,
      });

      const response = await ddbClient.send(command);

      if (response.Items) {
        for (const item of response.Items) {
          const record = unmarshall(item);
          outcomes.push({
            id: record.id || record.outcomeId,
            tenantId: record.tenantId,
            saleId: record.saleId,
            classification: record.classification,
            accuracy: record.accuracy || record.qualityScores?.overallAccuracy,
            qualityScores: record.qualityScores,
            createdAt: record.createdAt,
            outcomeType: record.outcomeType,
          });
        }
      }

      if (!response.LastEvaluatedKey) {
        break;
      }

      exclusiveStartKey = response.LastEvaluatedKey;
    }
  } catch (error) {
    console.error('Error querying carousel-main:', error);
    throw error;
  }

  return outcomes;
}

/**
 * Query outcomes from lcp-outcomes created in time window
 */
async function queryOutcomesFromLcpApi(
  windowStart: Date,
  windowEnd: Date
): Promise<OutcomeRecord[]> {
  const outcomes: OutcomeRecord[] = [];
  let exclusiveStartKey: any = undefined;

  const startTimeStr = windowStart.toISOString();
  const endTimeStr = windowEnd.toISOString();

  try {
    while (true) {
      const command = new QueryCommand({
        TableName: LCP_OUTCOMES_TABLE,
        IndexName: 'CreatedAtIndex', // Assumes GSI on createdAt
        KeyConditionExpression: 'createdAt BETWEEN :start AND :end',
        ExpressionAttributeValues: {
          ':start': { S: startTimeStr },
          ':end': { S: endTimeStr },
        },
        ProjectionExpression: 'outcomeId,tenantId,saleId,classification,accuracy,qualityScores,createdAt,outcomeType',
        Limit: 1000,
        ExclusiveStartKey: exclusiveStartKey,
      });

      const response = await ddbClient.send(command);

      if (response.Items) {
        for (const item of response.Items) {
          const record = unmarshall(item);
          outcomes.push({
            id: record.outcomeId,
            tenantId: record.tenantId,
            saleId: record.saleId,
            classification: record.classification,
            accuracy: record.accuracy,
            qualityScores: record.qualityScores,
            createdAt: record.createdAt,
            outcomeType: record.outcomeType,
          });
        }
      }

      if (!response.LastEvaluatedKey) {
        break;
      }

      exclusiveStartKey = response.LastEvaluatedKey;
    }
  } catch (error) {
    console.error('Error querying lcp-outcomes:', error);
    throw error;
  }

  return outcomes;
}

/**
 * Compare outcomes from both systems and identify divergences
 * Tolerance: ±5 seconds on timestamps, ±0.5% on accuracy scores
 */
function compareOutcomes(
  carouselOutcomes: OutcomeRecord[],
  lcpOutcomes: OutcomeRecord[]
): DivergenceCheckResult['divergenceEvents'] {
  const divergences: DivergenceCheckResult['divergenceEvents'] = [];

  // Build map of lcp outcomes by saleId for O(1) lookup
  const lcpBySaleId = new Map<string, OutcomeRecord>();
  for (const outcome of lcpOutcomes) {
    lcpBySaleId.set(`${outcome.tenantId}#${outcome.saleId}`, outcome);
  }

  // Check each carousel outcome for matching lcp outcome
  for (const carouselOutcome of carouselOutcomes) {
    const key = `${carouselOutcome.tenantId}#${carouselOutcome.saleId}`;
    const lcpOutcome = lcpBySaleId.get(key);

    if (!lcpOutcome) {
      // Missing from lcp-outcomes
      divergences.push({
        saleId: carouselOutcome.saleId,
        outcomeId: carouselOutcome.id,
        reason: 'missing_lcp',
        carouselData: carouselOutcome,
      });
      continue;
    }

    // Compare critical fields
    const timestampDiff = Math.abs(
      new Date(carouselOutcome.createdAt).getTime() - new Date(lcpOutcome.createdAt).getTime()
    );

    const carouselAccuracy = carouselOutcome.accuracy ?? carouselOutcome.qualityScores?.overallAccuracy ?? 0;
    const lcpAccuracy = lcpOutcome.accuracy ?? 0;
    const accuracyDiff = Math.abs(carouselAccuracy - lcpAccuracy);

    // Divergence conditions
    const timestampTolerance = 5000; // 5 seconds
    const accuracyTolerance = 0.5; // 0.5%

    if (timestampDiff > timestampTolerance) {
      divergences.push({
        saleId: carouselOutcome.saleId,
        outcomeId: carouselOutcome.id,
        reason: 'field_mismatch',
        carouselData: { createdAt: carouselOutcome.createdAt },
        lcpData: { createdAt: lcpOutcome.createdAt },
      });
    } else if (accuracyDiff > accuracyTolerance) {
      divergences.push({
        saleId: carouselOutcome.saleId,
        outcomeId: carouselOutcome.id,
        reason: 'field_mismatch',
        carouselData: { accuracy: carouselAccuracy },
        lcpData: { accuracy: lcpAccuracy },
      });
    } else if (carouselOutcome.classification !== lcpOutcome.classification) {
      divergences.push({
        saleId: carouselOutcome.saleId,
        outcomeId: carouselOutcome.id,
        reason: 'type_mismatch',
        carouselData: { classification: carouselOutcome.classification },
        lcpData: { classification: lcpOutcome.classification },
      });
    }

    // Remove from map so we can detect outcomes in lcp but not in carousel
    lcpBySaleId.delete(key);
  }

  // Check for outcomes in lcp but missing from carousel (should be rare)
  for (const [key, lcpOutcome] of lcpBySaleId) {
    divergences.push({
      saleId: lcpOutcome.saleId,
      outcomeId: lcpOutcome.id,
      reason: 'missing_carousel',
      lcpData: lcpOutcome,
    });
  }

  return divergences;
}

/**
 * Emit divergence metrics to CloudWatch
 */
async function emitMetrics(result: DivergenceCheckResult): Promise<void> {
  try {
    const metricData: Parameters<typeof PutMetricDataCommand>[0]['MetricData'] = [
      {
        MetricName: 'divergence-check-carousel-count',
        Value: result.carouselMainCount,
        Unit: 'Count',
        Timestamp: new Date(),
      },
      {
        MetricName: 'divergence-check-lcp-count',
        Value: result.lcpApiCount,
        Unit: 'Count',
        Timestamp: new Date(),
      },
      {
        MetricName: 'divergence-check-matched',
        Value: result.matchedCount,
        Unit: 'Count',
        Timestamp: new Date(),
      },
      {
        MetricName: 'divergence-check-divergence-count',
        Value: result.divergenceCount,
        Unit: 'Count',
        Timestamp: new Date(),
        Dimensions: [
          { Name: 'CheckWindow', Value: `${result.checkWindow}h` },
          { Name: 'Status', Value: result.status },
        ],
      },
      {
        MetricName: 'divergence-check-divergence-percentage',
        Value: result.divergencePercentage,
        Unit: 'Percent',
        Timestamp: new Date(),
        Dimensions: [{ Name: 'CheckWindow', Value: `${result.checkWindow}h` }],
      },
    ];

    const command = new PutMetricDataCommand({
      Namespace: 'bg-remover/divergence-check',
      MetricData: metricData,
    });

    await cwClient.send(command);
    console.log('Metrics emitted successfully');
  } catch (error) {
    console.error('Failed to emit metrics:', error);
    // Don't throw; metrics emission should not block check completion
  }
}

/**
 * Send alert (SNS + optional Slack) if divergence detected
 */
async function sendAlert(
  result: DivergenceCheckResult,
  allDivergences: DivergenceCheckResult['divergenceEvents']
): Promise<void> {
  const message = formatAlertMessage(result, allDivergences);

  // SNS alert (for integration with oncall system)
  if (DIVERGENCE_ALERT_TOPIC) {
    try {
      const command = new PublishCommand({
        TopicArn: DIVERGENCE_ALERT_TOPIC,
        Subject: `bg-remover Dual-Write Divergence Detected (${result.status})`,
        Message: message,
      });

      await snsClient.send(command);
      console.log('SNS alert sent');
    } catch (error) {
      console.error('Failed to send SNS alert:', error);
    }
  }

  // Slack webhook (optional, if configured)
  if (SLACK_WEBHOOK_URL) {
    try {
      const slackPayload = formatSlackMessage(result);
      await fetch(SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(slackPayload),
      });
      console.log('Slack message sent');
    } catch (error) {
      console.error('Failed to send Slack message:', error);
    }
  }
}

/**
 * Format alert message for SNS/email
 */
function formatAlertMessage(
  result: DivergenceCheckResult,
  allDivergences: DivergenceCheckResult['divergenceEvents']
): string {
  const sampleRecords = allDivergences
    .slice(0, 5)
    .map(
      (d) =>
        `  - Sale ${d.saleId} (outcome ${d.outcomeId}): ${d.reason}\n` +
        (d.carouselData ? `    Carousel: ${JSON.stringify(d.carouselData)}\n` : '') +
        (d.lcpData ? `    LCP: ${JSON.stringify(d.lcpData)}` : '')
    )
    .join('\n');

  return `
BG-REMOVER DUAL-WRITE DIVERGENCE ALERT

Status: ${result.status}
Time Window: ${result.checkWindow}h (${result.timeRange.start} to ${result.timeRange.end})

Summary:
  Carousel-Main Outcomes: ${result.carouselMainCount}
  LCP-API Outcomes: ${result.lcpApiCount}
  Matched: ${result.matchedCount}
  Divergences: ${result.divergenceCount} (${result.divergencePercentage.toFixed(2)}%)

Recommendations:
${result.recommendations.map((r) => `  - ${r}`).join('\n')}

Sample Divergent Records:
${sampleRecords}

Dashboard: https://console.aws.amazon.com/cloudwatch/home?region=eu-west-1#dashboards:name=bg-remover-DualWrite-Validation

Decision Gate: 2026-05-01 00:00 UTC
  `;
}

/**
 * Format alert message for Slack
 */
function formatSlackMessage(result: DivergenceCheckResult) {
  return {
    channel: '#platform-alerts',
    username: 'BG-Remover Monitor',
    icon_emoji: ':warning:',
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `⚠️ Dual-Write Divergence Detected (${result.status})`,
        },
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Check Window:*\n${result.checkWindow}h`,
          },
          {
            type: 'mrkdwn',
            text: `*Divergence %:*\n${result.divergencePercentage.toFixed(2)}%`,
          },
          {
            type: 'mrkdwn',
            text: `*Carousel-Main:*\n${result.carouselMainCount} outcomes`,
          },
          {
            type: 'mrkdwn',
            text: `*LCP-API:*\n${result.lcpApiCount} outcomes`,
          },
        ],
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Recommendations:*\n${result.recommendations.map((r) => `• ${r}`).join('\n')}`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'View Dashboard',
            },
            url: 'https://console.aws.amazon.com/cloudwatch/home?region=eu-west-1#dashboards:name=bg-remover-DualWrite-Validation',
            style: 'primary',
          },
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Check Logs',
            },
            url: 'https://console.aws.amazon.com/cloudwatch/home?region=eu-west-1#logStream:',
          },
        ],
      },
    ],
  };
}
