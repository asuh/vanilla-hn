import { expect, test } from "@playwright/test";

async function waitForApp(page) {
  await expect(page.getByRole("button", { name: "settings" })).toBeEnabled();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    globalThis.__VANILLA_HN_MOCK__ = true;
  });
});

test("loads stories, preserves document focus, and follows internal links", async ({ page }) => {
  await page.goto("/");
  await waitForApp(page);

  const stories = page.locator(".story-list > .item");
  await expect(stories).toHaveCount(30);
  await expect(page.locator("#app")).not.toBeFocused();

  await page.getByRole("link", { name: "new", exact: true }).click();
  await expect(page).toHaveURL(/\/newest$/);
  await expect(page.getByRole("heading", { name: "Newest" })).toBeVisible();

  await page.locator('.comments-link[href="/story/33"]').click();
  await expect(page).toHaveURL(/\/story\/33$/);
  await expect(page.locator('.item-view[data-item-id="33"]')).toBeVisible();
});

test("persists dark mode without reverting the first painted colors", async ({ page }) => {
  await page.goto("/");
  await waitForApp(page);
  await page.getByRole("button", { name: "settings" }).click();
  await page.locator("#s-theme").selectOption("dark");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");

  await page.waitForTimeout(200);
  await page.reload({ waitUntil: "domcontentloaded" });

  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(11, 11, 11)");
});

test("renders complete story and comment spinners", async ({ page }) => {
  await page.goto("/item/3");
  await waitForApp(page);

  await expect(page.locator(".item-view .loading .spinner > div")).toHaveCount(3);
  await expect(page.locator(".item-view .kids .comment").first()).toBeVisible();
});

test("reorders cached stories when the realtime ranking arrives", async ({ page }) => {
  await page.addInitScript(() => {
    const items = {};
    for (let id = 1; id <= 30; id++) {
      items[String(id)] = { id: String(id), title: `Cached story ${id}`, time: 1 };
    }
    sessionStorage.setItem(
      "vanilla-hn:stories:top",
      JSON.stringify({
        ids: Array.from({ length: 30 }, (_, index) => String(30 - index)),
        items,
      }),
    );
  });

  await page.goto("/");
  await waitForApp(page);
  const rows = page.locator(".story-list > .item");
  await expect(rows.first()).toHaveAttribute("data-id", "1");
  await expect(rows.nth(1)).toHaveAttribute("data-id", "2");
  await expect(rows.first().locator(".rank")).toHaveText("1.");
  await expect(rows.nth(1).locator(".rank")).toHaveText("2.");
});
