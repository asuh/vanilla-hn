import { debounce } from "../utils/helpers.js";

/**
 * StoryStore — manages a story list (by type) with sessionStorage caching.
 *
 * Subscribes to HNService for a specific list type (top, newest, ask, etc.),
 * caches story IDs and loaded items in sessionStorage, and notifies listeners
 * when data changes.
 *
 * @class StoryStore
 */
export default class StoryStore {
  /** Read a saved story without starting a list or subscribing to its items. */
  static getStoredItem(id) {
    const key = String(id);
    for (const listType of ["top", "newest", "ask", "show", "jobs"]) {
      try {
        const saved = JSON.parse(sessionStorage.getItem(`vanilla-hn:stories:${listType}`));
        const item = saved?.items?.[key];
        if (item?.title && String(item.id) === key) return item;
      } catch (_) {
        // A corrupt list cache or unavailable storage must not prevent loading.
      }
    }
    return null;
  }

  /**
   * @param {string} listType - The story list type (top, newest, ask, show, jobs).
   * @param {Object} hnService - The HNService instance.
   * @param {Object} [options]
   * @param {number} [options.pageSize=30] - Items per page.
   */
  constructor(listType, hnService, options = {}) {
    this.listType = listType;
    this._hn = hnService;
    this._pageSize = options.pageSize || 30;
    this._ids = []; // All story IDs in order
    this._items = new Map(); // id (string) → full item object
    this._listeners = new Set();
    this._unsub = null; // List subscription unsub
    this._itemUnsubs = []; // Per-item subscription unsubs
    this._debouncedSave = debounce(() => this._saveToSession(), 300);

    this._loadFromSession();
  }

  /** @returns {string[]} All story IDs in list order */
  get ids() {
    return this._ids;
  }

  /** @returns {number} Total number of stories */
  get length() {
    return this._ids.length;
  }

  /**
   * Get a single cached item by ID.
   * @param {string|number} id
   * @returns {Object|undefined}
   */
  getItem(id) {
    return this._items.get(String(id));
  }

  /**
   * Get items for a specific page.
   * Returns full item objects where available, or { id } placeholders.
   *
   * @param {number} page - 1-based page number.
   * @returns {Object[]} Array of items for the page.
   */
  getPageItems(page) {
    const start = (page - 1) * this._pageSize;
    const end = start + this._pageSize;
    return this._ids.slice(start, end).map((id) => this._items.get(id) || { id });
  }

  /**
   * @param {number} page - 1-based page number.
   * @returns {boolean} Whether there are more pages after this one.
   */
  hasNextPage(page) {
    return page * this._pageSize < this._ids.length;
  }

  /**
   * Start subscribing to the story list from HNService.
   * If cached data exists, listeners are notified immediately.
   * @returns {Function} Unsubscribe function.
   */
  subscribe() {
    // Notify immediately if cached data exists
    if (this._ids.length > 0) {
      this._notify();
    }

    this._unsub = this._hn.onStoriesValue(this.listType, (raw) => {
      if (!raw || !Array.isArray(raw) || raw.length === 0) return;

      if (typeof raw[0] === "object") {
        // Full objects (mock mode)
        this._ids = raw.map((item) => String(item.id));
        for (const item of raw) {
          this._items.set(String(item.id), item);
        }
      } else {
        // ID list (Firebase)
        this._ids = raw.map((id) => String(id));
      }

      this._debouncedSave();
      this._notify();
    });

    return () => this.dispose();
  }

  /**
   * Subscribe to individual item updates for a set of IDs.
   * Useful for loading full item data for the current page.
   *
   * @param {Array<string|number>} ids - Item IDs to subscribe to.
   */
  subscribeToItems(ids) {
    // Cancel previous per-item subs
    this._clearItemSubs();

    for (const id of ids) {
      const unsub = this._hn.onItemValue(id, (item) => {
        if (item) {
          this._items.set(String(item.id), item);
          this._debouncedSave();
          this._notify(item);
        }
      });
      if (typeof unsub === "function") this._itemUnsubs.push(unsub);
    }
  }

  /**
   * @param {Function} fn - Listener called with the store instance on changes.
   * @returns {Function} Unsubscribe function.
   */
  addListener(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  /** Tear down all subscriptions and save final state. */
  dispose() {
    if (this._unsub) {
      try {
        this._unsub();
      } catch (_) {
        /* ignore */
      }
      this._unsub = null;
    }
    this._clearItemSubs();
    this._debouncedSave.cancel();
    this._saveToSession();
    this._listeners.clear();
  }

  // ── Private ────────────────────────────────

  _clearItemSubs() {
    for (const unsub of this._itemUnsubs) {
      try {
        unsub();
      } catch (_) {
        /* ignore */
      }
    }
    this._itemUnsubs = [];
  }

  _notify(item) {
    for (const fn of this._listeners) {
      try {
        fn(this, item);
      } catch (e) {
        console.warn("[StoryStore] listener error:", e);
      }
    }
  }

  _loadFromSession() {
    try {
      const key = `vanilla-hn:stories:${this.listType}`;
      const raw = sessionStorage.getItem(key);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (Array.isArray(data.ids)) {
        this._ids = data.ids;
      }
      if (data.items && typeof data.items === "object") {
        for (const [id, item] of Object.entries(data.items)) {
          this._items.set(id, item);
        }
      }
    } catch (_) {
      /* ignore */
    }
  }

  _saveToSession() {
    try {
      const key = `vanilla-hn:stories:${this.listType}`;
      // Only cache items we actually have full data for (not placeholders)
      const items = {};
      for (const [id, item] of this._items) {
        if (item?.title) {
          // Only cache items with full data
          items[id] = item;
        }
      }
      sessionStorage.setItem(
        key,
        JSON.stringify({
          ids: this._ids,
          items,
        }),
      );
    } catch (_) {
      /* ignore */
    }
  }
}
