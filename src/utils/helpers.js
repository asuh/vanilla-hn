/**
 * helpers.js
 *
 * Shared pure-logic utilities for vanilla-hn.
 * These are intentionally framework-free and DOM-free so they can be used
 * anywhere in the application (stores, views, services, tests).
 *
 * @module utils/helpers
 */

/**
 * Create a debounced version of a function that delays invocation until
 * `wait` milliseconds have elapsed since the last call.
 *
 * The returned function has a `.cancel()` method that clears any pending
 * timeout, making it safe to use in teardown / cleanup paths.
 *
 * @param {Function} fn   - The function to debounce.
 * @param {number}   wait - Delay in milliseconds (default 150).
 * @returns {Function & { cancel: () => void }} Debounced function.
 *
 * @example
 *   const save = debounce(() => localStorage.setItem('k', 'v'), 300);
 *   save();          // schedules
 *   save();          // reschedules (previous timer cleared)
 *   save.cancel();   // cancels pending call
 */
export function debounce(fn, wait = 150) {
  let timeoutId = null;

  /** @type {Function & { cancel: () => void }} */
  const debounced = function (...args) {
    if (timeoutId !== null) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      timeoutId = null;
      try {
        fn.apply(this, args);
      } catch (e) {
        console.warn("[debounce] callback threw:", e);
      }
    }, wait);
  };

  debounced.cancel = () => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };

  return debounced;
}

/**
 * A more robust debounce that compensates for timer drift by re-scheduling
 * if the callback fires too early. Preserves `this` context and arguments.
 *
 * The returned function exposes a `.cancel()` method.
 *
 * This matches the react-hn `cancellableDebounce` implementation used in
 * StoryCommentThreadStore for count-changed and save callbacks.
 *
 * @param {Function} fn   - The function to debounce.
 * @param {number}   wait - Delay in milliseconds.
 * @returns {Function & { cancel: () => void }} Debounced function.
 */
export function cancellableDebounce(fn, wait) {
  let timeoutId = null;
  let lastCallTime = 0;
  let savedArgs = null;
  let savedThis = null;

  function later() {
    const elapsed = Date.now() - lastCallTime;
    if (elapsed < wait) {
      // Timer fired early (clock drift) — reschedule for the remainder.
      timeoutId = setTimeout(later, wait - elapsed);
    } else {
      timeoutId = null;
      try {
        fn.apply(savedThis, savedArgs);
      } catch (e) {
        console.warn("[cancellableDebounce] callback threw:", e);
      }
      savedArgs = null;
      savedThis = null;
    }
  }

  /** @type {Function & { cancel: () => void }} */
  const debounced = function (...args) {
    savedArgs = args;
    savedThis = this;
    lastCallTime = Date.now();

    if (timeoutId === null) {
      timeoutId = setTimeout(later, wait);
    }
  };

  debounced.cancel = () => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    savedArgs = null;
    savedThis = null;
  };

  return debounced;
}

/**
 * Simple pluralisation helper.
 *
 * Can be called in two modes:
 *
 * 1. **Suffix mode** — `pluralise(n)` returns `''` when `n === 1`, `'s'`
 *    otherwise.  Useful for appending: `${count} comment${pluralise(count)}`.
 *
 * 2. **Word mode** — `pluralise(n, singular)` or `pluralise(n, singular, plural)`
 *    returns the appropriate full word.
 *    Example: `pluralise(3, 'comment')` → `'comments'`
 *             `pluralise(1, 'child', 'children')` → `'child'`
 *
 * @param {number}  n               - The count to check.
 * @param {string}  [singular]      - Singular form of the word.
 * @param {string}  [plural]        - Explicit plural form (defaults to `singular + 's'`).
 * @returns {string} The pluralised result.
 */
export function pluralise(n, singular, plural) {
  // Suffix-only mode: pluralise(3) → 's', pluralise(1) → ''
  if (singular === undefined) {
    return n === 1 ? "" : "s";
  }

  const p = plural !== undefined ? plural : `${singular}s`;
  return n === 1 ? singular : p;
}

/**
 * Extract the display hostname from a URL string.
 *
 * Strips the leading `www.` prefix for cleaner display.
 * Returns an empty string for falsy or unparseable input.
 *
 * @param {string} url - A full URL (e.g. `'https://www.example.com/page'`).
 * @returns {string} The hostname without `www.` (e.g. `'example.com'`), or `''`.
 *
 * @example
 *   parseHost('https://www.github.com/foo') // → 'github.com'
 *   parseHost('not a url')                  // → ''
 *   parseHost(null)                         // → ''
 */
export function parseHost(url) {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Clamp a number between a minimum and maximum value.
 *
 * @param {number} value - The value to clamp.
 * @param {number} min   - Lower bound.
 * @param {number} max   - Upper bound.
 * @returns {number} The clamped value.
 */
export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Shallow-compare two plain objects for equality.
 * Returns `true` if both have the same own keys with `===` equal values.
 *
 * @param {Object} a
 * @param {Object} b
 * @returns {boolean}
 */
export function shallowEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}
