import { test, expect, request } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

test.describe('Corrupted image handling', () => {
  test('should reject a corrupted JPEG image', async ({}) => {
    const corruptedPath = path.resolve(__dirname, '../../test-data/corrupted.jpg');
    const fileBuffer = fs.readFileSync(corruptedPath);

    const apiRequest = await request.newContext({
      baseURL: process.env.BG_REMOVER_API_URL ?? 'http://localhost:3000',
    });

    const response = await apiRequest.post('/bg-remover/process', {
      multipart: {
        file: {
          name: 'corrupted.jpg',
          mimeType: 'image/jpeg',
          buffer: fileBuffer,
        },
      },
    });

    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/corrupted|invalid/i);
    await apiRequest.dispose();
  });
});
