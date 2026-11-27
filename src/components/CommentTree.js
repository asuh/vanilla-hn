/**
 * CommentTree.js
 *
 * Loads and renders a whole comment tree below one root item (a story, or a
 * permalinked comment).
 *
 * Data flow is one-directional:
 *
 *   hnService ──payload──▶ threadStore.commentAdded() ──state──▶ CommentElement.sync()
 *
 *  - Every visible comment's replies are subscribed eagerly, whether they are
 *    offscreen or inside a collapsed thread, so counts and realtime updates
 *    stay complete. Replies of hidden dead/deleted comments are not loaded.
 *  - The thread store is the only owner of collapse, new-comment and count
 *    state. A user toggle writes to the store, and the store's state is pushed
 *    back into elements, never the other way round.
 *  - Store changes and arriving payloads schedule one DOM sync per animation
 *    frame instead of reconciling the tree on every event.
 */

import { create } from "../utils/dom.js";
import { CommentElement } from "./CommentElement.js";
import { createSpinner } from "./Spinner.js";

const DELAYED_TEXT = "Unable to load comment. Trying again in 30 seconds.";

export default class CommentTree {
  /**
   * @param {Object} opts
   * @param {number|string} opts.rootId - Id of the item whose `kids` form the top level.
   * @param {HTMLElement} opts.container - Element that receives top-level comments.
   * @param {Object} opts.hnService - Provides `onItemValue(id, cb) -> unsubscribe`.
   * @param {Object} opts.threadStore - CommentThreadStore (or subclass) instance.
   * @param {Object} [opts.settingsStore] - Provides showDead/showDeleted/replyLinks.
   * @param {boolean} [opts.showHiddenRoots=false] - Render the root's dead/deleted
   *   direct replies as stubs and load their replies (comment permalinks).
   */
  constructor({
    rootId,
    container,
    hnService,
    threadStore,
    settingsStore = null,
    showHiddenRoots = false,
  }) {
    this.rootId = String(rootId);
    this.showHiddenRoots = showHiddenRoots;
    this.hnService = hnService;
    this.threadStore = threadStore;
    this.settingsStore = settingsStore;

    /** @type {Map<string, Function>} comment id -> unsubscribe */
    this._subscriptions = new Map();
    /** @type {Map<string, Object>} latest payload per comment id */
    this._payloads = new Map();
    /** @type {Set<string>} ids whose last response was empty */
    this._delayed = new Set();
    /** @type {Map<string, CommentElement>} every rendered comment, any depth */
    this._elements = new Map();
    /** @type {Map<string, HTMLElement>} id -> current DOM slot (placeholder or comment) */
    this._slots = new Map();
    /** @type {Map<string, {el: HTMLElement, depth: number}>} parent id -> kids container */
    this._containers = new Map([[this.rootId, { el: container, depth: 0 }]]);
    /** Ordered kid ids per parent, for placing late or new replies. */
    this._kidOrder = new Map();
    /** @type {Map<string, string>} comment id -> id of the item that listed it */
    this._parentOf = new Map();

    this._frame = 0;
    this._frameIsTimeout = false;
    this._disposed = false;

    this._storeUnsub = threadStore?.addListener?.(() => this.requestSync()) || null;
  }

  /**
   * Set (or update) the root's ordered kid ids. New ids are subscribed and
   * get placeholders in order; existing ones are left untouched.
   *
   * @param {Array<number|string>} kids
   */
  setKids(kids) {
    if (this._disposed) return;
    this._placeKids(this.rootId, kids);
  }

  /** Schedule a DOM sync for the next animation frame. */
  requestSync() {
    if (this._disposed || this._frame) return;
    const run = () => {
      this._frame = 0;
      this._syncAll();
    };
    this._frameIsTimeout = typeof requestAnimationFrame !== "function";
    this._frame = this._frameIsTimeout ? setTimeout(run, 16) : requestAnimationFrame(run);
  }

  /** Number of rendered comment elements (for diagnostics and tests). */
  get size() {
    return this._elements.size;
  }

  /** Unsubscribe everything and detach all rendered comments. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._frame) {
      // Frame and timer ids are separate counters; cancel only the one used.
      if (this._frameIsTimeout) clearTimeout(this._frame);
      else cancelAnimationFrame(this._frame);
      this._frame = 0;
    }
    this._storeUnsub?.();
    for (const unsubscribe of this._subscriptions.values()) {
      try {
        unsubscribe();
      } catch (_e) {
        /* ignore */
      }
    }
    this._subscriptions.clear();
    for (const element of this._elements.values()) element.cleanup();
    for (const slot of this._slots.values()) slot.remove();
    this._elements.clear();
    this._slots.clear();
    this._containers.clear();
    this._payloads.clear();
    this._kidOrder.clear();
    this._parentOf.clear();
    this._delayed.clear();
  }

  // ── Loading ────────────────────────────────────────────────────────────────

  _subscribe(id) {
    if (this._subscriptions.has(id) || typeof this.hnService?.onItemValue !== "function") return;
    // Reserve the key first so a synchronous callback cannot subscribe twice.
    this._subscriptions.set(id, () => {});
    const unsubscribe = this.hnService.onItemValue(id, (payload) => this._receive(id, payload));
    if (this._disposed) {
      unsubscribe?.();
      return;
    }
    if (typeof unsubscribe === "function") this._subscriptions.set(id, unsubscribe);
  }

  _receive(id, payload) {
    // Ignore callbacks queued before a hidden subtree was unsubscribed.
    if (this._disposed || !this._subscriptions.has(id)) return;

    if (!payload?.id) {
      if (!this._delayed.has(id)) {
        this._delayed.add(id);
        this.threadStore?.commentDelayed?.(id);
      }
      const slot = this._slots.get(id);
      if (slot && !this._elements.has(id)) {
        slot.textContent = DELAYED_TEXT;
        slot.classList.add("placeholder--delayed");
      }
      return;
    }

    this._delayed.delete(id);
    // Place comments under the item that listed them; fill a missing parent
    // so the store can wire its graph.
    const knownParent = this._parentOf.get(id);
    if (payload.parent == null && knownParent != null) {
      payload = { ...payload, parent: Number(knownParent) };
    }
    this._payloads.set(id, payload);
    try {
      this.threadStore?.commentAdded?.(payload);
    } catch (_e) {
      /* store bookkeeping is best effort */
    }

    this._renderReceived(id, payload);
    this.requestSync();
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  _isVisible(payload, parentId) {
    if (this.showHiddenRoots && parentId === this.rootId) return true;
    const showDead = this.settingsStore?.get?.("showDead") ?? false;
    const showDeleted = this.settingsStore?.get?.("showDeleted") ?? false;
    return !((payload.deleted && !showDeleted) || (payload.dead && !showDead));
  }

  /** Create or update the element for a payload that just arrived. */
  _renderReceived(id, payload) {
    const existing = this._elements.get(id);
    const parentId = this._parentOf.get(id) ?? String(payload.parent);

    if (existing) {
      // Once shown, a comment stays: if moderation hides it, it becomes a
      // [dead]/deleted stub and keeps its replies, which the store still counts.
      existing.setComment(payload);
      this._placeKids(id, payload.kids);
      return;
    }

    if (!this._isVisible(payload, parentId)) {
      // Arrived hidden: drop its placeholder and skip its replies, which the
      // store does not expect.
      this._slots.get(id)?.remove();
      this._slots.delete(id);
      return;
    }

    const parent = this._containers.get(parentId);
    if (!parent) return; // The parent was hidden after this reply was requested.
    this._mount(id, payload, parentId, parent);
  }

  _mount(id, payload, parentId, parent) {
    const element = new CommentElement({
      comment: payload,
      depth: parent.depth,
      settingsStore: this.settingsStore,
      onToggle: (commentId, collapsed) => this._onToggle(String(commentId), collapsed),
    });
    const node = element.render(this._stateFor(id, element));
    this._elements.set(id, element);
    this._containers.set(id, { el: element.kidsEl, depth: parent.depth + 1 });

    const slot = this._slots.get(id);
    if (slot?.parentNode) slot.replaceWith(node);
    else this._insertInOrder(parentId, id, node, parent.el);
    this._slots.set(id, node);

    this._placeKids(id, payload.kids);
  }

  /**
   * Subscribe to `kids` and make sure each visible kid has a slot, in order.
   * Kids whose payloads already arrived are mounted directly.
   */
  _placeKids(parentId, kids) {
    if (!Array.isArray(kids)) return;
    const ids = kids.map(String);
    this._kidOrder.set(parentId, ids);
    const parent = this._containers.get(parentId);

    for (const kid of ids) {
      if (!this._parentOf.has(kid)) this._parentOf.set(kid, parentId);
      this._subscribe(kid);
      if (!parent || this._slots.has(kid)) continue;
      const payload = this._payloads.get(kid);
      if (payload) {
        if (this._isVisible(payload, parentId)) this._mount(kid, payload, parentId, parent);
        continue;
      }
      const placeholder = this._createPlaceholder(kid);
      this._insertInOrder(parentId, kid, placeholder, parent.el);
      this._slots.set(kid, placeholder);
    }
  }

  /** Insert `node` before the next sibling (by kid order) that is already in the DOM. */
  _insertInOrder(parentId, id, node, containerEl) {
    const order = this._kidOrder.get(parentId) || [];
    const index = order.indexOf(id);
    for (let i = index + 1; index !== -1 && i < order.length; i++) {
      const next = this._slots.get(order[i]);
      if (next?.parentNode === containerEl) {
        containerEl.insertBefore(node, next);
        return;
      }
    }
    containerEl.appendChild(node);
  }

  _createPlaceholder(id) {
    const delayed = this._delayed.has(id);
    const placeholder = create("div", {
      attrs: {
        class: delayed ? "placeholder placeholder--delayed" : "placeholder",
        role: "group",
        "aria-label": `Comment ${id} loading`,
        "data-comment-id": id,
      },
    });
    if (delayed) placeholder.textContent = DELAYED_TEXT;
    else {
      placeholder.append(
        createSpinner({ inline: true, size: "20px", label: `Loading comment ${id}` }),
      );
    }
    return placeholder;
  }

  // ── State sync ─────────────────────────────────────────────────────────────

  _onToggle(id, collapsed) {
    this.threadStore?.toggleCollapse?.(id, collapsed);
    // Update this comment right away so its counts never lag the disclosure.
    const element = this._elements.get(id);
    if (element) element.sync(this._stateFor(id, element));
  }

  _stateFor(id, element) {
    const store = this.threadStore;
    const collapsed = Boolean(store?.isCollapsed?.[id]);
    return {
      collapsed,
      isNew: Boolean(store?.isNew?.[id]),
      counts: collapsed ? store?.getChildCounts?.(element.comment) || null : null,
    };
  }

  _syncAll() {
    if (this._disposed) return;
    for (const [id, element] of this._elements) element.sync(this._stateFor(id, element));
  }
}
