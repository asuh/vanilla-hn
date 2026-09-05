import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const wcagTags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function waitForApp(page) {
  await expect(page.getByRole("button", { name: "settings" })).toBeEnabled();
}

async function expectNoAxeViolations(page, state) {
  const { violations } = await new AxeBuilder({ page }).withTags(wcagTags).analyze();
  expect(violations, `${state}: ${JSON.stringify(violations, null, 2)}`).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    globalThis.__VANILLA_HN_MOCK__ = true;
  });
});

test("representative routes have no detectable WCAG 2.2 AA violations", async ({ page }) => {
  for (const [state, route] of [
    ["top stories", "/"],
    ["story and comments", "/story/33"],
    ["permalinked comment", "/comment/201"],
    ["user profile", "/user/tester"],
    ["new comments", "/newcomments"],
    ["read stories", "/read"],
    ["not found", "/missing-page"],
  ]) {
    await page.goto(route);
    await waitForApp(page);
    await expectNoAxeViolations(page, state);
  }

  await page.goto("/");
  await waitForApp(page);
  await page.getByRole("button", { name: "settings" }).click();
  await expectNoAxeViolations(page, "settings popover");

  await page.locator("#s-theme").selectOption("dark");
  await expectNoAxeViolations(page, "dark settings popover");
});

test("external links use normal same-tab navigation", async ({ page }) => {
  await page.goto("/");
  await waitForApp(page);

  await expect(page.locator('a[target="_blank"]')).toHaveCount(0);
  await expect(page.locator(".story-list .title-link").first()).toHaveAttribute(
    "href",
    /^https:\/\//,
  );

  await page.goto("/story/33");
  await waitForApp(page);
  await expect(page.locator('a[target="_blank"]')).toHaveCount(0);
  await expect(page.locator(".item-view .title a")).toHaveAttribute("href", /^https:\/\//);

  await page.goto("/user/tester");
  await waitForApp(page);
  await expect(page.locator('a[target="_blank"]')).toHaveCount(0);
  await expect(page.locator(".user-view__hn-link-anchor")).toHaveAccessibleName(
    "View tester's profile on Hacker News",
  );
});

test("the skip link becomes visible for keyboard users", async ({ page, browserName }) => {
  await page.goto("/");
  await waitForApp(page);

  // macOS WebKit includes links in keyboard navigation with Option-Tab.
  const nextLink = browserName === "webkit" && process.platform === "darwin" ? "Alt+Tab" : "Tab";
  await page.keyboard.press(nextLink);
  const skipLink = page.getByRole("link", { name: "Skip to content" });
  await expect(skipLink).toBeFocused();
  await expect(skipLink).toBeVisible();
  await expect(skipLink).toHaveCSS("position", "fixed");

  await page.keyboard.press(nextLink);
  const homeLink = page.getByRole("link", { name: "vanilla-hn home" });
  await expect(homeLink).toBeFocused();
  await expect(homeLink).toHaveCSS("outline-style", "solid");
  await expect(homeLink).toHaveCSS("outline-width", "2px");
});

test("standalone compact controls meet the WCAG 2.2 minimum target size", async ({ page }) => {
  await page.goto("/");
  await waitForApp(page);

  for (const locator of [
    page.getByRole("link", { name: "vanilla-hn home" }),
    page.getByRole("button", { name: "settings" }),
  ]) {
    const box = await locator.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(24);
    expect(box?.height).toBeGreaterThanOrEqual(24);
  }

  await page.getByRole("button", { name: "settings" }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  const controlHeights = await page
    .locator(
      '#settings-panel :is(input:not([type="checkbox"]), select), #settings-panel label:has(input[type="checkbox"])',
    )
    .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
  expect(Math.min(...controlHeights)).toBeGreaterThanOrEqual(24);
});
