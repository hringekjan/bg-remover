import { spawn } from 'node:child_process';
import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { once } from 'node:events';

const SERVERLESS_CMD = ['npx', ['serverless', 'offline', 'start', '--noPrependStage']];

test.describe('Full stack with serverless-offline', () => {
  let serverProcess: ReturnType<typeof spawn>;

  test.beforeAll(async () => {
    serverProcess = spawn(SERVERLESS_CMD[0], SERVERLESS_CMD[1], {
      cwd: path.resolve(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'development' },
    });

    // Wait until the offline server prints the ready line
    await once(serverProcess.stdout!, 'data');
    // Give a short grace period for the HTTP server to be reachable
    await new Promise(res => setTimeout(res, 2000));
  });

  test.afterAll(() => {
    serverProcess.kill();
  });

  test('remove-bg endpoint works against offline server', async ({ request }) => {
    const imagePath = path.resolve(__dirname, '../../test-data/sample.jpg');
    const buffer = fs.readFileSync(imagePath);

    const response = await request.post('http://localhost:3000/dev/api/remove-bg', {
      multipart: {
        file: {
          name: 'sample.jpg',
          mimeType: 'image/jpeg',
          buffer,
        },
      },
    });

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty('imageUrl');
  });
});
