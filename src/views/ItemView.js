/**
 * ItemView.js
 *
 * Story/item detail page. Wires together:
 *  - StoryHeader: title and metadata, rendered from cached data when available
 *    and patched on realtime updates.
 *  - ItemControls and CommentSlider: new-comment tools for return visits.
 *  - CommentTree: eager loading and rendering of the comment tree.
 *  - A per-story StoryCommentThreadStore: the single source of truth for
 *    collapse, new-comment and count state.
 */

import CommentSlider from "../components/CommentSlider.js";
import CommentTree from "../components/CommentTree.js";
import ItemControls from "../components/ItemControls.js";
import PollOption from "../components/PollOption.js";
import { createSpinner } from "../components/Spinner.js";
import StoryHeader from "../components/StoryHeader.js";
import StoryCommentThreadStore from "../stores/StoryCommentThreadStore.js";
import StoryStore from "../stores/StoryStore.js";
import { create, setSafeHTML } from "../utils/dom.js";
import { getCachedItem, rememberItem } from "../utils/item-ancestors.js";
import View from "./View.js";

const SITE_TITLE = "Vanilla HN";

export default class ItemView extends View {
  /**
   * @param {Object} context
   * @param {Object} context.params - Route params; expects `{ id: string }`.
   * @param {Object} context.services - Expects `hnService`.
   * @param {Object} context.stores - Expects `settingsStore`, `readStoriesStore`,
   *   and optionally `updatesStore` for cached headers.
   */
  constructor(context = {}) {
    super(context);
    this.itemId = this.params?.id ? String(this.params.id) : null;

    this._item = null;
    this._threadStore = null;
    this._threadStoreUnsub = null;
    this._itemUnsub = null;
    this._handleBeforeUnload = null;

    this._header = null;
    this._controls = null;
    this._slider = null;
    this._tree = null;
    this._pollOptions = [];

    this._loadingEl = null;
    this._contentEl = null;
    this._itemTextEl = null;
    this._pollEl = null;
    this._kidsEl = null;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Render the loading shell, show any cached header immediately, and start
   * the realtime story subscription.
   *
   * @returns {HTMLElement}
   */
  render() {
    const root = create("div", {
      attrs: { class: "view item-view", "data-item-id": this.itemId || "" },
    });
    this._loadingEl = create(
      "div",
      { attrs: { class: "loading", role: "status", "aria-live": "polite" } },
      createSpinner({ inline: true, label: "Loading story" }),
      " Loading story…",
    );
    this._contentEl = create("div", { attrs: { class: "content", hidden: true } });
    root.append(this._loadingEl, this._contentEl);
    this.root = root;

    // Restore saved headers on reload as well as during list-to-thread navigation.
    const cachedItem =
      getCachedItem(this.itemId) ||
      StoryStore.getStoredItem(this.itemId) ||
      this.stores?.updatesStore?.getStory(this.itemId);
    if (cachedItem?.title) this._onItemLoaded(cachedItem);
    this._subscribeToItem();

    return root;
  }

  attachEventListeners() {
    // Handlers are attached by the components that own their elements.
  }

  cleanup() {
    this._itemUnsub?.();
    this._itemUnsub = null;

    this._tree?.dispose();
    this._tree = null;
    this._controls?.cleanup();
    this._controls = null;
    this._slider?.cleanup();
    this._slider = null;
    for (const option of this._pollOptions) option.cleanup();
    this._pollOptions = [];

    this._threadStoreUnsub?.();
    this._threadStoreUnsub = null;
    this._threadStore?.dispose();
    this._threadStore = null;

    if (this._handleBeforeUnload) {
      window.removeEventListener("beforeunload", this._handleBeforeUnload);
      this._handleBeforeUnload = null;
    }

    super.cleanup();
  }

  // ── Story data ─────────────────────────────────────────────────────────────

  _subscribeToItem() {
    const hn = this.services?.hnService;
    if (typeof hn?.onItemValue !== "function" || !this.itemId) {
      this._showError("Service unavailable or missing item id.");
      return;
    }
    this._itemUnsub = hn.onItemValue(this.itemId, (item) => this._onItemLoaded(item));
  }

  /**
   * Handle cached or realtime story data. The first payload builds the page;
   * later payloads patch it in place.
   *
   * @param {Object|null} item
   */
  _onItemLoaded(item) {
    if (!item?.id) {
      if (!this._item) this._showError("Story not found.");
      return;
    }

    const previousItem = this._item;
    this._item = item;
    rememberItem(item);
    if (item.title) document.title = `${item.title} | ${SITE_TITLE}`;

    if (!previousItem) {
      this._initThreadStore(item);
      this._buildContent(item);
      this._loadingEl.hidden = true;
      this._contentEl.hidden = false;
      this._tree.setKids(item.kids);
      if (!this._threadStore.loading) this._onThreadLoadComplete();
      return;
    }

    const store = this._threadStore;
    if (store.loading) {
      const kidsDelta = (item.kids?.length || 0) - (previousItem.kids?.length || 0);
      if (kidsDelta) store.adjustExpectedComments(kidsDelta);
    }
    store.itemUpdated(item);
    this._header.update(item);
    this._patchBodyText(item, previousItem);
    this._tree.setKids(item.kids);
  }

  _initThreadStore(item) {
    const store = new StoryCommentThreadStore(item.id, {
      settings: this.stores?.settingsStore,
    });
    store.initForItem(item);
    this._threadStore = store;
    this._threadStoreUnsub = store.addListener((change) => this._onThreadStoreChanged(change));

    // Mirror react-hn's handleBeforeUnload: persist the session's maxCommentId
    // on reload or close so the next visit starts from the right baseline.
    this._handleBeforeUnload = () => this._threadStore?.dispose();
    window.addEventListener("beforeunload", this._handleBeforeUnload);
  }

  // ── Content ────────────────────────────────────────────────────────────────

  _buildContent(item) {
    const content = this._contentEl;
    content.replaceChildren();

    this._header = new StoryHeader({ settingsStore: this.stores?.settingsStore });
    content.appendChild(this._header.render(item));

    // Controls sit inside the meta bar, as react-hn passes them to renderItemMeta().
    this._controls = new ItemControls({
      item,
      threadStore: this._threadStore,
      readStoriesStore: this.stores?.readStoriesStore,
      onAutoCollapse: () => this._handleAutoCollapse(),
      onMarkAsRead: () => this._handleMarkAsRead(),
      getNewCommentCount: () => this._getNewCommentCount(),
      getCommentCount: () => this._getCommentCount(),
    });
    this._header.metaEl.appendChild(this._controls.render());

    this._slider = new CommentSlider({
      threadStore: this._threadStore,
      onHighlight: () => this._tree?.requestSync(),
      getCommentCount: () => this._getCommentCount(),
    });
    content.appendChild(this._slider.render());

    // Body text for Ask HN, jobs, etc.
    if (item.text) {
      this._itemTextEl = create("div", { attrs: { class: "body-text" }, html: item.text });
      content.appendChild(this._itemTextEl);
    }

    if (item.type === "poll" && Array.isArray(item.parts) && item.parts.length) {
      this._pollEl = create("div", { attrs: { class: "poll" } });
      for (const id of item.parts) {
        const option = new PollOption({ id, services: this.services });
        this._pollOptions.push(option);
        this._pollEl.appendChild(option.render());
      }
      content.appendChild(this._pollEl);
    }

    // Comments are a sibling of .content, matching react-hn's Item__kids.
    this._kidsEl = create("section", { attrs: { class: "kids", "aria-label": "Comments" } });
    this.root.appendChild(this._kidsEl);
    this._tree = new CommentTree({
      rootId: item.id,
      container: this._kidsEl,
      hnService: this.services?.hnService,
      threadStore: this._threadStore,
      settingsStore: this.stores?.settingsStore,
    });
  }

  _patchBodyText(item, previousItem) {
    if (item.text && item.text !== previousItem.text) {
      if (!this._itemTextEl) {
        this._itemTextEl = create("div", { attrs: { class: "body-text" } });
        this._contentEl.insertBefore(this._itemTextEl, this._pollEl || null);
      }
      setSafeHTML(this._itemTextEl, item.text);
    } else if (!item.text) {
      this._itemTextEl?.remove();
      this._itemTextEl = null;
    }
  }

  // ── Thread state ───────────────────────────────────────────────────────────

  /**
   * Refresh the new-comment controls when counts change. CommentTree listens
   * to the same store and updates the comments themselves.
   *
   * @param {Object} [change]
   */
  _onThreadStoreChanged(change) {
    if (change?.type === "collapse") return;
    if (change?.type === "loaded") {
      this._onThreadLoadComplete();
      return;
    }
    this._controls?.update();
    this._slider?.show();
  }

  /** The initial wave of comments has arrived; the store has already auto-collapsed. */
  _onThreadLoadComplete() {
    this._controls?.update();
    this._slider?.show();
  }

  _handleAutoCollapse() {
    this._threadStore?.collapseThreadsWithoutNewComments();
  }

  /** Reset new-comment tracking for this story and remember it as read. */
  _handleMarkAsRead() {
    const storyId = this._item?.id;
    if (!storyId) return;
    this._threadStore?.markAsRead();
    this.stores?.readStoriesStore?.markAsRead?.(storyId);
    this._controls?.update();
  }

  _getCommentCount() {
    if (this._threadStore) return this._threadStore.commentCount;
    return this._item?.descendants || 0;
  }

  _getNewCommentCount() {
    return this._threadStore?.newCommentCount || 0;
  }

  _showError(msg) {
    if (!this._loadingEl) return;
    this._loadingEl.textContent = `Error: ${msg}`;
    this._loadingEl.classList.add("loading-error");
  }
}
