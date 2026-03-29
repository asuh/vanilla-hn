/**
 * ReadStoriesStore.js
 *
 * Small store for tracking which stories the user has read and when.
 * - Persists a compact map of { [storyId]: timestampSeconds } to localStorage.
 * - Exposes markAsRead, isRead, getReadStories, unmarkAsRead, clearOlderThan
 * - Provides addListener/subscribe semantics and notifies listeners on changes.
 *
 * Design notes:
 * - Timestamps are stored as seconds (Unix epoch) to keep the stored JSON small.
 * - The store is resilient to missing localStorage (e.g., during SSR or private mode).
 * - Writes are debounced to avoid thrashing localStorage on rapid navigation.
 */

const STORAGE_KEY = 'vanilla-hn:read:v1';
const DEFAULT_MAX_ENTRIES = 500; // safety limit for persisted map

function safeParseJSON(raw, fallback = {}) {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : fallback;
  } catch (e) {
    return fallback;
  }
}

function debounce(fn, wait = 200) {
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      try { fn(...args); } catch (e) { /* swallow */ }
    }, wait);
  };
}

export default class ReadStoriesStore {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.maxEntries=500] maximum number of entries to persist
   */
  constructor(opts = {}) {
    this._key = STORAGE_KEY;
    this._maxEntries = Number(opts.maxEntries) || DEFAULT_MAX_ENTRIES;
    this._listeners = new Set();
    // Internal map: { [id]: tsSeconds }
    this._reads = {};

    // Attempt to load persisted state
    this._load();

    // Debounced persist to avoid frequent storage writes
    this._debouncedSave = debounce(() => this._persist(), 150);
  }

  /* ---------------------------
   * Persistence
   * --------------------------- */

  _load() {
    if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
      this._reads = {};
      return;
    }
    try {
      const raw = window.localStorage.getItem(this._key);
      if (!raw) {
        this._reads = {};
        return;
      }
      const parsed = safeParseJSON(raw, {});
      // Normalize keys to strings and values to numbers (seconds)
      const normalized = {};
      for (const [k, v] of Object.entries(parsed)) {
        const id = String(k);
        const ts = Number(v) || 0;
        if (ts > 0) normalized[id] = ts;
      }
      this._reads = normalized;
    } catch (e) {
      // If reading fails, fall back to empty map
      this._reads = {};
      console.warn('ReadStoriesStore: failed to load from localStorage', e);
    }
  }

  _persist() {
    if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
      return;
    }
    try {
      // Ensure we don't persist an excessively large object
      this._enforceMaxEntries();
      window.localStorage.setItem(this._key, JSON.stringify(this._reads));
    } catch (e) {
      // Ignore storage errors (quota, blocked storage, etc.)
      console.warn('ReadStoriesStore: failed to persist to localStorage', e);
    }
  }

  _enforceMaxEntries() {
    const keys = Object.keys(this._reads);
    if (keys.length <= this._maxEntries) return;
    // Remove oldest entries first
    const sorted = keys.sort((a, b) => (this._reads[a] - this._reads[b]));
    const toRemove = sorted.slice(0, keys.length - this._maxEntries);
    for (const k of toRemove) {
      delete this._reads[k];
    }
  }

  /* ---------------------------
   * Public API
   * --------------------------- */

  /**
   * Mark a story as read at the provided timestamp (seconds). If tsSeconds is omitted,
   * the current time is used.
   *
   * @param {string|number} storyId
   * @param {number} [tsSeconds]
   */
  markAsRead(storyId, tsSeconds) {
    if (storyId == null) return;
    const id = String(storyId);
    const ts = Number(tsSeconds) || Math.floor(Date.now() / 1000);
    this._reads[id] = ts;
    // Persist (debounced) and notify listeners
    this._debouncedSave();
    this._notify();
    return id;
  }

  /**
   * Unmark a story as read (remove from the persisted store).
   * @param {string|number} storyId
   * @returns {boolean} true if removed, false if not present
   */
  unmarkAsRead(storyId) {
    if (storyId == null) return false;
    const id = String(storyId);
    if (!(id in this._reads)) return false;
    delete this._reads[id];
    this._debouncedSave();
    this._notify();
    return true;
  }

  /**
   * Check whether a story is marked as read.
   * Optionally pass `withinSeconds` to check if it was read within a time window.
   *
   * @param {string|number} storyId
   * @param {number} [withinSeconds] if provided, returns true only if read timestamp is within this many seconds from now.
   * @returns {boolean}
   */
  isRead(storyId, withinSeconds) {
    if (storyId == null) return false;
    const id = String(storyId);
    const ts = this._reads[id];
    if (!ts) return false;
    if (typeof withinSeconds === 'number') {
      const now = Math.floor(Date.now() / 1000);
      return (now - ts) <= withinSeconds;
    }
    return true;
  }

  /**
   * Return a shallow copy of the read stories map: { id: tsSeconds, ... }
   * @returns {Object}
   */
  getReadStories() {
    return Object.assign({}, this._reads);
  }

  /**
   * Remove read marks older than the specified age (in seconds).
   * Useful to prune long-running storage for limited devices.
   *
   * @param {number} maxAgeSeconds
   * @returns {number} number of entries removed
   */
  clearOlderThan(maxAgeSeconds) {
    if (typeof maxAgeSeconds !== 'number' || maxAgeSeconds <= 0) return 0;
    const now = Math.floor(Date.now() / 1000);
    let removed = 0;
    for (const [id, ts] of Object.entries(this._reads)) {
      if ((now - ts) > maxAgeSeconds) {
        delete this._reads[id];
        removed++;
      }
    }
    if (removed > 0) {
      this._debouncedSave();
      this._notify();
    }
    return removed;
  }

  /**
   * Wipe all persisted read marks
   */
  clearAll() {
    this._reads = {};
    this._debouncedSave();
    this._notify();
  }

  /* ---------------------------
   * Listener API
   * --------------------------- */

  /**
   * Add a listener that will be called with the current reads snapshot whenever
   * the store changes. Returns an unsubscribe function.
   *
   * @param {Function} fn (readsSnapshot) => void
   * @returns {Function} unsubscribe
   */
  addListener(fn) {
    if (typeof fn !== 'function') throw new TypeError('ReadStoriesStore.addListener expects a function');
    this._listeners.add(fn);
    // call immediately with current snapshot so subscribers can initialize
    try { fn(this.getReadStories()); } catch (e) { /* swallow subscriber errors */ }
    return () => this._listeners.delete(fn);
  }

  /**
   * Alias for addListener
   */
  subscribe(fn) {
    return this.addListener(fn);
  }

  _notify() {
    const snapshot = this.getReadStories();
    for (const fn of Array.from(this._listeners)) {
      try { fn(snapshot); } catch (e) { /* swallow */ }
    }
  }

  /* ---------------------------
   * Utility
   * --------------------------- */

  /**
   * Return number of stored read entries
   * @returns {number}
   */
  size() {
    return Object.keys(this._reads).length;
  }

  /**
   * Destroy store: clear listeners and stop any pending debounced saves (by forcing a save).
   * Use when tearing down an SPA or running tests.
   */
  destroy() {
    // Persist immediately before destroying
    try { this._persist(); } catch (e) { /* ignore */ }
    this._listeners.clear();
  }
}
