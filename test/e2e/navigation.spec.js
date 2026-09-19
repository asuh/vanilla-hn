import { expect, test } from "@playwright/test";

for (const fallback of [false, true]) {
  test.describe(fallback ? "History API scrolling" : "Browser navigation scrolling", () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((disableNavigation) => {
        globalThis.__VANILLA_HN_MOCK__ = true;
        if (disableNavigation) {
          Object.defineProperty(window, "navigation", { value: undefined });
        }
      }, fallback);
      await page.goto("/");
      await expect(page.locator(".story-list > .item")).toHaveCount(30);
      // Keep both routes scrollable so document shrinking cannot hide a missing reset.
      await page.addStyleTag({ content: "body { min-height: 4000px; }" });
    });

    test("opens cached comments at the top before responses arrive and restores Back", async ({
      page,
      isMobile,
    }) => {
      const link = page.locator('.comments-link[href="/story/27"]');
      await link.scrollIntoViewIfNeeded();
      const listScroll = await page.evaluate(() => window.scrollY);
      expect(listScroll).toBeGreaterThan(100);

      await page.evaluate(() => {
        window.vanillaHN.services.hnService.onItemValue = () => () => {};
      });
      if (isMobile) await link.tap();
      else await link.click();
      await expect(page).toHaveURL(/\/story\/27$/);
      await expect(page.locator(".item-view .title")).not.toBeEmpty();
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
      await expect(page.locator(".item-view .title")).toBeInViewport();
      await expect(page.locator("#app")).not.toBeFocused();

      await page.goBack();
      await expect(page.locator(".story-list > .item")).toHaveCount(30);
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(listScroll);

      await page.goForward();
      await expect(page.locator(".item-view .title")).toBeInViewport();
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    });

    test("resets programmatic navigation without overriding fragment jumps", async ({ page }) => {
      await page.evaluate(() => {
        window.scrollTo(0, 500);
        window.vanillaHN.router.navigate("/newest");
      });
      await expect(page.getByRole("heading", { name: "Newest" })).toBeVisible();
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

      await page.evaluate(() => {
        const target = document.createElement("div");
        target.id = "scroll-target";
        target.style.marginTop = "1500px";
        document.body.append(target);
        location.hash = "scroll-target";
      });
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(1000);
      await expect(page.getByRole("heading", { name: "Newest" })).toHaveCount(1);
    });

    test("honors fragment targets on a new route", async ({ page }) => {
      await page.evaluate(() => {
        const router = window.vanillaHN.router;
        router.register("/scroll-fixture", () => {
          const view = document.createElement("div");
          view.style.paddingTop = "1500px";
          const target = document.createElement("p");
          target.id = "section-two";
          target.textContent = "Fragment target";
          view.append(target);
          return view;
        });
        router.navigate("/scroll-fixture#section-two");
      });
      await expect(page).toHaveURL(/\/scroll-fixture#section-two$/);
      await expect(page.getByText("Fragment target")).toBeInViewport();
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(1000);
    });

    test("does not reset scroll when a superseded route finishes", async ({ page }) => {
      await page.evaluate(() => {
        window.vanillaHN.router.register(
          "/delayed-route",
          () =>
            new Promise((resolve) => {
              window.finishDelayedRoute = () => resolve(document.createElement("div"));
            }),
        );
        window.vanillaHN.router.navigate("/delayed-route");
      });
      await expect
        .poll(() => page.evaluate(() => typeof window.finishDelayedRoute))
        .toBe("function");
      await page.evaluate(() => window.vanillaHN.router.navigate("/newest"));
      await expect(page.getByRole("heading", { name: "Newest" })).toBeVisible();
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
      const scrollAfterCompletion = await page.evaluate(async () => {
        window.scrollTo(0, 500);
        window.finishDelayedRoute();
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        return window.scrollY;
      });
      expect(scrollAfterCompletion).toBe(500);
      await expect(page.getByRole("heading", { name: "Newest" })).toHaveCount(1);
    });
  });
}
