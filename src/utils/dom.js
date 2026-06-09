/**
 * Utilities for DOM creation and manipulation.
 *
 * Lightweight helpers used across the vanilla-hn app to:
 *  - Create elements with attributes, props, dataset, styles, and event listeners
 *  - Query and operate on DOM nodes
 *  - Safely create fragments from HTML strings (uses native Sanitizer when available)
 *  - Small helper for formatting relative times (basic replacement for a separate time.js)
 *
 * The API is intentionally small and dependency-free.
 */

/**
 * Create an element with convenient options and children.
 *
 * Examples:
 *   create('div', { attrs: { id: 'x' }, style: { color: 'red' } }, 'hello')
 *   create('button', { events: { click: onClick }, attrs: { type: 'button' } }, 'Click')
 *
 * Options:
 *  - attrs: { [name]: value } (attributes set via setAttribute; boolean false removes attr)
 *  - props: { [prop]: value } (set directly on the element)
 *  - dataset: { [key]: value } (sets dataset.key = value)
 *  - style: { [propName]: value } (applies inline styles)
 *  - events: { [eventName]: handler } (calls addEventListener)
 *  - html: string (uses Element.setHTML() when available, with template fallback)
 *
 * @param {string} tag
 * @param {Object} [options]
 * @param {...(Node|string|number)} children
 * @returns {HTMLElement}
 */
export function create(tag, options = {}, ...children) {
  const el = document.createElement(tag);

  const {
    attrs = {},
    props = {},
    dataset = {},
    style = {},
    events = {},
    html,
  } = options;

  // attributes
  for (const [name, value] of Object.entries(attrs)) {
    if (value === false || value == null) {
      // remove falsy/explicit false attributes
      try {
        el.removeAttribute(name);
      } catch (e) {
        /* ignore */
      }
    } else if (value === true) {
      // boolean attribute (present)
      el.setAttribute(name, "");
    } else {
      el.setAttribute(name, String(value));
    }
  }

  // properties
  for (const [k, v] of Object.entries(props)) {
    try {
      el[k] = v;
    } catch (e) {
      // If the property can't be assigned, ignore
    }
  }

  // dataset
  for (const [k, v] of Object.entries(dataset)) {
    if (v == null) continue;
    el.dataset[k] = String(v);
  }

  // styles
  for (const [k, v] of Object.entries(style)) {
    // allow numeric values to be used directly for CSS variables or numeric props
    try {
      el.style[k] = v;
    } catch (e) {
      // ignore invalid style keys
    }
  }

  // events
  for (const [evt, handler] of Object.entries(events)) {
    if (typeof handler === "function") {
      el.addEventListener(evt, handler);
    }
  }

  // html shortcut: prefer the platform Sanitizer-backed setHTML() API when
  // available, then fall back to inert template parsing for older browsers.
  if (typeof html === "string") {
    setSafeHTML(el, html);
  } else {
    // append children
    appendChildren(el, children);
  }

  return el;
}

/**
 * Set HTML content using the platform HTML Sanitizer API when available.
 *
 * The current HTML Sanitizer API exposes `Element.setHTML()` as the safe,
 * browser-maintained insertion primitive. Older browsers keep the previous
 * inert-template path, which matches the app's existing behavior for HN's
 * pre-sanitized Firebase HTML while avoiding direct `innerHTML` writes into
 * live DOM nodes.
 *
 * @param {Element} el
 * @param {string} html
 * @returns {Element}
 */
export function setSafeHTML(el, html) {
  if (!el) return el;
  const source = html == null ? "" : String(html);

  if (typeof el.setHTML === "function") {
    try {
      el.setHTML(source);
      return el;
    } catch (e) {
      /* fall back to template parsing */
    }
  }

  while (el.firstChild) el.removeChild(el.firstChild);
  const tpl = document.createElement("template");
  tpl.innerHTML = source;
  el.appendChild(tpl.content);
  return el;
}

/**
 * Append a list of children (strings -> text nodes, numbers -> text nodes, nodes -> nodes)
 * @param {HTMLElement} parent
 * @param {Array} children
 */
export function appendChildren(parent, children) {
  for (const child of children) {
    if (child == null) continue;
    if (child instanceof Node) {
      parent.appendChild(child);
    } else if (typeof child === "string" || typeof child === "number") {
      parent.appendChild(document.createTextNode(String(child)));
    } else if (Array.isArray(child)) {
      appendChildren(parent, child);
    } else {
      // an object (e.g. returned from another helper) - stringify as fallback
      parent.appendChild(document.createTextNode(String(child)));
    }
  }
}

/**
 * Query a single element matching the given CSS selector.
 *
 * @param {string} selector  CSS selector string.
 * @param {Element|Document} [root=document]  Root element to search within.
 * @returns {Element|null}
 */
export const qs = (selector, root = document) => {
  return root.querySelector(selector);
};

/**
 * Query all elements matching the given CSS selector, returned as an Array.
 *
 * @param {string} selector  CSS selector string.
 * @param {Element|Document} [root=document]  Root element to search within.
 * @returns {Element[]}
 */
export const qsa = (selector, root = document) => {
  return Array.from(root.querySelectorAll(selector));
};

/**
 * Attach an event listener and return an unsubscribe function that removes it.
 *
 * @param {EventTarget} el
 * @param {string} eventName
 * @param {Function} handler
 * @param {AddEventListenerOptions|boolean} [options]
 * @returns {Function} unsubscribe – call to remove the listener.
 */
export function on(el, eventName, handler, options) {
  el.addEventListener(eventName, handler, options);
  return () => el.removeEventListener(eventName, handler, options);
}

/**
 * Remove an event listener (thin wrapper around `removeEventListener`).
 *
 * @param {EventTarget} el
 * @param {string} eventName
 * @param {Function} handler
 * @param {EventListenerOptions|boolean} [options]
 */
export function off(el, eventName, handler, options) {
  el.removeEventListener(eventName, handler, options);
}

/**
 * Delegate an event from a root element to descendants matching a CSS selector.
 *
 * Walks up the DOM from `event.target` to `root` looking for an element that
 * matches `selector`. When found, `handler` is invoked with `(event, matchedEl)`.
 *
 * Example:
 *   delegate(listEl, 'click', 'a.item-link', ev => { ... })
 *
 * @param {HTMLElement} root      The element on which the listener is attached.
 * @param {string}      eventName The DOM event name (e.g. `'click'`).
 * @param {string}      selector  A CSS selector to match against descendant elements.
 * @param {Function}    handler   Callback invoked with `(event, matchedElement)`.
 * @returns {Function}  unsubscribe – call to remove the delegated listener.
 */
export function delegate(root, eventName, selector, handler) {
  if (!root) return () => {};
  const listener = (ev) => {
    let el = ev.target;
    while (el && el !== root) {
      if (el.matches && el.matches(selector)) {
        try {
          handler.call(el, ev, el);
        } catch (err) {
          // swallow errors from handlers to avoid breaking other delegated listeners
          console.error("delegate handler error", err);
        }
        return;
      }
      el = el.parentElement;
    }
  };
  root.addEventListener(eventName, listener);
  return () => root.removeEventListener(eventName, listener);
}

/**
 * Replace the children of an element (fast)
 * Uses replaceChildren if available.
 * @param {Element} el
 * @param {...(Node|string|number)} nodes
 */
export function replaceChildren(el, ...nodes) {
  if (typeof el.replaceChildren === "function") {
    el.replaceChildren(...nodes);
  } else {
    // fallback
    while (el.firstChild) el.removeChild(el.firstChild);
    appendChildren(el, nodes);
  }
}

/**
 * Remove all children
 * @param {Element} el
 */
export function empty(el) {
  if (!el) return;
  replaceChildren(el);
}

/**
 * Create a DocumentFragment from an HTML string.
 * Useful to batch-insert markup.
 *
 * Note: this does not sanitize the provided HTML. Only use with trusted content
 * or sanitize before calling.
 *
 * @param {string} html
 * @returns {DocumentFragment}
 */
export function fragmentFromHTML(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  return tpl.content;
}

/**
 * Escape text for safe insertion into text nodes / attributes
 * @param {string} str
 * @returns {string}
 */
export function escapeHTML(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Add one or more CSS class names to an element.
 *
 * @param {Element} el
 * @param {...string} classes
 */
export function addClass(el, ...classes) {
  if (!el || !el.classList) return;
  el.classList.add(...classes.filter(Boolean));
}

/**
 * Remove one or more CSS class names from an element.
 *
 * @param {Element} el
 * @param {...string} classes
 */
export function removeClass(el, ...classes) {
  if (!el || !el.classList) return;
  el.classList.remove(...classes.filter(Boolean));
}

/**
 * Toggle a CSS class on an element.
 *
 * @param {Element} el
 * @param {string} className
 * @param {boolean} [force]
 * @returns {boolean} `true` if the class is now present, `false` otherwise.
 */
export function toggleClass(el, className, force) {
  if (!el || !el.classList) return;
  return el.classList.toggle(className, force);
}

/**
 * Simple button factory (small convenience)
 * @param {string} label
 * @param {Object} [opts]
 * @returns {HTMLButtonElement}
 */
export function button(label, opts = {}) {
  const { attrs = {}, events = {}, style = {}, props = {} } = opts;
  return create(
    "button",
    { attrs: { type: "button", ...attrs }, events, style, props },
    label,
  );
}

/**
 * Small helper to set multiple attributes quickly.
 * If a value is false or null the attribute is removed.
 *
 * @param {Element} el
 * @param {Object} attrs
 */
export function setAttrs(el, attrs = {}) {
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) {
      try {
        el.removeAttribute(k);
      } catch (e) {
        /* ignore */
      }
    } else if (v === true) {
      el.setAttribute(k, "");
    } else {
      el.setAttribute(k, String(v));
    }
  }
}

/* -------------------------
   Tiny time helpers (minimal replacement for a dedicated time.js)
   ------------------------- */

/**
 * Given a Date | timestamp (ms | seconds) returns a human-friendly relative
 * time string like "3h ago", "2 days ago", or "just now".
 *
 * Uses `Intl.RelativeTimeFormat` when available; falls back to simple
 * English strings such as `"5 minutes ago"` or `"in 2 hours"`.
 *
 * @param {Date|number|string} when  The point in time to describe. Accepts a
 *   `Date`, a numeric timestamp in milliseconds or seconds (auto-detected via
 *   heuristic), or a date-parseable string.
 * @param {Object} [opts]
 * @param {number} [opts.now]  Current timestamp in milliseconds (override for
 *   testing or server time).
 * @returns {string}  A human-readable relative time description, or an empty
 *   string when `when` is nullish.
 */
export function formatRelativeTime(when, opts = {}) {
  if (when == null) return "";
  const now = typeof opts.now === "number" ? opts.now : currentEpochMilliseconds();

  let time;
  if (isTemporalInstant(when)) time = Number(when.epochMilliseconds);
  else if (when instanceof Date) time = when.getTime();
  else {
    // try to parse numeric-like input
    const n = Number(when);
    if (!Number.isNaN(n)) {
      // heuristics: if value looks like seconds (<= 1e10) treat as seconds
      time = n > 1e12 ? n : n > 1e10 ? n : n * 1000;
    } else {
      // attempt Date parse
      const parsed = Date.parse(String(when));
      time = Number.isNaN(parsed) ? now : parsed;
    }
  }

  const diffMs = time - now;
  const diffSeconds = Math.round(diffMs / 1000);
  const absSeconds = Math.abs(diffSeconds);

  const units = [
    { name: "year", secs: 60 * 60 * 24 * 365 },
    { name: "month", secs: 60 * 60 * 24 * 30 },
    { name: "day", secs: 60 * 60 * 24 },
    { name: "hour", secs: 60 * 60 },
    { name: "minute", secs: 60 },
    { name: "second", secs: 1 },
  ];

  for (const u of units) {
    if (absSeconds >= u.secs || u.name === "second") {
      const val = Math.round(diffSeconds / u.secs);
      // Use Intl.RelativeTimeFormat when available
      if (
        typeof Intl !== "undefined" &&
        typeof Intl.RelativeTimeFormat === "function"
      ) {
        try {
          const rtf = new Intl.RelativeTimeFormat(undefined, {
            numeric: "auto",
          });
          return rtf.format(val, u.name);
        } catch (e) {
          // fall through
        }
      }
      // Fallback english-style
      if (val === 0) return "just now";
      const absVal = Math.abs(val);
      const unitLabel = absVal === 1 ? u.name : `${u.name}s`;
      return val > 0
        ? `in ${absVal} ${unitLabel}`
        : `${absVal} ${unitLabel} ago`;
    }
  }
}

function currentEpochMilliseconds() {
  if (globalThis.Temporal?.Now?.instant) {
    try {
      return Number(globalThis.Temporal.Now.instant().epochMilliseconds);
    } catch (e) {
      /* fall back */
    }
  }
  return Date.now();
}

function isTemporalInstant(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof value.epochMilliseconds === "number" &&
      typeof value.epochNanoseconds === "bigint",
  );
}

/**
 * Convenience: given a unix timestamp in seconds (common in HN payloads),
 * returns a human-friendly relative time string via {@link formatRelativeTime}.
 *
 * @param {number} unixSeconds  Unix epoch timestamp in **seconds**.
 * @returns {string}  A human-readable relative time description, or an empty
 *   string when `unixSeconds` is nullish.
 */
export function timeAgoFromUnix(unixSeconds) {
  if (unixSeconds == null) return "";
  const ms = Number(unixSeconds) * 1000;
  return formatRelativeTime(ms);
}
