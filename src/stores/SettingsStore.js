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

import { debounce } from "../utils/helpers.js";

const STORAGE_KEY = "vanilla-hn:settings:v1";
const DEFAULTS = {
  autoCollapse: true,
  replyLinks: true,
  showDead: false,
  showDeleted: false,
  titleFontSize: 18, // px
  listSpacing: "normal", // 'compact' | 'normal' | 'spacious'
  theme: "light", // 'light' | 'dark' | 'system'
};

export default class SettingsStore {
  /**
   * Create a new SettingsStore instance.
   *
   * Merges the provided `initial` overrides into the built-in defaults,
   * hydrates from localStorage (if available), sets up debounced persistence,
   * and applies the current theme to the DOM immediately.
   *
   * @param {Object} [initial={}] Optional key/value overrides to merge on top
   *                              of the built-in defaults before localStorage
   *                              hydration occurs.
   */
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
    try {
      this.applyTheme();
    } catch (_e) {
      /* ignore in non-DOM environments */
    }
  }

  /**
   * Load settings from localStorage and merge into the current in-memory state.
   *
   * Only known keys (those present in `DEFAULTS`) are merged so that stale or
   * invalid keys from an older schema are silently ignored. If localStorage is
   * unavailable or the stored JSON is malformed the current defaults remain
   * untouched.
   */
  load() {
    if (typeof window === "undefined" || typeof window.localStorage === "undefined") return;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch (_e) {
        // Malformed JSON — fall through and keep defaults.
        return;
      }
      if (parsed && typeof parsed === "object") {
        // Merge shallowly; only known keys get assigned to avoid stale/invalid keys
        for (const k of Object.keys(DEFAULTS)) {
          if (k in parsed) this._state[k] = parsed[k];
        }
      }
    } catch (e) {
      // ignore storage errors
      console.warn("SettingsStore.load(): failed to read localStorage", e);
    }
  }

  /**
   * Persist current state to localStorage.
   * Internal method; use update() which triggers debounced persistence.
   */
  _persist() {
    if (typeof window === "undefined" || typeof window.localStorage === "undefined") return;
    try {
      const json = JSON.stringify(this._state);
      window.localStorage.setItem(STORAGE_KEY, json);
    } catch (e) {
      // Storage might be full or blocked; don't throw
      console.warn("SettingsStore._persist(): failed to write localStorage", e);
    }
  }

  /**
   * Persist the current state to localStorage immediately, bypassing the
   * debounce delay. Use sparingly — prefer {@link update} for normal writes.
   */
  saveNow() {
    this._persist();
  }

  /**
   * Update one or more settings with a shallow merge and notify all listeners.
   *
   * Unknown keys (those not present in `DEFAULTS`) are silently ignored.
   * The write to localStorage is debounced to improve perceived performance.
   * If the `theme`, `titleFontSize`, or `listSpacing` keys are included the
   * DOM theme is re-applied synchronously before listeners are invoked.
   *
   * @param {Object} updates An object whose keys are setting names and whose
   *                         values are the new values to apply. Only keys that
   *                         actually differ from the current state trigger a
   *                         change notification.
   */
  update(updates = {}) {
    if (!updates || typeof updates !== "object") return;
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
      if ("theme" in updates || "titleFontSize" in updates || "listSpacing" in updates) {
        try {
          this.applyTheme();
        } catch (_e) {
          /* ignore */
        }
      }
      this.notify();
    }
  }

  /**
   * Retrieve the entire settings state or a single setting by key.
   *
   * When called without arguments (or with a non-string value) a shallow clone
   * of the full state object is returned so that callers cannot accidentally
   * mutate internal state.
   *
   * @param {string} [key] Optional setting name to retrieve.
   * @returns {*|Object} The value of the requested key, or a shallow copy of
   *                     the full state object when `key` is omitted.
   */
  get(key) {
    if (typeof key === "string") return this._state[key];
    // return a shallow clone to avoid accidental external mutation
    return Object.assign({}, this._state);
  }

  /**
   * Register a listener callback that will be invoked with a snapshot of the
   * full settings state whenever it changes.
   *
   * The listener is called immediately upon registration with the current state
   * so that subscribers can initialise without a separate `get()` call.
   *
   * @param {Function} fn Callback invoked as `fn(stateSnapshot)`.
   * @returns {Function} An unsubscribe function — call it to remove the listener.
   */
  addListener(fn) {
    if (typeof fn !== "function")
      throw new TypeError("SettingsStore.addListener expects a function");
    this._listeners.add(fn);
    // Immediately call with current state so subscribers can initialize
    try {
      fn(this.get());
    } catch (_e) {
      /* swallow subscriber errors */
    }

    return () => {
      this._listeners.delete(fn);
    };
  }

  /**
   * Alias for {@link addListener}. Provided for API symmetry with other stores.
   *
   * @param {Function} fn Callback invoked as `fn(stateSnapshot)`.
   * @returns {Function} An unsubscribe function — call it to remove the listener.
   */
  subscribe(fn) {
    return this.addListener(fn);
  }

  /**
   * Invoke every registered listener with a shallow snapshot of the current
   * settings state. Listener errors are caught and logged so that a single
   * misbehaving subscriber cannot break other listeners or the store itself.
   */
  notify() {
    const snapshot = this.get();
    for (const fn of Array.from(this._listeners)) {
      try {
        fn(snapshot);
      } catch (e) {
        console.warn("SettingsStore listener threw", e);
      }
    }
  }

  /**
   * Apply the current theme and UI-related preferences to the DOM.
   *
   * Behavior:
   *  - For `system` the method removes inline overrides so CSS `light-dark()` or
   *    `prefers-color-scheme` may decide the active theme.
   *  - For `light`/`dark` it sets `color-scheme` and a small set of override
   *    custom properties (so no body class toggling is required).
   *
   * Also sets `--font-size-title` and `data-list-spacing` as before.
   *
   * This method is a no-op when `document` is not available (e.g. SSR or tests).
   */
  applyTheme() {
    if (typeof document === "undefined") return;

    const root = document.documentElement;
    const theme = this._state.theme || DEFAULTS.theme;

    // Helper to remove any inline overrides
    const removeOverrides = () => {
      try {
        root.style.removeProperty("color-scheme");
        root.style.removeProperty("--override-hn-bg");
        root.style.removeProperty("--override-hn-text");
        root.style.removeProperty("--override-hn-muted");
        root.style.removeProperty("--override-hn-accent");
      } catch (_e) {
        // ignore style errors
      }
    };

    if (theme === "system") {
      // Let the CSS (light-dark() or prefers-color-scheme fallback) decide.
      removeOverrides();
    } else if (theme === "dark") {
      // Force dark: tell UA and set a few override tokens
      try {
        root.style.setProperty("color-scheme", "dark");
        root.style.setProperty("--override-hn-bg", "#0b0b0b");
        root.style.setProperty("--override-hn-text", "#e6e6e6");
        root.style.setProperty("--override-hn-muted", "#9a9a9a");
        root.style.setProperty("--override-hn-accent", "#7ee787");
      } catch (_e) {
        // ignore style errors
      }
    } else {
      // Force light
      try {
        root.style.setProperty("color-scheme", "light");
        root.style.setProperty("--override-hn-bg", "#ffffff");
        root.style.setProperty("--override-hn-text", "#111111");
        root.style.setProperty("--override-hn-muted", "#666666");
        root.style.setProperty("--override-hn-accent", "#2f9e44");
      } catch (_e) {
        // ignore style errors
      }
    }

    // Font size for titles (applied as CSS variable so components can use it)
    try {
      const size = Number(this._state.titleFontSize) || DEFAULTS.titleFontSize;
      root.style.setProperty("--font-size-title", `${size}px`);
    } catch (_e) {
      // ignore style errors
    }

    // list spacing: set a data attribute for CSS to scope styles
    try {
      const spacing = String(this._state.listSpacing || DEFAULTS.listSpacing);
      root.setAttribute("data-list-spacing", spacing);
    } catch (_e) {
      // ignore
    }
  }

  /**
   * Reset all settings to their built-in defaults.
   *
   * Optionally persists the reset state to localStorage (enabled by default).
   * The theme is re-applied and all listeners are notified after the reset.
   *
   * @param {boolean} [persist=true] When `true` (the default) the reset state
   *                                 is written to localStorage via the normal
   *                                 debounced save path.
   */
  reset(persist = true) {
    this._state = Object.assign({}, DEFAULTS);
    if (persist) this._debouncedSave();
    try {
      this.applyTheme();
    } catch (_e) {
      /* ignore */
    }
    this.notify();
  }
}

/* End of SettingsStore.js */
