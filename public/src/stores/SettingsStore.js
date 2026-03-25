/**
 * SettingsStore.js
 *
 * A small, dependency-free settings store used by the vanilla-hn scaffold.
 *
 * Responsibilities:
 *  - Hold user preferences (autoCollapse, replyLinks, showDead, showDeleted, titleFontSize, listSpacing, theme)
 *  - Persist preferences to localStorage
 *  - Expose a simple listener API so views can react to changes
 *  - Apply theme-related CSS variables to the document
 *
 * Usage:
 *   import SettingsStore from './stores/SettingsStore.js';
 *   const settings = new SettingsStore();
 *   settings.addListener(state => { ... });
 *   settings.update({ theme: 'dark' });
 *
 * Notes:
 *  - This file intentionally avoids any framework or external dependency.
 *  - It is resilient to missing `document`/`localStorage` (useful for SSR or tests).
 */

const STORAGE_KEY = 'vanilla-hn:settings:v1';
const DEFAULTS = {
  autoCollapse: true,
  replyLinks: true,
  showDead: false,
  showDeleted: false,
  titleFontSize: 18, // px
  listSpacing: 'normal', // 'compact' | 'normal' | 'spacious'
  theme: 'light' // 'light' | 'dark' | 'system'
};

function safeParseJSON(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch (e) {
    return fallback;
  }
}

/**
 * Minimal debounce utility to coalesce frequent saves.
 */
function debounce(fn, wait = 200) {
  let timeout = null;
  return (...args) => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => {
      timeout = null;
      try { fn(...args); } catch (e) { /* swallow */ }
    }, wait);
  };
}

export default class SettingsStore {
  constructor(initial = {}) {
    // Internal state
    this._state = Object.assign({}, DEFAULTS, initial);

    // listeners: Set<Function>
    this._listeners = new Set();

    // Load persisted settings (if any)
    this.load();

    // Debounced save to avoid thrashing localStorage
    this._debouncedSave = debounce(() => this._persist(), 150);

    // Apply theme immediately
    try { this.applyTheme(); } catch (e) { /* ignore in non-DOM environments */ }
  }

  /**
   * Load settings from localStorage and merge into current state.
   * If localStorage is unavailable or data is malformed, defaults remain.
   */
  load() {
    if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = safeParseJSON(raw, null);
      if (parsed && typeof parsed === 'object') {
        // Merge shallowly; only known keys get assigned to avoid stale/invalid keys
        for (const k of Object.keys(DEFAULTS)) {
          if (k in parsed) this._state[k] = parsed[k];
        }
      }
    } catch (e) {
      // ignore storage errors
      console.warn('SettingsStore.load(): failed to read localStorage', e);
    }
  }

  /**
   * Persist current state to localStorage.
   * Internal method; use update() which triggers debounced persistence.
   */
  _persist() {
    if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return;
    try {
      const json = JSON.stringify(this._state);
      window.localStorage.setItem(STORAGE_KEY, json);
    } catch (e) {
      // Storage might be full or blocked; don't throw
      console.warn('SettingsStore._persist(): failed to write localStorage', e);
    }
  }

  /**
   * Save immediately (no debounce). Use sparingly.
   */
  saveNow() {
    this._persist();
  }

  /**
   * Update settings with a shallow merge and notify listeners.
   * The write to localStorage is debounced to improve perceived performance.
   *
   * @param {Object} updates
   */
  update(updates = {}) {
    if (!updates || typeof updates !== 'object') return;
    let changed = false;
    for (const [k, v] of Object.entries(updates)) {
      if (!(k in DEFAULTS)) continue; // ignore unknown keys
      const prev = this._state[k];
      // simple equality check
      if (prev !== v) {
        this._state[k] = v;
        changed = true;
      }
    }
    if (changed) {
      // persist after a short delay (debounced)
      this._debouncedSave();
      // apply theme immediately if theme changed
      if ('theme' in updates || 'titleFontSize' in updates || 'listSpacing' in updates) {
        try { this.applyTheme(); } catch (e) { /* ignore */ }
      }
      this.notify();
    }
  }

  /**
   * Get the whole state or a single key.
   *
   * @param {string} [key] Optional key to retrieve.
   * @returns {*}
   */
  get(key) {
    if (typeof key === 'string') return this._state[key];
    // return a shallow clone to avoid accidental external mutation
    return Object.assign({}, this._state);
  }

  /**
   * Add a listener callback which will be invoked with the new state whenever it changes.
   * Returns an unsubscribe function.
   *
   * @param {Function} fn
   * @returns {Function} unsubscribe
   */
  addListener(fn) {
    if (typeof fn !== 'function') throw new TypeError('SettingsStore.addListener expects a function');
    this._listeners.add(fn);
    // Immediately call with current state so subscribers can initialize
    try { fn(this.get()); } catch (e) { /* swallow subscriber errors */ }

    return () => {
      this._listeners.delete(fn);
    };
  }

  /**
   * Alias for addListener
   */
  subscribe(fn) {
    return this.addListener(fn);
  }

  /**
   * Notify all listeners of the current state.
   */
  notify() {
    const snapshot = this.get();
    for (const fn of Array.from(this._listeners)) {
      try { fn(snapshot); } catch (e) { console.warn('SettingsStore listener threw', e); }
    }
  }

  /**
   * Apply theme and other UI-related preferences to the document.
   * This mutates `document.documentElement` and `document.body` when available.
   *
   * Behavior:
   *  - `theme === 'dark'` => add `body.classList.add('dark')`
   *  - `theme === 'light'` => remove `body.classList.remove('dark')`
   *  - `theme === 'system'` => follow prefers-color-scheme
   *
   * Also applies `--font-size-title` based on `titleFontSize` and spacing classes for listSpacing.
   */
  applyTheme() {
    if (typeof document === 'undefined') return;

    const body = document.body;
    const root = document.documentElement;
    const theme = this._state.theme || DEFAULTS.theme;

    // Theme handling
    if (theme === 'dark') {
      body.classList.add('dark');
    } else if (theme === 'light') {
      body.classList.remove('dark');
    } else if (theme === 'system') {
      // follow OS: remove explicit class and let CSS media queries handle it,
      // but if you prefer to set class based on current system preference:
      const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      if (prefersDark) body.classList.add('dark');
      else body.classList.remove('dark');
    }

    // Font size for titles (applied as CSS variable so components can use it)
    try {
      const size = Number(this._state.titleFontSize) || DEFAULTS.titleFontSize;
      root.style.setProperty('--font-size-title', `${size}px`);
    } catch (e) {
      // ignore style errors
    }

    // list spacing: set a data attribute for CSS to scope styles
    try {
      const spacing = String(this._state.listSpacing || DEFAULTS.listSpacing);
      root.setAttribute('data-list-spacing', spacing);
    } catch (e) {
      // ignore
    }
  }

  /**
   * Reset settings to defaults (optionally persist).
   *
   * @param {boolean} [persist=true]
   */
  reset(persist = true) {
    this._state = Object.assign({}, DEFAULTS);
    if (persist) this._debouncedSave();
    try { this.applyTheme(); } catch (e) { /* ignore */ }
    this.notify();
  }
}

/* End of SettingsStore.js */
