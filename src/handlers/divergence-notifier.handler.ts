/**
 * Divergence Notifier Handler
 *
 * Consumes divergence alerts from SNS and sends formatted Slack notifications
 * to the platform-alerts channel for oncall visibility.
 */

import { SNSEvent } from 'aws-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

interface DivergenceAlertMessage {
  checkWindow: number;
  timeRange: {
    start: string;
    end: string;
  };
  carouselMainCount: number;
  lcpApiCount: number;
  matchedCount: number;
  divergenceCount: number;
  divergencePercentage: number;
  divergenceEvents: Array<{
    saleId: string;
    outcomeId: string;
    reason: string;
  }>;
  status: 'PASS' | 'WARN' | 'FAIL';
  recommendations: string[];
}

const ssmClient = new SSMClient({ region: process.env.AWS_REGION || 'eu-west-1' });

/**
 * Lambda handler for SNS divergence alerts
 */
export async function handler(event: SNSEvent): Promise<void> {
  console.log('Received divergence alert SNS message');

  try {
    // Get Slack webhook URL from SSM Parameter Store
    const slackWebhookUrl = await getSlackWebhookUrl();

    // Process each SNS message
    for (const record of event.Records) {
      const message = record.Sns.Message;
      console.log('SNS Message:', message);

      // Try to parse as JSON; if it fails, treat as plain text
      let alert: DivergenceAlertMessage;
      try {
        alert = JSON.parse(message) as DivergenceAlertMessage;
      } catch {
        // If not JSON, treat as plain text alert message
        await sendTextAlertToSlack(slackWebhookUrl, message);
        continue;
      }

      // Send formatted Slack notification
      await sendAlertToSlack(slackWebhookUrl, alert);
    }

    console.log('Divergence alerts processed successfully');
  } catch (error) {
    console.error('Failed to process divergence alert:', error);
    // Don't throw; alerting failure should not block SNS processing
  }
}

/**
 * Fetch Slack webhook URL from SSM Parameter Store
 */
async function getSlackWebhookUrl(): Promise<string> {
  const stage = process.env.STAGE || 'dev';
  const paramName = `/bg-remover/slack-webhook-${stage}`;

  try {
    const command = new GetParameterCommand({
      Name: paramName,
      WithDecryption: true,
    });

    const response = await ssmClient.send(command);
    if (!response.Parameter?.Value) {
      throw new Error(`Parameter ${paramName} not found or empty`);
    }

    return response.Parameter.Value;
  } catch (error) {
    console.error(`Failed to fetch Slack webhook URL from ${paramName}:`, error);
    throw error;
  }
}

/**
 * Send formatted alert to Slack via webhook
 */
async function sendAlertToSlack(slackWebhookUrl: string, alert: DivergenceAlertMessage): Promise<void> {
  const payload = formatSlackPayload(alert);

  try {
    const response = await fetch(slackWebhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Slack API error: ${response.status} ${response.statusText}`);
    }

    console.log('Alert sent to Slack successfully');
  } catch (error) {
    console.error('Failed to send alert to Slack:', error);
    throw error;
  }
}

/**
 * Send plain text alert to Slack
 */
async function sendTextAlertToSlack(slackWebhookUrl: string, message: string): Promise<void> {
  const payload = {
    channel: '#platform-alerts',
    username: 'BG-Remover Monitor',
    icon_emoji: ':warning:',
    text: message,
  };

  try {
    const response = await fetch(slackWebhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Slack API error: ${response.status} ${response.statusText}`);
    }

    console.log('Text alert sent to Slack successfully');
  } catch (error) {
    console.error('Failed to send text alert to Slack:', error);
    throw error;
  }
}

/**
 * Format divergence alert into Slack block kit payload
 */
function formatSlackPayload(alert: DivergenceAlertMessage) {
  const divergenceColor = alert.divergencePercentage >= 1.0 ? '#FF0000' : '#FFA500'; // Red if FAIL, Orange if WARN
  const emoji = alert.status === 'FAIL' ? ':fire:' : ':warning:';

  const sampleRecords = alert.divergenceEvents
    .slice(0, 3)
    .map(
      (d) =>
        `• Sale ${d.saleId} (outcome ${d.outcomeId.slice(0, 8)}...): ${d.reason.replace(/_/g, ' ')}`
    )
    .join('\n');

  const fields = [
    {
      type: 'mrkdwn',
      text: `*Window:*\n${alert.checkWindow}h`,
    },
    {
      type: 'mrkdwn',
      text: `*Status:*\n${alert.status}`,
    },
    {
      type: 'mrkdwn',
      text: `*Divergence %:*\n${alert.divergencePercentage.toFixed(2)}%`,
    },
    {
      type: 'mrkdwn',
      text: `*Divergences:*\n${alert.divergenceCount} of ${alert.carouselMainCount}`,
    },
    {
      type: 'mrkdwn',
      text: `*Carousel-Main:*\n${alert.carouselMainCount} outcomes`,
    },
    {
      type: 'mrkdwn',
      text: `*LCP-API:*\n${alert.lcpApiCount} outcomes`,
    },
  ];

  return {
    channel: '#platform-alerts',
    username: 'BG-Remover Monitor',
    icon_emoji: ':warning:',
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `${emoji} Dual-Write Divergence Detected (${alert.status})`,
          emoji: true,
        },
      },
      {
        type: 'section',
        fields: fields,
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Time Range:*\n${new Date(alert.timeRange.start).toUTCString()} – ${new Date(alert.timeRange.end).toUTCString()}`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Recommendations:*\n${alert.recommendations.map((r) => `• ${r}`).join('\n')}`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Sample Divergent Records:*\n${sampleRecords}`,
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
              emoji: true,
            },
            url: 'https://console.aws.amazon.com/cloudwatch/home?region=eu-west-1#dashboards:name=bg-remover-DualWrite-Validation',
            style: 'primary',
          },
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Check Logs',
              emoji: true,
            },
            url: 'https://console.aws.amazon.com/cloudwatch/home?region=eu-west-1#logsV2:log-groups',
          },
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Rollback Plan',
              emoji: true,
            },
            url: 'https://github.com/carousellabs/enterprise-packages/blob/develop/services/platform/carousel/organisms/bg-remover/docs/operations/DUAL-WRITE-MONITORING-WAVE3.md#7-rollback-procedure-emergency',
            style: 'danger',
          },
        ],
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: '🔔 Decision Gate: 2026-05-01 00:00 UTC | If FAIL status, prepare for rollback',
          },
        ],
      },
    ],
  };
}
