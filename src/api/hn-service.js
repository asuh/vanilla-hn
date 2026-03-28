import { initializeApp, deleteApp } from "firebase/app";
import { getDatabase, ref, child, onValue, get } from "firebase/database";

import { debounce } from "../utils/helpers.js";

/**
 * hn-service.js
 *
 * Firebase Realtime Database integration for the Hacker News public API.
 * Firebase SDK is resolved via importmap to local vendor files — no npm
 * install required. Falls back to MockBackend if Firebase fails to load.
 *
 * Public API:
 *   onStoriesValue(listType, cb) -> unsub
 *   onItemValue(id, cb)          -> unsub
 *   fetchItem(id, { signal })    -> Promise<item>
 *   onUserValue(id, cb)          -> unsub
 *   onUpdatesValue(cb)           -> unsub
 *   destroy()
 *
 * listType values: 'top' | 'newest' | 'ask' | 'show' | 'jobs'
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HN_DB_URL = "https://hacker-news.firebaseio.com";
const API_ROOT = "/v0";

const LIST_PATHS = {
  top: `${API_ROOT}/topstories`,
  newest: `${API_ROOT}/newstories`,
  ask: `${API_ROOT}/askstories`,
  show: `${API_ROOT}/showstories`,
  jobs: `${API_ROOT}/jobstories`,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function noop() {}

// ---------------------------------------------------------------------------
// MockBackend
// ---------------------------------------------------------------------------

function createMockItem(id, opts = {}) {
  const n = Number(id) || 1;
  return {
    id: n,
    by: opts.by || `user${(n % 10) + 1}`,
    time: opts.time || nowSeconds() - (n % 3600),
    text:
      opts.text ||
      (opts.type !== "story" ? `Mock comment body for id ${n}.` : undefined),
    title: opts.type === "story" ? opts.title || `Mock story ${n}` : undefined,
    url:
      opts.type === "story"
        ? opts.url || `https://example.com/story/${n}`
        : undefined,
    kids: Array.isArray(opts.kids) ? opts.kids : [],
    score: opts.score != null ? opts.score : Math.max(1, n % 200),
    descendants: opts.descendants != null ? opts.descendants : n % 30,
    type: opts.type || "story",
    dead: false,
    deleted: false,
  };
}

/**
 * In-memory mock backend that simulates HN data for development and testing.
 *
 * Produces synthetic stories, comments, and users without any network calls.
 * Periodically mutates data to mimic realtime updates.
 *
 * @class MockBackend
 */
class MockBackend {
  constructor() {
    this._items = new Map();
    this._lists = {
      top: this._range(1, 30),
      newest: this._range(31, 60),
      ask: this._range(61, 75),
      show: this._range(76, 90),
      jobs: this._range(91, 100),
    };

    // Pre-populate items
    for (let id = 1; id <= 200; id++) {
      const type = id <= 100 ? "story" : "comment";
      const kids =
        type === "story" && id % 3 === 0 ? [id + 200, id + 201, id + 202] : [];
      this._items.set(String(id), createMockItem(String(id), { type, kids }));
    }
    // A few comment items for kids
    for (let id = 201; id <= 500; id++) {
      this._items.set(
        String(id),
        createMockItem(String(id), {
          type: "comment",
          kids: id % 4 === 0 ? [id + 300] : [],
        }),
      );
    }

    this._storyListeners = new Map(); // listType → Set<cb>
    this._itemListeners = new Map(); // id       → Set<cb>
    this._userListeners = new Map(); // id       → Set<cb>
    this._updatesListeners = new Set();

    this._tick = debounce(this._doTick.bind(this), 0);
    this._tickInterval = setInterval(() => this._doTick(), 4000);
  }

  _range(start, end) {
    const arr = [];
    for (let i = start; i <= end; i++) arr.push(String(i));
    return arr;
  }

  _doTick() {
    // Randomly bump a score or add a child comment
    const keys = Array.from(this._items.keys());
    const id = keys[Math.floor(Math.random() * keys.length)];
    const item = this._items.get(id);
    if (!item) return;

    if (Math.random() < 0.3 && item.type === "story") {
      const newId = String(this._items.size + 1);
      const child = createMockItem(newId, {
        type: "comment",
        text: `Auto comment on ${id}`,
      });
      this._items.set(newId, child);
      item.kids = [...(item.kids || []), newId];
      item.descendants = (item.descendants || 0) + 1;
      this._notifyItem(id, item);
      this._notifyItem(newId, child);
    } else {
      item.score = (item.score || 0) + 1;
      this._notifyItem(id, item);
    }
  }

  _notifyItem(id, payload) {
    const listeners = this._itemListeners.get(String(id));
    if (!listeners) return;
    for (const cb of listeners) {
      try {
        cb({ ...payload });
      } catch (e) {
        /* swallow */
      }
    }
  }

  // -- public surface --------------------------------------------------------

  /**
   * Subscribe to a story list by type.
   * @param {string} listType - One of 'top', 'newest', 'ask', 'show', 'jobs'.
   * @param {Function} cb - Callback receiving an array of item objects.
   * @returns {Function} Unsubscribe function.
   */
  onStoriesValue(listType, cb) {
    const type = listType || "top";
    const set = this._storyListeners.get(type) || new Set();
    set.add(cb);
    this._storyListeners.set(type, set);

    const ids = (this._lists[type] || []).slice();
    const items = ids.map((id) => this._items.get(id)).filter(Boolean);
    setTimeout(() => {
      try {
        cb(items);
      } catch (e) {
        /* swallow */
      }
    }, 0);

    return () => set.delete(cb);
  }

  /**
   * Subscribe to realtime updates for a single item.
   * @param {number|string} itemId
   * @param {Function} cb - Callback receiving the item object.
   * @returns {Function} Unsubscribe function.
   */
  onItemValue(itemId, cb) {
    const id = String(itemId);
    const set = this._itemListeners.get(id) || new Set();
    set.add(cb);
    this._itemListeners.set(id, set);

    const item = this._items.get(id) || createMockItem(id, { type: "comment" });
    setTimeout(() => {
      try {
        cb({ ...item });
      } catch (e) {
        /* swallow */
      }
    }, 0);

    return () => set.delete(cb);
  }

  /**
   * One-off fetch of a single item (async).
   * @param {number|string} itemId
   * @returns {Promise<Object|null>} The item object.
   */
  async fetchItem(itemId) {
    await new Promise((r) => setTimeout(r, 80 + Math.random() * 120));
    const id = String(itemId);
    let item = this._items.get(id);
    if (!item) {
      item = createMockItem(id, { type: "comment" });
      this._items.set(id, item);
    }
    return { ...item };
  }

  /**
   * Subscribe to realtime updates for a user profile.
   * @param {string} userId
   * @param {Function} cb - Callback receiving the user object.
   * @returns {Function} Unsubscribe function.
   */
  onUserValue(userId, cb) {
    const id = String(userId);
    const set = this._userListeners.get(id) || new Set();
    set.add(cb);
    this._userListeners.set(id, set);
    setTimeout(() => {
      try {
        cb({
          id,
          about: `<p>Mock user <em>${id}</em></p>`,
          created: nowSeconds() - 86400 * 365,
          karma: (id.length * 137) % 9999,
        });
      } catch (e) {
        /* swallow */
      }
    }, 0);
    return () => set.delete(cb);
  }

  /**
   * Subscribe to the global updates feed.
   * @param {Function} cb - Callback receiving `{ items, profiles }`.
   * @returns {Function} Unsubscribe function.
   */
  onUpdatesValue(cb) {
    this._updatesListeners.add(cb);
    setTimeout(() => {
      try {
        cb({ items: [], profiles: [] });
      } catch (e) {}
    }, 0);
    return () => this._updatesListeners.delete(cb);
  }

  /**
   * Tear down the mock backend, clearing all intervals and listeners.
   */
  destroy() {
    clearInterval(this._tickInterval);
    this._storyListeners.clear();
    this._itemListeners.clear();
    this._userListeners.clear();
    this._updatesListeners.clear();
  }
}

// ---------------------------------------------------------------------------
// FirebaseBackend
// ---------------------------------------------------------------------------

/**
 * Firebase Realtime Database backend connecting to the official HN API.
 *
 * Wraps the Firebase SDK to expose a callback-based subscription interface
 * consistent with {@link MockBackend}. Handles initialisation, listener
 * attachment, one-off reads, and teardown.
 *
 * @class FirebaseBackend
 */
class FirebaseBackend {
  /** @constructor */
  constructor() {
    this._app = null;
    this._db = null;
    this._sdk = null; // { ref, child, onValue, get }
    this._destroyed = false;

    // _init is now synchronous (static imports resolved at module load time)
    this._firebaseReady = new Promise((resolve, reject) => {
      try {
        this._init();
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  }

  _init() {
    try {
      this._app = initializeApp(
        { databaseURL: HN_DB_URL },
        `vanilla-hn-${Date.now()}`,
      );
      this._db = getDatabase(this._app);
      this._sdk = { ref, child, onValue, get };
    } catch (e) {
      throw e;
    }
  }

  _ref(path) {
    const { ref, child } = this._sdk;
    // path like '/v0/topstories' or '/v0/item/123'
    const db = this._db;
    // ref(db) gives the root; child navigates from there
    return child(ref(db), path.replace(/^\//, ""));
  }

  /**
   * Attach a realtime listener. Returns an unsubscribe function.
   * If Firebase isn't ready yet, queues the attachment.
   * @param {string} path - Database path (e.g. '/v0/topstories').
   * @param {Function} cb - Callback invoked with snapshot data.
   * @param {Function} [transform] - Optional transform applied to snapshot value before cb.
   * @returns {Function} Unsubscribe function.
   */
  _subscribe(path, cb, transform) {
    let realUnsub = null;
    let cancelled = false;

    this._firebaseReady
      .then(() => {
        if (cancelled || this._destroyed) return;
        const dbRef = this._ref(path);
        const handler = (snapshot) => {
          const val = snapshot.val();
          try {
            cb(transform ? transform(val) : val);
          } catch (e) {
            /* swallow cb errors */
          }
        };
        realUnsub = this._sdk.onValue(dbRef, handler, (err) => {
          console.warn(`[HNService] Firebase listener error on ${path}:`, err);
        });
      })
      .catch((err) => {
        console.warn(
          `[HNService] Firebase not ready, cannot subscribe to ${path}:`,
          err,
        );
      });

    return () => {
      cancelled = true;
      if (typeof realUnsub === "function") realUnsub();
    };
  }

  onStoriesValue(listType, cb) {
    const path = LIST_PATHS[listType] || LIST_PATHS.top;
    return this._subscribe(path, cb, (val) => {
      // val is an array of numeric ids from Firebase
      if (!Array.isArray(val)) return [];
      // Return ids as strings for consistency; ItemView will fetch each item
      return val.map(String);
    });
  }

  onItemValue(itemId, cb) {
    return this._subscribe(`${API_ROOT}/item/${itemId}`, cb);
  }

  /**
   * One-off fetch of a single item. Supports `AbortSignal` via `opts.signal`.
   * @param {number|string} itemId
   * @param {Object} [opts]
   * @param {AbortSignal} [opts.signal] - Optional abort signal.
   * @returns {Promise<Object|null>} The item object or null.
   */
  async fetchItem(itemId, opts = {}) {
    const signal = opts && opts.signal;
    if (signal && signal.aborted)
      throw new DOMException("Aborted", "AbortError");

    await this._firebaseReady;
    if (this._destroyed) throw new Error("HNService destroyed");

    const dbRef = this._ref(`${API_ROOT}/item/${itemId}`);
    const snapPromise = this._sdk.get(dbRef).then((snap) => snap.val());

    if (!signal) return snapPromise;

    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
      snapPromise
        .then((v) => {
          signal.removeEventListener("abort", onAbort);
          resolve(v);
        })
        .catch((e) => {
          signal.removeEventListener("abort", onAbort);
          reject(e);
        });
    });
  }

  onUserValue(userId, cb) {
    return this._subscribe(`${API_ROOT}/user/${userId}`, cb);
  }

  onUpdatesValue(cb) {
    return this._subscribe(`${API_ROOT}/updates`, cb);
  }

  /**
   * Destroy the Firebase backend, deleting the Firebase app instance
   * and releasing all resources.
   */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    if (this._app) {
      try {
        deleteApp(this._app).catch(noop);
      } catch (e) {
        /* ignore */
      }
      this._app = null;
    }
    this._db = null;
    this._sdk = null;
  }
}

// ---------------------------------------------------------------------------
// HNService — public class
// ---------------------------------------------------------------------------

/**
 * HNService
 *
 * Usage:
 *   const svc = new HNService()           // real Firebase, mock fallback
 *   const svc = new HNService({mock:true}) // force mock
 *
 * All methods return an unsubscribe function (or Promise for fetchItem).
 */
export default class HNService {
  /**
   * Create an HNService instance.
   *
   * @param {Object} [options]
   * @param {boolean} [options.mock] - When `true`, force the use of {@link MockBackend}
   *   instead of Firebase. Defaults to `false`.
   */
  constructor(options = {}) {
    this._destroyed = false;
    this._forceMock = Boolean(options && options.mock);

    if (this._forceMock) {
      this._backend = new MockBackend();
      this._usingMock = true;
      this._firebaseReady = Promise.resolve();
    } else {
      const firebase = new FirebaseBackend();
      this._backend = firebase;
      this._usingMock = false;

      // If Firebase fails to init, swap to mock automatically
      this._firebaseReady = firebase._firebaseReady.catch((err) => {
        console.warn(
          "[HNService] Firebase failed to load — switching to MockBackend.",
          err,
        );
        if (this._destroyed) return;
        const mock = new MockBackend();
        this._backend = mock;
        this._usingMock = true;
        firebase.destroy();
      });
    }
  }

  /**
   * Whether the service is currently backed by the mock backend.
   * @returns {boolean}
   */
  get isUsingMock() {
    return this._usingMock;
  }

  /**
   * Subscribe to a story list.
   *
   * The callback receives:
   * - **MockBackend**: an array of full item objects.
   * - **FirebaseBackend**: an array of id strings (views should fetch each via
   *   {@link HNService#onItemValue}).
   *
   * @param {string} listType - One of `'top'`, `'newest'`, `'ask'`, `'show'`, `'jobs'`.
   * @param {Function} callback - Called with the stories payload.
   * @returns {Function} Unsubscribe function.
   */
  onStoriesValue(listType, callback) {
    if (this._destroyed) return noop;
    return this._backend.onStoriesValue(listType, callback);
  }

  /**
   * Subscribe to realtime updates for a single item.
   *
   * The callback receives the full item object whenever it changes.
   *
   * @param {number|string} itemId - The HN item id.
   * @param {Function} callback - Called with the item object on each update.
   * @returns {Function} Unsubscribe function.
   */
  onItemValue(itemId, callback) {
    if (this._destroyed) return noop;
    return this._backend.onItemValue(itemId, callback);
  }

  /**
   * One-off fetch of a single item. Respects `AbortSignal` via `opts.signal`.
   *
   * @param {number|string} itemId - The HN item id.
   * @param {Object} [opts]
   * @param {AbortSignal} [opts.signal] - Optional abort signal.
   * @returns {Promise<Object|null>} Resolves with the item object, or `null`.
   */
  async fetchItem(itemId, opts = {}) {
    if (this._destroyed) throw new Error("HNService destroyed");
    // Wait for backend to be decided (mock swap may be in flight)
    await this._firebaseReady.catch(noop);
    return this._backend.fetchItem(itemId, opts);
  }

  /**
   * Subscribe to realtime updates for a user profile.
   *
   * @param {string} userId - The HN username.
   * @param {Function} callback - Called with the user object on each update.
   * @returns {Function} Unsubscribe function.
   */
  onUserValue(userId, callback) {
    if (this._destroyed) return noop;
    return this._backend.onUserValue(userId, callback);
  }

  /**
   * Subscribe to the HN updates feed (recently changed items and profiles).
   *
   * @param {Function} callback - Called with the updates payload.
   * @returns {Function} Unsubscribe function.
   */
  onUpdatesValue(callback) {
    if (this._destroyed) return noop;
    return this._backend.onUpdatesValue(callback);
  }

  /**
   * Tear down the service and release all backend resources.
   *
   * After calling `destroy()` all subscription and fetch methods will no-op
   * or throw.
   */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    if (this._backend && typeof this._backend.destroy === "function") {
      try {
        this._backend.destroy();
      } catch (e) {
        /* ignore */
      }
    }
    this._backend = null;
  }
}
