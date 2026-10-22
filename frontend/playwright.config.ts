import { defineConfig } from '@playwright/test';

// The caller starts the built Go runtime against a temporary database. Keeping
// server ownership outside Playwright avoids replacing an existing local runtime.
export default defineConfig({
  testDir: './e2e',
  outputDir: '../test-results/e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 45000,
  expect: { timeout: 10000 },
  reporter: [['list'], ['html', { outputFolder: '../test-results/report', open: 'never' }]],
  use: {
    baseURL: process.env.APIX_E2E_URL || 'http://127.0.0.1:4317',
    viewport: { width: 1440, height: 960 },
    browserName: 'chromium',
    locale: 'zh-CN',
    timezoneId: 'Asia/Taipei',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    reducedMotion: 'reduce',
    launchOptions: process.env.APIX_CHROMIUM_PATH
      ? { executablePath: process.env.APIX_CHROMIUM_PATH }
      : undefined,
  },
});
