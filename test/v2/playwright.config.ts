import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  use: {
    baseURL: 'http://127.0.0.1:4174',
    browserName: 'chromium',
    launchOptions: {
      executablePath: process.env.CHROMIUM_PATH,
    },
  },
  webServer: {
    command: 'pnpm exec vite --config test/v2/vite.config.ts',
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: false,
  },
});
