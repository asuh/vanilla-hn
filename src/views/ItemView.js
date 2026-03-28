/**
 * ItemView.js
 *
 * Full implementation of the story/item detail view for vanilla-hn.
 *
 * Responsibilities:
 *  - Render a loading skeleton immediately, then populate when item data arrives.
 *  - Display story title (external link or internal #/item/:id), metadata bar
 *    (score, author link, time, descendants/discuss link), and optional body text.
 *  - Instantiate a per-story StoryCommentThreadStore via initForItem() once data lands.
 *  - Render a "controls bar" when the thread has been visited before, showing:
 *      - N new comments in the last X time
 *      - "auto collapse" button
 *      - "mark as read" button
 *  - Render a time-based comment slider that lets the user highlight comments
 *    newer than a chosen position in the comment sequence.
 *  - Render child comments using CommentElement, wired to the threadStore.
 *  - Auto-collapse after initial load if autoCollapse setting is on and there are new comments.
 *  - Update document.title when the story loads.
 *  - Full cleanup: dispose threadStore, unsubscribe all listeners, cleanup comment elements.
 */

import View from "./View.js";
import { create, timeAgoFromUnix } from "../utils/dom.js";
import { pluralise, parseHost } from "../utils/helpers.js";
import { CommentElement } from "../components/CommentElement.js";
import StoryCommentThreadStore from "../stores/StoryCommentThreadStore.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const SITE_TITLE = "Vanilla HN";

/** How many ms between polls when waiting for threadStore.loading to become false. */
const LOAD_POLL_INTERVAL_MS = 200;

/** Max time (ms) we wait for the thread to finish loading before giving up on auto-collapse. */
const LOAD_POLL_TIMEOUT_MS = 30_000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Given a unix-seconds timestamp for the last visit, produce a human-readable
 * duration string like "3 hours" or "2 days" (without the trailing "ago").
 *
 * NOTE: This is intentionally separate from `dom.js`'s `formatRelativeTime` /
 * `timeAgoFromUnix`, which return strings such as "3 hours ago". Here we need
 * only the bare duration portion (e.g. for "N new comments in the last 3 hours").
 *
 * @param {number} lastVisitSeconds  unix timestamp in seconds
 * @returns {string} Human-readable duration, e.g. "3 hours", or "" if falsy input
 */
function sinceLastVisit(lastVisitSeconds) {
  if (!lastVisitSeconds) return "";
  const diffMs = Date.now() - lastVisitSeconds * 1000;
  const diffSeconds = Math.max(0, Math.round(diffMs / 1000));

  const units = [
    { name: "year", secs: 60 * 60 * 24 * 365 },
    { name: "month", secs: 60 * 60 * 24 * 30 },
    { name: "week", secs: 60 * 60 * 24 * 7 },
    { name: "day", secs: 60 * 60 * 24 },
    { name: "hour", secs: 60 * 60 },
    { name: "minute", secs: 60 },
  ];

  for (const u of units) {
    const val = Math.floor(diffSeconds / u.secs);
    if (val >= 1) return `${val} ${pluralise(val, u.name)}`;
  }
  return "a moment";
}

// ─── ItemView ────────────────────────────────────────────────────────────────

export default class ItemView extends View {
  /**
   * Create a new ItemView.
   *
   * @param {Object}  context
   * @param {Object}  context.params              - Route params; expects `{ id: string }`.
   * @param {Object}  context.services            - Shared service instances.
   * @param {Object}  context.services.hnService  - HNService for Firebase subscriptions.
   * @param {Object}  context.stores              - Shared store instances.
   * @param {Object}  context.stores.settingsStore     - User-preference store.
   * @param {Object}  context.stores.readStoriesStore  - Tracks which stories the user has read.
   * @param {Object}  [context.stores.threadStore]     - Optional global thread store (used as fallback).
   * @param {Function} [context.stores.createThreadStore] - Factory for per-story thread stores.
   * @param {Function} [context.stores.loadThreadState]   - Loader for persisted thread state.
   */
  constructor(context = {}) {
    super(context);

    this.itemId = this.params && this.params.id ? String(this.params.id) : null;

    // Per-story thread store — created once we have item data.
    this._threadStore = null;

    // The loaded HN item object.
    this._item = null;

    // Slider position (1-based index into sorted comment array).
    // Initialised to null; defaults to commentCount - 1 once we know it.
    this._sliderValue = null;

    // Map of commentId (string) -> CommentElement instance for top-level comments.
    this._commentElements = new Map();

    // Unsubscribe handle for the primary hnService.onItemValue subscription.
    this._itemUnsub = null;

    // Unsubscribe handle for threadStore listener.
    this._threadStoreUnsub = null;

    // Poll timer id for waiting on threadStore.loading.
    this._loadPollTimer = null;
    this._loadPollStarted = 0;

    // DOM refs populated by render().
    this._loadingEl = null;
    this._contentEl = null;
    this._titleEl = null;
    this._metaEl = null;
    this._controlsEl = null;
    this._sliderContainerEl = null;
    this._itemTextEl = null;
    this._kidsEl = null;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Build and return the root HTMLElement for this view.
   *
   * Creates a loading skeleton, kicks off an `hnService.onItemValue` subscription,
   * and returns the root element immediately. The content is populated
   * asynchronously once item data arrives.
   *
   * @returns {HTMLElement} The root DOM node for this view.
   */
  render() {
    // Root wrapper
    const root = create("div", {
      attrs: { class: "view item-view", "data-item-id": this.itemId || "" },
    });

    // Loading indicator (shown until item data arrives)
    this._loadingEl = create(
      "div",
      {
        attrs: { class: "item-loading", role: "status", "aria-live": "polite" },
      },
      create("span", { attrs: { class: "spinner" } }),
      " Loading story…",
    );
    root.appendChild(this._loadingEl);

    // Content wrapper — hidden until item loads
    this._contentEl = create("div", {
      attrs: { class: "item-content", hidden: true },
    });
    root.appendChild(this._contentEl);

    // Kick off subscription
    this._subscribeToItem();

    this.root = root;
    return root;
  }

  attachEventListeners() {
    // Primary event wiring is done inline during render / _buildContent for
    // tight coupling between elements and handlers. Nothing extra needed here.
  }

  /**
   * Full cleanup of this view's resources.
   *
   * Tears down:
   * - The load-completion poll timer.
   * - The `hnService.onItemValue` subscription for the story.
   * - The per-story `StoryCommentThreadStore` listener and the store itself.
   * - Every rendered `CommentElement` (calling `ce.cleanup()`).
   * - Base-class unsubscribers and DOM removal (via `super.cleanup()`).
   *
   * @returns {void}
   */
  cleanup() {
    // Cancel any pending load-completion poll.
    this._clearLoadPoll();

    // Unsubscribe from hnService item feed.
    if (typeof this._itemUnsub === "function") {
      try {
        this._itemUnsub();
      } catch (e) {
        /* ignore */
      }
      this._itemUnsub = null;
    }

    // Unsubscribe from threadStore.
    if (typeof this._threadStoreUnsub === "function") {
      try {
        this._threadStoreUnsub();
      } catch (e) {
        /* ignore */
      }
      this._threadStoreUnsub = null;
    }

    // Dispose the per-story thread store.
    if (this._threadStore) {
      try {
        if (typeof this._threadStore.dispose === "function") {
          this._threadStore.dispose();
        } else if (typeof this._threadStore.saveState === "function") {
          // vanilla StoryCommentThreadStore uses saveState instead of dispose
          this._threadStore.saveState();
        }
      } catch (e) {
        /* ignore */
      }
      this._threadStore = null;
    }

    // Cleanup all rendered comment elements.
    for (const ce of this._commentElements.values()) {
      try {
        if (typeof ce.cleanup === "function") ce.cleanup();
      } catch (e) {
        /* ignore */
      }
    }
    this._commentElements.clear();

    // Let base class handle unsubscribers and DOM removal.
    super.cleanup();
  }

  // ── Data subscription ──────────────────────────────────────────────────────

  /**
   * Subscribe to `hnService.onItemValue` for this story's id.
   *
   * Registers a Firebase real-time listener that fires `_onItemLoaded`
   * whenever the item data changes. The unsubscribe handle is stored in
   * `this._itemUnsub` and cleaned up by `cleanup()`.
   *
   * @returns {void}
   */
  _subscribeToItem() {
    const hn = this.services && this.services.hnService;
    if (!hn || typeof hn.onItemValue !== "function" || !this.itemId) {
      this._showError("Service unavailable or missing item id.");
      return;
    }

    this._itemUnsub = hn.onItemValue(this.itemId, (item) => {
      this._onItemLoaded(item);
    });
  }

  /**
   * Callback invoked every time `hnService` emits an update for this item.
   *
   * On the **first** call: initialises the thread store, builds the full
   * content DOM (title, meta, controls, slider, body text, comment stubs),
   * hides the loading skeleton, sets `document.title`, subscribes to child
   * comments, and starts the load-completion poll.
   *
   * On **subsequent** calls: patches mutable meta fields (score, time,
   * descendants) in place.
   *
   * @param {Object|null} item - The HN item payload, or `null` if not found.
   * @returns {void}
   */
  _onItemLoaded(item) {
    if (!item || !item.id) {
      if (!this._item) this._showError("Story not found.");
      return;
    }

    const isFirstLoad = !this._item;
    this._item = item;

    if (isFirstLoad) {
      // Set up the per-story thread store now that we have item data.
      this._initThreadStore(item);

      // Build and mount content DOM.
      this._buildContent(item);

      // Hide loading, reveal content.
      if (this._loadingEl) this._loadingEl.hidden = true;
      if (this._contentEl) this._contentEl.hidden = false;

      // Update document title.
      if (item.title) {
        document.title = `${item.title} | ${SITE_TITLE}`;
      }

      // Kick off comment subscriptions.
      this._subscribeToComments(item);

      // Begin watching for thread load completion (for auto-collapse).
      this._startLoadPoll();
    } else {
      // Subsequent updates: patch title, score, descendants.
      this._patchItemMeta(item);

      // If thread store exists and was loading, notify it of updated kids.
      if (
        this._threadStore &&
        typeof this._threadStore.initForItem === "function"
      ) {
        // Re-init is idempotent for updates; only call if the store supports it.
      }
    }
  }

  // ── ThreadStore initialisation ────────────────────────────────────────────

  /**
   * Create and initialise a per-story `StoryCommentThreadStore` for the given item.
   *
   * Builds a `getItemById` helper (used by the store for tree traversal),
   * instantiates the store scoped to `item.id`, calls `initForItem()` or
   * seeds state via `_ensureEntry()`, and subscribes to store change
   * notifications via `_onThreadStoreChanged`.
   *
   * @param {Object} item - The HN item payload for the current story.
   * @returns {void}
   */
  _initThreadStore(item) {
    const globalThreadStore = this.stores && this.stores.threadStore;

    // Build a getItemById helper that the vanilla store can use for traversal.
    // It looks up loaded comment elements and returns their comment payload.
    const getItemById = (id) => {
      const key = String(id);
      // Check if it's the story itself
      if (key === String(this.itemId)) return this._item;
      // Check loaded comment elements
      const ce = this._commentElements.get(key);
      if (ce && ce.comment) return ce.comment;
      // Fallback to global threadStore's item cache if available
      if (
        globalThreadStore &&
        typeof globalThreadStore.getItemById === "function"
      ) {
        return globalThreadStore.getItemById(id);
      }
      return null;
    };

    // Create a fresh StoryCommentThreadStore scoped to this story.
    this._threadStore = new StoryCommentThreadStore(item.id, { getItemById });

    // Call initForItem if the store exposes it (some implementations do).
    if (typeof this._threadStore.initForItem === "function") {
      try {
        this._threadStore.initForItem(item);
      } catch (e) {
        /* ignore */
      }
    } else {
      // Vanilla implementation uses update() to seed initial state.
      // Seed the store with any previously persisted state by ensuring entry exists.
      if (typeof this._threadStore._ensureEntry === "function") {
        this._threadStore._ensureEntry(item.id);
      }
    }

    // Subscribe to threadStore changes so we can re-render reactive sections.
    if (typeof this._threadStore.addListener === "function") {
      this._threadStoreUnsub = this._threadStore.addListener((change) => {
        this._onThreadStoreChanged(change);
      });
    }
  }

  // ── Content building ───────────────────────────────────────────────────────

  /**
   * Build the full content DOM for the loaded item and append it to `this._contentEl`.
   *
   * Constructs the story header (title + meta bar), controls bar, comment
   * time-slider, optional body text, and the comments container. Populates
   * internal DOM-ref fields (`_titleEl`, `_metaEl`, `_controlsEl`, etc.).
   *
   * @param {Object} item - The HN item payload.
   * @returns {void}
   */
  _buildContent(item) {
    const content = this._contentEl;
    if (!content) return;

    // Clear any previous content.
    while (content.firstChild) content.removeChild(content.firstChild);

    // Story header section
    const header = create("div", { attrs: { class: "item-header" } });

    // Title
    this._titleEl = this._buildTitle(item);
    header.appendChild(this._titleEl);

    // Meta bar
    this._metaEl = this._buildMeta(item);
    header.appendChild(this._metaEl);

    content.appendChild(header);

    // Controls bar (new comments info + auto-collapse + mark-as-read)
    this._controlsEl = create("div", { attrs: { class: "item-controls" } });
    content.appendChild(this._controlsEl);
    // Render controls immediately (may be empty on first visit)
    this._renderControls();

    // Comment time slider
    this._sliderContainerEl = create("div", {
      attrs: {
        class: "item-slider-container",
        "aria-label": "Highlight comments by position",
      },
      style: { opacity: "0", transition: "opacity .33s ease-out" },
    });
    content.appendChild(this._sliderContainerEl);
    this._buildSlider();

    // Item body text (ask HN, job posts, etc.)
    if (item.text) {
      this._itemTextEl = create("div", {
        attrs: { class: "item-text" },
        html: item.text,
      });
      content.appendChild(this._itemTextEl);
    }

    // Comments section
    this._kidsEl = create("div", {
      attrs: { class: "item-kids", role: "list", "aria-label": "Comments" },
    });
    content.appendChild(this._kidsEl);
  }

  /**
   * Build the title element for the story.
   *
   * External URLs get an `<a>` pointing at the URL (with `target="_blank"`)
   * followed by a hostname badge. Internal / dead stories get an `<a>` that
   * links to `#/item/:id`. Dead stories are prefixed with `[dead]`.
   *
   * @param {Object} item - The HN item payload.
   * @returns {HTMLElement} A wrapper `<div class="item-title">` containing the link.
   */
  _buildTitle(item) {
    const titleText = item.dead
      ? `[dead] ${item.title || ""}`
      : item.title || `Item ${item.id}`;
    const settings = this.stores && this.stores.settingsStore;
    const fontSize =
      settings && typeof settings.get === "function"
        ? settings.get("titleFontSize")
        : 18;

    const titleWrapper = create("div", {
      attrs: { class: "item-title" },
      style: { fontSize: `${fontSize || 18}px` },
    });

    if (item.url && !item.dead) {
      const link = create(
        "a",
        {
          attrs: {
            href: item.url,
            target: "_blank",
            rel: "noopener noreferrer",
          },
        },
        titleText,
      );
      titleWrapper.appendChild(link);

      const host = parseHost(item.url);
      if (host) {
        const hostEl = create(
          "span",
          { attrs: { class: "item-host" } },
          ` (${host})`,
        );
        titleWrapper.appendChild(hostEl);
      }
    } else {
      const link = create(
        "a",
        {
          attrs: { href: `#/item/${item.id}` },
        },
        titleText,
      );
      titleWrapper.appendChild(link);
    }

    return titleWrapper;
  }

  /**
   * Build the metadata bar beneath the title.
   *
   * Renders score (e.g. "42 points"), author link, relative time, and a
   * comments/discuss link. Job posts show only the time.
   *
   * @param {Object} item - The HN item payload.
   * @returns {HTMLElement} A `<div class="item-meta">` element.
   */
  _buildMeta(item) {
    const meta = create("div", { attrs: { class: "item-meta" } });

    if (item.type === "job") {
      // Job posts only show time
      const time = create(
        "span",
        { attrs: { class: "item-time" } },
        timeAgoFromUnix(item.time),
      );
      meta.appendChild(time);
      return meta;
    }

    // Score
    const score = create(
      "span",
      { attrs: { class: "item-score" } },
      `${item.score || 0} ${pluralise(item.score || 0, "point")}`,
    );
    meta.appendChild(score);
    meta.appendChild(document.createTextNode(" by "));

    // Author link
    const byLink = create(
      "a",
      { attrs: { href: `#/user/${item.by}`, class: "item-by" } },
      item.by || "unknown",
    );
    meta.appendChild(byLink);
    meta.appendChild(document.createTextNode(" "));

    // Time
    const timeEl = create(
      "span",
      { attrs: { class: "item-time" } },
      timeAgoFromUnix(item.time),
    );
    meta.appendChild(timeEl);
    meta.appendChild(document.createTextNode(" | "));

    // Comments/discuss link
    const commentsCount = item.descendants != null ? item.descendants : 0;
    const commentsText =
      commentsCount > 0
        ? `${commentsCount} ${pluralise(commentsCount, "comment")}`
        : "discuss";
    const commentsLink = create(
      "a",
      {
        attrs: { href: `#/item/${item.id}`, class: "item-comments-link" },
      },
      commentsText,
    );
    meta.appendChild(commentsLink);

    return meta;
  }

  /**
   * Patch mutable fields on the meta bar after a subsequent item update.
   * @param {Object} item
   */
  _patchItemMeta(item) {
    if (!this._metaEl) return;

    const scoreEl = this._metaEl.querySelector(".item-score");
    if (scoreEl)
      scoreEl.textContent = `${item.score || 0} ${pluralise(item.score || 0, "point")}`;

    const timeEl = this._metaEl.querySelector(".item-time");
    if (timeEl) timeEl.textContent = timeAgoFromUnix(item.time);

    const commentsEl = this._metaEl.querySelector(".item-comments-link");
    if (commentsEl) {
      const commentsCount = item.descendants != null ? item.descendants : 0;
      commentsEl.textContent =
        commentsCount > 0
          ? `${commentsCount} ${pluralise(commentsCount, "comment")}`
          : "discuss";
    }
  }

  // ── Controls bar ──────────────────────────────────────────────────────────

  /**
   * Render (or re-render) the controls bar. Shows nothing on first visit.
   * On revisits: "N new comments in the last X | auto collapse | mark as read"
   */
  _renderControls() {
    const el = this._controlsEl;
    if (!el) return;

    // Clear
    while (el.firstChild) el.removeChild(el.firstChild);

    if (!this._threadStore) return;

    const storyId = this._item && this._item.id;
    const state =
      storyId && typeof this._threadStore.getState === "function"
        ? this._threadStore.getState(storyId)
        : null;

    const lastVisit = state
      ? state.lastVisit
      : this._threadStore.lastVisit || null;
    const newCommentCount = this._getNewCommentCount();

    // Only show the controls bar when we've been here before and have new comments.
    if (!lastVisit || newCommentCount <= 0) return;

    el.setAttribute("class", "item-controls item-controls--visible");

    const since = sinceLastVisit(lastVisit);

    // "N new comments in the last X"
    const newInfo = create(
      "span",
      { attrs: { class: "item-controls__new-info" } },
      create(
        "em",
        {},
        `${newCommentCount} new ${pluralise(newCommentCount, "comment")}`,
      ),
      ` in the last ${since}`,
    );
    el.appendChild(newInfo);

    el.appendChild(document.createTextNode(" | "));

    // "auto collapse" button
    const autoCollapseBtn = create(
      "button",
      {
        attrs: {
          type: "button",
          class: "item-controls__btn item-controls__btn--collapse",
          title: "Collapse threads without new comments",
        },
        events: {
          click: (e) => {
            e.preventDefault();
            this._handleAutoCollapse();
          },
        },
      },
      "auto collapse",
    );
    el.appendChild(autoCollapseBtn);

    el.appendChild(document.createTextNode(" | "));

    // "mark as read" button
    const markReadBtn = create(
      "button",
      {
        attrs: {
          type: "button",
          class: "item-controls__btn item-controls__btn--read",
        },
        events: {
          click: (e) => {
            e.preventDefault();
            this._handleMarkAsRead();
          },
        },
      },
      "mark as read",
    );
    el.appendChild(markReadBtn);
  }

  // ── Comment slider ────────────────────────────────────────────────────────

  /**
   * Build (or rebuild) the comment time-based slider inside
   * `this._sliderContainerEl`.
   *
   * The slider lets the user choose a position in the chronologically-sorted
   * comment list; comments after that position are visually highlighted.
   * It is only rendered once the thread contains at least 2 comments.
   *
   * @returns {void}
   */
  _buildSlider() {
    const container = this._sliderContainerEl;
    if (!container) return;

    while (container.firstChild) container.removeChild(container.firstChild);

    if (!this._threadStore) return;

    const commentCount = this._getCommentCount();
    if (commentCount < 2) return;

    // Show the slider section
    container.style.opacity = "1";
    container.setAttribute("aria-hidden", "false");

    // Default slider to the second-to-last comment (highlight most recent)
    if (this._sliderValue === null || this._sliderValue > commentCount - 1) {
      this._sliderValue = commentCount - 1;
    }

    const slider = create("input", {
      attrs: {
        type: "range",
        class: "item-slider",
        min: "1",
        max: String(commentCount - 1),
        value: String(this._sliderValue),
        "aria-label": "Highlight comments after this position",
      },
      style: { margin: "0", verticalAlign: "middle" },
    });

    // Label showing "highlight N comments from <time>"
    const label = create("span", { attrs: { class: "item-slider__label" } });
    this._updateSliderLabel(label, this._sliderValue);

    // Button to apply the slider selection
    const applyBtn = create(
      "button",
      {
        attrs: {
          type: "button",
          class: "item-slider__btn",
        },
        events: {
          click: () => {
            const val = parseInt(slider.value, 10);
            this._sliderValue = val;
            if (
              this._threadStore &&
              typeof this._threadStore.highlightNewCommentsSince === "function"
            ) {
              try {
                this._threadStore.highlightNewCommentsSince(val);
              } catch (e) {
                /* ignore */
              }
            }
            this._updateSliderLabel(label, val);
          },
        },
      },
      label,
    );

    slider.addEventListener("input", () => {
      const val = parseInt(slider.value, 10);
      this._sliderValue = val;
      this._updateSliderLabel(label, val);
    });

    container.appendChild(slider);
    container.appendChild(applyBtn);
  }

  /**
   * Update the slider label to reflect how many comments would be highlighted
   * and from when.
   * @param {HTMLElement} labelEl
   * @param {number} sliderVal  1-based index
   */
  _updateSliderLabel(labelEl, sliderVal) {
    if (!labelEl) return;
    while (labelEl.firstChild) labelEl.removeChild(labelEl.firstChild);

    const commentCount = this._getCommentCount();
    const howMany = Math.max(0, commentCount - sliderVal);

    let timeStr = "";
    if (
      this._threadStore &&
      typeof this._threadStore.getCommentByTimeIndex === "function"
    ) {
      try {
        const refComment = this._threadStore.getCommentByTimeIndex(
          sliderVal + 1,
        );
        if (refComment && refComment.time) {
          timeStr = timeAgoFromUnix(refComment.time);
        }
      } catch (e) {
        /* ignore */
      }
    }

    labelEl.appendChild(
      document.createTextNode(
        `highlight ${howMany} ${pluralise(howMany, "comment")}${timeStr ? " from " : ""}`,
      ),
    );

    if (timeStr) {
      labelEl.appendChild(
        create("span", { attrs: { class: "item-slider__time" } }, timeStr),
      );
    }
  }

  /**
   * Reveal the slider once enough comments are loaded.
   */
  _maybeShowSlider() {
    const commentCount = this._getCommentCount();
    if (!this._sliderContainerEl) return;

    if (commentCount >= 2) {
      this._buildSlider();
    } else {
      this._sliderContainerEl.style.opacity = "0";
    }
  }

  // ── Comment rendering ─────────────────────────────────────────────────────

  /**
   * Subscribe to `hnService.onItemValue` for every top-level child id in
   * `item.kids`.
   *
   * For each child a placeholder `<div>` is appended to `this._kidsEl` to
   * preserve ordering. When a comment's data arrives, `_onCommentLoaded`
   * replaces the placeholder with a fully-rendered `CommentElement`.
   * Unsubscribe handles are pushed to `this._unsubscribers` so they are
   * cleaned up by the base `View.cleanup()`.
   *
   * @param {Object} item - The HN item payload (must have a `kids` array).
   * @returns {void}
   */
  _subscribeToComments(item) {
    if (!item.kids || item.kids.length === 0) return;
    const hn = this.services && this.services.hnService;
    if (!hn || typeof hn.onItemValue !== "function") return;

    const kidsEl = this._kidsEl;
    if (!kidsEl) return;

    for (const kidId of item.kids) {
      const childIdStr = String(kidId);

      // Create a placeholder to preserve ordering while comments load
      const placeholder = create(
        "div",
        {
          attrs: {
            class: "comment-placeholder",
            "data-comment-id": childIdStr,
            role: "group",
            "aria-label": `Comment ${childIdStr} loading`,
          },
        },
        `Loading comment…`,
      );
      kidsEl.appendChild(placeholder);

      // Subscribe — use the View base-class _unsubscribers array via a manual push
      // so they're cleaned up if cleanup() is called before comments arrive.
      const unsub = hn.onItemValue(kidId, (comment) => {
        if (!comment || !comment.id) return;
        this._onCommentLoaded(comment, placeholder);
      });

      if (typeof unsub === "function") {
        this._unsubscribers.push(unsub);
      }
    }
  }

  /**
   * Handle arrival of a top-level comment's data from `hnService`.
   *
   * If the comment has already been rendered (i.e. an update), its existing
   * `CommentElement` is patched in place. Otherwise a new `CommentElement` is
   * created, rendered, and swapped in for the loading placeholder.
   *
   * The comment is also registered with the per-story thread store via
   * `_notifyThreadStoreComment`, and collapse / new-comment visual states are
   * applied.
   *
   * @param {Object}      comment     - The HN comment payload.
   * @param {HTMLElement}  placeholder - The placeholder `<div>` to replace.
   * @returns {void}
   */
  _onCommentLoaded(comment, placeholder) {
    const key = String(comment.id);
    const existingCE = this._commentElements.get(key);

    // Notify the thread store about this comment.
    this._notifyThreadStoreComment(comment);

    if (existingCE) {
      // Update existing CommentElement with fresh data.
      existingCE.comment = comment;
      try {
        if (typeof existingCE.update === "function") existingCE.update();
      } catch (e) {
        /* ignore */
      }
      // Apply collapse state from threadStore if it changed.
      this._applyCollapseState(existingCE, comment.id);
      return;
    }

    // Build a CommentElement for this top-level comment.
    const storesForComment = {
      ...(this.stores || {}),
      threadStore: this._threadStore,
    };

    let ce;
    try {
      ce = new CommentElement({
        comment,
        services: this.services,
        stores: storesForComment,
        depth: 0,
      });
    } catch (err) {
      console.warn(
        "ItemView: failed to create CommentElement for",
        comment.id,
        err,
      );
      if (placeholder && placeholder.parentNode) {
        placeholder.textContent = `[Error loading comment ${comment.id}]`;
      }
      return;
    }

    this._commentElements.set(key, ce);

    // Render and insert into DOM, replacing the placeholder.
    let commentNode;
    try {
      commentNode = ce.render();
    } catch (err) {
      console.warn(
        "ItemView: CommentElement.render() failed for",
        comment.id,
        err,
      );
      if (placeholder && placeholder.parentNode) {
        placeholder.textContent = `[Error rendering comment ${comment.id}]`;
      }
      return;
    }

    if (placeholder && placeholder.parentNode) {
      placeholder.parentNode.replaceChild(commentNode, placeholder);
    } else if (this._kidsEl) {
      this._kidsEl.appendChild(commentNode);
    }

    // Apply any collapse state that was set before this comment loaded.
    this._applyCollapseState(ce, comment.id);

    // Mark new-comment visual state.
    this._applyNewState(ce, comment.id);
  }

  /**
   * Notify the threadStore that a comment has been added.
   * Handles both the vanilla API (storyId, commentId, parentId, time)
   * and the React-style API (comment object).
   *
   * @param {Object} comment
   */
  _notifyThreadStoreComment(comment) {
    if (!this._threadStore || !this._item) return;
    try {
      if (typeof this._threadStore.commentAdded === "function") {
        // Always pass the full comment object — both the vanilla StoryCommentThreadStore
        // and the react-hn-style store expect commentAdded(commentObject).
        this._threadStore.commentAdded(comment);
      }
    } catch (e) {
      // Ignore; store notification is best-effort
    }
  }

  // ── Collapse state management ─────────────────────────────────────────────

  /**
   * Apply the threadStore's collapse state to a given CommentElement.
   * @param {CommentElement} ce
   * @param {number|string} commentId
   */
  _applyCollapseState(ce, commentId) {
    if (!this._threadStore || !ce) return;
    try {
      let collapsed = false;
      if (typeof this._threadStore.isCollapsed === "function") {
        collapsed = this._threadStore.isCollapsed(
          this._item && this._item.id,
          commentId,
        );
      } else if (
        this._threadStore.isCollapsed &&
        typeof this._threadStore.isCollapsed === "object"
      ) {
        collapsed = Boolean(this._threadStore.isCollapsed[String(commentId)]);
      }
      if (typeof ce.toggleCollapse === "function") {
        ce.toggleCollapse(collapsed, false);
      }
    } catch (e) {
      /* ignore */
    }
  }

  /**
   * Apply the new-comment visual class to a CommentElement if it is "new".
   * @param {CommentElement} ce
   * @param {number|string} commentId
   */
  _applyNewState(ce, commentId) {
    if (!this._threadStore || !ce || !ce.root) return;
    try {
      let isNew = false;
      if (
        this._threadStore.isNew &&
        typeof this._threadStore.isNew === "object"
      ) {
        isNew = Boolean(this._threadStore.isNew[String(commentId)]);
      }
      if (isNew) {
        ce.root.classList.add("comment--new");
      } else {
        ce.root.classList.remove("comment--new");
      }
    } catch (e) {
      /* ignore */
    }
  }

  /**
   * Walk all loaded CommentElements and re-apply collapse + new state from threadStore.
   */
  _reapplyAllCommentStates() {
    for (const [id, ce] of this._commentElements.entries()) {
      this._applyCollapseState(ce, id);
      this._applyNewState(ce, id);
    }
  }

  // ── Thread load completion ────────────────────────────────────────────────

  /**
   * Start polling threadStore.loading to detect when the initial thread load finishes.
   * Once done, applies auto-collapse if configured.
   */
  _startLoadPoll() {
    this._clearLoadPoll();
    this._loadPollStarted = Date.now();
    this._pollLoadCompletion();
  }

  _pollLoadCompletion() {
    if (!this._threadStore) return;

    // Check if we should give up
    if (Date.now() - this._loadPollStarted > LOAD_POLL_TIMEOUT_MS) {
      return;
    }

    // For vanilla StoryCommentThreadStore, "loading done" means we've received
    // at least a response. The store doesn't track loading itself; we infer
    // completion from comment count stability or after a reasonable timeout.
    // For React-style store, check threadStore.loading.
    const loading = this._threadStore.loading;
    if (loading === false) {
      this._onThreadLoadComplete();
      return;
    }

    // If loading property doesn't exist (vanilla store), we can't know for certain —
    // use a pragmatic delay: wait until no new comments arrive for a short window.
    // We schedule the next poll regardless and let _onThreadLoadComplete be
    // guarded against double-calls.
    this._loadPollTimer = setTimeout(() => {
      this._pollLoadCompletion();
    }, LOAD_POLL_INTERVAL_MS);
  }

  _clearLoadPoll() {
    if (this._loadPollTimer !== null) {
      clearTimeout(this._loadPollTimer);
      this._loadPollTimer = null;
    }
  }

  /**
   * Called once the thread has finished its initial load.
   * Applies auto-collapse if the setting is on and there are new comments.
   */
  _onThreadLoadComplete() {
    this._clearLoadPoll();

    const settings = this.stores && this.stores.settingsStore;
    const autoCollapse =
      settings && typeof settings.get === "function"
        ? settings.get("autoCollapse")
        : false;

    const newCommentCount = this._getNewCommentCount();

    if (autoCollapse && newCommentCount > 0 && this._threadStore) {
      if (
        typeof this._threadStore.collapseThreadsWithoutNewComments ===
        "function"
      ) {
        try {
          this._threadStore.collapseThreadsWithoutNewComments();
        } catch (e) {
          /* ignore */
        }
      }
    }

    // Show the slider now that loading is complete.
    this._maybeShowSlider();
  }

  // ── Store change handler ──────────────────────────────────────────────────

  /**
   * Called whenever the threadStore emits a change notification.
   * @param {Object|undefined} change  change descriptor from threadStore._notify()
   */
  _onThreadStoreChanged(change) {
    const type = change && change.type;

    if (
      type === "collapse" ||
      type === "toggleCollapse" ||
      type === "autoCollapse"
    ) {
      // Re-apply collapse state to all top-level CommentElements.
      this._reapplyAllCommentStates();
      return;
    }

    if (type === "markAsRead") {
      // Refresh the controls bar to clear the "new comments" notice.
      this._renderControls();
      this._reapplyAllCommentStates();
      return;
    }

    if (type === "commentAdded") {
      // A new comment was registered — update slider and controls.
      this._maybeShowSlider();
      return;
    }

    // Generic / unknown change: refresh reactive sections.
    this._renderControls();
    this._maybeShowSlider();
    this._reapplyAllCommentStates();
  }

  // ── Action handlers ───────────────────────────────────────────────────────

  /**
   * Handle the "auto collapse" button.
   *
   * Delegates to `threadStore.collapseThreadsWithoutNewComments()` to mark
   * every thread that contains no new comments as collapsed, then walks all
   * rendered `CommentElement` instances to apply the updated collapse state.
   *
   * @returns {void}
   */
  _handleAutoCollapse() {
    if (!this._threadStore) return;
    if (
      typeof this._threadStore.collapseThreadsWithoutNewComments === "function"
    ) {
      try {
        this._threadStore.collapseThreadsWithoutNewComments();
      } catch (e) {
        /* ignore */
      }
    }
    this._reapplyAllCommentStates();
  }

  /**
   * Handle the "mark as read" button.
   *
   * Performs the following steps:
   *  1. Calls `threadStore.markAsRead(storyId)` to reset the per-story
   *     new-comment tracking (updates `lastVisit` and `maxCommentId`).
   *  2. Calls `readStoriesStore.markAsRead(storyId)` to persist the story
   *     in the global read-stories list.
   *  3. Re-renders the controls bar (which will hide itself because
   *     `newCommentCount` drops to 0).
   *  4. Strips `comment--new` CSS classes from all rendered comment elements.
   *
   * @returns {void}
   */
  _handleMarkAsRead() {
    const storyId = this._item && this._item.id;
    if (!storyId) return;

    // Mark in the per-story thread store.
    if (
      this._threadStore &&
      typeof this._threadStore.markAsRead === "function"
    ) {
      try {
        this._threadStore.markAsRead(storyId);
      } catch (e) {
        /* ignore */
      }
    }

    // Mark in the global read-stories store.
    const readStore = this.stores && this.stores.readStoriesStore;
    if (readStore && typeof readStore.markAsRead === "function") {
      try {
        readStore.markAsRead(storyId);
      } catch (e) {
        /* ignore */
      }
    }

    // Refresh the controls bar — it should now hide (no more new comments).
    this._renderControls();

    // Remove new-comment highlights from rendered comment elements.
    this._reapplyAllCommentStates();
  }

  // ── Error display ─────────────────────────────────────────────────────────

  /**
   * Replace the loading indicator with an error message.
   * @param {string} msg
   */
  _showError(msg) {
    if (this._loadingEl) {
      this._loadingEl.textContent = `Error: ${msg}`;
      this._loadingEl.classList.add("item-loading--error");
    }
  }

  // ── Utility accessors ─────────────────────────────────────────────────────

  /**
   * Return the current loaded comment count from the threadStore.
   * Falls back to item.descendants or 0.
   * @returns {number}
   */
  _getCommentCount() {
    if (this._threadStore) {
      // vanilla store: check entry via getState
      const storyId = this._item && this._item.id;
      if (storyId && typeof this._threadStore.getState === "function") {
        const s = this._threadStore.getState(storyId);
        if (s && typeof s.commentCount === "number") return s.commentCount;
      }
      // React-style store
      if (typeof this._threadStore.commentCount === "number") {
        return this._threadStore.commentCount;
      }
    }
    return this._item && this._item.descendants ? this._item.descendants : 0;
  }

  /**
   * Return the count of new comments from the threadStore.
   * @returns {number}
   */
  _getNewCommentCount() {
    if (!this._threadStore) return 0;

    // React-style store exposes newCommentCount directly
    if (typeof this._threadStore.newCommentCount === "number") {
      return this._threadStore.newCommentCount;
    }

    // Vanilla store: derive from getState + maxCommentId heuristic
    const storyId = this._item && this._item.id;
    if (storyId && typeof this._threadStore.getState === "function") {
      const s = this._threadStore.getState(storyId);
      if (s) {
        // If lastVisit is 0/null this is a first visit → no "new" banner
        if (!s.lastVisit) return 0;
        // getChildCounts provides a `new` count if getItemById is wired up
        if (typeof this._threadStore.getChildCounts === "function") {
          try {
            const counts = this._threadStore.getChildCounts(storyId, null);
            if (counts && typeof counts.new === "number") return counts.new;
          } catch (e) {
            /* ignore */
          }
        }
      }
    }

    return 0;
  }
}
