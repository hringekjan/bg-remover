import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: {
    timeout: 5000,
  },
  fullyParallel: true,
  reporter: [
    ['html', { open: 'never' }],
    ['json'],
    ['list'],
  ],
  use: {
    baseURL: process.env.BG_REMOVER_API_URL ?? 'https://api.dev.hringekjan.is',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'api',
      testMatch: '**/*.e2e.test.ts',
    },
  ],
});
