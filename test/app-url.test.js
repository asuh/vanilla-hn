import assert from "node:assert/strict";
import test from "node:test";
import { isAppURL, normalizeBasePath, toAppPath, toRouteTarget } from "../src/utils/app-url.js";

test("app URLs honor root and project deployment paths", () => {
  assert.equal(normalizeBasePath("vanilla-hn"), "/vanilla-hn/");
  assert.equal(normalizeBasePath("/"), "/");
  assert.equal(toAppPath("/newest?page=2", "/vanilla-hn/"), "/vanilla-hn/newest?page=2");
  assert.equal(toAppPath("/", "/vanilla-hn/"), "/vanilla-hn/");
  assert.equal(toAppPath("/vanilla-hn/read", "/vanilla-hn/"), "/vanilla-hn/read");
  assert.equal(
    toAppPath("https://news.ycombinator.com/", "/vanilla-hn/"),
    "https://news.ycombinator.com/",
  );
});

test("route targets remove only the configured deployment path", () => {
  const route = new URL("https://asuh.github.io/vanilla-hn/story/33?page=2");
  const outside = new URL("https://asuh.github.io/another-app/");

  assert.equal(toRouteTarget(route, "/vanilla-hn/"), "/story/33?page=2");
  assert.equal(toRouteTarget(outside, "/vanilla-hn/"), null);
  assert.equal(isAppURL(route, "/vanilla-hn/"), true);
  assert.equal(isAppURL(outside, "/vanilla-hn/"), false);
});
