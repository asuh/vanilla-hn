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

import { Paginator } from "../components/Paginator.js";
import { createSpinner } from "../components/Spinner.js";
import { create, timeAgoFromUnix } from "../utils/dom.js";
import { fetchCommentAncestors, itemPath } from "../utils/item-ancestors.js";
import View from "./View.js";

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
    const rawPage = context.params?.page || 1;
    this.page = Math.max(1, parseInt(rawPage, 10) || 1);

    /** @type {Object|null} */
    this._hn = this.services?.hnService || null;
    /** @type {Object|null} */
    this._settingsStore = this.stores?.settingsStore || null;

    /** @type {Object[]} Comment payloads from the updates store */
    this._comments = [];
    /** @type {Function|null} Unsubscribe from updates store */
    this._unsub = null;
    this._updatesStore = this.stores.updatesStore || null;

    /** @type {number[]} Interval IDs for live time tickers */
    this._timeTimers = [];

    /** @type {HTMLElement|null} */
    this._listEl = null;
    /** @type {HTMLElement|null} */
    this._paginationEl = null;
    /** @type {Paginator|null} */
    this._paginator = null;
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

    const heading = create("h1", { attrs: { class: "heading" } }, "New Comments");
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

    this._renderLoading();

    this._paginator = new Paginator({
      page: this.page,
      hasMore: false,
      buildHref: (p) => (p <= 1 ? "/newcomments" : `/newcomments?page=${p}`),
    });
    this._paginationEl = this._paginator.render();

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
    this._clearTimeTimers();
    if (this._unsub) {
      try {
        this._unsub();
      } catch (_) {
        /* ignore */
      }
      this._unsub = null;
    }
    this._updatesStore?.stop();
    this._comments = [];
    if (this._paginator) {
      this._paginator.cleanup();
      this._paginator = null;
    }
    super.cleanup();
  }

  // ── Private ──────────────────────────────────────────────────────────

  /**
   * Subscribe to the updates store.
   * @private
   */
  _subscribe() {
    if (!this._updatesStore) {
      this._renderError("Updates store unavailable.");
      return;
    }

    this._updatesStore.start();
    this._unsub = this._updatesStore.addListener((updates, status = {}) => {
      const showDead = this._settingsStore ? this._settingsStore.get("showDead") : false;
      const showDeleted = this._settingsStore ? this._settingsStore.get("showDeleted") : false;
      const comments = (updates.comments || []).filter((comment) => {
        if (comment.dead && !showDead) return false;
        if (comment.deleted && !showDeleted) return false;
        return true;
      });
      if (!status.ready && comments.length === 0) return;
      this._comments = comments;
      this._renderPage();
    });
  }

  /**
   * Render the current page of comments.
   * @private
   */
  _renderPage() {
    if (!this._listEl) return;
    this._clearTimeTimers();

    const sorted = this._comments.slice().sort((a, b) => (b.time || 0) - (a.time || 0));

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

    for (const comment of pageItems) {
      fragment.appendChild(this._createCommentRow(comment));
    }

    this._listEl.appendChild(fragment);
    if (this._paginator) {
      this._paginator.update({ page: this.page, hasMore });
    }
  }

  _clearTimeTimers() {
    for (const id of this._timeTimers) clearInterval(id);
    this._timeTimers = [];
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
        class: `entry${comment.dead ? " dead" : ""}`,
        "data-id": String(comment.id),
      },
    });

    // Meta line: author · time · parent/on story
    const meta = create("div", { attrs: { class: "meta" } });

    if (comment.by) {
      const byLink = create(
        "a",
        {
          attrs: {
            href: `/user/${comment.by}`,
            class: "author",
          },
        },
        comment.by,
      );
      meta.appendChild(byLink);
    }

    if (comment.time) {
      meta.appendChild(document.createTextNode(" · "));
      const time = create("span", { attrs: { class: "time" } }, timeAgoFromUnix(comment.time));
      meta.appendChild(time);

      // Tick the time text live while the comment is recent (< 1h old)
      const diffMs = Date.now() - comment.time * 1000;
      const initialInterval = diffMs < 60_000 ? 1_000 : diffMs < 3_600_000 ? 60_000 : 0;
      if (initialInterval > 0) {
        const tick = () => {
          time.textContent = timeAgoFromUnix(comment.time);
          // Reschedule at coarser interval once we've crossed 60 s
          const age = Date.now() - comment.time * 1000;
          const next = age < 60_000 ? 1_000 : age < 3_600_000 ? 60_000 : 0;
          if (next === 0) {
            // No more ticking needed — clear the stored timer
            this._timeTimers = this._timeTimers.filter((id) => id !== timerId);
          } else if (next !== currentInterval) {
            clearInterval(timerId);
            timerId = setInterval(tick, next);
            currentInterval = next;
            this._timeTimers = this._timeTimers.filter((id) => id !== oldId);
            this._timeTimers.push(timerId);
          }
          // eslint-disable-next-line no-unused-vars
          oldId = timerId;
        };
        let oldId;
        let currentInterval = initialInterval;
        let timerId = setInterval(tick, initialInterval);
        this._timeTimers.push(timerId);
      }
    }

    this._appendAncestorLinks(comment, meta).catch(() => {});

    li.appendChild(meta);

    // Comment text
    if (comment.text) {
      const textEl = create("div", {
        attrs: { class: "text" },
        html: comment.text, // HN API returns pre-sanitized HTML
      });
      li.appendChild(textEl);
    } else if (comment.deleted) {
      const deletedEl = create("div", { attrs: { class: "text deleted" } }, "[deleted]");
      li.appendChild(deletedEl);
    }

    return li;
  }

  async _appendAncestorLinks(comment, meta) {
    if (!this._hn || typeof this._hn.fetchItem !== "function") return;
    const result = await fetchCommentAncestors(this._hn, comment, {
      signal: this.signal,
    });
    if (!meta.isConnected) return;
    if (result.parent && result.op && comment.parent !== result.op.id) {
      meta.appendChild(document.createTextNode(" | "));
      meta.appendChild(
        create(
          "a",
          { attrs: { href: itemPath(result.parent.type, comment.parent), class: "parent-link" } },
          "parent",
        ),
      );
    }
    if (result.op) {
      meta.appendChild(document.createTextNode(" | on: "));
      meta.appendChild(
        create(
          "a",
          { attrs: { href: itemPath(result.op), class: "op-link" } },
          result.op.title || `Item ${result.op.id}`,
        ),
      );
    }
  }

  // ── Placeholder states ───────────────────────────────────────────────

  /**
   * @private
   */
  _renderLoading() {
    if (!this._listEl) return;
    this._listEl.replaceChildren(
      create(
        "li",
        { attrs: { class: "entry loading" } },
        createSpinner({ size: "20px", label: "Loading new comments…" }),
      ),
    );
  }

  /**
   * @private
   */
  _renderEmpty() {
    if (!this._listEl) return;
    this._listEl.innerHTML = "";
    this._listEl.setAttribute("aria-busy", "false");
    const li = create("li", { attrs: { class: "entry empty" } }, "No new comments found.");
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
    const li = create("li", { attrs: { class: "entry error" } }, msg);
    this._listEl.appendChild(li);
  }
}
