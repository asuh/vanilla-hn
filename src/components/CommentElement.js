/**
 * CommentElement.js
 *
 * Renders a single comment node. It owns no thread state: collapse, new-comment
 * and descendant-count state live in the thread store, and {@link CommentTree}
 * pushes that state in through `sync()`. Native details/summary provide the
 * disclosure semantics; a user toggle is reported through `onToggle` so the
 * store stays the single source of truth.
 */

import { create, setSafeHTML, timeAgoFromUnix } from "../utils/dom.js";
import { itemPath } from "../utils/item-ancestors.js";

export class CommentElement {
  /**
   * @param {Object} opts
   * @param {Object} opts.comment - Comment payload from the HN API.
   * @param {number} [opts.depth=0] - Nesting depth (for indentation).
   * @param {Object} [opts.settingsStore] - Provides showDead/showDeleted/replyLinks.
   * @param {Function} [opts.onToggle] - Called as `onToggle(id, collapsed)` after a user toggle.
   */
  constructor({ comment, depth = 0, settingsStore = null, onToggle = null } = {}) {
    if (!comment?.id) throw new Error("CommentElement requires a comment with an id");

    this.comment = comment;
    this.depth = depth | 0;
    this.settingsStore = settingsStore;
    this.onToggle = onToggle;

    this.root = null;
    this.kidsEl = null;
    this._detailsEl = null;
    this._textEl = null;
    this._timeEl = null;
    this._byEl = null;
    this._countsEl = null;
    this._displayMode = null;

    // Last state written to the DOM, so sync() only touches what changed.
    this._state = { collapsed: false, isNew: false, children: -1, newComments: -1 };
  }

  /**
   * Build the comment's DOM.
   *
   * @param {Object} [state] - Initial `{ collapsed, isNew, counts }` from the store.
   * @returns {HTMLElement}
   */
  render(state = {}) {
    if (this.root) return this.root;

    const classes = ["comment"];
    if (this.depth > 0) classes.push("child");
    if (this.comment.dead) classes.push("dead");
    if (this.comment.deleted) classes.push("deleted");

    const wrapper = create("article", {
      attrs: { class: classes.join(" "), "data-id": this.comment.id },
    });
    wrapper.style.setProperty("--comment-level", this.depth);

    // Keep metadata links outside the interactive summary. CSS positions the
    // summary control at the beginning of the same visual row.
    wrapper.appendChild(this._createMeta());

    this._detailsEl = create("details", {
      attrs: { class: "comment-disclosure", open: true },
      events: { toggle: () => this._onDisclosureToggle() },
    });
    this._detailsEl.appendChild(
      create("summary", { attrs: { class: "toggle", "aria-label": this._toggleLabel() } }),
    );

    const content = create("div", { attrs: { class: "content" } });
    this._textEl = this._createText();
    content.appendChild(this._textEl);
    this._detailsEl.appendChild(content);

    // .kids is a sibling of .content inside the disclosure.
    this.kidsEl = create("div", { attrs: { class: "kids" } });
    this._detailsEl.appendChild(this.kidsEl);
    wrapper.appendChild(this._detailsEl);

    this.root = wrapper;
    this.sync(state);
    return wrapper;
  }

  /**
   * Apply store state. Idempotent and cheap when nothing changed.
   *
   * @param {Object} state
   * @param {boolean} [state.collapsed]
   * @param {boolean} [state.isNew]
   * @param {{children: number, newComments: number}} [state.counts] - Needed when collapsed.
   */
  sync({ collapsed = false, isNew = false, counts = null } = {}) {
    if (!this.root) return;
    const prev = this._state;

    // Write `open` only when the store's state changes. A user click flips
    // `open` before its toggle event reports to the store; forcing the store's
    // older value here would undo that click.
    if (collapsed !== prev.collapsed) {
      prev.collapsed = collapsed;
      // Setting `open` queues a toggle event; the handler ignores it because
      // the store already agrees.
      if (this._detailsEl.open === collapsed) this._detailsEl.open = !collapsed;
      this.root.classList.toggle("collapsed", collapsed);
      // Drive count visibility directly: scoped :has() invalidation can leave
      // Safari waiting for a scroll before repainting.
      this._countsEl.hidden = !collapsed;
    }

    if (isNew !== prev.isNew) {
      prev.isNew = isNew;
      this.root.classList.toggle("new", isNew);
    }

    if (collapsed && counts) this._renderCounts(counts.children || 0, counts.newComments || 0);
  }

  /**
   * Replace the payload after a realtime update and refresh text and time.
   *
   * @param {Object} comment
   */
  setComment(comment) {
    const previous = this.comment;
    this.comment = comment;
    if (!this.root) return;

    if (
      comment.text !== previous.text ||
      comment.dead !== previous.dead ||
      comment.deleted !== previous.deleted ||
      this._displayMode !== this._currentDisplayMode()
    ) {
      this.root.classList.toggle("dead", Boolean(comment.dead));
      this.root.classList.toggle("deleted", Boolean(comment.deleted));
      // Replace the byline only when it changes, so a focused link keeps focus.
      if (comment.deleted !== previous.deleted || comment.by !== previous.by) {
        const by = this._createBy();
        this._byEl.replaceWith(by);
        this._byEl = by;
        this._detailsEl.firstElementChild.setAttribute("aria-label", this._toggleLabel());
      }
      const text = this._createText();
      this._textEl.replaceWith(text);
      this._textEl = text;
    }
    this._timeEl.textContent = timeAgoFromUnix(comment.time || Date.now() / 1000);
  }

  /** Detach from the DOM and release references. */
  cleanup() {
    this.root?.remove();
    this.root = null;
    this.kidsEl = null;
    this._detailsEl = null;
    this._textEl = null;
    this._timeEl = null;
    this._byEl = null;
    this._countsEl = null;
    this.onToggle = null;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _onDisclosureToggle() {
    if (!this._detailsEl) return;
    const collapsed = !this._detailsEl.open;
    if (collapsed === this._state.collapsed) return;
    this.onToggle?.(this.comment.id, collapsed);
  }

  /**
   * Populate counts as react-hn does for collapsed comments:
   * " | (N children[, M new])"
   */
  _renderCounts(children, newComments) {
    const prev = this._state;
    if (children === prev.children && newComments === prev.newComments) return;
    prev.children = children;
    prev.newComments = newComments;

    this.root.classList.toggle("has-new", newComments > 0);
    const childWord = `${children} child${children !== 1 ? "ren" : ""}`;
    const nodes = [` | (${childWord}`];
    if (newComments > 0) nodes.push(", ", create("em", {}, `${newComments} new`));
    nodes.push(")");
    this._countsEl.replaceChildren(...nodes);
  }

  _createMeta() {
    const meta = create("div", { attrs: { class: "meta" } });
    this._timeEl = create(
      "span",
      { attrs: { class: "time" } },
      timeAgoFromUnix(this.comment.time || Date.now() / 1000),
    );
    this._countsEl = create("span", { attrs: { class: "counts", hidden: true } });
    this._byEl = this._createBy();
    meta.append(
      this._byEl,
      " ",
      this._timeEl,
      " | ",
      create(
        "a",
        { attrs: { class: "permalink", href: itemPath("comment", this.comment.id) } },
        "link",
      ),
      this._countsEl,
    );
    return meta;
  }

  _toggleLabel() {
    return this.comment.deleted ? "Deleted comment" : `Comment by ${this.comment.by || "unknown"}`;
  }

  _createBy() {
    // Deleted items carry no author.
    if (this.comment.deleted) return create("span", { attrs: { class: "by" } }, "[deleted]");
    return create(
      "a",
      { attrs: { class: "by", href: `/user/${this.comment.by}` } },
      String(this.comment.by || "unknown"),
    );
  }

  _showReplyLinks() {
    return this.settingsStore?.get?.("replyLinks") ?? true;
  }

  /** The settings that shape the comment body, to know when to rebuild it. */
  _currentDisplayMode() {
    const settings = this.settingsStore;
    return [
      this._showReplyLinks(),
      settings?.get?.("showDead") ?? false,
      settings?.get?.("showDeleted") ?? false,
    ].join();
  }

  _createText() {
    const settings = this.settingsStore;
    const showDead = settings?.get?.("showDead") ?? false;
    const showDeleted = settings?.get?.("showDeleted") ?? false;
    const id = `comment-body-${this.comment.id}`;
    this._displayMode = this._currentDisplayMode();

    if (this.comment.deleted) {
      return create(
        "div",
        { attrs: { class: "text deleted", id } },
        showDeleted ? "[deleted]" : "",
      );
    }
    // Permalinks show hidden direct replies as stubs so their replies stay reachable.
    if (this.comment.dead && !showDead) {
      return create("div", { attrs: { class: "text dead", id } }, "[dead]");
    }

    // HN text is HTML (<p>, <a>, <i>, <pre>); setSafeHTML sanitizes it.
    const textEl = create("div", { attrs: { class: "text", id } });
    setSafeHTML(textEl, this.comment.text || "");

    if (this._showReplyLinks() && !this.comment.dead) {
      textEl.appendChild(
        create(
          "p",
          {},
          create(
            "a",
            { attrs: { href: `https://news.ycombinator.com/reply?id=${this.comment.id}` } },
            "reply",
          ),
        ),
      );
    }
    return textEl;
  }
}

export default CommentElement;
