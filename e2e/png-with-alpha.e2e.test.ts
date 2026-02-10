import { test, expect, request } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

test.describe('PNG with alpha channel', () => {
  test('should process PNG that contains an alpha channel', async () => {
    const pngPath = path.resolve(__dirname, '../../test-data/transparent.png');
    const fileBuffer = fs.readFileSync(pngPath);

    const apiRequest = await request.newContext({
      baseURL: process.env.BG_REMOVER_API_URL ?? 'http://localhost:3000',
    });

    const response = await apiRequest.post('/bg-remover/process', {
      multipart: {
        file: {
          name: 'transparent.png',
          mimeType: 'image/png',
          buffer: fileBuffer,
        },
      },
    });

    expect(response.status()).toBe(200);
    const json = await response.json();
    expect(json).toHaveProperty('imageUrl');
    // The returned image should be a PNG without alpha (background removed)
    expect(json.imageUrl).toMatch(/\.png$/i);
    await apiRequest.dispose();
  });
});
