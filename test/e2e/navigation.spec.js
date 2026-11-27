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

    for (const [id, hash] of [
      ["section-two", "section-two"],
      ["café-notes", "caf%C3%A9-notes"],
    ]) {
      test(`honors the #${hash} fragment target on a new route`, async ({ page }) => {
        await page.evaluate((targetId) => {
          const router = window.vanillaHN.router;
          router.register("/scroll-fixture", () => {
            const view = document.createElement("div");
            view.style.paddingTop = "1500px";
            const target = document.createElement("p");
            target.id = targetId;
            target.textContent = "Fragment target";
            view.append(target);
            return view;
          });
        }, id);
        await page.evaluate((fragment) => {
          window.vanillaHN.router.navigate(`/scroll-fixture#${fragment}`);
        }, hash);
        await expect(page).toHaveURL(new RegExp(`/scroll-fixture#${hash}$`));
        await expect(page.getByText("Fragment target")).toBeInViewport();
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(1000);
      });
    }

    for (const [id, hash] of [
      ["hidden-note", "hidden-note"],
      ["café-hidden", "caf%C3%A9-hidden"],
    ]) {
      test(`reveals the #${hash} target inside a closed disclosure`, async ({ page }) => {
        await page.evaluate((targetId) => {
          window.vanillaHN.router.register("/disclosure-fixture", () => {
            const view = document.createElement("div");
            view.style.paddingTop = "1500px";
            const details = document.createElement("details");
            const summary = document.createElement("summary");
            summary.textContent = "Collapsed thread";
            const target = document.createElement("p");
            target.id = targetId;
            target.textContent = "Hidden target";
            details.append(summary, target);
            view.append(details);
            return view;
          });
        }, id);
        await page.evaluate((fragment) => {
          window.vanillaHN.router.navigate(`/disclosure-fixture#${fragment}`);
        }, hash);
        await expect(page.locator("details")).toHaveAttribute("open");
        await expect(page.getByText("Hidden target")).toBeInViewport();
      });
    }

    test("prefers a literal ID over the decoded fragment", async ({ page }) => {
      await page.evaluate(() => {
        window.vanillaHN.router.register("/twin-fixture", () => {
          const view = document.createElement("div");
          const literal = document.createElement("p");
          literal.id = "caf%C3%A9-twin";
          literal.textContent = "Literal target";
          literal.style.marginTop = "1500px";
          const decoded = document.createElement("p");
          decoded.id = "café-twin";
          decoded.textContent = "Decoded target";
          decoded.style.marginTop = "3000px";
          view.append(literal, decoded);
          return view;
        });
        window.vanillaHN.router.navigate("/twin-fixture#caf%C3%A9-twin");
      });
      await expect(page.getByText("Literal target")).toBeInViewport();
      await expect(page.getByText("Decoded target")).not.toBeInViewport();
    });

    test("keeps the native focus starting point for encoded fragments", async ({
      page,
      browserName,
      isMobile,
    }) => {
      test.skip(fallback, "The History API path scrolls fragments manually");
      test.skip(
        browserName !== "chromium" || isMobile,
        "Sequential Tab focus needs desktop Chromium",
      );
      await page.evaluate(() => {
        window.vanillaHN.router.register("/focus-fixture", () => {
          const view = document.createElement("div");
          view.style.paddingTop = "1500px";
          view.innerHTML =
            '<a id="caf\u00e9-link" href="#one">First link</a> <a href="#two">Next link</a>';
          return view;
        });
        window.vanillaHN.router.navigate("/focus-fixture#caf%C3%A9-link");
      });
      await expect(page.getByText("First link")).toBeInViewport();
      await page.keyboard.press("Tab");
      await expect(page.getByText("Next link")).toBeFocused();
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
