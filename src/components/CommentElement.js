/**
 * CommentElement.js
 *
 * A lightweight, framework-free component for rendering a single comment node
 * in the threaded Hacker News style UI.
 *
 * Exports:
 *  - CommentElement (class)       : construct with new CommentElement({ comment, stores, services, depth })
 *
 * Notes:
 *  - This component uses the small DOM helpers in `src/utils/dom.js`.
 *  - It intentionally keeps responsibilities limited:
 *      - render a comment (meta, text, children container)
 *      - toggle collapse/expand
 *      - subscribe to child comments via `services.hnService` as soon as IDs arrive
 *      - native disclosure semantics through details/summary
 *  - Real sanitization of HTML is environment-specific. Here we escape text by default.
 */

import { create, setSafeHTML, timeAgoFromUnix } from "../utils/dom.js";
import { createSpinner } from "./Spinner.js";
import { itemPath } from "../utils/item-ancestors.js";

export class CommentElement {
  /**
   * Create a new CommentElement.
   *
   * @param {Object} opts - Configuration object.
   * @param {Object} opts.comment - Comment payload from the HN API (id, by, time, text, kids[]).
   * @param {Object} [opts.services={}] - Application services (e.g. hnService).
   * @param {Object} [opts.stores={}] - Application stores (e.g. threadStore, settingsStore).
   * @param {number} [opts.depth=0] - Comment nesting depth (for styling/logic).
   */
  constructor({ comment, services = {}, stores = {}, depth = 0 } = {}) {
    if (!comment?.id) throw new Error("CommentElement requires a comment with an id");

    this.comment = comment;
    this.services = services;
    this.stores = stores;
    this.depth = depth | 0;

    this.root = null;
    this._detailsEl = null;
    this._kidsContainer = null;
    this._collapsed = false;
    this._loadedKids = new Map(); // childId -> CommentElement
    this._unsubs = []; // unsubscribe functions from any listeners
    this._loadingPlaceholders = new Map(); // childId -> placeholder element
    this._disposed = false;
  }

  /**
   * Render the comment to an HTMLElement. Idempotent: repeated calls will return
   * the same root unless cleanup() has been called.
   *
   * @returns {HTMLElement} The root article element representing this comment.
   */
  render() {
    if (this.root) return this.root;

    const classes = ["comment"];
    if (this.depth > 0) classes.push("child");
    if (this.comment.dead) classes.push("dead");
    if (this.comment.deleted) classes.push("deleted");
    if (this.stores?.threadStore?.isNew?.[String(this.comment.id)]) classes.push("new");

    // Root wrapper
    const wrapper = create("article", {
      attrs: { class: classes.join(" ") },
      props: { "data-id": this.comment.id },
    });
    wrapper.style.setProperty("--comment-level", this.depth);

    this._detailsEl = create("details", {
      attrs: {
        class: "comment-disclosure",
        open: !this._collapsed,
      },
      events: {
        toggle: () => this._syncCollapsedFromDisclosure(),
      },
    });

    // Keep metadata links outside the interactive summary. CSS positions the
    // summary control at the beginning of the same visual row.
    const summary = this._createDisclosureSummary();
    this._detailsEl.appendChild(summary);
    const meta = this._createMeta();
    wrapper.appendChild(meta);

    // .content wraps the comment text; .kids is its sibling in the disclosure.
    this._contentEl = create("div", { attrs: { class: "content" } });

    // Body / text
    const text = this._createText();
    this._contentEl.appendChild(text);

    this._detailsEl.appendChild(this._contentEl);

    // Kids container — sibling to .content (not nested inside it)
    this._kidsContainer = create("div", {
      attrs: { class: "kids" },
    });
    this._detailsEl.appendChild(this._kidsContainer);
    wrapper.appendChild(this._detailsEl);

    this.root = wrapper;

    // Start every reply subscription immediately, including offscreen/collapsed threads.
    if (Array.isArray(this.comment.kids) && this.comment.kids.length > 0) {
      for (const kidId of this.comment.kids) {
        const placeholder = this._createKidPlaceholder(kidId);
        this._kidsContainer.appendChild(placeholder);
        this._loadingPlaceholders.set(String(kidId), placeholder);
        this._loadChildAndReplacePlaceholder(kidId, placeholder).catch(() => {});
      }
    }

    this.updateCounts();
    return wrapper;
  }

  _createDisclosureSummary() {
    return create("summary", {
      attrs: {
        class: "toggle",
        "aria-label": `Comment by ${this.comment.by || "unknown"}`,
      },
    });
  }

  _createMeta() {
    const meta = create("div", { attrs: { class: "meta" } });

    // Byline and time
    const by = create(
      "a",
      { attrs: { class: "by", href: `/user/${this.comment.by}` } },
      String(this.comment.by || "unknown"),
    );
    const time = create(
      "span",
      { attrs: { class: "time" } },
      timeAgoFromUnix(this.comment.time || Date.now() / 1000),
    );
    const permalink = create(
      "a",
      { attrs: { class: "permalink", href: itemPath("comment", this.comment.id) } },
      "link",
    );

    // Stored on `this` so realtime updates can refresh it without re-rendering.
    this._countsEl = create("span", { attrs: { class: "counts" } });

    meta.appendChild(by);
    meta.appendChild(document.createTextNode(" "));
    meta.appendChild(time);
    meta.appendChild(document.createTextNode(" | "));
    meta.appendChild(permalink);
    meta.appendChild(this._countsEl);

    return meta;
  }

  /**
   * Populate `_countsEl` with child/new-comment counts, matching react-hn's
   * collapsed comment display: " | (N children[, M new])"
   * Keep visibility in sync with the native disclosure without scoped :has()
   * invalidation, which can leave Safari waiting for a scroll to repaint.
   */
  updateCounts() {
    if (!this._countsEl) return;
    this._countsEl.hidden = this._detailsEl?.open ?? !this._collapsed;

    let children = 0;
    let newComments = 0;

    if (this.stores?.threadStore && typeof this.stores.threadStore.getChildCounts === "function") {
      try {
        const c = this.stores.threadStore.getChildCounts(this.comment);
        if (c) {
          children = c.children || 0;
          newComments = c.newComments || 0;
        }
      } catch (_e) {
        children = Array.isArray(this.comment.kids) ? this.comment.kids.length : 0;
      }
    } else {
      children = Array.isArray(this.comment.kids) ? this.comment.kids.length : 0;
    }

    while (this._countsEl.firstChild) this._countsEl.removeChild(this._countsEl.firstChild);
    this.root?.classList.toggle("has-new", newComments > 0);
    const childWord = `${children} child${children !== 1 ? "ren" : ""}`;
    this._countsEl.appendChild(document.createTextNode(` | (${childWord}`));
    if (newComments > 0) {
      this._countsEl.appendChild(document.createTextNode(", "));
      const em = document.createElement("em");
      em.textContent = `${newComments} new`;
      this._countsEl.appendChild(em);
    }
    this._countsEl.appendChild(document.createTextNode(")"));
  }

  _createText() {
    const showDead = this.stores?.settingsStore?.get?.("showDead") ?? false;
    const showDeleted = this.stores?.settingsStore?.get?.("showDeleted") ?? false;
    if (this.comment.deleted) {
      return create(
        "div",
        {
          attrs: {
            class: "text deleted",
            id: `comment-body-${this.comment.id}`,
          },
        },
        showDeleted ? "[deleted]" : "",
      );
    }
    if (this.comment.dead && !showDead) {
      return create(
        "div",
        {
          attrs: {
            class: "text dead",
            id: `comment-body-${this.comment.id}`,
          },
        },
        "[dead]",
      );
    }

    // HN comment text is pre-sanitized HTML from the Firebase API (e.g. <p>, <a>, <i>).
    // Render it as HTML directly rather than escaping it.
    const textEl = create("div", {
      attrs: {
        class: "text",
        id: `comment-body-${this.comment.id}`,
      },
      html: this.comment.text || "",
    });

    const replyLinks = this.stores?.settingsStore?.get?.("replyLinks") ?? true;
    if (replyLinks && !this.comment.dead) {
      const p = document.createElement("p");
      const a = create(
        "a",
        {
          attrs: { href: `https://news.ycombinator.com/reply?id=${this.comment.id}` },
        },
        "reply",
      );
      p.appendChild(a);
      textEl.appendChild(p);
    }

    return textEl;
  }

  _createKidPlaceholder(kidId) {
    const placeholder = create("div", {
      attrs: {
        class: "placeholder",
        role: "group",
        "aria-label": `Comment ${kidId} loading`,
        "data-kid-id": String(kidId),
      },
    });
    placeholder.append(
      createSpinner({
        inline: true,
        size: "20px",
        label: `Loading comment ${kidId}`,
      }),
    );
    return placeholder;
  }

  /**
   * Toggle collapse state.
   * If explicitState is provided (true = collapsed, false = expanded) it will be applied.
   *
   * @param {boolean} [explicitState] - If provided, forces collapsed (true) or expanded (false).
   * @param {boolean} [notifyStore=true] - Whether to notify the store of the state change.
   * @returns {boolean} The new collapsed state.
   */
  toggleCollapse(explicitState, notifyStore = true) {
    const newState = explicitState === undefined ? !this._collapsed : Boolean(explicitState);
    if (newState === this._collapsed) return this._collapsed;
    this._collapsed = newState;

    if (this._detailsEl) this._detailsEl.open = !this._collapsed;
    this.updateCounts();

    // persist collapse state in a store if available
    // (skip when the caller is already syncing state FROM the store to avoid
    // an infinite notify → reapply → notify loop)
    if (
      notifyStore &&
      this.stores?.threadStore &&
      typeof this.stores.threadStore.toggleCollapse === "function"
    ) {
      try {
        this.stores.threadStore.toggleCollapse(this.comment.id, this._collapsed);
      } catch (_e) {
        // ignore store errors
      }
    }
    return this._collapsed;
  }

  _syncCollapsedFromDisclosure() {
    if (!this._detailsEl) return;
    const collapsed = !this._detailsEl.open;
    if (collapsed === this._collapsed) return;

    this._collapsed = collapsed;
    this.updateCounts();

    if (this.stores?.threadStore && typeof this.stores.threadStore.toggleCollapse === "function") {
      try {
        this.stores.threadStore.toggleCollapse(this.comment.id, collapsed);
      } catch (_e) {
        // ignore store errors
      }
    }
  }

  async _loadChildAndReplacePlaceholder(childId, placeholderEl) {
    // If already loaded, replace placeholder with existing node
    const key = String(childId);
    if (this._loadedKids.has(key)) {
      const childElement = this._loadedKids.get(key);
      if (placeholderEl && childElement?.root) {
        placeholderEl.replaceWith(childElement.root);
        this._loadingPlaceholders.delete(key);
      }
      return;
    }

    const hn = this.services?.hnService;
    if (!hn) {
      if (placeholderEl) placeholderEl.textContent = "Cannot load (no service)";
      return;
    }

    // Prefer onItemValue (realtime subscription) if provided, otherwise do a one-off fetch
    let unsub = null;
    if (typeof hn.onItemValue === "function") {
      try {
        unsub = hn.onItemValue(childId, (payload) => {
          // Create or update child element when payload arrives
          this._upsertChildFromPayload(childId, payload, placeholderEl);
        });
      } catch (_e) {
        // fallback to fetch
        unsub = null;
      }
    }

    if (!unsub) {
      // one-off fetch
      try {
        const payload = await hn.fetchItem(childId);
        this._upsertChildFromPayload(childId, payload, placeholderEl);
      } catch (_err) {
        if (placeholderEl) placeholderEl.textContent = `Failed to load ${childId}`;
      }
      return;
    }

    // record unsubscribe so cleanup can detach realtime listener
    if (typeof unsub === "function") this._unsubs.push(unsub);
  }

  _upsertChildFromPayload(childId, payload, placeholderEl) {
    if (this._disposed) return;
    const key = String(childId);
    if (!payload) {
      if (placeholderEl)
        placeholderEl.textContent = "Unable to load comment. Trying again in 30 seconds.";
      if (
        this.stores?.threadStore &&
        typeof this.stores.threadStore.commentDelayed === "function"
      ) {
        this.stores.threadStore.commentDelayed(childId);
      }
      return;
    }
    const showDeleted = this.stores?.settingsStore?.get?.("showDeleted") ?? false;
    const showDead = this.stores?.settingsStore?.get?.("showDead") ?? false;
    if ((payload.deleted && !showDeleted) || (payload.dead && !showDead)) {
      if (this.stores?.threadStore?.commentAdded) {
        try {
          this.stores.threadStore.commentAdded(payload);
        } catch (_e) {
          /* ignore */
        }
      }
      if (placeholderEl) placeholderEl.remove();
      this._loadingPlaceholders.delete(key);
      return;
    }
    // If a child element already exists, update its comment payload
    if (this._loadedKids.has(key)) {
      const existing = this._loadedKids.get(key);
      this.stores?.threadStore?.commentAdded?.(payload);
      existing.comment = payload;
      try {
        existing.update?.();
      } catch (_e) {
        /* ignore */
      }
      if (placeholderEl && existing.root) placeholderEl.replaceWith(existing.root);
      this._loadingPlaceholders.delete(key);
      return;
    }

    // Register the comment with the threadStore so isNew / graph wiring is set
    // before render(). Child comments never flow through ItemView._notifyThreadStoreComment,
    // so without this call isNew[childId] is never populated.
    if (this.stores?.threadStore && typeof this.stores.threadStore.commentAdded === "function") {
      try {
        this.stores.threadStore.commentAdded(payload);
      } catch (_e) {
        /* ignore */
      }
    }

    // Create a new CommentElement for the child and render it
    const childElement = new CommentElement({
      comment: payload,
      services: this.services,
      stores: this.stores,
      depth: this.depth + 1,
    });
    const childNode = childElement.render();
    // Insert into DOM replacing placeholder if present
    if (placeholderEl?.parentNode) {
      placeholderEl.replaceWith(childNode);
      this._loadingPlaceholders.delete(key);
    } else if (this._kidsContainer) {
      this._kidsContainer.appendChild(childNode);
    }
    this._loadedKids.set(key, childElement);

    // Apply .new highlight if the threadStore marks this comment as new
    if (this.stores?.threadStore?.isNew?.[String(childId)]) {
      childNode.classList.add("new");
    }
  }

  /**
   * Update visual representation of the comment (e.g., after comment data changed).
   *
   * @returns {void}
   */
  update() {
    if (!this.root) return;
    // Update text — HN text is pre-sanitized HTML, render it directly.
    const textEl = this.root.querySelector(".text");
    if (textEl) {
      setSafeHTML(textEl, this.comment.text || "");
      const replyLinks = this.stores?.settingsStore?.get?.("replyLinks") ?? true;
      if (replyLinks && !this.comment.dead) {
        const p = document.createElement("p");
        const a = create(
          "a",
          {
            attrs: { href: `https://news.ycombinator.com/reply?id=${this.comment.id}` },
          },
          "reply",
        );
        p.appendChild(a);
        textEl.appendChild(p);
      }
    }
    // Update time
    const timeEl = this.root.querySelector(".meta .time");
    if (timeEl) {
      timeEl.textContent = timeAgoFromUnix(this.comment.time || Date.now() / 1000);
    }
    // Update counts
    const descEl = this.root.querySelector(".meta .desc");
    if (descEl) {
      const descendantCount =
        this.comment.descendants != null
          ? this.comment.descendants
          : Array.isArray(this.comment.kids)
            ? this.comment.kids.length
            : 0;
      descEl.textContent = `${descendantCount} replies`;
    }
    // Subscribe to any new kids that appeared in the updated comment payload.
    // This handles real-time updates where a new reply arrives while the user
    // is on the page — the parent comment's Firebase subscription fires with
    // an updated kids array containing the new child id.
    if (Array.isArray(this.comment.kids) && this._kidsContainer) {
      for (const kidId of this.comment.kids) {
        const key = String(kidId);
        if (!this._loadedKids.has(key) && !this._loadingPlaceholders.has(key)) {
          const placeholder = this._createKidPlaceholder(kidId);
          this._kidsContainer.appendChild(placeholder);
          this._loadingPlaceholders.set(key, placeholder);
          this._loadChildAndReplacePlaceholder(kidId, placeholder).catch(() => {});
        }
      }
    }

    this.updateCounts();
  }

  /**
   * Remove listeners and free references. Should be called when the comment is unmounted.
   *
   * @returns {void}
   */
  cleanup() {
    this._disposed = true;

    // Call cleanup on loaded child elements
    for (const child of this._loadedKids.values()) {
      try {
        if (typeof child.cleanup === "function") child.cleanup();
      } catch (_e) {
        /* ignore */
      }
    }
    this._loadedKids.clear();

    // Run any unsubscribe functions from realtime listeners
    for (const unsub of this._unsubs) {
      try {
        typeof unsub === "function" && unsub();
      } catch (_e) {
        /* ignore */
      }
    }
    this._unsubs = [];

    // Remove references to DOM nodes
    if (this.root?.parentNode) {
      try {
        this.root.parentNode.removeChild(this.root);
      } catch (_e) {
        /* ignore */
      }
    }
    this.root = null;
    this._detailsEl = null;
    this._kidsContainer = null;
    this._loadingPlaceholders.clear();
  }
}

export default CommentElement;
