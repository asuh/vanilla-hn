import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    globalThis.__VANILLA_HN_MOCK__ = true;
  });
});

test("loads and navigates from a GitHub Pages project path", async ({ page }) => {
  await page.goto("./");
  await expect(page.getByRole("button", { name: "settings" })).toBeEnabled();
  await expect(page.locator(".story-list > .item")).toHaveCount(30);

  const newest = page.getByRole("link", { name: "new", exact: true });
  expect(await newest.evaluate((link) => link.pathname)).toBe("/vanilla-hn/newest");
  await newest.click();
  await expect(page).toHaveURL(/\/vanilla-hn\/newest$/);
  await expect(page.getByRole("heading", { name: "Newest" })).toBeVisible();

  const comments = page.locator('.comments-link[href="/vanilla-hn/story/33"]');
  await comments.click();
  await expect(page).toHaveURL(/\/vanilla-hn\/story\/33$/);
  await expect(page.locator('.item-view[data-item-id="33"]')).toBeVisible();
});

test("loads a nested route directly through the app-shell fallback", async ({ page }) => {
  await page.goto("story/33");
  await expect(page.getByRole("button", { name: "settings" })).toBeEnabled();
  await expect(page).toHaveURL(/\/vanilla-hn\/story\/33$/);
  await expect(page.locator('.item-view[data-item-id="33"]')).toBeVisible();
  await expect(page.locator('link[rel="stylesheet"]')).toHaveAttribute(
    "href",
    /\/vanilla-hn\/assets\/styles-[^/]+\.css$/,
  );
});
