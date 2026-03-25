/**
 * ListView.js
 *
 * Full story-list view for vanilla-hn (no frameworks, no React).
 *
 * Exports:
 *  - default:     ListView  — paginated story list with read-state, new-comment badges, spinners
 *  - named:       UserView  — user profile view (karma, created, about, HN link)
 *
 * Context shape expected by both views:
 *  {
 *    params:   { page?: string|number, id?: string },
 *    stores:   { settingsStore, readStoriesStore, threadStore },
 *    services: { hnService },
 *    options:  { listType? },   // may also live directly on context as context.listType
 *  }
 */

import View from "./View.js";
import StoryCommentThreadStore from "../stores/StoryCommentThreadStore.js";
import { create, timeAgoFromUnix, delegate } from "../utils/dom.js";

/* ─────────────────────────────────────────────
   Constants
───────────────────────────────────────────── */

const PAGE_SIZE = 30;

/** Human-readable display names for each list type. */
const LIST_TITLES = {
  top: "News",
  newest: "Newest",
  ask: "Ask HN",
  show: "Show HN",
  jobs: "Jobs",
};

/* ─────────────────────────────────────────────
   Small helpers (module-private)
───────────────────────────────────────────── */

/**
 * Extract hostname from a URL string, stripping the leading "www." if present.
 * Returns null when the URL is falsy or cannot be parsed.
 *
 * @param {string|null|undefined} url
 * @returns {string|null}
 */
function extractHost(url) {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (_) {
    return null;
  }
}

/**
 * Build the hash fragment used for pagination links.
 * Examples:
 *   paginationHref('top',    1) → '#/'
 *   paginationHref('top',    2) → '#/?page=2'
 *   paginationHref('newest', 1) → '#/newest'
 *   paginationHref('newest', 3) → '#/newest?page=3'
 *
 * @param {string} listType
 * @param {number} page      1-based page number
 * @returns {string}
 */
function paginationHref(listType, page) {
  const base = listType === "top" ? "#/" : `#/${listType}`;
  return page <= 1 ? base : `${base}?page=${page}`;
}

/**
 * Create a single animated skeleton placeholder `<li>` element shown while
 * the real story data is being fetched.
 *
 * @param {number} rank  1-based rank number to show in the rank column
 * @returns {HTMLLIElement}
 */
function createSkeletonItem(rank) {
  const li = create("li", {
    attrs: {
      class: "item item--skeleton",
      role: "listitem",
      "aria-hidden": "true",
    },
  });

  // Rank
  const rankEl = create(
    "span",
    { attrs: { class: "item__rank" } },
    String(rank),
  );

  // Content column
  const col = create("div", { attrs: { class: "col item__col" } });

  // Skeleton title bar
  const titleShimmer = create("div", { attrs: { class: "item__title" } });
  const titleLink = create("a", {
    attrs: {
      class: "item__title-link item__title-link--skeleton",
      href: "#",
      tabindex: "-1",
      "aria-label": "Loading…",
    },
  });
  // Varying widths make the skeleton look more natural
  const widths = ["72%", "65%", "80%", "58%", "74%"];
  titleLink.style.width = widths[(rank - 1) % widths.length];
  titleShimmer.appendChild(titleLink);
  col.appendChild(titleShimmer);

  // Skeleton meta bar
  const metaShimmer = create("div", {
    attrs: { class: "meta item__meta--skeleton" },
  });
  col.appendChild(metaShimmer);

  li.appendChild(rankEl);
  li.appendChild(col);
  return li;
}

/**
 * Render 30 skeleton placeholder list items into the given `<ul>` element,
 * replacing whatever was there before.
 *
 * @param {HTMLUListElement} listEl
 * @param {number}           startRank  rank of the first visible item on this page
 */
function renderSkeletons(listEl, startRank = 1) {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < PAGE_SIZE; i++) {
    frag.appendChild(createSkeletonItem(startRank + i));
  }
  listEl.replaceChildren(frag);
}

/* ─────────────────────────────────────────────
   ListView
───────────────────────────────────────────── */

export default class ListView extends View {
  /**
   * @param {Object} context
   */
  constructor(context = {}) {
    super(context);

    // Resolve the list type from options or direct context property
    this.listType =
      (context.options && context.options.listType) ||
      context.listType ||
      "top";

    // Parse page number (1-based, default 1)
    const rawPage = (context.params && context.params.page) || 1;
    this.page = Math.max(1, parseInt(rawPage, 10) || 1);

    // All items returned from the service for this list type
    this._allItems = [];

    // Unsubscribe function returned by hnService.onStoriesValue
    this._unsub = null;

    // Delegate-listener teardown returned by delegate()
    this._undelegateClick = null;

    // Whether the initial data has arrived yet
    this._loaded = false;

    // Convenience references to commonly used stores / service
    this._hn = this.services.hnService || null;
    this._readStore = this.stores.readStoriesStore || null;
    this._threadStore = this.stores.threadStore || null;
  }

  /* ─────────────────────────────────────
     Lifecycle – render
  ───────────────────────────────────── */

  /**
   * Build the initial DOM skeleton and kick off the data subscription.
   * Returns the root HTMLElement synchronously so the Router can mount it
   * right away; the list content is filled in once data arrives.
   *
   * @returns {HTMLElement}
   */
  render() {
    const titleText = LIST_TITLES[this.listType] || this.listType;
    document.title = `${titleText} | vanilla-hn`;

    // ── Outer wrapper ──────────────────────────────────────────────────────
    const wrapper = create("div", { attrs: { class: "view list-view" } });

    // ── Page heading ───────────────────────────────────────────────────────
    const header = create(
      "header",
      { attrs: { class: "list-view__header container" } },
      create("h1", { attrs: { class: "list-view__title" } }, titleText),
    );
    wrapper.appendChild(header);

    // ── Main content container ─────────────────────────────────────────────
    const main = create("main", {
      attrs: { class: "container list-view__main" },
    });

    // Story list (populated once data arrives or on update)
    this._listEl = create("ul", {
      attrs: {
        class: "story-list",
        role: "list",
        "aria-label": `${titleText} stories`,
        "aria-live": "polite",
        "aria-busy": "true",
      },
    });

    // Render loading skeletons immediately so the page isn't blank
    const startRank = (this.page - 1) * PAGE_SIZE + 1;
    renderSkeletons(this._listEl, startRank);

    main.appendChild(this._listEl);

    // Pagination nav (empty until data arrives)
    this._paginationEl = create("nav", {
      attrs: {
        class: "list-view__pagination",
        "aria-label": "Pagination",
      },
    });
    main.appendChild(this._paginationEl);

    wrapper.appendChild(main);
    this.root = wrapper;

    // Start the realtime subscription (fills in the list when data arrives)
    this._subscribe();

    return wrapper;
  }

  /* ─────────────────────────────────────
     Lifecycle – event listeners
  ───────────────────────────────────── */

  /**
   * Wire a delegated click handler on the story list so we can mark stories
   * as read when their title links are clicked.
   *
   * Called by the Router after the element is in the DOM.
   */
  attachEventListeners() {
    if (!this._listEl) return;

    // We listen on the list root and let events bubble up, matching
    // only the internal `#/item/…` title anchors (class item__title-link).
    this._undelegateClick = delegate(
      this._listEl,
      "click",
      "a.item__title-link[data-id]",
      (_ev, anchor) => {
        const id = anchor.dataset.id;
        if (id && this._readStore) {
          this._readStore.markAsRead(id);
          // Visually mark the row as read immediately without waiting for a
          // full re-render (keeps the UI snappy)
          const li = anchor.closest("li.item");
          if (li) li.classList.add("item--read");
        }
      },
    );
  }

  /* ─────────────────────────────────────
     Lifecycle – cleanup
  ───────────────────────────────────── */

  /**
   * Unsubscribe from hnService and tear down delegated event listeners.
   * The base class cleanup() handles the AbortController and any extra
   * unsubscribers registered via watchEvent().
   */
  cleanup() {
    if (typeof this._unsub === "function") {
      try {
        this._unsub();
      } catch (_) {}
      this._unsub = null;
    }

    if (typeof this._undelegateClick === "function") {
      try {
        this._undelegateClick();
      } catch (_) {}
      this._undelegateClick = null;
    }

    try {
      super.cleanup();
    } catch (_) {}
  }

  /* ─────────────────────────────────────
     Private – data subscription
  ───────────────────────────────────── */

  /**
   * Subscribe to hnService for the current list type.
   * The callback receives the *full* array of item objects every time the
   * data changes (initial load + any realtime updates).
   */
  _subscribe() {
    if (!this._hn || typeof this._hn.onStoriesValue !== "function") {
      this._renderError("Data service unavailable.");
      return;
    }

    this._unsub = this._hn.onStoriesValue(this.listType, (items) => {
      try {
        this._allItems = Array.isArray(items) ? items : [];
        this._loaded = true;
        this._renderPage();
      } catch (err) {
        console.warn("ListView: error rendering story list", err);
      }
    });
  }

  /* ─────────────────────────────────────
     Private – rendering
  ───────────────────────────────────── */

  /**
   * Slice `_allItems` to the current page window and render the list items
   * plus pagination controls.
   */
  _renderPage() {
    const start = (this.page - 1) * PAGE_SIZE; // inclusive, 0-based index
    const end = start + PAGE_SIZE; // exclusive
    const pageItems = this._allItems.slice(start, end);
    const hasMore = this._allItems.length > end;

    // ── Story list ─────────────────────────────────────────────────────────
    if (pageItems.length === 0) {
      this._renderEmpty();
    } else {
      const frag = document.createDocumentFragment();
      pageItems.forEach((item, idx) => {
        frag.appendChild(
          this._createItemEl(item, start + idx + 1 /* 1-based rank */),
        );
      });
      this._listEl.replaceChildren(frag);
    }

    // Mark list as loaded (for assistive tech live region)
    this._listEl.setAttribute("aria-busy", "false");

    // ── Pagination ─────────────────────────────────────────────────────────
    this._renderPagination(hasMore);
  }

  /**
   * Show a "no stories found" message in the list container.
   */
  _renderEmpty() {
    this._listEl.replaceChildren(
      create(
        "li",
        { attrs: { class: "item item--empty", role: "listitem" } },
        "No stories found.",
      ),
    );
  }

  /**
   * Show an error message in the list container.
   *
   * @param {string} msg
   */
  _renderError(msg) {
    if (!this._listEl) return;
    this._listEl.replaceChildren(
      create(
        "li",
        { attrs: { class: "item item--error", role: "listitem" } },
        msg,
      ),
    );
    this._listEl.setAttribute("aria-busy", "false");
  }

  /**
   * Build and inject the prev / next navigation links.
   *
   * @param {boolean} hasMore  true when there is at least one more page after this one
   */
  _renderPagination(hasMore) {
    if (!this._paginationEl) return;

    const children = [];

    if (this.page > 1) {
      children.push(
        create(
          "a",
          {
            attrs: {
              href: paginationHref(this.listType, this.page - 1),
              class:
                "list-view__pagination-link list-view__pagination-link--prev",
              rel: "prev",
            },
          },
          "← prev",
        ),
      );
    }

    if (hasMore) {
      children.push(
        create(
          "a",
          {
            attrs: {
              href: paginationHref(this.listType, this.page + 1),
              class:
                "list-view__pagination-link list-view__pagination-link--next",
              rel: "next",
            },
          },
          "more →",
        ),
      );
    }

    this._paginationEl.replaceChildren(...children);
  }

  /**
   * Create a single `<li class="item">` element for the given story object.
   *
   * Structure:
   *   <li class="item [item--read]">
   *     <span class="item__rank">N.</span>
   *     <div class="col item__col">
   *       <div class="item__title">
   *         <a href="[external url or #/item/id]" class="item__title-link" [target="_blank"] [data-id]>Title</a>
   *         [<span class="item-host">(hostname)</span>]       ← only for external links
   *       </div>
   *       <div class="meta item__meta">
   *         NNN points |
   *         by <a href="#/user/name">name</a> |
   *         3 hours ago |
   *         <a href="#/item/id">N comments</a>  [<span class="badge badge--new">+N new</span>]
   *       </div>
   *     </div>
   *   </li>
   *
   * @param {Object} item   HN item object
   * @param {number} rank   1-based rank for this page
   * @returns {HTMLLIElement}
   */
  _createItemEl(item, rank) {
    const id = item.id != null ? String(item.id) : "";
    const title = item.title || `Story ${id}`;
    const by = item.by || "unknown";
    const score = item.score != null ? item.score : 0;
    const descendants =
      item.descendants != null
        ? item.descendants
        : Array.isArray(item.kids)
          ? item.kids.length
          : 0;
    const url = item.url || null;
    const host = extractHost(url);
    const isRead = this._readStore ? this._readStore.isRead(id) : false;
    const timeAgo = timeAgoFromUnix(item.time);

    // ── Root <li> ──────────────────────────────────────────────────────────
    const li = create("li", {
      attrs: {
        class: `item${isRead ? " item--read" : ""}`,
        role: "listitem",
        "data-id": id,
      },
    });

    // ── Rank ───────────────────────────────────────────────────────────────
    li.appendChild(
      create(
        "span",
        { attrs: { class: "item__rank", "aria-label": `Rank ${rank}` } },
        `${rank}.`,
      ),
    );

    // ── Content column ─────────────────────────────────────────────────────
    const col = create("div", { attrs: { class: "col item__col" } });

    // ── Title row ──────────────────────────────────────────────────────────
    const titleRow = create("div", { attrs: { class: "item__title title" } });

    if (url) {
      // External link — opens in a new tab; the internal "comments" link is in meta
      const extLink = create(
        "a",
        {
          attrs: {
            href: url,
            class: "item__title-link",
            target: "_blank",
            rel: "noopener noreferrer",
            "aria-label": `${title} (external link, opens in new tab)`,
          },
        },
        title,
      );
      titleRow.appendChild(extLink);

      // Hostname badge next to the title
      if (host) {
        titleRow.appendChild(
          create("span", { attrs: { class: "item-host" } }, `(${host})`),
        );
      }
    } else {
      // No external URL — link directly to the comments / item page
      const intLink = create(
        "a",
        {
          attrs: {
            href: `#/item/${id}`,
            class: "item__title-link",
            "data-id": id, // picked up by delegated click handler
          },
        },
        title,
      );
      titleRow.appendChild(intLink);
    }

    col.appendChild(titleRow);

    // ── Meta row ───────────────────────────────────────────────────────────
    const meta = create("div", { attrs: { class: "meta item__meta" } });

    // Score
    meta.appendChild(
      create(
        "span",
        { attrs: { class: "item__score" } },
        `${score} point${score !== 1 ? "s" : ""}`,
      ),
    );
    meta.appendChild(document.createTextNode(" by "));

    // Author link
    meta.appendChild(
      create("a", { attrs: { href: `#/user/${by}`, class: "item__by" } }, by),
    );
    meta.appendChild(document.createTextNode(" · "));

    // Relative time
    if (timeAgo) {
      meta.appendChild(
        create("span", { attrs: { class: "item__time" } }, timeAgo),
      );
      meta.appendChild(document.createTextNode(" · "));
    }

    // Comments link — always goes to the internal item page
    const commentsLink = create(
      "a",
      {
        attrs: {
          href: `#/item/${id}`,
          class: "item__comments",
          "data-id": id, // also needed here so clicking "N comments" marks as read
        },
      },
      `${descendants} comment${descendants !== 1 ? "s" : ""}`,
    );
    meta.appendChild(commentsLink);

    // ── New-comment badge ──────────────────────────────────────────────────
    const badge = this._newCommentBadge(id, descendants);
    if (badge) meta.appendChild(badge);

    col.appendChild(meta);
    li.appendChild(col);

    return li;
  }

  /**
   * Compute and return a new-comment badge element, or `null` if none is needed.
   *
   * A badge is shown when:
   *   • We have a persisted thread state for this story (i.e., the user has
   *     visited the comment thread before), AND
   *   • The current descendant count exceeds the stored comment count.
   *
   * @param {string} id           story id (string)
   * @param {number} descendants  current total comment count from API
   * @returns {HTMLElement|null}
   */
  _newCommentBadge(id, descendants) {
    if (!id || descendants == null) return null;

    let threadState = null;
    try {
      // StoryCommentThreadStore.loadState is called as an instance method.
      // The store's loadState() (no args) re-reads from storage into this._map;
      // the useful per-story data is retrieved via getState(id).
      if (
        this._threadStore &&
        typeof this._threadStore.getState === "function"
      ) {
        threadState = this._threadStore.getState(id);
      }
    } catch (_) {
      return null;
    }

    if (!threadState) return null;

    const { commentCount } = threadState;
    if (typeof commentCount !== "number" || commentCount <= 0) return null;

    const newCount = descendants - commentCount;
    if (newCount <= 0) return null;

    return create(
      "span",
      {
        attrs: {
          class: "badge badge--new",
          role: "status",
          "aria-label": `${newCount} new comment${newCount !== 1 ? "s" : ""}`,
        },
      },
      `+${newCount} new`,
    );
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   UserView
   ─────────────────────────────────────────────────────────────────────────
   Renders a Hacker News user profile page.

   Context:
     params.id  — the username (string)
     services.hnService.onUserValue(userId, cb) — realtime subscription
                  callback receives { id, karma, created, about }

   DOM structure:
     <div class="view user-view">
       <div class="container user-view__content">
         <h2 class="user-view__name">username</h2>
         <dl class="user-view__stats">
           <dt>karma</dt>  <dd>NNN</dd>
           <dt>joined</dt> <dd>X years ago</dd>
         </dl>
         <div class="user-view__about">…HTML from HN…</div>   ← set via innerHTML
         <p class="user-view__hn-link">
           <a href="https://news.ycombinator.com/user?id=username">profile on HN ↗</a>
         </p>
       </div>
     </div>
═══════════════════════════════════════════════════════════════════════════ */

export class UserView extends View {
  /**
   * @param {Object} context
   */
  constructor(context = {}) {
    super(context);

    this.userId =
      (context.params && context.params.id) ||
      (context.options && context.options.id) ||
      null;

    this._unsub = null;
    this._contentEl = null;
  }

  /* ─────────────────────────────────────
     Lifecycle
  ───────────────────────────────────── */

  /**
   * Build the initial shell and subscribe to user data.
   * @returns {HTMLElement}
   */
  render() {
    document.title = `${this.userId || "User"} | vanilla-hn`;

    const wrapper = create("div", { attrs: { class: "view user-view" } });

    this._contentEl = create("div", {
      attrs: { class: "container user-view__content" },
    });

    // Show a loading indicator immediately
    this._contentEl.appendChild(
      create(
        "p",
        { attrs: { class: "user-view__loading" } },
        create("span", {
          attrs: {
            class: "spinner",
            role: "status",
            "aria-label": "Loading user profile…",
          },
        }),
      ),
    );

    wrapper.appendChild(this._contentEl);
    this.root = wrapper;

    this._subscribe();
    return wrapper;
  }

  cleanup() {
    if (typeof this._unsub === "function") {
      try {
        this._unsub();
      } catch (_) {}
      this._unsub = null;
    }
    try {
      super.cleanup();
    } catch (_) {}
  }

  /* ─────────────────────────────────────
     Private
  ───────────────────────────────────── */

  _subscribe() {
    const hn = this.services && this.services.hnService;

    if (!hn || typeof hn.onUserValue !== "function" || !this.userId) {
      this._renderError(
        "User data service unavailable or no user id provided.",
      );
      return;
    }

    this._unsub = hn.onUserValue(this.userId, (user) => {
      try {
        if (!user) {
          this._renderError(`User "${this.userId}" not found.`);
        } else {
          document.title = `${user.id || this.userId} | vanilla-hn`;
          this._renderUser(user);
        }
      } catch (err) {
        console.warn("UserView: error rendering user", err);
      }
    });
  }

  /**
   * Replace the content element's children with the fully rendered user profile.
   *
   * @param {Object} user  — { id, karma, created (unix seconds), about (HTML string) }
   */
  _renderUser(user) {
    if (!this._contentEl) return;

    const id = user.id || this.userId || "Unknown";
    const karma = user.karma != null ? user.karma : 0;
    const created =
      user.created != null ? timeAgoFromUnix(user.created) : "unknown";
    const about = user.about || ""; // may contain HTML (HN returns <a>, <p>, etc.)
    const hnUrl = `https://news.ycombinator.com/user?id=${encodeURIComponent(id)}`;

    // ── Name heading ───────────────────────────────────────────────────────
    const heading = create("h2", { attrs: { class: "user-view__name" } }, id);

    // ── Stats table (karma + joined date) ──────────────────────────────────
    const stats = create(
      "dl",
      { attrs: { class: "user-view__stats" } },
      create("dt", {}, "karma"),
      create("dd", { attrs: { class: "user-view__karma" } }, String(karma)),
      create("dt", {}, "joined"),
      create("dd", { attrs: { class: "user-view__joined" } }, created),
    );

    // ── About section ──────────────────────────────────────────────────────
    // HN returns the `about` field as pre-rendered HTML (links, paragraphs, etc.)
    // so we must use innerHTML here. This is fine because the content originates
    // directly from HN's API and is the user's own self-description.
    const aboutSection = create("div", {
      attrs: { class: "user-view__about" },
    });
    if (about) {
      aboutSection.innerHTML = about;
    }

    // ── External HN profile link ───────────────────────────────────────────
    const hnLink = create(
      "p",
      { attrs: { class: "user-view__hn-link" } },
      create(
        "a",
        {
          attrs: {
            href: hnUrl,
            target: "_blank",
            rel: "noopener noreferrer",
            class: "user-view__hn-link-anchor",
          },
        },
        `View ${id}'s profile on Hacker News ↗`,
      ),
    );

    // ── Replace content ────────────────────────────────────────────────────
    this._contentEl.replaceChildren(heading, stats, aboutSection, hnLink);
  }

  /**
   * Show a plain-text error message in the content area.
   * @param {string} msg
   */
  _renderError(msg) {
    if (!this._contentEl) return;
    this._contentEl.replaceChildren(
      create("p", { attrs: { class: "user-view__error" } }, msg),
    );
  }
}
