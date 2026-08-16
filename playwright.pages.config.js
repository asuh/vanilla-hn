import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./test/e2e-pages",
  fullyParallel: true,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  expect: { timeout: 15_000 },
  use: {
    baseURL: "http://127.0.0.1:5012/vanilla-hn/",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "pages-chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "PORT=5012 npm run preview",
    url: "http://127.0.0.1:5012/vanilla-hn/",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
