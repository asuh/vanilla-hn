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

  const headerColors = await page
    .locator(".site-header a, .site-header .settings")
    .evaluateAll((elements) => elements.map((element) => getComputedStyle(element).color));
  expect(new Set(headerColors)).toEqual(new Set(["rgb(126, 231, 135)"]));

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

test("renders one main landmark and a dedicated not-found route", async ({ page }) => {
  await page.goto("/missing-page");
  await waitForApp(page);

  await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
  await expect(page.locator("main")).toHaveCount(1);
  await expect(page.locator(".story-list")).toHaveCount(0);
});

test("matches user queries and renders complete profile parity", async ({ page }) => {
  await page.addInitScript(() => {
    globalThis.__VANILLA_HN_MOCK_USER_DELAY_MS__ = 2_000;
  });
  await page.goto("/user/tester?from=comments");
  await waitForApp(page);

  await expect(page.getByRole("heading", { name: "tester" })).toBeVisible();
  await expect(page.locator(".user-view__loading .spinner > div")).toHaveCount(3);
  await expect(page.locator(".user-view__loading .spinner > div").first()).toHaveCSS(
    "width",
    "20px",
  );

  await expect(page.locator(".user-view__created")).toContainText(/.+ \(.+\)/);
  await expect(page.locator(".user-view__karma")).not.toBeEmpty();
  await expect(page.locator(".user-view__delay")).toHaveText("0");
  await expect(page.locator(".about")).toContainText("Mock user tester");
});

test("keeps new comments loading until the first feed completes", async ({ page }) => {
  await page.addInitScript(() => {
    globalThis.__VANILLA_HN_MOCK_UPDATES_DELAY_MS__ = 2_000;
  });
  await page.goto("/newcomments");
  await waitForApp(page);

  await expect(page.locator(".comment-feed .loading .spinner > div")).toHaveCount(3);
  await expect(page.locator(".comment-feed .loading .spinner > div").first()).toHaveCSS(
    "width",
    "20px",
  );
  await expect(page.getByText("No new comments found.")).toBeVisible();
});

test("sanitizes profile HTML when the native Sanitizer API is unavailable", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Element.prototype, "setHTML", {
      configurable: true,
      value: undefined,
    });
    globalThis.__VANILLA_HN_MOCK_USER_ABOUT__ = `
      <p style="color:red">Safe <strong>content</strong></p>
      <a class="unsafe" href="javascript:alert(1)" onclick="alert(1)">unsafe link</a>
      <a class="safe" href="https://example.com/profile">safe link</a>
      <img src=x onerror="alert(1)">
      <script>globalThis.__unsafeProfileScript = true</script>
    `;
  });
  await page.goto("/user/tester");
  await waitForApp(page);

  const about = page.locator(".about");
  await expect(about.locator("strong")).toHaveText("content");
  await expect(about.locator("script, img")).toHaveCount(0);
  await expect(about.getByText("unsafe link")).not.toHaveAttribute("href");
  await expect(about.getByText("unsafe link")).not.toHaveAttribute("onclick");
  await expect(about.getByRole("link", { name: "safe link", exact: true })).toHaveAttribute(
    "href",
    "https://example.com/profile",
  );
  await expect(about.locator("p")).not.toHaveAttribute("style");
  expect(await page.evaluate(() => globalThis.__unsafeProfileScript)).toBeUndefined();
});

test("shows build metadata and the source repository in the footer", async ({ page }) => {
  await page.goto("/");
  await waitForApp(page);

  await expect(page.locator(".site-footer")).toContainText("vanilla-hn v0.1.0");
  await expect(page.locator(".site-footer [data-source-link]")).toHaveAttribute(
    "href",
    "https://github.com/asuh/vanilla-hn",
  );
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
  await expect(page.locator("ol.story-list")).toHaveAttribute("start", "1");
  await expect(page.locator(".story-list .rank")).toHaveCount(0);
});

test("continues native story numbering across pages", async ({ page }) => {
  await page.goto("/?page=2");
  await waitForApp(page);

  await expect(page.locator("ol.story-list")).toHaveJSProperty("start", 31);
});

test("uses native ordered markers with a compact mobile gutter", async ({ page }) => {
  test.skip((page.viewportSize()?.width || 0) > 720, "Mobile layout only");

  await page.goto("/");
  await waitForApp(page);

  const list = page.locator(".story-list");
  const firstItem = list.locator(":scope > .item").first();
  await expect(list).toHaveJSProperty("start", 1);
  await expect(firstItem).toHaveCSS("display", "list-item");

  const gutter = await list.evaluate((element) => {
    const styles = getComputedStyle(element);
    const padding = Number.parseFloat(styles.paddingLeft);
    const fontSize = Number.parseFloat(styles.fontSize);
    return { padding, em: padding / fontSize };
  });
  expect(gutter.padding).toBeLessThanOrEqual(31);
  expect(gutter.em).toBeCloseTo(2.25, 2);

  const [listBox, titleBox] = await Promise.all([
    list.boundingBox(),
    firstItem.locator(".title").boundingBox(),
  ]);
  expect(titleBox.x - listBox.x).toBeLessThanOrEqual(31);
  await expect(firstItem.locator(".rank")).toHaveCount(0);
});

test("collapses comments in one style pass and prefetches ahead of scrolling", async ({ page }) => {
  await page.addInitScript(() => {
    const NativeIntersectionObserver = globalThis.IntersectionObserver;
    globalThis.__commentObserverMargins = [];
    globalThis.IntersectionObserver = class {
      constructor(callback, options = {}) {
        globalThis.__commentObserverMargins.push(options.rootMargin || "0px");
        this.inner = new NativeIntersectionObserver(callback, options);
      }

      observe(target) {
        this.inner.observe(target);
      }

      unobserve(target) {
        this.inner.unobserve(target);
      }

      disconnect() {
        this.inner.disconnect();
      }
    };
  });

  await page.goto("/item/3");
  await waitForApp(page);

  const comments = page.locator(".item-view > .kids > .comment");
  await expect(comments).toHaveCount(3);
  const comment = comments.nth(1);
  const toggle = comment.locator(":scope > .content > .meta .toggle");

  const collapsed = await toggle.evaluate((button) => {
    const root = button.closest(".comment");
    const text = root.querySelector(":scope > .content > .text");
    const kids = root.querySelector(":scope > .kids");
    button.click();
    return {
      root: root.classList.contains("collapsed"),
      text: getComputedStyle(text).display,
      kids: getComputedStyle(kids).display,
    };
  });
  expect(collapsed).toEqual({ root: true, text: "none", kids: "none" });

  const expanded = await toggle.evaluate((button) => {
    const root = button.closest(".comment");
    const text = root.querySelector(":scope > .content > .text");
    const kids = root.querySelector(":scope > .kids");
    button.click();
    return {
      root: root.classList.contains("collapsed"),
      text: getComputedStyle(text).display,
      kids: getComputedStyle(kids).display,
    };
  });
  expect(expanded.root).toBe(false);
  expect(expanded.text).not.toBe("none");
  expect(expanded.kids).not.toBe("none");

  const margins = await page.evaluate(() => globalThis.__commentObserverMargins);
  const prefetchDistance = Math.max(...margins.map((margin) => Number.parseInt(margin, 10)));
  expect(prefetchDistance).toBeGreaterThanOrEqual(Math.ceil(page.viewportSize().height * 1.5));
});
