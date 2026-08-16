import { debounce } from "../utils/helpers.js";
import { rememberItem } from "../utils/item-ancestors.js";

const STORAGE_KEY = "vanilla-hn:updates:v1";
const DEFAULT_CACHE_SIZE = 500;
const DISPLAYABLE_TYPES = new Set(["comment", "job", "poll", "story"]);

function emptyCache() {
  return { comments: {}, stories: {} };
}

function sortByTimeDesc(a, b) {
  return (b.time || 0) - (a.time || 0);
}

export default class UpdatesStore {
  constructor(hnService, options = {}) {
    this._hn = hnService;
    this._cacheSize = options.cacheSize || DEFAULT_CACHE_SIZE;
    this._listeners = new Set();
    this._cache = emptyCache();
    this._updates = { comments: [], stories: [] };
    this._ready = false;
    this._unsub = null;
    this._fetchGeneration = 0;
    this._debouncedSave = debounce(() => this.saveSession(), 150);
    this.loadSession();
  }

  addListener(fn) {
    if (typeof fn !== "function") {
      throw new TypeError("UpdatesStore.addListener expects a function");
    }
    this._listeners.add(fn);
    fn(this.getUpdates(), { ready: this._ready });
    return () => this._listeners.delete(fn);
  }

  isReady() {
    return this._ready;
  }

  getUpdates() {
    return {
      comments: this._updates.comments.slice(),
      stories: this._updates.stories.slice(),
    };
  }

  getItem(id) {
    const key = String(id);
    return this._cache.comments[key] || this._cache.stories[key] || null;
  }

  getComment(id) {
    return this._cache.comments[String(id)] || null;
  }

  getStory(id) {
    return this._cache.stories[String(id)] || null;
  }

  start() {
    if (this._unsub || !this._hn || typeof this._hn.onUpdatesValue !== "function") {
      return;
    }

    this._ready = false;
    this._unsub = this._hn.onUpdatesValue((updates) => {
      const ids = Array.isArray(updates)
        ? updates
        : Array.isArray(updates?.items)
          ? updates.items
          : [];
      this._fetchItems(ids);
    });
  }

  stop() {
    this._fetchGeneration++;
    this._ready = false;
    if (typeof this._unsub === "function") {
      try {
        this._unsub();
      } catch (_) {}
    }
    this._unsub = null;
  }

  loadSession() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      this._cache = raw ? JSON.parse(raw) : emptyCache();
    } catch (_) {
      this._cache = emptyCache();
    }
    if (!this._cache.comments || !this._cache.stories) {
      this._cache = emptyCache();
    }
    this._populateUpdates();
  }

  saveSession() {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(this._cache));
    } catch (_) {}
  }

  dispose() {
    this.stop();
    this._debouncedSave.cancel();
    this.saveSession();
    this._listeners.clear();
  }

  async _fetchItems(ids) {
    const generation = ++this._fetchGeneration;
    if (!ids.length || !this._hn || typeof this._hn.fetchItem !== "function") {
      this._ready = true;
      this._emit();
      return;
    }

    const items = await Promise.all(ids.map((id) => this._hn.fetchItem(id).catch(() => null)));
    if (generation !== this._fetchGeneration) return;

    let changed = false;
    for (const item of items) {
      if (!item || item.deleted || !DISPLAYABLE_TYPES.has(item.type)) continue;
      rememberItem(item);
      if (item.type === "comment") {
        this._cache.comments[String(item.id)] = item;
      } else {
        this._cache.stories[String(item.id)] = item;
      }
      changed = true;
    }

    if (changed) {
      this._populateUpdates();
      this._debouncedSave();
    }
    this._ready = true;
    this._emit();
  }

  _populateUpdates() {
    this._updates.comments = this._processCache(this._cache.comments);
    this._updates.stories = this._processCache(this._cache.stories);
  }

  _processCache(cacheObj) {
    const arr = Object.values(cacheObj).sort(sortByTimeDesc);
    const evicted = arr.splice(this._cacheSize);
    for (const item of evicted) delete cacheObj[String(item.id)];
    return arr;
  }

  _emit() {
    const snapshot = this.getUpdates();
    for (const fn of this._listeners) {
      try {
        fn(snapshot, { ready: this._ready });
      } catch (err) {
        console.warn("UpdatesStore listener error:", err);
      }
    }
  }
}
