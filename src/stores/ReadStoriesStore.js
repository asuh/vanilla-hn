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

import { debounce } from "../utils/helpers.js";

const STORAGE_KEY = "vanilla-hn:read:v1";
const DEFAULT_MAX_ENTRIES = 500; // safety limit for persisted map

export default class ReadStoriesStore {
  /**
   * Create a new ReadStoriesStore.
   *
   * Loads any previously persisted read-story entries from localStorage and
   * sets up a debounced save so rapid `markAsRead` calls don't thrash storage.
   *
   * @param {Object} [opts] - Configuration options.
   * @param {number} [opts.maxEntries=500] - Maximum number of entries to persist.
   *   When exceeded, the oldest entries are pruned before saving.
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
    if (typeof window === "undefined" || typeof window.localStorage === "undefined") {
      this._reads = {};
      return;
    }
    try {
      const raw = window.localStorage.getItem(this._key);
      if (!raw) {
        this._reads = {};
        return;
      }
      let parsed;
      try {
        const v = JSON.parse(raw);
        parsed = v && typeof v === "object" ? v : {};
      } catch (_e) {
        parsed = {};
      }
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
      console.warn("ReadStoriesStore: failed to load from localStorage", e);
    }
  }

  _persist() {
    if (typeof window === "undefined" || typeof window.localStorage === "undefined") {
      return;
    }
    try {
      // Ensure we don't persist an excessively large object
      this._enforceMaxEntries();
      window.localStorage.setItem(this._key, JSON.stringify(this._reads));
    } catch (e) {
      // Ignore storage errors (quota, blocked storage, etc.)
      console.warn("ReadStoriesStore: failed to persist to localStorage", e);
    }
  }

  _enforceMaxEntries() {
    const keys = Object.keys(this._reads);
    if (keys.length <= this._maxEntries) return;
    // Remove oldest entries first
    const sorted = keys.sort((a, b) => this._reads[a] - this._reads[b]);
    const toRemove = sorted.slice(0, keys.length - this._maxEntries);
    for (const k of toRemove) {
      delete this._reads[k];
    }
  }

  /* ---------------------------
   * Public API
   * --------------------------- */

  /**
   * Mark a story as read at the provided timestamp (seconds).
   *
   * If `tsSeconds` is omitted, the current time is used. The write to
   * localStorage is debounced, and all registered listeners are notified
   * with an updated snapshot of the reads map.
   *
   * @param {string|number} storyId - The ID of the story to mark as read.
   * @param {number} [tsSeconds] - Unix timestamp in seconds. Defaults to `Date.now() / 1000`.
   * @returns {string} The normalised string ID of the story that was marked.
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
   * Remove a story's read mark from the persisted store.
   *
   * Triggers a debounced save and notifies listeners if the entry existed.
   *
   * @param {string|number} storyId - The ID of the story to unmark.
   * @returns {boolean} `true` if the entry was present and removed, `false` if it was not found.
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
   *
   * When `withinSeconds` is provided, the method only returns `true` if the
   * story was read within that many seconds from the current time.
   *
   * @param {string|number} storyId - The ID of the story to check.
   * @param {number} [withinSeconds] - If provided, returns `true` only when the
   *   read timestamp is within this many seconds of now.
   * @returns {boolean} Whether the story is (recently) read.
   */
  isRead(storyId, withinSeconds) {
    if (storyId == null) return false;
    const id = String(storyId);
    const ts = this._reads[id];
    if (!ts) return false;
    if (typeof withinSeconds === "number") {
      const now = Math.floor(Date.now() / 1000);
      return now - ts <= withinSeconds;
    }
    return true;
  }

  /**
   * Return a shallow copy of the read stories map.
   *
   * The returned object maps string story IDs to Unix-second timestamps.
   * Mutations to the returned object do not affect the store.
   *
   * @returns {Object.<string, number>} A `{ storyId: timestampSeconds }` snapshot.
   */
  getReadStories() {
    return Object.assign({}, this._reads);
  }

  /**
   * Remove read marks older than the specified age.
   *
   * Useful to prune long-running storage on limited devices. Triggers a
   * debounced save and listener notification when at least one entry is removed.
   *
   * @param {number} maxAgeSeconds - Entries older than this many seconds are removed.
   * @returns {number} The number of entries that were removed.
   */
  clearOlderThan(maxAgeSeconds) {
    if (typeof maxAgeSeconds !== "number" || maxAgeSeconds <= 0) return 0;
    const now = Math.floor(Date.now() / 1000);
    let removed = 0;
    for (const [id, ts] of Object.entries(this._reads)) {
      if (now - ts > maxAgeSeconds) {
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
   * Wipe all persisted read marks and reset the store to an empty state.
   *
   * Triggers a debounced save and notifies all listeners.
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
   * Register a listener that is called with a snapshot of the reads map
   * whenever the store changes.
   *
   * The listener is also invoked immediately with the current snapshot so
   * that subscribers can initialise their state without an extra `getReadStories()` call.
   *
   * @param {Function} fn - Callback of the form `(readsSnapshot: Object.<string, number>) => void`.
   * @returns {Function} An unsubscribe function. Call it to remove the listener.
   */
  addListener(fn) {
    if (typeof fn !== "function")
      throw new TypeError("ReadStoriesStore.addListener expects a function");
    this._listeners.add(fn);
    // call immediately with current snapshot so subscribers can initialize
    try {
      fn(this.getReadStories());
    } catch (_e) {
      /* swallow subscriber errors */
    }
    return () => this._listeners.delete(fn);
  }

  /**
   * Alias for {@link ReadStoriesStore#addListener}.
   *
   * @param {Function} fn - Callback of the form `(readsSnapshot: Object.<string, number>) => void`.
   * @returns {Function} An unsubscribe function.
   */
  subscribe(fn) {
    return this.addListener(fn);
  }

  _notify() {
    const snapshot = this.getReadStories();
    for (const fn of Array.from(this._listeners)) {
      try {
        fn(snapshot);
      } catch (_e) {
        /* swallow */
      }
    }
  }

  /* ---------------------------
   * Utility
   * --------------------------- */

  /**
   * Return the number of stories currently tracked as read.
   *
   * @returns {number} The count of stored read entries.
   */
  size() {
    return Object.keys(this._reads).length;
  }

  /**
   * Destroy the store: persist any pending state immediately, then clear all
   * registered listeners.
   *
   * Use this when tearing down an SPA view or during test cleanup to ensure
   * no debounced callbacks fire after the store is logically dead.
   */
  destroy() {
    // Persist immediately before destroying
    try {
      this._persist();
    } catch (_e) {
      /* ignore */
    }
    this._listeners.clear();
  }
}
