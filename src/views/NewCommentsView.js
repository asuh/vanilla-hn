/**
 * NewCommentsView.js
 *
 * Displays a feed of recently updated comments across all of Hacker News.
 * Subscribes to the HN updates endpoint to get recently changed item IDs,
 * fetches each one, filters to comments only, and renders them in a
 * paginated list with author, time, parent story link, and comment text.
 *
 * @module views/NewCommentsView
 */

import View from "./View.js";
import { create, timeAgoFromUnix, escapeHTML } from "../utils/dom.js";

const PAGE_SIZE = 30;
const SITE_TITLE = "Vanilla HN";

/**
 * View that renders a feed of the most recently changed comments on HN.
 *
 * @class NewCommentsView
 * @extends View
 */
export default class NewCommentsView extends View {
  /**
   * @param {Object} [context]
   * @param {Object} [context.params]
   * @param {string|number} [context.params.page] - 1-based page number.
   * @param {Object} [context.services]
   * @param {Object} [context.services.hnService] - HN data service.
   * @param {Object} [context.stores]
   * @param {Object} [context.stores.settingsStore] - User preferences store.
   */
  constructor(context = {}) {
    super(context);
    const rawPage = (context.params && context.params.page) || 1;
    this.page = Math.max(1, parseInt(rawPage, 10) || 1);

    /** @type {Object|null} */
    this._hn = (this.services && this.services.hnService) || null;
    /** @type {Object|null} */
    this._settingsStore = (this.stores && this.stores.settingsStore) || null;

    /** @type {number[]} All comment IDs from the updates feed */
    this._allCommentIds = [];
    /** @type {Map<number, Object>} Fetched comment payloads keyed by ID */
    this._comments = new Map();
    /** @type {Function|null} Unsubscribe from updates feed */
    this._unsub = null;
    /** @type {Function[]} Per-item unsubscribe functions */
    this._itemUnsubs = [];
    /** @type {boolean} Whether the initial update IDs have arrived */
    this._loaded = false;

    /** @type {HTMLElement|null} */
    this._listEl = null;
    /** @type {HTMLElement|null} */
    this._paginationEl = null;
  }

  /**
   * Build and return the view's root DOM element.
   * @returns {HTMLElement}
   */
  render() {
    document.title = `New Comments | ${SITE_TITLE}`;

    const wrapper = create("div", {
      attrs: { class: "view newcomments-view" },
    });

    const heading = create("h1", { attrs: { class: "view__heading" } }, "New Comments");
    wrapper.appendChild(heading);

    const container = create("div", { attrs: { class: "container" } });

    this._listEl = create("ul", {
      attrs: {
        class: "comment-feed",
        role: "list",
        "aria-live": "polite",
        "aria-busy": "true",
      },
    });

    // Show loading skeletons
    this._renderSkeletons();

    this._paginationEl = create("nav", {
      attrs: { class: "list-view__pagination", "aria-label": "Pagination" },
    });

    container.appendChild(this._listEl);
    container.appendChild(this._paginationEl);
    wrapper.appendChild(container);

    this.root = wrapper;
    this._subscribe();
    return wrapper;
  }

  /**
   * Tear down subscriptions and DOM.
   */
  cleanup() {
    if (this._unsub) {
      try { this._unsub(); } catch (_) { /* ignore */ }
      this._unsub = null;
    }
    for (const unsub of this._itemUnsubs) {
      try { unsub(); } catch (_) { /* ignore */ }
    }
    this._itemUnsubs = [];
    this._comments.clear();
    super.cleanup();
  }

  // ── Private ──────────────────────────────────────────────────────────

  /**
   * Subscribe to the HN updates endpoint to get recently changed item IDs.
   * @private
   */
  _subscribe() {
    if (!this._hn || typeof this._hn.onUpdatesValue !== "function") {
      this._renderError("Data service unavailable.");
      return;
    }

    this._unsub = this._hn.onUpdatesValue((updates) => {
      if (!updates) return;

      // The updates endpoint returns { items: [...ids], profiles: [...] }
      const itemIds = Array.isArray(updates)
        ? updates
        : Array.isArray(updates.items)
          ? updates.items
          : [];

      if (itemIds.length === 0 && !this._loaded) {
        this._loaded = true;
        this._renderEmpty();
        return;
      }

      // We'll fetch each item and filter to comments client-side.
      // Store all IDs — we'll identify comments as they load.
      this._fetchAndFilterComments(itemIds);
    });
  }

  /**
   * Fetch items by ID and filter to comments.
   * @param {number[]} itemIds
   * @private
   */
  _fetchAndFilterComments(itemIds) {
    // Cancel previous per-item subscriptions
    for (const unsub of this._itemUnsubs) {
      try { unsub(); } catch (_) { /* ignore */ }
    }
    this._itemUnsubs = [];
    this._comments.clear();
    this._allCommentIds = [];

    const showDead = this._settingsStore
      ? this._settingsStore.get("showDead")
      : false;
    const showDeleted = this._settingsStore
      ? this._settingsStore.get("showDeleted")
      : false;

    let pending = itemIds.length;
    let resolved = 0;

    const onItemResolved = () => {
      resolved++;
      // Once we've resolved enough to fill at least a page (or all), render
      if (
        (!this._loaded && resolved >= Math.min(pending, PAGE_SIZE * 2)) ||
        resolved >= pending
      ) {
        this._loaded = true;
        this._renderPage();
      }
    };

    for (const id of itemIds) {
      if (typeof this._hn.fetchItem === "function") {
        this._hn
          .fetchItem(id)
          .then((item) => {
            if (item && item.type === "comment") {
              if (item.dead && !showDead) { onItemResolved(); return; }
              if (item.deleted && !showDeleted) { onItemResolved(); return; }
              this._comments.set(item.id, item);
              this._allCommentIds.push(item.id);
            }
            onItemResolved();
          })
          .catch(() => onItemResolved());
      } else {
        // Fallback: use onItemValue for a single read
        const unsub = this._hn.onItemValue(id, (item) => {
          if (item && item.type === "comment") {
            if (item.dead && !showDead) { onItemResolved(); return; }
            if (item.deleted && !showDeleted) { onItemResolved(); return; }
            this._comments.set(item.id, item);
            this._allCommentIds.push(item.id);
          }
          onItemResolved();
        });
        if (typeof unsub === "function") this._itemUnsubs.push(unsub);
      }
    }

    // Edge case: no IDs at all
    if (itemIds.length === 0) {
      this._loaded = true;
      this._renderEmpty();
    }
  }

  /**
   * Render the current page of comments.
   * @private
   */
  _renderPage() {
    if (!this._listEl) return;

    // Sort by ID descending (newest first — higher IDs are newer on HN)
    const sorted = [...this._allCommentIds].sort((a, b) => b - a);

    const startIndex = (this.page - 1) * PAGE_SIZE;
    const pageItems = sorted.slice(startIndex, startIndex + PAGE_SIZE);
    const hasMore = startIndex + PAGE_SIZE < sorted.length;

    if (pageItems.length === 0 && this.page === 1) {
      this._renderEmpty();
      return;
    }

    this._listEl.innerHTML = "";
    this._listEl.setAttribute("aria-busy", "false");

    const fragment = document.createDocumentFragment();

    for (const id of pageItems) {
      const comment = this._comments.get(id);
      if (!comment) continue;
      fragment.appendChild(this._createCommentRow(comment));
    }

    this._listEl.appendChild(fragment);
    this._renderPagination(hasMore);
  }

  /**
   * Create a single comment row element for the feed.
   *
   * @param {Object} comment - HN comment item.
   * @returns {HTMLElement} An `<li>` element.
   * @private
   */
  _createCommentRow(comment) {
    const li = create("li", {
      attrs: {
        class: `comment-feed__item${comment.dead ? " comment-feed__item--dead" : ""}`,
        "data-id": String(comment.id),
      },
    });

    // Meta line: author · time · on Story#parent
    const meta = create("div", { attrs: { class: "comment-feed__meta" } });

    if (comment.by) {
      const byLink = create(
        "a",
        { attrs: { href: `#/user/${comment.by}`, class: "comment-feed__author" } },
        comment.by,
      );
      meta.appendChild(byLink);
    }

    if (comment.time) {
      meta.appendChild(document.createTextNode(" · "));
      const time = create(
        "span",
        { attrs: { class: "comment-feed__time" } },
        timeAgoFromUnix(comment.time),
      );
      meta.appendChild(time);
    }

    // Link to parent item (story or comment)
    if (comment.parent) {
      meta.appendChild(document.createTextNode(" | "));
      const parentLink = create(
        "a",
        { attrs: { href: `#/item/${comment.parent}`, class: "comment-feed__parent-link" } },
        "parent",
      );
      meta.appendChild(parentLink);
    }

    li.appendChild(meta);

    // Comment text
    if (comment.text) {
      const textEl = create("div", {
        attrs: { class: "comment-feed__text" },
        html: comment.text, // HN API returns pre-sanitized HTML
      });
      li.appendChild(textEl);
    } else if (comment.deleted) {
      const deletedEl = create(
        "div",
        { attrs: { class: "comment-feed__text comment-feed__text--deleted" } },
        "[deleted]",
      );
      li.appendChild(deletedEl);
    }

    return li;
  }

  /**
   * Render pagination controls.
   * @param {boolean} hasMore - Whether there are more pages.
   * @private
   */
  _renderPagination(hasMore) {
    if (!this._paginationEl) return;
    this._paginationEl.innerHTML = "";

    const fragment = document.createDocumentFragment();

    if (this.page > 1) {
      const prevPage = this.page - 1;
      const prevHref = prevPage === 1 ? "#/newcomments" : `#/newcomments?page=${prevPage}`;
      const prev = create(
        "a",
        { attrs: { href: prevHref, class: "pagination__link", rel: "prev" } },
        "\u2190 prev",
      );
      fragment.appendChild(prev);
    }

    if (hasMore) {
      if (this.page > 1) {
        fragment.appendChild(document.createTextNode(" | "));
      }
      const next = create(
        "a",
        {
          attrs: {
            href: `#/newcomments?page=${this.page + 1}`,
            class: "pagination__link",
            rel: "next",
          },
        },
        "more \u2192",
      );
      fragment.appendChild(next);
    }

    this._paginationEl.appendChild(fragment);
  }

  // ── Placeholder states ───────────────────────────────────────────────

  /**
   * @private
   */
  _renderSkeletons() {
    if (!this._listEl) return;
    this._listEl.innerHTML = "";
    for (let i = 0; i < PAGE_SIZE; i++) {
      const li = create("li", {
        attrs: { class: "comment-feed__item comment-feed__item--skeleton", "aria-hidden": "true" },
      });
      const metaSkel = create("div", { attrs: { class: "skeleton skeleton--meta" } });
      metaSkel.innerHTML = "&nbsp;";
      const textSkel = create("div", { attrs: { class: "skeleton skeleton--text" } });
      textSkel.innerHTML = "&nbsp;<br>&nbsp;";
      li.appendChild(metaSkel);
      li.appendChild(textSkel);
      this._listEl.appendChild(li);
    }
  }

  /**
   * @private
   */
  _renderEmpty() {
    if (!this._listEl) return;
    this._listEl.innerHTML = "";
    this._listEl.setAttribute("aria-busy", "false");
    const li = create(
      "li",
      { attrs: { class: "comment-feed__item comment-feed__item--empty" } },
      "No new comments found.",
    );
    this._listEl.appendChild(li);
  }

  /**
   * @param {string} msg
   * @private
   */
  _renderError(msg) {
    if (!this._listEl) return;
    this._listEl.innerHTML = "";
    this._listEl.setAttribute("aria-busy", "false");
    const li = create(
      "li",
      { attrs: { class: "comment-feed__item comment-feed__item--error" } },
      msg,
    );
    this._listEl.appendChild(li);
  }
}
