/**
 * View.js
 *
 * Base View class for the vanilla-hn application.
 *
 * A "View" is an object responsible for producing an HTMLElement (via `render()`),
 * wiring event listeners (`attachEventListeners()`), subscribing to stores, and
 * cleaning itself up (`cleanup()`).
 *
 * The Router expects views to expose:
 *  - a `render()` method that returns an HTMLElement (synchronously is preferred)
 *  - an optional `attachEventListeners()` method called after mounting
 *  - an optional `cleanup()` method called when the view is removed
 *  - an optional `focus()` method for accessibility focus management
 *
 * This base class provides:
 *  - consistent constructor signature: `new View(context)` where `context` may
 *    include `params`, `stores`, and `services`.
 *  - a small set of DOM helpers (`createElement`) to keep view code concise.
 *  - subscription management helpers to keep unsubscribe bookkeeping centralized.
 *  - an AbortController instance available via `this.signal` for cancellable fetches.
 *
 * Derived views should extend this class and implement `render()` and any
 * other lifecycle hooks needed.
 */

export default class View {
  /**
   * @param {Object} [context]
   * @param {Object} [context.params] Route params (e.g. { id: '123' })
   * @param {Object} [context.stores] Stores collection (settingsStore, etc.)
   * @param {Object} [context.services] Service collection (HNService, etc.)
   * @param {Object} [context.options] Any additional options
   */
  constructor(context = {}) {
    const { params = {}, stores = {}, services = {}, options = {} } = context;
    this.params = params;
    this.stores = stores;
    this.services = services;
    this.options = options;

    // Internal state for the view (not persisted)
    this.state = Object.assign({}, options.initialState || {});

    // Root element returned by render() and mounted into the DOM
    this.root = null;

    // Abort controller for cancellable async operations (fetches, timeouts, etc.)
    this._abortController = new AbortController();
    this.signal = this._abortController.signal;

    // Unsubscribe functions for store listeners and event listeners
    this._unsubscribers = [];

    // Event listener bookkeeping for element-level handlers (element, event, handler)
    // stored only to facilitate cleanup if needed.
    this._elementListeners = [];

    // Flag to indicate whether attachEventListeners has been invoked
    this._listenersAttached = false;
  }

  /* ---------------------------
   * Required override
   * --------------------------- */

  /**
   * Implement this in derived views.
   * Should return a DOM node (HTMLElement) ready to mount.
   * Can be synchronous. If you must perform async work, do it before returning
   * and ensure you still return an HTMLElement for the router to mount.
   *
   * Example:
   *   render() {
   *     const el = this.createElement('div', { class: 'view' }, 'Hello');
   *     return el;
   *   }
   *
   * @returns {HTMLElement}
   */
  render() {
    throw new Error("View.render() not implemented by subclass");
  }

  /* ---------------------------
   * Mounting helpers
   * --------------------------- */

  /**
   * Mounts this view into the provided container element.
   * If the view has already been rendered, it will be removed and re-rendered.
   *
   * @param {Element} container
   * @returns {HTMLElement} the root element returned by render()
   */
  mountTo(container) {
    if (!container) throw new Error("mountTo requires a container element");

    // If a previous root exists, remove it cleanly first
    try {
      this.cleanup();
    } catch (e) {
      // non-fatal
      console.warn("View.cleanup() during mount threw:", e);
    }

    const el = this.render();
    if (!(el instanceof HTMLElement)) {
      throw new Error("View.render() must return an HTMLElement");
    }

    this.root = el;
    container.appendChild(el);

    // Allow derived classes to attach any event listeners now that elements are in the DOM
    try {
      if (typeof this.attachEventListeners === "function") {
        this.attachEventListeners();
        this._listenersAttached = true;
      }
    } catch (err) {
      console.warn("attachEventListeners threw an error:", err);
    }

    return el;
  }

  /**
   * A small focus helper. By default focuses the first tabbable element inside
   * the view's root element, falling back to the root element itself.
   *
   * The heuristic searches for the first element matching common tabbable
   * selectors (`a[href]`, `button`, `input`, `textarea`, `select`,
   * `[tabindex]` excluding `[tabindex="-1"]`). If none is found the root
   * element receives focus directly.
   */
  focus() {
    if (!this.root) return;
    // Try to find a meaningful focus target
    const selectors = 'a[href], button, input, textarea, select, [tabindex]:not([tabindex="-1"])';
    const target = this.root.querySelector(selectors);
    try {
      if (target && typeof target.focus === "function") target.focus();
      else this.root.focus?.();
    } catch (_e) {
      // ignore focus errors
    }
  }

  /* ---------------------------
   * DOM helpers
   * --------------------------- */

  /**
   * Convenience wrapper for creating elements.
   *
   * Options:
   *  - attrs: { name: value } will be set via setAttribute (true sets empty attr, false removes).
   *  - props: { name: value } will be assigned to the element object (el[name] = value).
   *  - dataset: { key: value } will be assigned to el.dataset.
   *  - style: { prop: value } will be applied as inline style.
   *  - events: { eventName: handler } will addEventListener for each event.
   *  - html: string -> Element.setHTML() when available, template fallback otherwise
   *
   * @param {string} tag        The HTML tag name (e.g. `'div'`, `'button'`).
   * @param {Object} [options]  Element configuration (attrs, props, dataset, style, events, html).
   * @param {...(Node|string)} children  Child nodes or text strings to append.
   * @returns {HTMLElement} The newly created element.
   */
  createElement(tag, options = {}, ...children) {
    const el = document.createElement(tag);
    const { attrs = {}, props = {}, dataset = {}, style = {}, events = {}, html } = options;

    // attrs
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v == null) {
        try {
          el.removeAttribute(k);
        } catch (_e) {
          /* ignore */
        }
      } else if (v === true) {
        el.setAttribute(k, "");
      } else {
        el.setAttribute(k, String(v));
      }
    }

    // props
    for (const [k, v] of Object.entries(props)) {
      try {
        el[k] = v;
      } catch (_e) {
        /* ignore */
      }
    }

    // dataset
    for (const [k, v] of Object.entries(dataset)) {
      if (v == null) continue;
      el.dataset[k] = String(v);
    }

    // style
    for (const [k, v] of Object.entries(style)) {
      try {
        el.style[k] = v;
      } catch (_e) {
        /* ignore */
      }
    }

    // events
    for (const [evt, handler] of Object.entries(events)) {
      if (typeof handler === "function") {
        el.addEventListener(evt, handler);
        // store event for cleanup
        this._elementListeners.push({ el, evt, handler });
      }
    }

    if (typeof html === "string") {
      if (typeof el.setHTML === "function") {
        try {
          el.setHTML(html);
        } catch (_e) {
          const tpl = document.createElement("template");
          tpl.innerHTML = html;
          el.appendChild(tpl.content);
        }
      } else {
        const tpl = document.createElement("template");
        tpl.innerHTML = html;
        el.appendChild(tpl.content);
      }
    } else {
      for (const child of children) {
        if (child == null) continue;
        if (child instanceof Node) el.appendChild(child);
        else el.appendChild(document.createTextNode(String(child)));
      }
    }

    return el;
  }

  /**
   * Shortcut for creating a DocumentFragment from an array of nodes and/or strings.
   *
   * @param {Array<Node|string>} nodes  Nodes or text strings to include in the fragment.
   * @returns {DocumentFragment} A new fragment containing the provided nodes.
   */
  createFragment(nodes = []) {
    const frag = document.createDocumentFragment();
    for (const node of nodes) {
      if (node == null) continue;
      if (node instanceof Node) frag.appendChild(node);
      else frag.appendChild(document.createTextNode(String(node)));
    }
    return frag;
  }

  /* ---------------------------
   * State & store helpers
   * --------------------------- */

  /**
   * Shallow merge state and optionally call onStateChange() hook.
   * @param {Object} changes
   */
  setState(changes = {}) {
    Object.assign(this.state, changes);
    if (typeof this.onStateChange === "function") {
      try {
        this.onStateChange(this.state);
      } catch (e) {
        console.warn("onStateChange error", e);
      }
    }
  }

  /**
   * Subscribe to a store. The store is expected to expose
   * `addListener(fn) → unsubscribe`, `subscribe(fn) → unsubscribe`, or
   * `on(event, fn)` / `off(event, fn)`. If none of these is present the
   * method will throw.
   *
   * The returned unsubscribe function is also recorded internally and will
   * be invoked during {@link cleanup} if the caller does not unsubscribe
   * manually.
   *
   * @param {Object}   store    A store-like object with a listener API.
   * @param {Function} listener Callback invoked when the store value changes.
   * @returns {Function} An unsubscribe function to stop listening.
   */
  subscribe(store, listener) {
    if (!store || typeof listener !== "function") {
      throw new Error("subscribe requires a store and a listener function");
    }

    let unsub;
    if (typeof store.addListener === "function") {
      unsub = store.addListener(listener);
    } else if (typeof store.subscribe === "function") {
      unsub = store.subscribe(listener);
    } else if (typeof store.on === "function") {
      // some EventEmitter-like stores
      store.on("change", listener);
      unsub = () => store.off("change", listener);
    } else {
      throw new Error("store does not expose addListener/subscribe/on");
    }

    if (typeof unsub !== "function") {
      // Some stores return nothing and instead expect us to call a remove method on them.
      // In that case we just no-op the unsubscribe.
      unsub = () => {};
    }

    this._unsubscribers.push(unsub);
    return unsub;
  }

  /**
   * Attach a DOM-level event listener to a specific element and ensure it is
   * removed automatically during {@link cleanup}. Returns an unsubscribe
   * function that can also be called earlier to remove the listener manually.
   *
   * @param {EventTarget} el         The element (or any EventTarget) to listen on.
   * @param {string}      eventName  The DOM event name (e.g. `'click'`).
   * @param {Function}    handler    The event handler callback.
   * @param {Object|boolean} [options] Options forwarded to `addEventListener`.
   * @returns {Function} An unsubscribe function that removes the listener.
   */
  watchEvent(el, eventName, handler, options) {
    if (!el || typeof el.addEventListener !== "function") {
      throw new Error("watchEvent: invalid element");
    }
    el.addEventListener(eventName, handler, options);
    const unsub = () => {
      try {
        el.removeEventListener(eventName, handler, options);
      } catch (_e) {
        /* ignore */
      }
    };
    this._unsubscribers.push(unsub);
    // Also keep record so we can remove if needed earlier
    this._elementListeners.push({ el, evt: eventName, handler });
    return unsub;
  }

  /* ---------------------------
   * Async helpers
   * --------------------------- */

  /**
   * Convenience wrapper around the global `fetch()` that automatically
   * wires in this view's {@link AbortSignal}. When the view is cleaned up
   * the signal is aborted, cancelling any in-flight requests.
   *
   * @param {string|Request} input  The resource URL or Request object.
   * @param {Object}         [init] Optional fetch init options (headers, method, etc.).
   * @returns {Promise<Response>} The fetch response promise.
   */
  fetch(input, init = {}) {
    const merged = Object.assign({}, init, { signal: this.signal });
    return fetch(input, merged);
  }

  /* ---------------------------
   * Cleanup
   * --------------------------- */

  /**
   * Tear down the view and release all resources:
   *
   * 1. Aborts the view's {@link AbortController}, cancelling any in-flight
   *    fetches or other signal-aware async work.
   * 2. Invokes every unsubscribe function recorded via {@link subscribe} and
   *    {@link watchEvent}.
   * 3. Removes DOM event listeners attached through {@link createElement}.
   * 4. Detaches the root element from the DOM if it is still mounted.
   *
   * After cleanup the view should be considered disposed and not reused.
   */
  cleanup() {
    // Abort outstanding operations
    try {
      if (this._abortController) this._abortController.abort();
    } catch (_e) {
      // ignore
    }

    // Run recorded unsubscribers
    for (const unsub of this._unsubscribers.splice(0)) {
      try {
        unsub();
      } catch (e) {
        console.warn("unsub error", e);
      }
    }

    // Remove element listeners attached via createElement or watchEvent
    for (const { el, evt, handler } of this._elementListeners.splice(0)) {
      try {
        el.removeEventListener(evt, handler);
      } catch (_e) {
        /* ignore */
      }
    }

    // If root is present and mounted, remove it from DOM.
    if (this.root?.parentNode) {
      try {
        this.root.parentNode.removeChild(this.root);
      } catch (_e) {
        /* ignore */
      }
    }
    this.root = null;
    this._listenersAttached = false;
  }

  /* ---------------------------
   * Utility: placeholder view factory
   * --------------------------- */

  /**
   * Returns a minimal view-like object (not a full `View` subclass instance)
   * that can be used as a quick fallback when a full view implementation
   * isn't yet available. The returned object satisfies the Router's view
   * contract (`render()`, `cleanup()`, `focus()`).
   *
   * Example:
   *   const NotFound = View.createPlaceholderView('Not Found', 'The requested page was not found.');
   *   router.setNotFound(() => NotFound);
   *
   * @param {string} [title='Placeholder']  Heading text rendered inside the placeholder.
   * @param {string} [message='']           Body text rendered below the heading.
   * @returns {Object} A view-like object with `render()`, `cleanup()`, and `focus()` methods.
   */
  static createPlaceholderView(title = "Placeholder", message = "") {
    return {
      render() {
        const container = document.createElement("div");
        container.className = "view-placeholder";
        const h = document.createElement("h2");
        h.textContent = title;
        const p = document.createElement("p");
        p.textContent = message;
        container.appendChild(h);
        container.appendChild(p);
        return container;
      },
      cleanup() {
        // nothing to do for this simple placeholder
      },
      focus() {
        // focus the root element if mounted
        // router will call focus() only if it is present; this is optional
      },
    };
  }
}

/* End of View.js */
