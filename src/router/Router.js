/**
 * Router.js
 *
 * A small, dependency-free hash-based router used by vanilla-hn.
 *
 * Features:
 * - Register routes with string paths or regular expressions.
 * - Support async view factories (handlers that return a View instance or an HTMLElement).
 * - Automatic cleanup of the previous view via a `cleanup()` method if present.
 * - Not-found handler support.
 * - Simple navigate() helper.
 *
 * Usage:
 *   const router = new Router({ mountPoint: '#app' });
 *   router.register(/^#?\/item\/(\d+)$/, async (match) => {
 *     // match is RegExpMatchArray
 *     return new ItemView({ id: match[1] });
 *   });
 *   router.start();
 *
 * Views:
 *   A "view" can be:
 *    - an HTMLElement (will be mounted as-is)
 *    - an object with a `render()` method that returns an HTMLElement
 *    - an object with `element` property (HTMLElement)
 *
 *   If a view exposes `cleanup()` it will be called when the router removes it.
 */

/**
 * A small, dependency-free hash-based router.
 *
 * Supports regex and string route patterns, async view factories,
 * stale-request cancellation, View Transitions API integration,
 * and accessibility focus management after mount.
 *
 * @class Router
 */

function isRegex(val) {
  return Object.prototype.toString.call(val) === "[object RegExp]";
}

function ensureLeadingHash(hash) {
  if (!hash) return "#/";
  return hash.startsWith("#") ? hash : `#${hash}`;
}

export class Router {
  /**
   * @param {Object} [options]
   * @param {string} [options.mountPoint] CSS selector for the container where views are mounted. Defaults to '#app'.
   * @param {boolean} [options.useHashChange] Whether to listen to hashchange (default true).
   */
  constructor(options = {}) {
    this.mountPointSelector = options.mountPoint || "#app";
    this.useHashChange = options.useHashChange !== false;
    this.routes = [];
    this.notFoundHandler = null;
    this.currentView = null;
    this.currentRouteInfo = null;
    this._running = false;
    this._routeRequestId = 0; // used to ignore stale async loads
    this._onHashChange = this._onHashChange.bind(this);
  }

  /**
   * Register a route.
   * - pattern may be a RegExp or a string. If string it will be compared to location.hash (exact equality).
   * - handler may be:
   *    - a function taking (matchOrHash) and returning a view or Promise<view>
   *    - a View instance (in which case the route will always mount that view)
   *
   * @param {RegExp|string} pattern  Route pattern to match against location.hash.
   * @param {Function|Object} handler  A function returning a view (or Promise<view>), or a view instance.
   * @returns {Router} this instance for chaining.
   */
  register(pattern, handler) {
    if (!pattern) throw new Error("Router.register: pattern is required");
    if (!handler) throw new Error("Router.register: handler is required");

    this.routes.push({ pattern, handler });
    return this;
  }

  /**
   * Set a not-found handler (used when no route matches).
   * The handler follows the same conventions as register handlers.
   *
   * @param {Function} handler  Handler invoked with the unmatched hash string.
   * @returns {Router} this instance for chaining.
   */
  setNotFound(handler) {
    this.notFoundHandler = handler;
    return this;
  }

  /**
   * Programmatic navigation. Updates the hash and triggers route handling.
   *
   * @param {string} hash  The target hash, e.g. '#/item/123' or '/item/123' (will be normalized with a leading '#').
   */
  navigate(hash) {
    const normalized = ensureLeadingHash(hash);
    if (location.hash === normalized) {
      // Still handle route in case the view wants to refresh
      this.handleRoute();
    } else {
      location.hash = normalized;
      // Hashchange event will call handleRoute if router is running
    }
  }

  /**
   * Start the router.
   *
   * Sets up a `hashchange` listener on `window` (unless `useHashChange` was
   * disabled) and immediately handles the current route so the initial view
   * is mounted on page load.
   */
  start() {
    if (this._running) return;
    if (this.useHashChange) {
      window.addEventListener("hashchange", this._onHashChange, false);
    }
    // Handle current route synchronously (but view may load asynchronously).
    this.handleRoute();
    this._running = true;
  }

  /**
   * Stop the router and remove the `hashchange` listener.
   *
   * Does not remove the currently mounted view — call `cleanup()` on the
   * view manually if you need to tear it down as well.
   */
  stop() {
    if (!this._running) return;
    if (this.useHashChange) {
      window.removeEventListener("hashchange", this._onHashChange, false);
    }
    this._running = false;
  }

  _onHashChange() {
    this.handleRoute();
  }

  /**
   * Match the current `location.hash` against registered routes and mount the
   * first matching view into the mount point.
   *
   * This method is async-safe: each call increments an internal request counter
   * so that stale async loads from earlier navigations are silently discarded.
   * When the View Transitions API is available the DOM swap is wrapped in
   * `document.startViewTransition()` for a cross-fade effect. After mounting,
   * the view's `focus()` hook (or a fallback) is called for accessibility.
   *
   * @returns {Promise<void>}
   */
  async handleRoute() {
    const requestId = ++this._routeRequestId;
    const rawHash = ensureLeadingHash(location.hash || "#/");
    // Find first matching route
    for (const route of this.routes) {
      if (isRegex(route.pattern)) {
        const match = rawHash.match(route.pattern);
        if (match) {
          try {
            const viewOrPromise = await this._invokeHandler(
              route.handler,
              match,
            );
            if (this._isStaleRequest(requestId)) return;
            await this._mountView(viewOrPromise, {
              route,
              match,
              hash: rawHash,
            });
            return;
          } catch (err) {
            console.error("Error loading route handler:", err);
            // continue to not-found fallback
            break;
          }
        }
      } else {
        // string match (normalize)
        const pat = route.pattern;
        const patHash = ensureLeadingHash(String(pat));
        if (rawHash === patHash) {
          try {
            const viewOrPromise = await this._invokeHandler(
              route.handler,
              rawHash,
            );
            if (this._isStaleRequest(requestId)) return;
            await this._mountView(viewOrPromise, {
              route,
              match: rawHash,
              hash: rawHash,
            });
            return;
          } catch (err) {
            console.error("Error loading route handler:", err);
            break;
          }
        }
      }
    }

    // No route matched -> not-found
    if (this.notFoundHandler) {
      try {
        const viewOrPromise = await this._invokeHandler(
          this.notFoundHandler,
          rawHash,
        );
        if (this._isStaleRequest(requestId)) return;
        await this._mountView(viewOrPromise, {
          route: null,
          match: null,
          hash: rawHash,
          notFound: true,
        });
        return;
      } catch (err) {
        console.error("Error loading notFound handler:", err);
      }
    }

    // If no not-found handler provided, clear mount point
    this._clearMount();
  }

  _isStaleRequest(requestId) {
    return requestId !== this._routeRequestId;
  }

  /**
   * Internal: calls a handler which may be:
   *  - a function (sync/async)
   *  - a view instance
   *  - an HTMLElement
   */
  async _invokeHandler(handler, matchOrHash) {
    if (typeof handler === "function") {
      // Handler may return a view or a Promise resolving to a view.
      return await handler(matchOrHash);
    }
    // If handler is already a view or element, return it.
    return handler;
  }

  /**
   * Mount the provided view into the mount point. Performs cleanup of previous view.
   * view may be:
   *  - HTMLElement
   *  - object with render() -> HTMLElement
   *  - object with element property (HTMLElement)
   *
   * routeInfo is an opaque object passed for debugging/possible future hooks.
   */
  async _mountView(view, routeInfo = {}) {
    // If the view is a function (factory), call it. But we handled factories in register.
    // Cleanup previous view if present
    try {
      if (this.currentView && typeof this.currentView.cleanup === "function") {
        try {
          // Allow cleanup to be async but don't await long-running operations
          const cleanupResult = this.currentView.cleanup();
          if (cleanupResult && typeof cleanupResult.then === "function") {
            // don't await — but swallow errors
            cleanupResult.catch((err) =>
              console.warn("cleanup() error (async):", err),
            );
          }
        } catch (err) {
          console.warn("Error while running previous view.cleanup():", err);
        }
      }
    } finally {
      // proceed to remove previous DOM
      this._clearMount();
      this.currentView = null;
      this.currentRouteInfo = null;
    }

    let el = null;
    let viewObj = null;

    // If view is an HTMLElement
    if (view instanceof HTMLElement) {
      el = view;
      viewObj = null;
    } else if (view && typeof view === "object") {
      // If view has render()
      if (typeof view.render === "function") {
        try {
          el = view.render();
        } catch (err) {
          console.error("View.render() threw an error:", err);
          throw err;
        }
        viewObj = view;
      } else if (view.element instanceof HTMLElement) {
        el = view.element;
        viewObj = view;
      } else {
        // Unknown shape: attempt to treat as plain node (string) or fail
        throw new Error(
          "Router: mounted view must be an HTMLElement or an object with render()/element.",
        );
      }
    } else {
      throw new Error("Router: invalid view returned from handler");
    }

    // Append to mount point
    const mountEl =
      document.querySelector(this.mountPointSelector) || document.body;
    // sanitize: ensure el is an HTMLElement
    if (!(el instanceof HTMLElement)) {
      throw new Error("Router: view.render() must return an HTMLElement");
    }
    // Attach identifying attribute for debugging
    el.setAttribute("data-router-mounted", "true");

    // The DOM swap — clear old nodes, append new view. Wrapped in a View
    // Transition when the API is available so the browser can cross-fade
    // between the outgoing and incoming views.
    const applyDOM = () => {
      this._clearMount();
      mountEl.appendChild(el);
    };

    applyDOM();

    // Save current view reference so it can be cleaned up later
    this.currentView = viewObj || el;
    this.currentRouteInfo = routeInfo;

    // Call attachEventListeners or mounted hooks if provided on the view object
    if (viewObj && typeof viewObj.attachEventListeners === "function") {
      try {
        viewObj.attachEventListeners();
      } catch (err) {
        console.warn("Error in view.attachEventListeners():", err);
      }
    }

    // After mount, a small focus/announcement step for accessibility
    try {
      // if the view exposes a focus() method, call it
      if (viewObj && typeof viewObj.focus === "function") {
        viewObj.focus();
      } else {
        // otherwise move focus to the mount point for keyboard users
        const appEl = document.querySelector(this.mountPointSelector);
        if (appEl) {
          appEl.setAttribute("tabindex", "-1");
          try {
            appEl.focus();
          } catch (e) {
            /* ignore */
          }
        }
      }
    } catch (err) {
      // non-fatal
    }

    return;
  }

  _clearMount() {
    const mountEl =
      document.querySelector(this.mountPointSelector) || document.body;
    if (!mountEl) return;
    // Remove all children that were mounted previously. We avoid removing elements
    // that don't have the data attribute in case the mount point contains other content.
    const children = Array.from(mountEl.children);
    for (const child of children) {
      try {
        // If it was mounted by this router, it will have the attribute
        if (
          child.getAttribute &&
          child.getAttribute("data-router-mounted") === "true"
        ) {
          mountEl.removeChild(child);
        } else {
          // If the mount point only holds router content, remove everything
          // (mount point default '#app' is expected to be dedicated).
          // We be conservative: only remove if mount point contains no other mounted children.
        }
      } catch (e) {
        console.warn("Error while clearing mount point:", e);
      }
    }
  }

  /**
   * Convenience: returns current route info (handler, pattern, last hash).
   *
   * @returns {Object|null} The route info object for the currently mounted view,
   *   or `null` if no route is active.
   */
  getCurrentRoute() {
    return this.currentRouteInfo;
  }
}

export default Router;
