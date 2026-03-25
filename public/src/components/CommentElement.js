/**
 * CommentElement.js
 *
 * A lightweight, framework-free component for rendering a single comment node
 * in the threaded Hacker News style UI and a small factory for story list items.
 *
 * Exports:
 *  - CommentElement (class)       : construct with new CommentElement({ comment, stores, services, depth })
 *  - createStoryListItem (function): factory returning an <li> for a story row
 *
 * Notes:
 *  - This component uses the small DOM helpers in `src/utils/dom.js`.
 *  - It intentionally keeps responsibilities limited:
 *      - render a comment (meta, text, children container)
 *      - toggle collapse/expand
 *      - lazy-load child comments via `services.hnService` when expanded
 *      - minimal accessibility (toggle button with aria-expanded)
 *  - Real sanitization of HTML is environment-specific. Here we escape text by default.
 */

import { create, fragmentFromHTML, escapeHTML, timeAgoFromUnix } from '../utils/dom.js';

export class CommentElement {
  /**
   * @param {Object} opts
   * @param {Object} opts.comment - comment payload (id, by, time, text, kids[])
   * @param {Object} [opts.services] - application services (hnService)
   * @param {Object} [opts.stores] - application stores (threadStore, settingsStore)
   * @param {number} [opts.depth] - comment nesting depth (for styling/logic)
   */
  constructor({ comment, services = {}, stores = {}, depth = 0 } = {}) {
    if (!comment || !comment.id) throw new Error('CommentElement requires a comment with an id');

    this.comment = comment;
    this.services = services;
    this.stores = stores;
    this.depth = depth | 0;

    this.root = null;
    this._kidsContainer = null;
    this._collapsed = false;
    this._loadedKids = new Map(); // childId -> CommentElement
    this._unsubs = []; // unsubscribe functions from any listeners
    this._loadingPlaceholders = new Map(); // childId -> placeholder element
  }

  /**
   * Render the comment to an HTMLElement. Idempotent: repeated calls will return
   * the same root unless cleanup() has been called.
   */
  render() {
    if (this.root) return this.root;

    const classes = ['comment'];
    if (this.depth > 0) classes.push('comment--child');
    if (this._collapsed) classes.push('comment--collapsed');

    // Root wrapper
    const wrapper = create('article', { attrs: { class: classes.join(' ') }, props: { 'data-id': this.comment.id } });

    // Meta row (by, time, toggle)
    const meta = this._createMeta();
    wrapper.appendChild(meta);

    // Body / text
    const text = this._createText();
    wrapper.appendChild(text);

    // Kids container (initially empty)
    this._kidsContainer = create('div', { attrs: { class: 'comment-kids' } });
    wrapper.appendChild(this._kidsContainer);

    // If there are declared kids, add lightweight placeholders so layout is predictable.
    if (Array.isArray(this.comment.kids) && this.comment.kids.length > 0) {
      for (const kidId of this.comment.kids) {
        const placeholder = this._createKidPlaceholder(kidId);
        this._kidsContainer.appendChild(placeholder);
        this._loadingPlaceholders.set(String(kidId), placeholder);
      }
    }

    this.root = wrapper;
    return wrapper;
  }

  _createMeta() {
    const meta = create('div', { attrs: { class: 'comment-meta' } });

    // Collapse toggle button
    const toggle = create('button', {
      attrs: { class: 'toggle', type: 'button', 'aria-expanded': String(!this._collapsed) },
      events: {
        click: (ev) => {
          ev.preventDefault();
          this.toggleCollapse();
        }
      }
    }, this._collapsed ? '+' : '−');

    // Byline and time
    const by = create('span', { attrs: { class: 'by' } }, String(this.comment.by || 'unknown'));
    const time = create('span', { attrs: { class: 'time' } }, timeAgoFromUnix(this.comment.time || Date.now() / 1000));

    // New / children count badge (if store provides info, try to show new counts)
    const counts = create('span', { attrs: { class: 'counts' } });
    const descendantCount = (this.comment.descendants != null) ? this.comment.descendants : (Array.isArray(this.comment.kids) ? this.comment.kids.length : 0);
    const descText = create('span', { attrs: { class: 'desc' } }, `${descendantCount} replies`);
    counts.appendChild(descText);

    // New-badge: consult stores.threadStore if available
    if (this.stores && this.stores.threadStore && typeof this.stores.threadStore.getChildCounts === 'function') {
      try {
        const countsObj = this.stores.threadStore.getChildCounts(this.comment.id);
        // getChildCounts may return { total: n, new: m }
        if (countsObj && countsObj.new && countsObj.new > 0) {
          const newBadge = create('span', { attrs: { class: 'badge badge--new', role: 'status', 'aria-live': 'polite' } }, String(countsObj.new));
          counts.appendChild(newBadge);
          // highlight the comment element visually
          meta.classList.add('comment--has-new');
        }
      } catch (e) {
        // ignore store errors; optional enhancement
      }
    }

    meta.appendChild(toggle);
    meta.appendChild(by);
    meta.appendChild(create('span', { attrs: { class: 'sep' } }, '·'));
    meta.appendChild(time);
    meta.appendChild(counts);

    return meta;
  }

  _createText() {
    // Prefer to escape HTML by default to avoid XSS on untrusted content.
    // If your service guarantees sanitized HTML you can change this to set innerHTML.
    const safe = this.comment.text ? escapeHTML(this.comment.text) : '';
    const textEl = create('div', { attrs: { class: 'comment-text' }, html: safe });
    return textEl;
  }

  _createKidPlaceholder(kidId) {
    const placeholder = create('div', { attrs: { class: 'comment-placeholder', role: 'group', 'aria-label': `Comment ${kidId} (loading)` } },
      `Loading comment ${kidId}…`
    );
    // clicking the placeholder should expand and trigger a load immediately
    placeholder.addEventListener('click', () => {
      // Expand parent if collapsed and load the child
      if (this._collapsed) this.toggleCollapse(false);
      this._loadChildAndReplacePlaceholder(kidId, placeholder);
    });
    return placeholder;
  }

  /**
   * Toggle collapse state.
   * If explicitState is provided (true = collapsed, false = expanded) it will be applied.
   */
  toggleCollapse(explicitState) {
    const newState = explicitState === undefined ? !this._collapsed : Boolean(explicitState);
    this._collapsed = newState;

    if (this.root) {
      if (this._collapsed) {
        this.root.classList.add('comment--collapsed');
      } else {
        this.root.classList.remove('comment--collapsed');
      }
      // update aria-expanded on toggle button if present
      const btn = this.root.querySelector('button.toggle');
      if (btn) btn.setAttribute('aria-expanded', String(!this._collapsed));
      if (!this._collapsed) {
        // when expanding, attempt to load visible (placeholder) children
        this._loadVisiblePlaceholders();
      }
    }

    // persist collapse state in a store if available
    if (this.stores && this.stores.threadStore && typeof this.stores.threadStore.toggleCollapse === 'function') {
      try {
        this.stores.threadStore.toggleCollapse(this.comment.id, this._collapsed);
      } catch (e) {
        // ignore store errors
      }
    }
    return this._collapsed;
  }

  _loadVisiblePlaceholders() {
    for (const [kidId, placeholder] of this._loadingPlaceholders.entries()) {
      // Replace each placeholder with a loading child (or kick off fetch)
      this._loadChildAndReplacePlaceholder(kidId, placeholder).catch(() => { /* swallow individual errors */ });
    }
  }

  async _loadChildAndReplacePlaceholder(childId, placeholderEl) {
    // If already loaded, replace placeholder with existing node
    const key = String(childId);
    if (this._loadedKids.has(key)) {
      const childElement = this._loadedKids.get(key);
      if (placeholderEl && childElement && childElement.root) {
        placeholderEl.replaceWith(childElement.root);
        this._loadingPlaceholders.delete(key);
      }
      return;
    }

    // Show a temporary spinner in the placeholder
    if (placeholderEl) {
      placeholderEl.textContent = 'Loading…';
      const spinner = create('span', { attrs: { class: 'spinner' } });
      placeholderEl.appendChild(spinner);
    }

    const hn = this.services && this.services.hnService;
    if (!hn) {
      if (placeholderEl) placeholderEl.textContent = 'Cannot load (no service)';
      return;
    }

    // Prefer onItemValue (realtime subscription) if provided, otherwise do a one-off fetch
    let unsub = null;
    if (typeof hn.onItemValue === 'function') {
      try {
        unsub = hn.onItemValue(childId, (payload) => {
          // Create or update child element when payload arrives
          this._upsertChildFromPayload(childId, payload, placeholderEl);
        });
      } catch (e) {
        // fallback to fetch
        unsub = null;
      }
    }

    if (!unsub) {
      // one-off fetch
      try {
        const payload = await hn.fetchItem(childId);
        this._upsertChildFromPayload(childId, payload, placeholderEl);
      } catch (err) {
        if (placeholderEl) placeholderEl.textContent = `Failed to load ${childId}`;
      }
      return;
    }

    // record unsubscribe so cleanup can detach realtime listener
    if (typeof unsub === 'function') this._unsubs.push(unsub);
  }

  _upsertChildFromPayload(childId, payload, placeholderEl) {
    const key = String(childId);
    if (!payload) {
      if (placeholderEl) placeholderEl.textContent = `Comment ${childId} not found`;
      return;
    }
    // If a child element already exists, update its comment payload
    if (this._loadedKids.has(key)) {
      const existing = this._loadedKids.get(key);
      existing.comment = payload;
      try { existing.update && existing.update(); } catch (e) { /* ignore */ }
      if (placeholderEl && existing.root) placeholderEl.replaceWith(existing.root);
      this._loadingPlaceholders.delete(key);
      return;
    }

    // Create a new CommentElement for the child and render it
    const childElement = new CommentElement({ comment: payload, services: this.services, stores: this.stores, depth: this.depth + 1 });
    const childNode = childElement.render();
    // Insert into DOM replacing placeholder if present
    if (placeholderEl && placeholderEl.parentNode) {
      placeholderEl.replaceWith(childNode);
      this._loadingPlaceholders.delete(key);
    } else if (this._kidsContainer) {
      this._kidsContainer.appendChild(childNode);
    }
    this._loadedKids.set(key, childElement);

    // If the child payload contains nested kids, create placeholders under its kids container
    if (Array.isArray(payload.kids) && payload.kids.length > 0) {
      // The child's own constructor will prepare placeholders when childElement.render() runs.
    }
  }

  /**
   * Update visual representation of the comment (e.g., after comment data changed)
   */
  update() {
    if (!this.root) return;
    // Update text
    const textEl = this.root.querySelector('.comment-text');
    if (textEl) {
      const safe = this.comment.text ? escapeHTML(this.comment.text) : '';
      textEl.innerHTML = safe;
    }
    // Update time
    const timeEl = this.root.querySelector('.comment-meta .time');
    if (timeEl) {
      timeEl.textContent = timeAgoFromUnix(this.comment.time || Date.now() / 1000);
    }
    // Update counts
    const descEl = this.root.querySelector('.comment-meta .desc');
    if (descEl) {
      const descendantCount = (this.comment.descendants != null) ? this.comment.descendants : (Array.isArray(this.comment.kids) ? this.comment.kids.length : 0);
      descEl.textContent = `${descendantCount} replies`;
    }
    // If store can report new-child counts, refresh badge
    if (this.stores && this.stores.threadStore && typeof this.stores.threadStore.getChildCounts === 'function') {
      try {
        const countsObj = this.stores.threadStore.getChildCounts(this.comment.id);
        const existingBadge = this.root.querySelector('.badge--new');
        if (countsObj && countsObj.new && countsObj.new > 0) {
          if (!existingBadge) {
            const newBadge = create('span', { attrs: { class: 'badge badge--new', role: 'status', 'aria-live': 'polite' } }, String(countsObj.new));
            const countsContainer = this.root.querySelector('.comment-meta .counts');
            if (countsContainer) countsContainer.appendChild(newBadge);
            this.root.classList.add('comment--has-new');
          } else {
            existingBadge.textContent = String(countsObj.new);
            this.root.classList.add('comment--has-new');
          }
        } else if (existingBadge) {
          existingBadge.remove();
          this.root.classList.remove('comment--has-new');
        }
      } catch (e) {
        // ignore store errors
      }
    }
  }

  /**
   * Remove listeners and free references. Should be called when the comment is unmounted.
   */
  cleanup() {
    // Call cleanup on loaded child elements
    for (const child of this._loadedKids.values()) {
      try { if (typeof child.cleanup === 'function') child.cleanup(); } catch (e) { /* ignore */ }
    }
    this._loadedKids.clear();

    // Run any unsubscribe functions from realtime listeners
    for (const unsub of this._unsubs) {
      try { typeof unsub === 'function' && unsub(); } catch (e) { /* ignore */ }
    }
    this._unsubs = [];

    // Remove references to DOM nodes
    if (this.root && this.root.parentNode) {
      try { this.root.parentNode.removeChild(this.root); } catch (e) { /* ignore */ }
    }
    this.root = null;
    this._kidsContainer = null;
    this._loadingPlaceholders.clear();
  }
}

/**
 * Factory for a story list item DOM node.
 * Returns an <li> element styled similarly to HN list rows.
 *
 * @param {Object} story - story object (id, title, by, time, score, descendants, url)
 * @param {Object} [opts] - options { showHost: true, showNewBadge: false, onClick: fn }
 * @returns {HTMLElement} li
 */
export function createStoryListItem(story = {}, opts = {}) {
  const { showHost = true, showNewBadge = false, onClick } = opts;
  const id = story.id || String(Math.random()).slice(2, 8);
  const titleText = story.title || `Story ${id}`;
  const by = story.by || 'unknown';
  const score = story.score != null ? story.score : 0;
  const descendants = story.descendants != null ? story.descendants : (Array.isArray(story.kids) ? story.kids.length : 0);
  const url = story.url || null;

  const li = create('li', { attrs: { class: 'item', role: 'listitem', 'data-id': String(id) } });

  const titleDiv = create('div', { attrs: { class: 'col' } });
  const titleEl = create('div', { attrs: { class: 'title' } });
  const a = create('a', { attrs: { href: `#/item/${id}` } }, titleText);
  titleEl.appendChild(a);
  titleDiv.appendChild(titleEl);

  const meta = create('div', { attrs: { class: 'meta' } }, `${score} points by ${by} · ${timeAgoFromUnix(story.time || Date.now() / 1000)} · ${descendants} comments`);
  titleDiv.appendChild(meta);
  li.appendChild(titleDiv);

  if (showHost && url) {
    try {
      const host = new URL(url).host.replace(/^www\./, '');
      const hostEl = create('div', { attrs: { class: 'item-host' } }, host);
      li.appendChild(hostEl);
    } catch (e) {
      // ignore bad URL
    }
  }

  if (showNewBadge) {
    const badge = create('span', { attrs: { class: 'badge badge--new' } }, 'new');
    li.appendChild(badge);
  }

  if (typeof onClick === 'function') {
    li.addEventListener('click', (ev) => {
      // If click target is a link, allow default navigation
      if (ev.target && ev.target.tagName === 'A') return;
      ev.preventDefault();
      onClick(ev, story);
    });
  }

  return li;
}

export default CommentElement;
