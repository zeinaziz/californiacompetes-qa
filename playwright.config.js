const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './scripts',
  timeout: 60000,
  use: {
    headless: true,
    viewport: { width: 1440, height: 900 },
    screenshot: 'off',
    video: 'off',
  },
  projects: [
    {
      name: 'desktop',
      use: { viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'mobile',
      use: { viewport: { width: 375, height: 812 } },
    },
  ],
});
