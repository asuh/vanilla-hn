import assert from "node:assert/strict";
import test from "node:test";

globalThis.sessionStorage = {
  getItem: () => null,
  setItem: () => {},
};

const [{ default: HNService }, { default: UpdatesStore }, { default: PermalinkedCommentView }] =
  await Promise.all([
    import("../src/api/hn-service.js"),
    import("../src/stores/UpdatesStore.js"),
    import("../src/views/PermalinkedCommentView.js"),
  ]);

test("mock subscriptions do not deliver queued values after unsubscribe", async () => {
  const service = new HNService({ mock: true });
  let calls = 0;
  const unsubscribe = service.onItemValue("1", () => calls++);

  unsubscribe();
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(calls, 0);
  service.destroy();
});

test("UpdatesStore stops its feed and invalidates pending fetches", async () => {
  let feedUnsubscribed = 0;
  let resolveFetch;
  const fetchResult = new Promise((resolve) => {
    resolveFetch = resolve;
  });
  const service = {
    onUpdatesValue(callback) {
      queueMicrotask(() => callback({ items: ["1"] }));
      return () => feedUnsubscribed++;
    },
    fetchItem() {
      return fetchResult;
    },
  };
  const store = new UpdatesStore(service);
  let emissions = 0;
  store.addListener(() => emissions++);
  store.start();
  await Promise.resolve();
  const emissionsBeforeStop = emissions;

  store.stop();
  resolveFetch({ id: 1, type: "story", title: "late result", time: 1 });
  await fetchResult;
  await Promise.resolve();

  assert.equal(feedUnsubscribed, 1);
  assert.equal(emissions, emissionsBeforeStop);
  store.dispose();
});

test("permalink rerenders release child subscriptions and elements", () => {
  const view = new PermalinkedCommentView();
  let unsubscribed = 0;
  let cleaned = 0;
  view._kidUnsubs.push(
    () => unsubscribed++,
    () => unsubscribed++,
  );
  view._commentElements.set("1", { cleanup: () => cleaned++ });

  view._resetRenderedThread();

  assert.equal(unsubscribed, 2);
  assert.equal(cleaned, 1);
  assert.equal(view._kidUnsubs.length, 0);
  assert.equal(view._commentElements.size, 0);
});
