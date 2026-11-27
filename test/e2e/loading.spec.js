import { expect, test } from "./fixtures.js";

const story = {
  id: 9001,
  type: "story",
  title: "A story available before its comments",
  by: "tester",
  time: 1_780_000_000,
  score: 10,
  descendants: 4,
  kids: [9101, 9102],
  text: "<p>Story introduction</p>",
};

// Hold each response until explicitly released to reproduce slow connections
// without timing races or relying on the live HN API.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    globalThis.__VANILLA_HN_MOCK__ = true;
  });
  await page.goto("/missing-page");
  await expect(page.getByRole("button", { name: "settings" })).toBeEnabled();
  await page.evaluate(() => {
    const service = window.vanillaHN.services.hnService;
    service._backend.destroy();
    const listeners = new Map();
    window.loadingFixture = {
      listeners,
      requests: [],
      deliver(item) {
        for (const callback of listeners.get(String(item.id)) || []) callback(item);
      },
    };
    service.onStoriesValue = (_type, callback) => {
      callback(["9001", "9002"]);
      return () => {};
    };
    service.onItemValue = (id, callback) => {
      const key = String(id);
      window.loadingFixture.requests.push(key);
      const callbacks = listeners.get(key) || new Set();
      callbacks.add(callback);
      listeners.set(key, callbacks);
      return () => callbacks.delete(callback);
    };
  });
});

test("keeps unloaded stories as skeletons and only updates the arriving row", async ({ page }) => {
  await page.evaluate(() => window.vanillaHN.router.navigate("/"));
  const rows = page.locator(".story-list > .item");
  await expect(rows).toHaveCount(2);
  await expect(page.locator(".story-list .skeleton")).toHaveCount(2);
  await expect(page.locator(".story-list a")).toHaveCount(0);
  await expect(page.locator(".story-list")).not.toContainText(/Story \d+|unknown|0 points/);

  await page.evaluate((item) => window.loadingFixture.deliver(item), story);
  await expect(rows.first().locator(".title")).toHaveText(story.title);
  await expect(rows.nth(1)).toHaveClass(/skeleton/);
  await rows.first().locator(".comments-link").focus();
  await page.evaluate((item) => window.loadingFixture.deliver(item), {
    ...story,
    id: 9002,
    title: "Second story",
  });
  await expect(rows.nth(1).locator(".title")).toHaveText("Second story");
  await expect(rows.first().locator(".comments-link")).toBeFocused();
});

test("shows cached story content and starts comments before the story refresh responds", async ({
  page,
}) => {
  await page.evaluate(() => window.vanillaHN.router.navigate("/"));
  await expect(page.locator(".story-list > .item")).toHaveCount(2);
  await page.evaluate((item) => window.loadingFixture.deliver(item), story);
  await page.locator('.comments-link[href="/story/9001"]').click();

  await expect(page.locator(".item-view .header .title")).toHaveText(story.title);
  await expect(page.locator(".item-view .body-text")).toHaveText("Story introduction");
  await expect(page.locator(".item-view > .loading")).toBeHidden();
  await expect(page.locator(".item-view > .kids > .placeholder")).toHaveCount(2);
  const requests = await page.evaluate(() => window.loadingFixture.requests);
  expect(requests).toContain("9101");
  expect(requests).toContain("9102");

  await page.evaluate((item) => window.loadingFixture.deliver(item), {
    ...story,
    title: "Updated story title",
    text: "<p>Updated introduction</p>",
    score: 20,
    kids: [9101, 9102, 9103],
    descendants: 5,
  });
  await expect(page.locator(".item-view .header .title")).toHaveText("Updated story title");
  await expect(page.locator(".item-view .body-text")).toHaveText("Updated introduction");
  await expect(page.locator(".item-view .header .score")).toHaveText("20 points");
  expect(await page.evaluate(() => window.loadingFixture.requests)).toContain("9103");
  await expect(page.locator(".item-view > .kids > .placeholder")).toHaveCount(3);
});

test("restores a saved listing header without visiting the list first", async ({ page }) => {
  await page.evaluate((item) => {
    sessionStorage.setItem("vanilla-hn:stories:top", "invalid JSON");
    sessionStorage.setItem(
      "vanilla-hn:stories:show",
      JSON.stringify({ ids: [String(item.id)], items: { [item.id]: item } }),
    );
    window.vanillaHN.router.navigate(`/story/${item.id}`);
  }, story);

  await expect(page.locator(".item-view .header .title")).toHaveText(story.title);
  await expect(page.locator(".item-view .body-text")).toHaveText("Story introduction");
  await expect(page.locator(".item-view > .loading")).toBeHidden();
  expect(await page.evaluate(() => window.loadingFixture.requests)).toEqual([
    "9101",
    "9102",
    "9001",
  ]);
});

test("keeps the story header on a full reload while fresh responses are held", async ({ page }) => {
  await page.evaluate(() => window.vanillaHN.router.navigate("/"));
  await expect(page.locator(".story-list > .item")).toHaveCount(2);
  await page.evaluate((item) => window.loadingFixture.deliver(item), story);
  await page.locator('.comments-link[href="/story/9001"]').click();
  await expect(page.locator(".item-view .header .title")).toHaveText(story.title);

  // Replace only the data service across reload; run the real bootstrap,
  // router, storage, and view code without any arriving item responses.
  await page.route("**/src/api/hn-service.js", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `export default class HNService {
      constructor() { window.heldItemListeners = new Map(); }
      onItemValue(id, callback) {
        const key = String(id);
        window.heldItemListeners.set(key, callback);
        return () => window.heldItemListeners.delete(key);
      }
    }`,
    }),
  );
  await page.reload();
  await expect(page.getByRole("button", { name: "settings" })).toBeEnabled();
  await expect(page.locator(".item-view .header .title")).toHaveText(story.title);
  await expect(page.locator(".item-view .body-text")).toHaveText("Story introduction");
  await expect(page.locator(".item-view > .loading")).toBeHidden();
  await expect(page.locator(".item-view > .kids > .placeholder")).toHaveCount(2);

  await page.evaluate((item) => window.heldItemListeners.get(String(item.id))(item), {
    ...story,
    title: "Fresh title after reload",
    text: "<p>Fresh body</p>",
  });
  await expect(page.locator(".item-view .header .title")).toHaveText("Fresh title after reload");
  await expect(page.locator(".item-view .body-text")).toHaveText("Fresh body");
});

test("restores a saved updates header without waiting for an item response", async ({ page }) => {
  await page.evaluate((item) => {
    sessionStorage.setItem(
      "vanilla-hn:updates:v1",
      JSON.stringify({ comments: {}, stories: { [item.id]: item } }),
    );
    window.vanillaHN.router.currentView.stores.updatesStore.loadSession();
    window.vanillaHN.router.navigate(`/story/${item.id}`);
  }, story);

  await expect(page.locator(".item-view .header .title")).toHaveText(story.title);
  await expect(page.locator(".item-view > .loading")).toBeHidden();
});

for (const collapseBeforeReplies of [false, true]) {
  test(`shows collapsed descendant counts ${collapseBeforeReplies ? "before" : "after"} replies arrive`, async ({
    page,
  }) => {
    await page.evaluate(() => {
      window.vanillaHN.stores.settingsStore.update({ autoCollapse: false });
      window.vanillaHN.router.navigate("/story/9001");
    });
    await expect(page.locator(".item-view")).toBeVisible();
    await page.evaluate((item) => {
      window.loadingFixture.deliver({ ...item, kids: [9101], descendants: 4 });
      window.loadingFixture.deliver({
        id: 9101,
        type: "comment",
        parent: 9001,
        by: "parent",
        time: item.time,
        text: "Parent comment",
        kids: [9201, 9202],
      });
    }, story);

    const parent = page.locator(".item-view > .kids > .comment");
    const toggle = parent.locator(":scope > details > summary");
    const counts = parent.locator(":scope > .meta .counts");
    if (collapseBeforeReplies) {
      await toggle.click();
      await expect(counts).toHaveText(" | (0 children)");
    }
    await page.evaluate(() => {
      const deliver = window.loadingFixture.deliver;
      deliver({ id: 9201, type: "comment", parent: 9101, text: "First reply", kids: [9301] });
      deliver({ id: 9301, type: "comment", parent: 9201, text: "Grandchild" });
      deliver({ id: 9202, type: "comment", parent: 9101, text: "Second reply" });
    });
    if (!collapseBeforeReplies) await toggle.click();
    await expect(counts).toHaveText(" | (3 children)");
    await expect(counts).toHaveJSProperty("hidden", false);
    await expect(counts).toBeVisible();

    await page.evaluate(() => {
      window.loadingFixture.deliver({
        id: 9202,
        type: "comment",
        parent: 9101,
        text: "Second reply",
        kids: [9302],
      });
      window.loadingFixture.deliver({
        id: 9302,
        type: "comment",
        parent: 9202,
        text: "New grandchild",
      });
    });
    await expect(counts).toHaveText(" | (4 children, 1 new)");
    await page.evaluate(() => window.vanillaHN.router.currentView._handleMarkAsRead());
    await expect(counts).toHaveText(" | (4 children)");
    await toggle.click();
    await expect(counts).toHaveJSProperty("hidden", true);
    await expect(counts).toBeHidden();

    const child = parent.locator(":scope > details > .kids > .comment").first();
    await child.locator(":scope > details > summary").click();
    await expect(child.locator(":scope > .meta .counts")).toHaveText(" | (1 child)");
    await expect(child.locator(":scope > .meta .counts")).toBeVisible();
  });
}

test("loads offscreen and collapsed replies eagerly, preserves order and releases subscriptions", async ({
  page,
}) => {
  await page.evaluate(() => window.vanillaHN.router.navigate("/story/9001"));
  await expect(page.locator(".item-view > .loading")).toBeVisible();
  await page.evaluate((item) => window.loadingFixture.deliver(item), story);
  await expect(page.locator(".item-view .header .title")).toHaveText(story.title);

  await page.evaluate(() => {
    const kids = document.querySelector(".item-view > .kids");
    kids.style.marginTop = "10000px";
    window.loadingFixture.deliver({
      id: 9102,
      type: "comment",
      parent: 9001,
      by: "second",
      time: 1_780_000_000,
      text: "Second top-level comment",
      kids: [9201, 9202],
    });
    document.querySelector(".comment-disclosure").open = false;
  });
  expect(await page.evaluate(() => window.loadingFixture.requests)).toEqual([
    "9001",
    "9101",
    "9102",
    "9201",
    "9202",
  ]);

  await page.evaluate(() => {
    const deliver = window.loadingFixture.deliver;
    deliver({ id: 9202, type: "comment", parent: 9102, text: "Second reply", kids: [9301] });
    deliver({ id: 9201, type: "comment", parent: 9102, text: "First reply" });
    deliver({ id: 9301, type: "comment", parent: 9202, text: "Deep reply" });
    deliver({ id: 9101, type: "comment", parent: 9001, text: "First top-level comment" });
  });
  await expect(page.locator(".item-view .placeholder")).toHaveCount(0);
  const comments = page.locator(".item-view > .kids > .comment");
  await expect(comments.first().locator(":scope > details > .content > .text")).toContainText(
    "First top-level",
  );
  const replies = comments.nth(1).locator(":scope > details > .kids > .comment");
  await expect(replies.first().locator(":scope > details > .content > .text")).toContainText(
    "First reply",
  );
  await expect(replies.nth(1).locator(":scope > details > .content > .text")).toContainText(
    "Second reply",
  );
  await expect(page.locator("#comment-body-9301")).toContainText("Deep reply");
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  await page.evaluate(() =>
    window.loadingFixture.deliver({
      id: 9202,
      type: "comment",
      parent: 9102,
      text: "Updated reply",
      kids: [9301, 9302],
    }),
  );
  const requests = await page.evaluate(() => window.loadingFixture.requests);
  expect(requests.filter((id) => id === "9301")).toHaveLength(1);
  expect(requests.filter((id) => id === "9302")).toHaveLength(1);
  await page.evaluate(() => window.vanillaHN.router.navigate("/missing-page"));
  await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
  expect(
    await page.evaluate(() =>
      [...window.loadingFixture.listeners.values()].every((set) => set.size === 0),
    ),
  ).toBe(true);
});

test("places realtime top-level comments in story order and syncs collapse from the store", async ({
  page,
}) => {
  await page.evaluate(() => {
    window.vanillaHN.stores.settingsStore.update({ autoCollapse: false });
    window.vanillaHN.router.navigate("/story/9001");
  });
  await expect(page.locator(".item-view")).toBeVisible();
  await page.evaluate((item) => {
    const deliver = window.loadingFixture.deliver;
    deliver({ ...item, kids: [9101, 9102] });
    deliver({ id: 9102, type: "comment", parent: 9001, text: "Second", kids: [9201] });
    deliver({ id: 9201, type: "comment", parent: 9102, text: "Reply" });
    deliver({ id: 9101, type: "comment", parent: 9001, text: "First" });
    // A newly ranked comment arrives between the existing ones.
    deliver({ ...item, kids: [9101, 9103, 9102] });
    deliver({ id: 9103, type: "comment", parent: 9001, text: "Inserted" });
  }, story);

  const texts = page.locator(".item-view > .kids > .comment > details > .content > .text");
  await expect(texts).toHaveText([/First/, /Inserted/, /Second/]);

  // Store-driven collapse reaches the native disclosure and its counts.
  await page.evaluate(() => {
    window.vanillaHN.router.currentView._threadStore.toggleCollapse(9102, true);
  });
  const second = page.locator('.item-view > .kids > .comment[data-id="9102"]');
  await expect(second.locator(":scope > details")).not.toHaveAttribute("open");
  await expect(second.locator(":scope > .meta .counts")).toHaveText(" | (1 child)");
  await expect(second).toHaveClass(/collapsed/);

  // A user toggle writes back to the store.
  await second.locator(":scope > details > summary").click();
  await expect(second.locator(":scope > details")).toHaveAttribute("open");
  expect(
    await page.evaluate(() =>
      Boolean(window.vanillaHN.router.currentView._threadStore.isCollapsed[9102]),
    ),
  ).toBe(false);
});

test("does not load replies of a deleted comment or end the first load early", async ({ page }) => {
  await page.evaluate(() => {
    localStorage.removeItem("9001");
    window.vanillaHN.router.navigate("/story/9001");
  });
  await expect(page.locator(".item-view")).toBeVisible();
  await page.evaluate((item) => {
    const deliver = window.loadingFixture.deliver;
    deliver({ ...item, kids: [9101, 9102], descendants: 3 });
    deliver({ id: 9101, type: "comment", parent: 9001, deleted: true, kids: [9201] });
    deliver({ id: 9102, type: "comment", parent: 9001, text: "Visible", kids: [9202] });
  }, story);
  expect(await page.evaluate(() => window.vanillaHN.router.currentView._threadStore.loading)).toBe(
    true,
  );
  await page.evaluate(() =>
    window.loadingFixture.deliver({ id: 9202, type: "comment", parent: 9102, text: "Reply" }),
  );

  await expect(page.locator("#comment-body-9202")).toContainText("Reply");
  expect(await page.evaluate(() => window.loadingFixture.requests)).not.toContain("9201");
  await expect(page.locator(".item-view .comment.new")).toHaveCount(0);
  await expect(page.locator(".item-view .controls")).toBeEmpty();
});

test("auto-collapses old threads on a revisit and highlights new replies", async ({ page }) => {
  await page.evaluate(() => {
    window.vanillaHN.stores.settingsStore.update({ autoCollapse: true });
    localStorage.setItem(
      "9001",
      JSON.stringify({ lastVisit: Date.now() - 60_000, commentCount: 3, maxCommentId: 9201 }),
    );
    window.vanillaHN.router.navigate("/story/9001");
  });
  await expect(page.locator(".item-view")).toBeVisible();
  await page.evaluate((item) => {
    const deliver = window.loadingFixture.deliver;
    deliver({ ...item, kids: [9101, 9102], descendants: 4 });
    deliver({ id: 9101, type: "comment", parent: 9001, text: "Old", kids: [9201] });
    deliver({ id: 9201, type: "comment", parent: 9101, text: "Old reply" });
    deliver({ id: 9102, type: "comment", parent: 9001, text: "Active", kids: [9202] });
    deliver({ id: 9202, type: "comment", parent: 9102, text: "New reply" });
  }, story);

  const old = page.locator('.item-view > .kids > .comment[data-id="9101"]');
  const active = page.locator('.item-view > .kids > .comment[data-id="9102"]');
  await expect(old).toHaveClass(/collapsed/);
  await expect(old.locator(":scope > details")).not.toHaveAttribute("open");
  await expect(old.locator(":scope > .meta .counts")).toHaveText(" | (1 child)");
  await expect(active.locator(":scope > details")).toHaveAttribute("open");
  await expect(page.locator('.comment[data-id="9202"]')).toHaveClass(/\bnew\b/);
  await expect(page.locator(".item-view .controls")).toContainText("1 new comment");
});

test("keeps a user toggle when a store sync runs before its toggle event", async ({ page }) => {
  await page.evaluate(() => window.vanillaHN.router.navigate("/story/9001"));
  await expect(page.locator(".item-view")).toBeVisible();
  await page.evaluate((item) => {
    window.loadingFixture.deliver({ ...item, kids: [9101] });
    window.loadingFixture.deliver({ id: 9101, type: "comment", parent: 9001, text: "Only" });
  }, story);
  const comment = page.locator('.item-view > .kids > .comment[data-id="9101"]');
  await expect(comment).toBeVisible();

  await page.evaluate(() => {
    document.querySelector('.comment[data-id="9101"] > details > summary').click();
    // A frame sync that lands before the native toggle event must not reopen it.
    window.vanillaHN.router.currentView._tree._syncAll();
  });
  await expect(comment.locator(":scope > details")).not.toHaveAttribute("open");
  await expect(comment.locator(":scope > .meta .counts")).toBeVisible();
  expect(
    await page.evaluate(() =>
      Boolean(window.vanillaHN.router.currentView._threadStore.isCollapsed[9101]),
    ),
  ).toBe(true);
});

test("keeps a shown comment as a stub with its replies when it is deleted", async ({ page }) => {
  await page.evaluate(() => window.vanillaHN.router.navigate("/story/9001"));
  await expect(page.locator(".item-view")).toBeVisible();
  await page.evaluate((item) => {
    const deliver = window.loadingFixture.deliver;
    deliver({ ...item, kids: [9101, 9102] });
    deliver({ id: 9101, type: "comment", parent: 9001, text: "Soon deleted", kids: [9201] });
    deliver({ id: 9102, type: "comment", parent: 9001, text: "Stays" });
  }, story);
  await expect(page.locator("#comment-body-9101")).toContainText("Soon deleted");

  await page.evaluate(() => {
    const { deliver } = window.loadingFixture;
    deliver({ id: 9101, type: "comment", parent: 9001, deleted: true, kids: [9201] });
    deliver({ id: 9201, type: "comment", parent: 9101, text: "Late reply" });
  });
  await expect(page.locator("#comment-body-9101")).not.toContainText("Soon deleted");
  await expect(page.locator('.comment[data-id="9101"]')).toHaveClass(/deleted/);
  await expect(page.locator('.comment[data-id="9101"] > .meta .by')).toHaveText("[deleted]");
  await expect(page.locator('.comment[data-id="9101"] > details > summary')).toHaveAccessibleName(
    "Deleted comment",
  );
  await expect(page.locator("#comment-body-9201")).toContainText("Late reply");
});

test("renders the stub once Show Dead is turned off and the comment updates", async ({ page }) => {
  await page.evaluate(() => {
    window.vanillaHN.stores.settingsStore.update({ showDead: true });
    window.vanillaHN.router.navigate("/story/9001");
  });
  await expect(page.locator(".item-view")).toBeVisible();
  await page.evaluate((item) => {
    const { deliver } = window.loadingFixture;
    deliver({ ...item, kids: [9101] });
    deliver({ id: 9101, type: "comment", parent: 9001, text: "Flagged text" });
    deliver({ id: 9101, type: "comment", parent: 9001, dead: true, text: "Flagged text" });
  }, story);
  await expect(page.locator("#comment-body-9101")).toContainText("Flagged text");

  await page.evaluate(() => {
    window.vanillaHN.stores.settingsStore.update({ showDead: false });
    // A kids-only update: text and moderation flags are unchanged.
    window.loadingFixture.deliver({
      id: 9101,
      type: "comment",
      parent: 9001,
      dead: true,
      text: "Flagged text",
      kids: [9201],
    });
  });
  await expect(page.locator("#comment-body-9101")).toHaveText("[dead]");
});

test("keeps focus on the author link when a comment's text is edited", async ({ page }) => {
  await page.evaluate(() => window.vanillaHN.router.navigate("/story/9001"));
  await expect(page.locator(".item-view")).toBeVisible();
  await page.evaluate((item) => {
    window.loadingFixture.deliver({ ...item, kids: [9101] });
    window.loadingFixture.deliver({
      id: 9101,
      type: "comment",
      parent: 9001,
      by: "author",
      text: "Before",
    });
  }, story);
  const by = page.locator('.comment[data-id="9101"] > .meta .by');
  await by.focus();
  await page.evaluate(() =>
    window.loadingFixture.deliver({
      id: 9101,
      type: "comment",
      parent: 9001,
      by: "author",
      text: "After",
    }),
  );
  await expect(page.locator("#comment-body-9101")).toContainText("After");
  await expect(by).toBeFocused();
});

test("keeps a new reply and the banner in step when its parent dies", async ({ page }) => {
  await page.evaluate(() => {
    window.vanillaHN.stores.settingsStore.update({ showDead: false });
    localStorage.setItem(
      "9001",
      JSON.stringify({ lastVisit: Date.now() - 60_000, commentCount: 2, maxCommentId: 9201 }),
    );
    window.vanillaHN.router.navigate("/story/9001");
  });
  await expect(page.locator(".item-view")).toBeVisible();
  await page.evaluate((item) => {
    const deliver = window.loadingFixture.deliver;
    deliver({ ...item, kids: [9101], descendants: 3 });
    deliver({ id: 9101, type: "comment", parent: 9001, text: "Old", kids: [9201] });
    deliver({ id: 9201, type: "comment", parent: 9101, text: "Old reply", kids: [9301] });
    deliver({ id: 9301, type: "comment", parent: 9201, text: "New reply" });
  }, story);
  const controls = page.locator(".item-view .controls");
  await expect(controls).toContainText("1 new comment");

  await page.evaluate(() =>
    window.loadingFixture.deliver({
      id: 9201,
      type: "comment",
      parent: 9101,
      dead: true,
      text: "Old reply",
      kids: [9301],
    }),
  );
  await expect(page.locator("#comment-body-9201")).toHaveText("[dead]");
  await expect(page.locator('.comment.new[data-id="9301"]')).toBeVisible();
  await expect(controls).toContainText("1 new comment");
});

test("applies the reply-link setting when a comment updates", async ({ page }) => {
  await page.evaluate(() => {
    window.vanillaHN.stores.settingsStore.update({ replyLinks: true });
    window.vanillaHN.router.navigate("/story/9001");
  });
  await expect(page.locator(".item-view")).toBeVisible();
  await page.evaluate((item) => {
    window.loadingFixture.deliver({ ...item, kids: [9101] });
    window.loadingFixture.deliver({ id: 9101, type: "comment", parent: 9001, text: "Text" });
  }, story);
  const replyLink = page.locator('#comment-body-9101 a[href*="reply?id=9101"]');
  await expect(replyLink).toHaveCount(1);

  await page.evaluate(() => {
    window.vanillaHN.stores.settingsStore.update({ replyLinks: false });
    // A kids-only update: text and moderation flags are unchanged.
    window.loadingFixture.deliver({
      id: 9101,
      type: "comment",
      parent: 9001,
      text: "Text",
      kids: [9201],
    });
  });
  await expect(replyLink).toHaveCount(0);
});

test("keeps the deepest reply of a long thread reachable", async ({ page }) => {
  // Phone width on every project, so the thread really overflows.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.vanillaHN.router.navigate("/story/9001"));
  await expect(page.locator(".item-view")).toBeVisible();
  const depth = 16;
  await page.evaluate(
    ({ item, depth }) => {
      const { deliver } = window.loadingFixture;
      deliver({ ...item, kids: [9100] });
      for (let level = 0; level < depth; level++) {
        deliver({
          id: 9100 + level,
          type: "comment",
          parent: level ? 9099 + level : 9001,
          by: `user${level}`,
          text: `<p>Level ${level} reply</p>`,
          kids: level < depth - 1 ? [9101 + level] : [],
        });
      }
    },
    { item: story, depth },
  );
  await expect(page.locator(".item-view .comment")).toHaveCount(depth);

  const reach = await page.evaluate(
    (lastId) => {
      const thread = document.querySelector(".item-view > .kids > .comment");
      const summary = document.querySelector(`.comment[data-id="${lastId}"] > details > summary`);
      const overflows = thread.scrollWidth > thread.clientWidth;
      thread.scrollLeft = thread.scrollWidth;
      const box = thread.getBoundingClientRect();
      const control = summary.getBoundingClientRect();
      return {
        pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        controlInside: control.left >= box.left && control.right <= box.right,
        overflows,
      };
    },
    9100 + depth - 1,
  );
  expect(reach.overflows).toBe(true);
  expect(reach.pageOverflow).toBe(false);
  expect(reach.controlInside).toBe(true);
});

test("shows dead and deleted direct replies on a permalink with their replies", async ({
  page,
}) => {
  await page.evaluate(() => {
    window.vanillaHN.stores.settingsStore.update({ showDead: false, showDeleted: false });
    window.vanillaHN.router.navigate("/comment/9101");
  });
  await expect.poll(() => page.evaluate(() => window.loadingFixture.requests)).toContain("9101");
  await page.evaluate(() => {
    const { deliver } = window.loadingFixture;
    deliver({ id: 9101, type: "comment", parent: 9001, text: "Permalinked", kids: [9201, 9202] });
    deliver({ id: 9201, type: "comment", parent: 9101, dead: true, text: "x", kids: [9301] });
    deliver({ id: 9202, type: "comment", parent: 9101, deleted: true, kids: [9302] });
    deliver({ id: 9301, type: "comment", parent: 9201, text: "Live reply under dead" });
    deliver({ id: 9302, type: "comment", parent: 9202, text: "Live reply under deleted" });
  });
  await expect(page.locator("#comment-body-9201")).toHaveText("[dead]");
  await expect(page.locator("#comment-body-9301")).toContainText("Live reply under dead");
  await expect(page.locator("#comment-body-9302")).toContainText("Live reply under deleted");
});
