import { NextRequest, NextResponse } from 'next/server';
import {
  ProductIdentitySettings,
  ProductIdentitySettingsSchema,
  DEFAULT_SETTINGS,
} from '../../../types/product-identity-settings';

// In-memory storage for now (in production, this would use SSM Parameter Store)
let cachedSettings: ProductIdentitySettings = DEFAULT_SETTINGS;
let cacheTimestamp: number = Date.now();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * GET /api/settings
 * Retrieve current product identity settings
 */
export async function GET(request: NextRequest) {
  try {
    // Check cache
    if (Date.now() - cacheTimestamp < CACHE_TTL) {
      return NextResponse.json(cachedSettings);
    }

    // In production, fetch from SSM Parameter Store:
    // const ssmClient = new SSMClient({ region: 'eu-west-1' });
    // const parameter = await ssmClient.send(new GetParameterCommand({
    //   Name: '/tf/dev/carousel-labs/services/bg-remover/product-identity-settings',
    //   WithDecryption: true,
    // }));
    // const settings = JSON.parse(parameter.Parameter.Value);

    // For now, return cached default settings
    cachedSettings = DEFAULT_SETTINGS;
    cacheTimestamp = Date.now();

    return NextResponse.json(cachedSettings);
  } catch (error) {
    console.error('Failed to fetch settings:', error);
    return NextResponse.json(
      { error: 'Failed to fetch settings', details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/settings
 * Update product identity settings
 */
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();

    // Validate settings
    const validationResult = ProductIdentitySettingsSchema.safeParse(body);
    if (!validationResult.success) {
      return NextResponse.json(
        { error: 'Invalid settings', details: validationResult.error.errors },
        { status: 400 }
      );
    }

    const settings = validationResult.data;

    // In production, save to SSM Parameter Store:
    // const ssmClient = new SSMClient({ region: 'eu-west-1' });
    // await ssmClient.send(new PutParameterCommand({
    //   Name: '/tf/dev/carousel-labs/services/bg-remover/product-identity-settings',
    //   Value: JSON.stringify(settings),
    //   Type: 'SecureString',
    //   Overwrite: true,
    // }));

    // For now, update in-memory cache
    cachedSettings = settings;
    cacheTimestamp = Date.now();

    return NextResponse.json({ success: true, settings });
  } catch (error) {
    console.error('Failed to update settings:', error);
    return NextResponse.json(
      { error: 'Failed to update settings', details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
