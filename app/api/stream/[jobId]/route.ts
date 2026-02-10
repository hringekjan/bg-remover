// services/bg-remover/app/api/stream/[jobId]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';

const dynamoDb = new DynamoDBClient({});
const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME || 'carousel-main-dev';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const resolvedParams = await params;
  const jobId = resolvedParams.jobId;

  // Set up SSE response headers
  const responseStream = new TransformStream();
  const writer = responseStream.writable.getWriter();
  const encoder = new TextEncoder();

  // Send initial connection confirmation
  writer.write(encoder.encode('data: {"type": "connected", "message": "Connected to SSE stream"}\n\n'));

  // Polling function to check DynamoDB
  const pollJobStatus = async () => {
    try {
      const command = new GetItemCommand({
        TableName: TABLE_NAME,
        Key: marshall({ jobId }),
      });

      const result = await dynamoDb.send(command);

      if (!result.Item) {
        writer.write(encoder.encode(`event: error\ndata: {"error": "Job not found"}\n\n`));
        return false;
      }

      const item = unmarshall(result.Item);

      // Send job started event if not already sent
      if (item.status === 'processing' && !item.sseStartedEventSent) {
        writer.write(encoder.encode(`event: job:started\ndata: ${JSON.stringify({ jobId })}\n\n`));
      }

      // Check for completed images
      if (item.results && Array.isArray(item.results)) {
        item.results.forEach((result: any, index: number) => {
          if (result.status === 'completed' && !result.sseProgressEventSent) {
            writer.write(encoder.encode(`event: image:completed\ndata: ${JSON.stringify({
              jobId,
              imageUrl: result.url,
              maskUrl: result.maskUrl,
              index
            })}\n\n`));
          }
        });
      }

      // Check for group completion
      if (item.status === 'completed' && !item.sseCompletedEventSent) {
        writer.write(encoder.encode(`event: group:progress\ndata: ${JSON.stringify({
          jobId,
          status: 'completed',
          results: item.results || []
        })}\n\n`));
        return false; // Stop polling
      }

      // Check for errors
      if (item.status === 'failed') {
        writer.write(encoder.encode(`event: error\ndata: ${JSON.stringify({
          jobId,
          error: item.errorMessage || 'Unknown error occurred'
        })}\n\n`));
        return false; // Stop polling
      }

      return true; // Continue polling
    } catch (error) {
      console.error('Error polling job status:', error);
      writer.write(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: 'Internal server error' })}\n\n`));
      return false;
    }
  };

  // Start polling with interval
  const pollingInterval = setInterval(async () => {
    const shouldContinue = await pollJobStatus();
    if (!shouldContinue) {
      clearInterval(pollingInterval);
      writer.close();
    }
  }, 500); // Poll every 500ms

  // Handle client disconnect and 5-minute timeout
  const timeout = setTimeout(() => {
    clearInterval(pollingInterval);
    writer.close();
  }, 5 * 60 * 1000);

  request.signal.addEventListener('abort', () => {
    clearInterval(pollingInterval);
    clearTimeout(timeout);
    writer.close();
  });

  return new NextResponse(responseStream.readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
