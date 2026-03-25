/**
 * HNService - a small abstraction around a Hacker News data source.
 *
 * This file provides a minimal, framework-free service that:
 *  - exposes the same surface you'd expect from a realtime-backed HN service:
 *      - onStoriesValue(listType, cb) -> unsubscribe
 *      - onItemValue(itemId, cb) -> unsubscribe
 *      - fetchItem(itemId, { signal }) -> Promise<item>
 *      - onUserValue(userId, cb) -> unsubscribe
 *      - onUpdatesValue(cb) -> unsubscribe
 *  - runs in "mock mode" if no realtime backend is configured. Mock mode
 *    emits deterministic test data and simple periodic updates so the UI
 *    can be developed without a Firebase key.
 *
 * Usage:
 *   const svc = new HNService({ mock: true })
 *   const unsubscribe = svc.onItemValue('123', item => { ... })
 *
 * Notes:
 *  - This implementation intentionally keeps things simple and dependency-free.
 *  - Replace or extend this file to integrate an actual realtime database (e.g. Firebase).
 */

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/** Create a shallow clone with predictable shape similar to HN API */
function createMockItem(id, opts = {}) {
  const base = {
    id: Number(id),
    by: opts.by || `user${(id % 10) + 1}`,
    time: opts.time || nowSeconds() - (id % 600),
    text: opts.text || `This is a mock comment/story for id ${id}.`,
    title: opts.title || (opts.type === 'story' ? `Mock story ${id}` : undefined),
    url: opts.url || (opts.type === 'story' ? `https://example.com/story/${id}` : undefined),
    kids: Array.isArray(opts.kids) ? opts.kids : (opts.kids === undefined ? [] : opts.kids),
    score: opts.score != null ? opts.score : Math.max(1, (Number(id) % 100)),
    type: opts.type || (opts.title ? 'story' : 'comment'),
    dead: false,
    deleted: false
  };
  return base;
}

/**
 * Small in-memory store used by the mock mode to simulate realtime behavior.
 * Not exported; internal to this file.
 */
class MockBackend {
  constructor() {
    this._storiesByList = {
      top: this._generateStoryIds(1, 30),
      newest: this._generateStoryIds(31, 60),
      ask: this._generateStoryIds(61, 75),
      show: this._generateStoryIds(76, 90),
      jobs: this._generateStoryIds(91, 100)
    };
    this._items = new Map();
    // Pre-populate some items
    for (let id = 1; id <= 200; id++) {
      this._items.set(String(id), createMockItem(String(id), { type: id % 5 === 0 ? 'story' : 'comment' }));
    }

    // listeners
    this._storyListeners = new Map(); // key: listType -> Set(callback)
    this._itemListeners = new Map(); // key: itemId -> Set(callback)
    this._userListeners = new Map(); // key: userId -> Set(callback)
    this._updatesListeners = new Set();

    // simulate some activity
    this._tickInterval = setInterval(() => this._tick(), 4000);
  }

  _generateStoryIds(start, end) {
    const arr = [];
    for (let i = start; i <= end; i++) arr.push(String(i));
    return arr;
  }

  _tick() {
    // Randomly pick an existing item and "update" it (simulate new comment or changed score)
    const keys = Array.from(this._items.keys());
    if (keys.length === 0) return;
    const idx = Math.floor(Math.random() * keys.length);
    const id = keys[idx];
    const item = this._items.get(id);
    if (!item) return;

    // 30% chance to add a child comment (new kid)
    if (Math.random() < 0.3) {
      const newId = String(this._items.size + 1);
      const child = createMockItem(newId, { type: 'comment', text: `Auto-generated child for ${id}` });
      this._items.set(newId, child);
      item.kids = item.kids ? [...item.kids, newId] : [newId];
      // notify item listeners for the parent and the new child
      this._notifyItem(id, item);
      this._notifyItem(newId, child);
    } else {
      // occasionally bump the score
      item.score = (item.score || 0) + 1;
      this._notifyItem(id, item);
    }

    // Occasionally notify high-level updates (e.g., top stories changed)
    if (Math.random() < 0.1) {
      for (const cb of this._updatesListeners) {
        try { cb({ timestamp: Date.now() }); } catch (e) { console.warn(e); }
      }
    }
  }

  _notifyStories(listType) {
    const ids = this._storiesByList[listType] || [];
    const listeners = this._storyListeners.get(listType);
    if (!listeners) return;
    for (const cb of listeners) {
      try { cb(ids.slice()); } catch (e) { console.warn(e); }
    }
  }

  _notifyItem(itemId, payload) {
    const listeners = this._itemListeners.get(String(itemId));
    if (!listeners) return;
    for (const cb of listeners) {
      try { cb({ ...payload }); } catch (e) { console.warn(e); }
    }
  }

  // Public-ish APIs used by HNService mock mode
  watchStories(listType, cb) {
    const set = this._storyListeners.get(listType) || new Set();
    set.add(cb);
    this._storyListeners.set(listType, set);
    // immediate initial delivery
    setTimeout(() => {
      try { cb((this._storiesByList[listType] || []).slice()); } catch (e) { console.warn(e); }
    }, 0);
    // return unsubscribe
    return () => { set.delete(cb); };
  }

  watchItem(itemId, cb) {
    const id = String(itemId);
    const set = this._itemListeners.get(id) || new Set();
    set.add(cb);
    this._itemListeners.set(id, set);
    // immediate initial delivery
    const initial = this._items.get(id) || createMockItem(id, { type: 'story' });
    setTimeout(() => {
      try { cb({ ...initial }); } catch (e) { console.warn(e); }
    }, 0);
    return () => { set.delete(cb); };
  }

  async fetchItem(itemId) {
    const id = String(itemId);
    // simulate network latency
    await new Promise(resolve => setTimeout(resolve, 120 + Math.random() * 200));
    let item = this._items.get(id);
    if (!item) {
      item = createMockItem(id, { type: 'comment' });
      this._items.set(id, item);
    }
    return { ...item };
  }

  watchUser(userId, cb) {
    const id = String(userId);
    const set = this._userListeners.get(id) || new Set();
    set.add(cb);
    this._userListeners.set(id, set);
    // deliver a mock user
    setTimeout(() => {
      try {
        cb({
          id,
          about: `Mock user ${id}`,
          created: nowSeconds() - 3600 * (Number(id) % 48),
          karma: (Number(id) % 200)
        });
      } catch (e) { console.warn(e); }
    }, 0);
    return () => { set.delete(cb); };
  }

  watchUpdates(cb) {
    this._updatesListeners.add(cb);
    // immediate initial ping
    setTimeout(() => {
      try { cb({ timestamp: Date.now() }); } catch (e) { console.warn(e); }
    }, 0);
    return () => { this._updatesListeners.delete(cb); };
  }

  destroy() {
    clearInterval(this._tickInterval);
    this._storyListeners.clear();
    this._itemListeners.clear();
    this._userListeners.clear();
    this._updatesListeners.clear();
    this._items.clear();
  }
}

/**
 * HNService
 *
 * Constructor options:
 *   - mock: boolean (force mock mode)
 *   - databaseURL: string (if provided, you would wire real Firebase here)
 *
 * In this scaffolded repo we default to mock mode. The class is written so you can
 * swap the internals with a Firebase-backed implementation that satisfies the same API.
 */
export default class HNService {
  constructor(options = {}) {
    this.options = options || {};
    this.mock = Boolean(this.options.mock) || !this.options.databaseURL;
    this._destroyed = false;

    if (this.mock) {
      this._backend = new MockBackend();
    } else {
      // Placeholder for real backend initialization (Firebase/etc).
      // In a real integration you'd initialize the SDK here and set up
      // methods that attach to realtime listeners and return unsubscribe functions.
      // Keep a tiny, resilient fallback so the service won't crash.
      console.warn('HNService: real backend not implemented in this scaffold — falling back to mock mode.');
      this._backend = new MockBackend();
      this.mock = true;
    }
  }

  /**
   * onStoriesValue(listType, callback)
   * - listType: 'top' | 'newest' | 'ask' | 'show' | 'jobs' etc.
   * - callback receives an array of item ids (strings) in the list order.
   * Returns an unsubscribe function.
   */
  onStoriesValue(listType, callback) {
    if (this._destroyed) return () => {};
    if (this.mock) {
      return this._backend.watchStories(listType, callback);
    }
    // Real backend would look like:
    // const ref = ref(db, `v0/${listType}`);
    // const listener = onValue(ref, snap => { callback(process(snap)) });
    // return () => off(ref, 'value', listener);
    throw new Error('onStoriesValue not implemented for non-mock mode');
  }

  /**
   * onItemValue(itemId, callback)
   * - callback receives the full item object whenever it changes.
   * Returns an unsubscribe function.
   */
  onItemValue(itemId, callback) {
    if (this._destroyed) return () => {};
    if (this.mock) {
      return this._backend.watchItem(itemId, callback);
    }
    throw new Error('onItemValue not implemented for non-mock mode');
  }

  /**
   * fetchItem(itemId, { signal })
   * - one-off fetch of an item (no persistent listener).
   * - honors AbortSignal if provided.
   */
  async fetchItem(itemId, opts = {}) {
    if (this._destroyed) throw new Error('HNService destroyed');
    const signal = opts.signal;
    if (signal && signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    if (this.mock) {
      const p = this._backend.fetchItem(itemId);
      if (!signal) return p;
      // wire abort
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          reject(new DOMException('Aborted', 'AbortError'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        p.then((v) => {
          signal.removeEventListener('abort', onAbort);
          resolve(v);
        }).catch((err) => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        });
      });
    }

    // Real fetch code would go here (e.g., fetch from REST endpoint)
    throw new Error('fetchItem not implemented for non-mock mode');
  }

  /**
   * onUserValue(userId, callback)
   * - callback receives the user object whenever it changes.
   * Returns an unsubscribe function.
   */
  onUserValue(userId, callback) {
    if (this._destroyed) return () => {};
    if (this.mock) {
      return this._backend.watchUser(userId, callback);
    }
    throw new Error('onUserValue not implemented for non-mock mode');
  }

  /**
   * onUpdatesValue(callback)
   * - top-level updates feed (e.g. global "updates" channel).
   * Returns an unsubscribe function.
   */
  onUpdatesValue(callback) {
    if (this._destroyed) return () => {};
    if (this.mock) {
      return this._backend.watchUpdates(callback);
    }
    throw new Error('onUpdatesValue not implemented for non-mock mode');
  }

  /**
   * Shutdown and release resources.
   */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    if (this._backend && typeof this._backend.destroy === 'function') {
      try { this._backend.destroy(); } catch (e) { /* ignore */ }
    }
    this._backend = null;
  }
}
