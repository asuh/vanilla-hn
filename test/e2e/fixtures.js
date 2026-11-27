import { test as base, expect } from "@playwright/test";

/**
 * Shared test fixture. Projects that set `historyFallback` hide the Navigation
 * API so the router's History API path runs the whole suite, as it does in
 * browsers without `window.navigation`.
 */
export const test = base.extend({
  historyFallback: [false, { option: true }],
  page: async ({ page, historyFallback }, use) => {
    if (historyFallback) {
      await page.addInitScript(() => {
        Object.defineProperty(window, "navigation", { value: undefined });
      });
    }
    await use(page);
  },
});

export { expect };
