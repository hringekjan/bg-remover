import { test, expect, request } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const IMAGE_PATH = path.resolve(__dirname, '../../test-data/sample.jpg');
const IMAGE_BUFFER = fs.readFileSync(IMAGE_PATH);
const REQUESTS_IN_BURST = 20; // higher than typical limit

test.describe('Rate-limit burst handling', () => {
  test('should enforce rate limits under burst traffic', async () => {
    const apiRequest = await request.newContext({
      baseURL: process.env.BG_REMOVER_API_URL ?? 'http://localhost:3000',
    });

    const promises = Array.from({ length: REQUESTS_IN_BURST }).map(() =>
             apiRequest.post('/bg-remover/process', {        multipart: {
          file: {
            name: 'sample.jpg',
            mimeType: 'image/jpeg',
            buffer: IMAGE_BUFFER,
          },
        },
      })
    );

    const responses = await Promise.all(promises);
    const success = responses.filter(r => r.status() === 200).length;
    const tooMany = responses.filter(r => r.status() === 429).length;

    // Expect at least one 429 (rate-limited) response in a burst
    expect(tooMany).toBeGreaterThanOrEqual(1);
    // Remaining should be successful
    expect(success + tooMany).toBe(REQUESTS_IN_BURST);

    await apiRequest.dispose();
  });
});
