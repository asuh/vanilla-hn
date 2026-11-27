import CommentTree from "../components/CommentTree.js";
import { createSpinner } from "../components/Spinner.js";
import CommentThreadStore from "../stores/CommentThreadStore.js";
import { create, timeAgoFromUnix } from "../utils/dom.js";
import { fetchCommentAncestors, itemPath, rememberItem } from "../utils/item-ancestors.js";
import View from "./View.js";

const SITE_TITLE = "Vanilla HN";

export default class PermalinkedCommentView extends View {
  constructor(context = {}) {
    super(context);
    this.commentId = this.params?.id ? String(this.params.id) : null;
    this._comment = null;
    this._threadStore = null;
    this._tree = null;
    this._itemUnsub = null;
    this._ancestorAbort = null;
  }

  render() {
    document.title = `Comment | ${SITE_TITLE}`;
    this.root = create("div", {
      attrs: { class: "view permalinked-comment-view" },
    });
    this._contentEl = create(
      "div",
      { attrs: { class: "comment comment--loading", role: "status" } },
      createSpinner({ inline: true, size: "20px", label: "Loading comment" }),
      " Loading comment...",
    );
    this.root.appendChild(this._contentEl);
    this._subscribe();
    return this.root;
  }

  cleanup() {
    if (typeof this._itemUnsub === "function") {
      try {
        this._itemUnsub();
      } catch (_) {}
      this._itemUnsub = null;
    }
    this._resetRenderedThread();
    this._contentEl = null;
    super.cleanup();
  }

  _resetRenderedThread() {
    this._tree?.dispose();
    this._tree = null;
    this._threadStore = null;
  }

  _subscribe() {
    const hn = this.services.hnService;
    if (!hn || typeof hn.onItemValue !== "function" || !this.commentId) {
      this._renderError("Service unavailable or missing comment id.");
      return;
    }

    this._itemUnsub = hn.onItemValue(this.commentId, (item) => {
      if (!item) {
        this._renderError("Comment not found.");
        return;
      }
      rememberItem(item);
      if (item.type !== "comment" && !item.deleted) {
        history.replaceState({}, "", itemPath(item));
        window.dispatchEvent(new PopStateEvent("popstate"));
        return;
      }
      this._comment = item;
      this._renderComment(item);
    });
  }

  async _renderComment(comment) {
    if (!this._contentEl) return;

    this._resetRenderedThread();

    if (comment.deleted) {
      document.title = `Deleted comment | ${SITE_TITLE}`;
      this._contentEl.className = "comment deleted";
      this._contentEl.replaceChildren(
        create(
          "div",
          { attrs: { class: "meta" } },
          "[deleted] | ",
          create(
            "a",
            { attrs: { href: `https://news.ycombinator.com/item?id=${comment.id}` } },
            "view on Hacker News",
          ),
        ),
      );
      return;
    }

    document.title = `Comment by ${comment.by || "unknown"} | ${SITE_TITLE}`;

    this._threadStore = new CommentThreadStore();
    this._threadStore.children[comment.id] = [];

    const settingsStore = this.stores.settingsStore;
    const showDead = settingsStore?.get?.("showDead") ?? false;
    if (comment.dead && !showDead) {
      this._contentEl.className = "comment dead";
      this._contentEl.replaceChildren(create("div", { attrs: { class: "meta" } }, "[dead]"));
      return;
    }

    this._contentEl.className = `comment permalinked${comment.dead ? " dead" : ""}`;
    const content = create("div", { attrs: { class: "content" } });
    const meta = create("div", { attrs: { class: "meta" } });

    meta.appendChild(
      create("a", { attrs: { href: `/user/${comment.by}`, class: "by" } }, comment.by || "unknown"),
    );
    meta.appendChild(document.createTextNode(" "));
    meta.appendChild(create("span", { attrs: { class: "time" } }, timeAgoFromUnix(comment.time)));
    meta.appendChild(document.createTextNode(" | "));
    meta.appendChild(
      create(
        "a",
        { attrs: { href: `https://news.ycombinator.com/item?id=${comment.id}` } },
        "view on Hacker News",
      ),
    );
    content.appendChild(meta);

    const text = create("div", { attrs: { class: "text" }, html: comment.text || "" });
    if ((settingsStore?.get?.("replyLinks") ?? true) && !comment.dead) {
      text.appendChild(
        create(
          "p",
          {},
          create(
            "a",
            { attrs: { href: `https://news.ycombinator.com/reply?id=${comment.id}` } },
            "reply",
          ),
        ),
      );
    }
    content.appendChild(text);

    const kids = create("div", { attrs: { class: "kids" } });
    this._contentEl.replaceChildren(content, kids);

    this._renderAncestors(comment, meta).catch(() => {});
    this._renderKids(comment, kids);
  }

  async _renderAncestors(comment, meta) {
    const hn = this.services.hnService;
    if (!hn || typeof hn.fetchItem !== "function") return;
    const result = await fetchCommentAncestors(hn, comment, { signal: this.signal });
    if (!meta?.isConnected) return;

    if (result.parent && result.op && comment.parent !== result.op.id) {
      meta.appendChild(document.createTextNode(" | "));
      meta.appendChild(
        create("a", { attrs: { href: itemPath(result.parent.type, comment.parent) } }, "parent"),
      );
    }
    if (result.op) {
      document.title = `Comment by ${comment.by || "unknown"} | ${result.op.title || SITE_TITLE}`;
      meta.appendChild(document.createTextNode(" | on: "));
      meta.appendChild(
        create(
          "a",
          { attrs: { href: itemPath(result.op) } },
          result.op.title || `Item ${result.op.id}`,
        ),
      );
    }
  }

  _renderKids(comment, kidsEl) {
    if (!Array.isArray(comment.kids) || !comment.kids.length) return;
    this._tree = new CommentTree({
      rootId: comment.id,
      container: kidsEl,
      hnService: this.services.hnService,
      threadStore: this._threadStore,
      settingsStore: this.stores.settingsStore,
      // Like HEAD, show dead/deleted direct replies as stubs with their replies.
      showHiddenRoots: true,
    });
    this._tree.setKids(comment.kids);
  }

  _renderError(message) {
    if (!this._contentEl) return;
    this._contentEl.className = "comment error";
    this._contentEl.textContent = message;
  }
}
