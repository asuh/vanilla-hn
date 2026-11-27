import assert from "node:assert/strict";
import test from "node:test";

globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };

const { default: CommentThreadStore } = await import("../src/stores/CommentThreadStore.js");
const { default: StoryCommentThreadStore } =
  await import("../src/stores/StoryCommentThreadStore.js");

const comment = (id, parent, extra = {}) => ({ id, parent, type: "comment", ...extra });

test("memoized descendant counts follow additions and deletions", () => {
  const store = new CommentThreadStore();
  store.commentAdded(comment(10, 1));
  store.commentAdded(comment(11, 10));
  store.commentAdded(comment(12, 11));
  assert.deepEqual(store.getChildCounts({ id: 10 }), { children: 2, newComments: 0 });
  assert.deepEqual(store.getChildCounts({ id: 11 }), { children: 1, newComments: 0 });

  store.commentAdded(comment(13, 10));
  store.isNew[13] = true;
  assert.deepEqual(store.getChildCounts({ id: 10 }), { children: 3, newComments: 1 });

  store.commentDeleted(comment(11, 10));
  assert.deepEqual(store.getChildCounts({ id: 10 }), { children: 1, newComments: 1 });
  assert.deepEqual(store.getChildCounts({ id: 99 }), { children: 0, newComments: 0 });
});

test("counts survive very deep threads without recursion", () => {
  const store = new CommentThreadStore();
  for (let id = 2; id <= 20_001; id++) store.commentAdded(comment(id, id - 1));
  assert.equal(store.getChildCounts({ id: 1 }).children, 20_000);
});

test("story stores refresh new counts after highlighting and marking read", () => {
  const storage = { get: () => null, set: () => {} };
  const store = new StoryCommentThreadStore(1, {
    storage,
    settings: { autoCollapse: false, showDead: false, showDeleted: false },
  });
  const events = [];
  store.addListener((change) => events.push(change.type));
  store.initForItem({ id: 1, kids: [10] });
  store.commentAdded(comment(10, 1, { kids: [11, 12] }));
  store.commentAdded(comment(11, 10));
  store.commentAdded(comment(12, 10));
  assert.equal(store.loading, false);
  assert.ok(events.includes("loaded"));

  store.highlightNewCommentsSince(2);
  assert.deepEqual(store.getChildCounts({ id: 10 }), { children: 2, newComments: 1 });

  store.markAsRead();
  assert.deepEqual(store.getChildCounts({ id: 10 }), { children: 2, newComments: 0 });
  assert.equal(events.at(-1), "markAsRead");
  store.dispose();
});

test("story stores drop dead comments from counts when they die", () => {
  const store = new StoryCommentThreadStore(1, {
    storage: { get: () => null, set: () => {} },
    settings: { autoCollapse: false, showDead: false, showDeleted: false },
  });
  store.initForItem({ id: 1, kids: [10] });
  store.commentAdded(comment(10, 1, { kids: [11] }));
  store.commentAdded(comment(11, 10));
  assert.equal(store.getChildCounts({ id: 10 }).children, 1);
  store.isNew[11] = true;
  store.newCommentCount = 1;
  store.invalidateCounts();
  assert.equal(store.getChildCounts({ id: 10 }).newComments, 1);

  store.commentAdded(comment(11, 10, { dead: true }));
  assert.equal(store.getChildCounts({ id: 10 }).newComments, 0);
  assert.equal(store.newCommentCount, 0);
  store.dispose();
});

test("story stores keep a deleted comment with replies in the graph", () => {
  const store = new StoryCommentThreadStore(1, {
    storage: { get: () => null, set: () => {} },
    settings: { autoCollapse: false, showDead: false, showDeleted: false },
  });
  store.initForItem({ id: 1, kids: [10] });
  store.commentAdded(comment(10, 1, { kids: [11] }));
  store.commentAdded(comment(11, 10, { kids: [12] }));
  store.commentAdded(comment(12, 11, { kids: [13] }));
  store.commentAdded(comment(13, 12));
  assert.equal(store.commentCount, 4);

  // A moderator deletes 11 while its replies stay on screen under the stub.
  store.commentAdded(comment(11, 10, { deleted: true, kids: [12] }));
  assert.equal(store.commentCount, 3);
  assert.equal(store.parents[12], 11);
  assert.equal(store.getChildCounts({ id: 10 }).children, 3);

  // The stub is not a highlight candidate, but its replies are.
  assert.equal(store.getCommentByTimeIndex(2).id, 12);
  store.highlightNewCommentsSince(1);
  assert.deepEqual(Object.keys(store.isNew).map(Number), [12, 13]);
  assert.equal(store.getChildCounts({ id: 10 }).newComments, 2);

  // A deleted comment without loaded replies still leaves the graph.
  store.commentAdded(comment(13, 12, { deleted: true }));
  assert.deepEqual(store.children[12], []);
  assert.equal(store.commentCount, 2);
  store.dispose();
});

test("story stores keep a comment deleted before its replies arrive in the graph", () => {
  const store = new StoryCommentThreadStore(1, {
    storage: { get: () => null, set: () => {} },
    settings: { autoCollapse: false, showDead: false, showDeleted: false },
  });
  store.initForItem({ id: 1, kids: [10] });
  store.commentAdded(comment(10, 1, { kids: [11] }));
  store.commentAdded(comment(11, 10, { kids: [12] }));
  store.commentAdded(comment(11, 10, { deleted: true, kids: [12] }));
  store.commentAdded(comment(12, 11));
  assert.equal(store.getChildCounts({ id: 10 }).children, 2);
  store.highlightNewCommentsSince(1);
  assert.deepEqual(Object.keys(store.isNew).map(Number), [12]);
  store.dispose();
});

test("the slider skips dead stubs but reaches their replies", () => {
  const store = new StoryCommentThreadStore(1, {
    storage: { get: () => null, set: () => {} },
    settings: { autoCollapse: false, showDead: false, showDeleted: false },
  });
  store.initForItem({ id: 1, kids: [10, 11, 12] });
  store.commentAdded(comment(10, 1));
  store.commentAdded(comment(11, 1));
  store.commentAdded(comment(12, 1, { kids: [13] }));
  store.commentAdded(comment(13, 12));
  // The newest top-level comment dies while shown; its stub keeps its reply.
  store.commentAdded(comment(12, 1, { dead: true, kids: [13] }));

  store.highlightNewCommentsSince(1);
  assert.deepEqual(Object.keys(store.isNew).map(Number), [11, 13]);
  store.dispose();
});

test("a vouched comment counts and can be highlighted again", () => {
  const store = new StoryCommentThreadStore(1, {
    storage: { get: () => null, set: () => {} },
    settings: { autoCollapse: false, showDead: false, showDeleted: false },
  });
  store.initForItem({ id: 1, kids: [10, 11] });
  store.commentAdded(comment(10, 1));
  store.commentAdded(comment(11, 1, { dead: true }));
  assert.equal(store.commentCount, 1);

  store.commentAdded(comment(11, 1));
  assert.equal(store.commentCount, 2);
  assert.equal(store.deadComments[11], undefined);
  store.highlightNewCommentsSince(1);
  assert.deepEqual(Object.keys(store.isNew).map(Number), [11]);
  store.dispose();
});
