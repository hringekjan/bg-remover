// services/bg-remover/app/api/create-product/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

const dynamoDb = new DynamoDBClient({});
const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME || 'carousel-main-dev';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { jobId, productName } = body;

    if (!jobId || !productName) {
      return NextResponse.json(
        { error: 'Missing required fields: jobId, productName' },
        { status: 400 }
      );
    }

    // Update job status to indicate product creation in progress
    const updateCommand = new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({ jobId }),
      UpdateExpression: 'SET productStatus = :status, productName = :name',
      ExpressionAttributeValues: marshall({
        ':status': 'creating',
        ':name': productName
      })
    });

    await dynamoDb.send(updateCommand);

    // Simulate async product creation
    setTimeout(async () => {
      try {
        const completeCommand = new UpdateItemCommand({
          TableName: TABLE_NAME,
          Key: marshall({ jobId }),
          UpdateExpression: 'SET productStatus = :status, productId = :id',
          ExpressionAttributeValues: marshall({
            ':status': 'created',
            ':id': `prod_${Date.now()}`
          })
        });

        await dynamoDb.send(completeCommand);
      } catch (error) {
        console.error('Error completing product creation:', error);
      }
    }, 3000);

    return NextResponse.json({
      message: 'Product creation initiated',
      jobId
    });
  } catch (error) {
    console.error('Error creating product:', error);
    return NextResponse.json(
      { error: 'Failed to initiate product creation' },
      { status: 500 }
    );
  }
}
