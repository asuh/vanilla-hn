/**
 * ListView.js
 *
 * Full story-list view for vanilla-hn (no frameworks, no React).
 *
 * Exports:
 *  - default: ListView — paginated story list with read-state, new-comment badges, spinners
 *
 * Context shape expected by this view:
 *  {
 *    params:   { page?: string|number },
 *    stores:   { settingsStore, readStoriesStore, threadStore },
 *    services: { hnService },
 *    options:  { listType? },   // may also live directly on context as context.listType
 *  }
 */

import { Paginator } from "../components/Paginator.js";
import StoryStore from "../stores/StoryStore.js";
import { create, delegate, timeAgoFromUnix } from "../utils/dom.js";
import { parseHost, pluralise } from "../utils/helpers.js";
import { itemPath, rememberItem } from "../utils/item-ancestors.js";
import View from "./View.js";

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
  read: "Read Stories",
};

/* ─────────────────────────────────────────────
   Small helpers (module-private)
───────────────────────────────────────────── */

/**
 * Build the hash fragment used for pagination links.
 * Examples:
 *   paginationHref('top',    1) → '/'
 *   paginationHref('top',    2) → '/?page=2'
 *   paginationHref('newest', 1) → '/newest'
 *   paginationHref('newest', 3) → '/newest?page=3'
 *
 * @param {string} listType
 * @param {number} page      1-based page number
 * @returns {string}
 */
function paginationHref(listType, page) {
  const base = listType === "top" ? "/" : `/${listType}`;
  return page <= 1 ? base : `${base}?page=${page}`;
}

/**
 * Create a single animated skeleton placeholder `<li>` element shown while
 * the real story data is being fetched.
 *
 * @param {number} rank  1-based list position used to vary the skeleton width
 * @returns {HTMLLIElement}
 */
function createSkeletonItem(rank) {
  const li = create("li", {
    attrs: {
      class: "item skeleton",
      "aria-hidden": "true",
    },
  });

  // Content column
  const col = create("div", { attrs: { class: "col" } });

  // Skeleton title bar
  const titleShimmer = create("div", { attrs: { class: "title" } });
  const titleLink = create("span", {
    attrs: {
      class: "title-link shimmer",
    },
  });
  // Varying widths make the skeleton look more natural
  const widths = ["72%", "65%", "80%", "58%", "74%"];
  titleLink.style.width = widths[(rank - 1) % widths.length];
  titleShimmer.appendChild(titleLink);
  col.appendChild(titleShimmer);

  // Skeleton meta bar
  const metaShimmer = create("div", {
    attrs: { class: "meta shimmer" },
  });
  col.appendChild(metaShimmer);

  li.appendChild(col);
  return li;
}

/**
 * Render 30 skeleton placeholder list items into the given `<ol>` element,
 * replacing whatever was there before.
 *
 * @param {HTMLOListElement} listEl
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
   * Create a new ListView instance.
   *
   * @param {Object} context
   * @param {Object} [context.params]          - Route parameters (e.g. page number).
   * @param {string|number} [context.params.page] - 1-based page number (default 1).
   * @param {Object} [context.stores]          - Application stores.
   * @param {Object} [context.stores.readStoriesStore] - Store tracking read stories.
   * @param {Object} [context.stores.threadStore]      - Store tracking comment thread state.
   * @param {Object} [context.services]        - Application services.
   * @param {Object} [context.services.hnService]      - Hacker News data service.
   * @param {Object} [context.options]         - Additional options (e.g. listType).
   * @param {string} [context.options.listType] - The list type to display (top, newest, ask, show, jobs, read).
   * @param {string} [context.listType]        - Alternative location for list type.
   */
  constructor(context = {}) {
    super(context);

    // Resolve the list type from options or direct context property
    this.listType = context.options?.listType || context.listType || "top";

    // Parse page number (1-based, default 1)
    const rawPage = context.params?.page || 1;
    this.page = Math.max(1, parseInt(rawPage, 10) || 1);

    // All items returned from the service for this list type
    this._allItems = [];

    // Keyed DOM map: item id (string) → <li> element currently in the list.
    // Used for efficient per-item patching instead of full-list rebuilds.
    this._itemNodes = new Map();
    this._pageIds = [];

    // Unsubscribe function returned by hnService.onStoriesValue
    this._unsub = null;

    // Delegate-listener teardown returned by delegate()
    this._undelegateClick = null;

    // Whether the initial data has arrived yet
    this._loaded = false;

    // Paginator component instance
    this._paginator = null;

    // StoryStore instance (used for Firebase/mock modes, not "read" mode)
    this._storyStore = null;

    // Convenience references to commonly used stores / service
    this._hn = this.services.hnService || null;
    this._readStore = this.stores.readStoriesStore || null;
    this._threadStore = this.stores.threadStore || null;
    this._loadThreadState = this.stores.loadThreadState || null;
  }

  /* ─────────────────────────────────────
     Lifecycle – render
  ───────────────────────────────────── */

  /**
   * Build the initial DOM skeleton and kick off the data subscription.
   * Returns the root HTMLElement synchronously so the Router can mount it
   * right away; the list content is filled in once data arrives.
   *
   * @returns {HTMLElement} The root element for this view.
   */
  render() {
    const titleText = LIST_TITLES[this.listType] || this.listType;
    document.title = `${titleText} | vanilla-hn`;

    // ── Outer wrapper ──────────────────────────────────────────────────────
    const wrapper = create("div", { attrs: { class: "view list-view" } });

    // ── Page heading ───────────────────────────────────────────────────────
    const header = create(
      "header",
      { attrs: { class: "header container" } },
      create("h1", { attrs: { class: "list-title" } }, titleText),
    );
    wrapper.appendChild(header);

    // ── Content container ──────────────────────────────────────────────────
    const content = create("div", {
      attrs: { class: "container" },
    });

    // Story list (populated once data arrives or on update)
    const startRank = (this.page - 1) * PAGE_SIZE + 1;
    this._listEl = create("ol", {
      attrs: {
        class: "story-list",
        start: String(startRank),
        "aria-label": `${titleText} stories`,
        "aria-live": "polite",
        "aria-busy": "true",
      },
    });

    // Render loading skeletons immediately so the page isn't blank
    renderSkeletons(this._listEl, startRank);

    content.appendChild(this._listEl);

    // Pagination nav (empty until data arrives)
    this._paginator = new Paginator({
      page: this.page,
      hasMore: false,
      buildHref: (p) => paginationHref(this.listType, p),
      className: "pagination",
      linkClassName: "link",
    });
    this._paginationEl = this._paginator.render();
    content.appendChild(this._paginationEl);

    wrapper.appendChild(content);
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
   *
   * @returns {void}
   */
  attachEventListeners() {
    if (!this._listEl) return;

    // We listen on the list root and let events bubble up, matching
    // only the internal `/item/…` title anchors (class title-link).
    this._undelegateClick = delegate(
      this._listEl,
      "click",
      "a.title-link[data-id]",
      (_ev, anchor) => {
        const id = anchor.dataset.id;
        if (id && this._readStore) {
          this._readStore.markAsRead(id);
          // Visually mark the row as read immediately without waiting for a
          // full re-render (keeps the UI snappy)
          const li = anchor.closest("li.item");
          if (li) li.classList.add("read");
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
   *
   * @returns {void}
   */
  cleanup() {
    if (typeof this._unsub === "function") {
      try {
        this._unsub();
      } catch (_) {}
      this._unsub = null;
    }

    // Tear down StoryStore (handles its own item subs internally)
    if (this._storyStore) {
      this._storyStore.dispose();
      this._storyStore = null;
    }

    // Tear down per-item subscriptions opened in Firebase (ID-list) mode
    // (used by "read" mode which doesn't go through StoryStore)
    if (Array.isArray(this._itemUnsubs)) {
      this._itemUnsubs.forEach((fn) => {
        if (typeof fn === "function") fn();
      });
      this._itemUnsubs = [];
    }

    this._itemNodes.clear();

    // Tear down Paginator component
    if (this._paginator) {
      this._paginator.cleanup();
      this._paginator = null;
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
   *
   * The FirebaseBackend returns an array of numeric ID strings (e.g. ["40000001", …])
   * while the MockBackend returns full item objects. This method handles both cases:
   *
   *  - Full objects  → store directly in _allItems and render.
   *  - ID strings    → keep skeleton placeholders, then open a per-item subscription
   *                    via onItemValue() for each item on the current page so the
   *                    full item data fills in as Firebase responds.
   *
   * Only items on the *current page* get individual subscriptions, which avoids
   * opening hundreds of Firebase connections for the full 500-item top-stories list.
   *
   * When `this.listType === 'read'`, we skip Firebase entirely and instead pull
   * from `readStoriesStore.getReadStories()`, sorted by most-recently-read first.
   */
  _subscribe() {
    // ── Read stories mode ────────────────────────────────────────────────
    if (this.listType === "read") {
      if (!this._readStore || typeof this._readStore.getReadStories !== "function") {
        this._renderError("Read stories store unavailable.");
        return;
      }

      // Initialise the per-item unsub array
      if (!Array.isArray(this._itemUnsubs)) {
        this._itemUnsubs = [];
      }

      const reads = this._readStore.getReadStories(); // { storyId: timestamp }
      const sortedIds = Object.keys(reads).sort((a, b) => reads[b] - reads[a]);

      if (sortedIds.length === 0) {
        this._allItems = [];
        this._loaded = true;
        this._renderPage();
        return;
      }

      // Seed _allItems with lightweight placeholder objects
      this._allItems = sortedIds.map((id) => ({ id: String(id) }));
      this._loaded = true;
      this._renderPage();

      // Subscribe to full item data only for items on the current page
      const start = (this.page - 1) * PAGE_SIZE;
      const end = start + PAGE_SIZE;
      const pageIds = sortedIds.slice(start, end);

      if (this._hn && typeof this._hn.onItemValue === "function") {
        pageIds.forEach((id, pageIdx) => {
          const allIdx = start + pageIdx;
          const unsub = this._hn.onItemValue(id, (item) => {
            if (item && typeof item === "object") {
              this._allItems[allIdx] = item;
              rememberItem(item);
              this._patchItem(item);
            }
          });
          this._itemUnsubs.push(unsub);
        });
      }

      return;
    }

    // ── Normal (Firebase / Mock) mode via StoryStore ─────────────────────
    if (!this._hn || typeof this._hn.onStoriesValue !== "function") {
      this._renderError("Data service unavailable.");
      return;
    }

    this._storyStore = new StoryStore(this.listType, this._hn, {
      pageSize: PAGE_SIZE,
    });

    this._storyStore.addListener((store, changedItem) => {
      try {
        // Rebuild _allItems from the store's full ID list, using full item
        // objects where available and { id } placeholders elsewhere.
        this._allItems = store.ids.map((id) => store.getItem(id) || { id });

        const pageItems = store.getPageItems(this.page);
        const pageIds = this._getPageIds(pageItems);

        if (!this._loaded) {
          // First notification — do a full page render
          this._loaded = true;
          this._renderPage();

          // Always subscribe to individual items on the current page so that
          // fresh data (e.g. up-to-date descendants/score) replaces any stale
          // sessionStorage-cached values.
          if (pageIds.length > 0) {
            store.subscribeToItems(pageIds);
          }
        } else if (!this._samePageIds(pageIds)) {
          // The story ID order changed under a cached page. Rebuild the page so
          // rank numbers and DOM order stay in sync, then listen to the new IDs.
          this._renderPage();
          if (pageIds.length > 0) {
            store.subscribeToItems(pageIds);
          }
        } else {
          // Subsequent notifications — patch individual items that changed
          (changedItem ? [changedItem] : pageItems).forEach((item) => {
            if (item?.title || item?.type) {
              this._patchItem(item);
            }
          });

          // Update pagination in case total count changed
          const hasMore = store.hasNextPage(this.page);
          this._paginator.update({ page: this.page, hasMore });
        }
      } catch (err) {
        console.warn("ListView: error rendering story list", err);
      }
    });

    this._storyStore.subscribe();
  }

  /* ─────────────────────────────────────
     Private – rendering
  ───────────────────────────────────── */

  /**
   * Full list render — used once on initial load or when the page set changes.
   * Populates `_itemNodes` so subsequent updates can patch individual items.
   */
  _renderPage() {
    const start = (this.page - 1) * PAGE_SIZE; // inclusive, 0-based index
    const end = start + PAGE_SIZE; // exclusive
    const pageItems = this._allItems.slice(start, end);
    const hasMore = this._allItems.length > end;

    // ── Story list ─────────────────────────────────────────────────────────
    if (pageItems.length === 0) {
      this._pageIds = [];
      this._itemNodes.clear();
      this._renderEmpty();
    } else {
      const frag = document.createDocumentFragment();
      this._pageIds = this._getPageIds(pageItems);
      this._itemNodes.clear();
      pageItems.forEach((item, idx) => {
        const li = this._createItemEl(item, start + idx + 1);
        const key = item.id != null ? String(item.id) : String(start + idx);
        this._itemNodes.set(key, li);
        frag.appendChild(li);
      });
      this._listEl.replaceChildren(frag);
    }

    // Mark list as loaded (for assistive tech live region)
    this._listEl.setAttribute("aria-busy", "false");

    // ── Pagination ─────────────────────────────────────────────────────────
    if (this._paginator) {
      this._paginator.update({ page: this.page, hasMore });
    }
  }

  _getPageIds(pageItems) {
    return pageItems
      .map((item) => (item && item.id != null ? String(item.id) : ""))
      .filter(Boolean);
  }

  _samePageIds(nextIds) {
    if (nextIds.length !== this._pageIds.length) return false;
    for (let i = 0; i < nextIds.length; i++) {
      if (nextIds[i] !== this._pageIds[i]) return false;
    }
    return true;
  }

  /**
   * Keyed update — replace a single item's <li> in place without touching the
   * rest of the list. Falls back to a full _renderPage if the node is missing.
   *
   * @param {Object} item Full HN item payload
   */
  _patchItem(item) {
    const key = item.id != null ? String(item.id) : null;
    if (!key) return;

    const oldNode = this._itemNodes.get(key);
    if (!oldNode?.parentNode) {
      // Node not found in map or was removed — fall back to full render
      this._renderPage();
      return;
    }

    const newNode = this._createItemEl(item);
    oldNode.parentNode.replaceChild(newNode, oldNode);
    this._itemNodes.set(key, newNode);
  }

  /**
   * Show a "no stories found" message in the list container.
   */
  _renderEmpty() {
    this._listEl.replaceChildren(
      create("li", { attrs: { class: "item empty" } }, "No stories found."),
    );
  }

  /**
   * Show an error message in the list container.
   *
   * @param {string} msg
   */
  _renderError(msg) {
    if (!this._listEl) return;
    this._listEl.replaceChildren(create("li", { attrs: { class: "item error" } }, msg));
    this._listEl.setAttribute("aria-busy", "false");
  }

  /**
   * Create a single `<li class="item">` element for the given story object.
   *
   * Structure:
   *   <li class="item [read]">
   *     <div class="col">
   *       <div class="title">
   *         <a href="[external url or /item/id]" class="title-link" [data-id]>Title</a>
   *         [<span class="host">(hostname)</span>]       ← only for external links
   *       </div>
   *       <div class="meta">
   *         NNN points |
   *         by <a href="/user/name">name</a> |
   *         3 hours ago |
   *         <a href="/item/id">N comments</a>  [<span class="badge new">+N new</span>]
   *       </div>
   *     </div>
   *   </li>
   *
   * @param {Object} item   HN item object
   * @returns {HTMLLIElement}
   */
  _createItemEl(item, rank = 1) {
    const id = item.id != null ? String(item.id) : "";
    if (!item.title && !item.type) {
      const skeleton = createSkeletonItem(rank);
      skeleton.dataset.id = id;
      return skeleton;
    }
    rememberItem(item);
    const title = item.title || (item.deleted ? "[deleted]" : "[unavailable]");
    const by = item.by || "unknown";
    const score = item.score != null ? item.score : 0;
    const descendants =
      item.descendants != null ? item.descendants : Array.isArray(item.kids) ? item.kids.length : 0;
    const url = item.url || null;
    const host = parseHost(url);
    const isRead = this._readStore ? this._readStore.isRead(id) : false;
    const timeAgo = timeAgoFromUnix(item.time);

    // ── Root <li> ──────────────────────────────────────────────────────────
    const li = create("li", {
      attrs: {
        class: `item${isRead ? " read" : ""}`,
        "data-id": id,
      },
    });

    // ── Content column ─────────────────────────────────────────────────────
    const col = create("div", { attrs: { class: "col" } });

    // ── Title row ──────────────────────────────────────────────────────────
    const titleRow = create("div", { attrs: { class: "title" } });

    if (url) {
      // External story link; the internal "comments" link is in meta.
      const extLink = create(
        "a",
        {
          attrs: {
            href: url,
            class: "title-link",
          },
        },
        title,
      );
      titleRow.appendChild(extLink);

      // Hostname badge next to the title
      if (host) {
        titleRow.appendChild(create("span", { attrs: { class: "host" } }, `(${host})`));
      }
    } else {
      // No external URL — link directly to the comments / item page
      const intLink = create(
        "a",
        {
          attrs: {
            href: itemPath(item),
            class: "title-link",
            "data-id": id, // picked up by delegated click handler
          },
        },
        title,
      );
      titleRow.appendChild(intLink);
    }

    col.appendChild(titleRow);

    // ── Meta row ───────────────────────────────────────────────────────────
    const meta = create("div", { attrs: { class: "meta" } });

    // Score
    meta.appendChild(
      create("span", { attrs: { class: "score" } }, `${score} point${pluralise(score)}`),
    );
    meta.appendChild(document.createTextNode(" by "));

    // Author link
    meta.appendChild(create("a", { attrs: { href: `/user/${by}`, class: "by" } }, by));
    meta.appendChild(document.createTextNode(" · "));

    // Relative time
    if (timeAgo) {
      meta.appendChild(create("span", { attrs: { class: "time" } }, timeAgo));
      meta.appendChild(document.createTextNode(" · "));
    }

    // Comments link — always goes to the internal item page
    const commentsLink = create(
      "a",
      {
        attrs: {
          href: itemPath(item),
          class: "comments-link",
          "data-id": id, // also needed here so clicking "N comments" marks as read
        },
      },
      `${descendants} comment${pluralise(descendants)}`,
    );
    meta.appendChild(commentsLink);

    // ── New-comment badge ──────────────────────────────────────────────────
    const badge = this._newCommentBadge(item, descendants);
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
   * @param {Object} item         HN item object
   * @param {number} descendants  current total comment count from API
   * @returns {HTMLElement|null}
   */
  _newCommentBadge(item, descendants) {
    const id = item && item.id != null ? String(item.id) : "";
    if (!id || descendants == null) return null;

    let threadState = null;
    try {
      // Prefer the injected loadThreadState function (reads directly from
      // localStorage), falling back to threadStore.getState for compatibility.
      if (typeof this._loadThreadState === "function") {
        threadState = this._loadThreadState(id);
      } else if (this._threadStore && typeof this._threadStore.getState === "function") {
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
      "a",
      {
        attrs: {
          class: "badge new",
          href: itemPath(item),
          role: "status",
          "aria-label": `${newCount} new comment${pluralise(newCount)}`,
        },
      },
      `+${newCount} new`,
    );
  }
}
