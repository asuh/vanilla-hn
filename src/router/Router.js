/**
 * Router.js
 *
 * A small, dependency-free client-side router used by vanilla-hn.
 *
 * Features:
 * - Register routes with string paths or regular expressions matched against
 *   `pathname + search` (e.g. `/item/123`, `/newest?page=2`, `/`).
 * - Navigation API (window.navigation) used where available; falls back to
 *   popstate + delegated click handler.
 * - Support async view factories (handlers that return a View instance or an HTMLElement).
 * - Automatic cleanup of the previous view via a `cleanup()` method if present.
 * - Not-found handler support.
 * - Simple navigate() helper.
 * - Stale-request cancellation via AbortSignal (Navigation API) or internal
 *   request-id counter (fallback path).
 *
 * Usage:
 *   const router = new Router({ mountPoint: '#app' });
 *   router.register(/^\/item\/(\d+)$/, async (match) => {
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

import {
  getAppBasePath,
  isAppURL,
  normalizeBasePath,
  toAppPath,
  toRouteTarget,
} from "../utils/app-url.js";

/**
 * A small, dependency-free client-side router.
 *
 * Supports regex and string route patterns matched against pathname+search,
 * async view factories, stale-request cancellation, Navigation API integration,
 * popstate + delegated-click fallback, View Transitions API integration,
 * and accessibility focus management after mount.
 *
 * @class Router
 */

function isRegex(val) {
  return Object.prototype.toString.call(val) === "[object RegExp]";
}

export class Router {
  /**
   * @param {Object} [options]
   * @param {string} [options.mountPoint] CSS selector for the container where views are mounted. Defaults to '#app'.
   */
  constructor(options = {}) {
    this.mountPointSelector = options.mountPoint || "#app";
    this.basePath = normalizeBasePath(options.basePath || getAppBasePath());
    this.routes = [];
    this.notFoundHandler = null;
    this.currentView = null;
    this.currentRouteInfo = null;
    this._running = false;

    // Used in the popstate/click fallback path to discard stale async loads.
    // When the Navigation API is available its own AbortSignal handles this.
    this._routeRequestId = 0;

    // Bound listener references stored so they can be removed in stop().
    this._onPopState = this._onPopState.bind(this);
    this._onDocClick = this._onDocClick.bind(this);
    this._onNavigate = this._onNavigate.bind(this);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Register a route.
   *
   * - `pattern` may be a RegExp or a string.
   *   - RegExp is matched against `pathname + search`
   *     (e.g. `/^\/item\/(\d+)$/`). Legacy patterns that begin with `#?`
   *     (e.g. `/^#?\/item\/(\d+)$/`) continue to work because the `#?`
   *     group simply never matches when tested against a plain pathname.
   *   - String is compared with strict equality against `pathname + search`.
   * - `handler` may be:
   *    - a function taking (matchOrPath) and returning a view or Promise<view>
   *    - a View instance (in which case the route will always mount that view)
   *
   * @param {RegExp|string} pattern   Route pattern to match against pathname+search.
   * @param {Function|Object} handler A function returning a view (or Promise<view>), or a view instance.
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
   * @param {Function} handler  Handler invoked with the unmatched path string.
   * @returns {Router} this instance for chaining.
   */
  setNotFound(handler) {
    this.notFoundHandler = handler;
    return this;
  }

  /**
   * Programmatic navigation. Triggers route handling for `path`.
   *
   * Uses `window.navigation.navigate()` where available so the Navigation API
   * manages the history entry and fires its `navigate` event. Falls back to
   * `history.pushState` + `_handleUrl`.
   *
   * @param {string} path  The target path, e.g. '/item/123' or '/newest?page=2'.
   */
  navigate(path) {
    const url = new URL(toAppPath(path, this.basePath), location.href);
    if (window.navigation) {
      window.navigation.navigate(url.href);
    } else {
      if (location.pathname + location.search !== url.pathname + url.search) {
        history.pushState({}, "", url.pathname + url.search);
      }
      this._handleUrl(url);
    }
  }

  /**
   * Start the router.
   *
   * Wires up the Navigation API listener when available; otherwise falls back
   * to a `popstate` listener on `window` plus a delegated `click` listener on
   * `document`. Then immediately handles the current URL so the initial view
   * is mounted on page load (the Navigation API does NOT fire `navigate` for
   * the first load).
   */
  start() {
    if (this._running) return;
    this._running = true;

    if (window.navigation) {
      // Navigation API path ─────────────────────────────────────────────────
      window.navigation.addEventListener("navigate", this._onNavigate);
    } else {
      // Fallback path ────────────────────────────────────────────────────────
      window.addEventListener("popstate", this._onPopState, false);
      document.addEventListener("click", this._onDocClick, false);
    }

    // Handle the current URL immediately for the initial page load.
    this._handleUrl(new URL(location.href));
  }

  /**
   * Stop the router and remove all event listeners added in `start()`.
   *
   * Does not remove the currently mounted view — call `cleanup()` on the
   * view manually if you need to tear it down.
   */
  stop() {
    if (!this._running) return;
    this._running = false;

    if (window.navigation) {
      window.navigation.removeEventListener("navigate", this._onNavigate);
    } else {
      window.removeEventListener("popstate", this._onPopState, false);
      document.removeEventListener("click", this._onDocClick, false);
    }
  }

  /**
   * Public compatibility shim.
   *
   * Any code that previously called `router.handleRoute()` directly will
   * continue to work. Delegates to `_handleUrl` using the current location.
   *
   * @returns {Promise<void>}
   */
  handleRoute() {
    return this._handleUrl(new URL(location.href));
  }

  /**
   * Convenience: returns current route info (handler, pattern, last path).
   *
   * @returns {Object|null} The route info object for the currently mounted view,
   *   or `null` if no route is active.
   */
  getCurrentRoute() {
    return this.currentRouteInfo;
  }

  // ---------------------------------------------------------------------------
  // Private event handlers
  // ---------------------------------------------------------------------------

  /** Navigation API `navigate` event handler. */
  _onNavigate(evt) {
    // Let the browser handle cross-origin navigations, hash-only jumps,
    // and download requests.
    if (!evt.canIntercept) return;
    if (evt.hashChange) return;
    if (evt.downloadRequest !== null) return;

    const url = new URL(evt.destination.url);
    if (url.origin !== location.origin || !isAppURL(url, this.basePath)) return;

    const signal = evt.signal;

    evt.intercept({
      handler: async () => {
        await this._handleUrl(url, signal);
      },
    });
  }

  /** popstate fallback — fired on back/forward navigation. */
  _onPopState() {
    this._handleUrl(new URL(location.href));
  }

  /**
   * Delegated click handler fallback.
   *
   * Intercepts same-origin link clicks, calls `history.pushState`, and
   * invokes `_handleUrl`. Fragment-only navigation, downloads, and
   * `target="_blank"` links are passed through to the browser as normal.
   *
   * @param {MouseEvent} evt
   */
  _onDocClick(evt) {
    // Ignore modified clicks (new tab / open in background, etc.)
    if (evt.ctrlKey || evt.metaKey || evt.shiftKey || evt.altKey) return;
    if (evt.button !== 0) return;

    const anchor = evt.target.closest("a[href]");
    if (!anchor) return;

    const url = new URL(anchor.href, location.href);

    // Only intercept same-origin links.
    if (url.origin !== location.origin) return;
    if (!isAppURL(url, this.basePath)) return;
    if (anchor.hasAttribute("download")) return;
    if (anchor.target === "_blank") return;

    // Skip fragment-only navigations (pathname + search are identical, only
    // hash differs) — let the browser handle the scroll/focus naturally.
    if (
      url.pathname === location.pathname &&
      url.search === location.search &&
      url.hash !== location.hash
    ) {
      return;
    }

    evt.preventDefault();

    if (location.pathname + location.search !== url.pathname + url.search) {
      history.pushState({}, "", url.pathname + url.search);
    }

    this._handleUrl(url);
  }

  // ---------------------------------------------------------------------------
  // Core routing logic
  // ---------------------------------------------------------------------------

  /**
   * Match `url` against registered routes and mount the first matching view
   * into the mount point.
   *
   * This method is async-safe:
   * - When called from the Navigation API path an `AbortSignal` is passed in;
   *   stale navigations are detected via `signal.aborted`.
   * - In the fallback path an internal `_routeRequestId` counter is used.
   *
   * The DOM swap can optionally be wrapped in `document.startViewTransition()`
   * — see TODO below.
   *
   * @param {URL}          url     The URL to route to.
   * @param {AbortSignal}  [signal] AbortSignal from a NavigateEvent (optional).
   * @returns {Promise<void>}
   */
  async _handleUrl(url, signal) {
    // Stale-request guard ─────────────────────────────────────────────────────
    // Navigation API: use the browser-provided signal.
    // Fallback: increment and capture the counter.
    const requestId = ++this._routeRequestId;

    const isStale = () => {
      if (signal) return signal.aborted;
      return requestId !== this._routeRequestId;
    };

    // The string we test patterns against: pathname + search
    // e.g. "/", "/newest", "/item/123", "/newest?page=2"
    const target = toRouteTarget(url, this.basePath);
    if (target == null) return;

    // Find first matching route ───────────────────────────────────────────────
    for (const route of this.routes) {
      if (isRegex(route.pattern)) {
        const match = target.match(route.pattern);
        if (match) {
          try {
            const view = await this._invokeHandler(route.handler, match);
            if (isStale()) return;
            await this._mountView(view, { route, match, path: target });
            return;
          } catch (err) {
            if (isStale()) return;
            console.error("Router: error in route handler:", err);
            break;
          }
        }
      } else {
        // String pattern — exact match against target path.
        if (target === String(route.pattern)) {
          try {
            const view = await this._invokeHandler(route.handler, target);
            if (isStale()) return;
            await this._mountView(view, {
              route,
              match: target,
              path: target,
            });
            return;
          } catch (err) {
            if (isStale()) return;
            console.error("Router: error in route handler:", err);
            break;
          }
        }
      }
    }

    if (isStale()) return;

    // No route matched — invoke the not-found handler if registered. ──────────
    if (this.notFoundHandler) {
      try {
        const view = await this._invokeHandler(this.notFoundHandler, target);
        if (isStale()) return;
        await this._mountView(view, {
          route: null,
          match: null,
          path: target,
          notFound: true,
        });
        return;
      } catch (err) {
        if (isStale()) return;
        console.error("Router: error in notFound handler:", err);
      }
    }

    // Nothing to show — clear the mount point.
    this._clearMount();
  }

  // ---------------------------------------------------------------------------
  // View lifecycle helpers (unchanged from original)
  // ---------------------------------------------------------------------------

  /**
   * Internal: calls a handler which may be:
   *  - a function (sync or async) receiving (matchOrPath)
   *  - a view instance or HTMLElement (returned as-is)
   *
   * @param {Function|Object|HTMLElement} handler
   * @param {RegExpMatchArray|string}     matchOrPath
   * @returns {Promise<*>}
   */
  async _invokeHandler(handler, matchOrPath) {
    if (typeof handler === "function") {
      return await handler(matchOrPath);
    }
    // Already a view or element — return directly.
    return handler;
  }

  /**
   * Mount the provided view into the mount point. Performs cleanup of the
   * previous view first.
   *
   * `view` may be:
   *  - HTMLElement
   *  - object with `render()` → HTMLElement
   *  - object with `element` property (HTMLElement)
   *
   * `routeInfo` is stored as `currentRouteInfo` for inspection via
   * `getCurrentRoute()`.
   *
   * Performs a direct DOM swap.
   *
   * @param {HTMLElement|Object} view
   * @param {Object}             [routeInfo]
   * @returns {Promise<void>}
   */
  async _mountView(view, routeInfo = {}) {
    // Cleanup previous view ───────────────────────────────────────────────────
    try {
      if (this.currentView && typeof this.currentView.cleanup === "function") {
        try {
          const cleanupResult = this.currentView.cleanup();
          if (cleanupResult && typeof cleanupResult.then === "function") {
            // Don't await — fire-and-forget, but swallow errors.
            cleanupResult.catch((err) => console.warn("Router: async cleanup() error:", err));
          }
        } catch (err) {
          console.warn("Router: error in previous view.cleanup():", err);
        }
      }
    } finally {
      this._clearMount();
      this.currentView = null;
      this.currentRouteInfo = null;
    }

    // Resolve element from the view value ────────────────────────────────────
    let el = null;
    let viewObj = null;

    if (view instanceof HTMLElement) {
      el = view;
      viewObj = null;
    } else if (view && typeof view === "object") {
      if (typeof view.render === "function") {
        try {
          el = view.render();
        } catch (err) {
          console.error("Router: view.render() threw an error:", err);
          throw err;
        }
        viewObj = view;
      } else if (view.element instanceof HTMLElement) {
        el = view.element;
        viewObj = view;
      } else {
        throw new Error(
          "Router: mounted view must be an HTMLElement or an object with render()/element.",
        );
      }
    } else {
      throw new Error("Router: invalid view returned from handler");
    }

    if (!(el instanceof HTMLElement)) {
      throw new Error("Router: view.render() must return an HTMLElement");
    }

    // Stamp the element so _clearMount() can identify it safely.
    el.setAttribute("data-router-mounted", "true");

    // DOM swap ────────────────────────────────────────────────────────────────
    const mountEl = document.querySelector(this.mountPointSelector) || document.body;

    const applyDOM = () => {
      this._clearMount();
      mountEl.appendChild(el);
    };

    applyDOM();

    // Persist references for the next navigation cycle.
    this.currentView = viewObj || el;
    this.currentRouteInfo = routeInfo;

    // Post-mount hook ─────────────────────────────────────────────────────────
    if (viewObj && typeof viewObj.attachEventListeners === "function") {
      try {
        viewObj.attachEventListeners();
      } catch (err) {
        console.warn("Router: error in view.attachEventListeners():", err);
      }
    }
  }

  /**
   * Remove all router-mounted children from the mount point.
   *
   * Only children that carry the `data-router-mounted` attribute are removed
   * so that any static content inside the mount container is left untouched.
   */
  _clearMount() {
    const mountEl = document.querySelector(this.mountPointSelector) || document.body;
    if (!mountEl) return;

    for (const child of Array.from(mountEl.children)) {
      try {
        if (child.getAttribute && child.getAttribute("data-router-mounted") === "true") {
          mountEl.removeChild(child);
        }
      } catch (err) {
        console.warn("Router: error while clearing mount point:", err);
      }
    }
  }
}

export default Router;
