/**
 * ListView.js
 *
 * A simple ListView implementation for the vanilla-hn scaffold.
 *
 * Exports:
 *  - default: ListView (extends View)
 *  - ItemView: placeholder view for story/item details
 *  - UserView: placeholder view for user profile
 *
 * Notes:
 *  - This view expects to receive `services.hnService` and `stores` via the context
 *    object passed to its constructor (see src/main.js lazyView factories).
 *  - It uses a small, dependency-free rendering strategy (build a fragment and
 *    replace the list container).
 */

import View from './View.js';
import { timeAgoFromUnix, create as createEl, fragmentFromHTML } from '../utils/dom.js';

export default class ListView extends View {
  /**
   * context:
   *  - params: route params
   *  - stores: { settingsStore, ... }
   *  - services: { hnService, ... }
   *  - options: { listType }
   */
  constructor(context = {}) {
    super(context);
    this.listType = (context.options && context.options.listType) || context.listType || 'top';
    this.items = []; // current list of item objects or ids (depending on hnService)
    this._mounted = false;
    this._unsub = null;
  }

  render() {
    // Build root wrapper
    const wrapper = createEl('div', { attrs: { class: 'view list-view' } });

    const container = createEl('div', { attrs: { class: 'container' } });
    const header = createEl('header', { attrs: { class: 'list-header' } });
    const title = createEl('h2', { attrs: { class: 'page-title' } }, this._titleText());
    header.appendChild(title);

    const meta = createEl('div', { attrs: { class: 'list-meta' } }, `List: ${this.listType}`);
    header.appendChild(meta);

    container.appendChild(header);

    // List element placeholder
    this._listEl = createEl('ul', { attrs: { class: 'story-list', role: 'list' } });
    container.appendChild(this._listEl);

    // Loading placeholder
    this._loadingEl = createEl('div', { attrs: { class: 'loading' } }, 'Loading…');
    container.appendChild(this._loadingEl);

    wrapper.appendChild(container);

    // Kick off data load after being rendered (we don't block on async)
    // Use a microtask so callers that mount this element see it first.
    Promise.resolve().then(() => {
      try { this._initSubscriptions(); } catch (e) { console.warn('ListView init subscriptions failed', e); }
    });

    this.root = wrapper;
    return wrapper;
  }

  _titleText() {
    const map = {
      top: 'Top',
      newest: 'Newest',
      ask: 'Ask',
      show: 'Show',
      jobs: 'Jobs'
    };
    return map[this.listType] || `${this.listType}`;
  }

  attachEventListeners() {
    // Delegate click on story links to allow SPA navigation when needed.
    // Prefer anchor navigation (hash) so router handles it; no extra wiring required.
    // We don't attach heavy listeners here; keep view lightweight.
  }

  _initSubscriptions() {
    if (this._mounted) return;
    this._mounted = true;

    const hn = this.services && this.services.hnService;
    if (!hn || typeof hn.onStoriesValue !== 'function') {
      // No service available -> render a helpful message
      this._renderError('Data service unavailable');
      return;
    }

    // Subscribe to stories updates for the chosen listType.
    // hn.onStoriesValue returns an unsubscribe function in the scaffold's mock service.
    const unsub = hn.onStoriesValue(this.listType, (items) => {
      // items may be an array of item IDs or item objects depending on service
      try {
        this._updateList(items || []);
      } catch (err) {
          console.warn('ListView updateList failed', err);
      }
    });

    // Keep track of unsubscribe to remove in cleanup
    this._unsub = typeof unsub === 'function' ? unsub : null;
    if (this._unsub) {
      // Ensure it will be called during cleanup
      if (Array.isArray(this._unsubscribers)) this._unsubscribers.push(this._unsub);
      else if (typeof this.subscribe === 'function') this.subscribe(this._unsub);
      else this._unsubscribers = [this._unsub];
    }
  }

  _renderError(msg) {
    if (this._loadingEl) this._loadingEl.textContent = `Error: ${msg}`;
    if (this._listEl) this._listEl.innerHTML = '';
  }

  _updateList(items) {
    // Normalize items to minimal object shape expected by renderer.
    // The HNService mock returns an array of item objects in this scaffold.
    this.items = Array.isArray(items) ? items : [];

    // Hide loading
    if (this._loadingEl) this._loadingEl.style.display = 'none';

    // Efficiently build list using DocumentFragment
    const frag = document.createDocumentFragment();

    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      // If service returns only ids, we render a minimal row pointing to the id.
      const id = (it && (it.id || it)) || String(i);
      const title = (it && (it.title || (`Story ${id}`))) || `Story ${id}`;
      const by = (it && it.by) || 'unknown';
      const time = (it && (it.time || it.ts)) || undefined;
      const descendants = (it && (it.descendants != null ? it.descendants : (it.kids ? it.kids.length : 0))) || 0;
      const score = (it && (it.score != null ? it.score : 0)) || 0;
      const url = (it && it.url) || null;

      const li = document.createElement('li');
      li.className = 'item';
      li.setAttribute('role', 'listitem');
      // Title block
      const titleDiv = document.createElement('div');
      titleDiv.className = 'col';

      const titleEl = document.createElement('div');
      titleEl.className = 'title';
      const a = document.createElement('a');
      a.href = `#/item/${id}`;
      a.textContent = title;
      a.setAttribute('data-id', String(id));
      a.setAttribute('aria-label', `${title} — by ${by}`);
      titleEl.appendChild(a);
      titleDiv.appendChild(titleEl);

      const meta = document.createElement('div');
      meta.className = 'meta';
      const metaText = `${score} points by ${by}${time ? ' · ' + timeAgoFromUnix(time) : ''} · ${descendants} comments`;
      meta.textContent = metaText;
      titleDiv.appendChild(meta);

      li.appendChild(titleDiv);

      // If external url, show host (lightweight)
      if (url) {
        try {
          const host = new URL(url).host.replace(/^www\./, '');
          const hostEl = document.createElement('div');
          hostEl.className = 'item-host';
          hostEl.textContent = host;
          li.appendChild(hostEl);
        } catch (e) {
          // ignore invalid URL
        }
      }

      frag.appendChild(li);
    }

    // Replace children of listEl
    if (this._listEl) {
      // clear then append
      while (this._listEl.firstChild) this._listEl.removeChild(this._listEl.firstChild);
      this._listEl.appendChild(frag);
    }
  }

  cleanup() {
    // Unsubscribe from service updates
    try {
      if (typeof this._unsub === 'function') this._unsub();
    } catch (e) { /* ignore */ }

    // Allow base class cleanup to run (unsubscribers bookkeeping, DOM removal)
    try { super.cleanup && super.cleanup(); } catch (e) { /* ignore */ }
  }
}

/* --------------------------------------------------------------------------
 * Simple placeholder ItemView and UserView implementations exported from this file.
 * They are intentionally minimal so they can be replaced by full implementations
 * later while allowing early navigation to function.
 * -------------------------------------------------------------------------- */

export class ItemView extends View {
  constructor(context = {}) {
    super(context);
    this.itemId = (context.params && context.params.id) || (context.options && context.options.id) || null;
    this._unsub = null;
    this._item = null;
  }

  render() {
    const container = createEl('div', { attrs: { class: 'view item-view' } });
    const title = createEl('h2', {}, `Item ${this.itemId || ''}`);
    container.appendChild(title);

    this._contentEl = createEl('div', { attrs: { class: 'item-content' } }, 'Loading item…');
    container.appendChild(this._contentEl);

    // subscribe to item updates if hnService available
    const hn = this.services && this.services.hnService;
    if (hn && typeof hn.onItemValue === 'function' && this.itemId) {
      this._unsub = hn.onItemValue(this.itemId, (item) => {
        this._item = item;
        this._renderItem();
      });
      if (typeof this._unsub === 'function') {
        if (Array.isArray(this._unsubscribers)) this._unsubscribers.push(this._unsub);
        else this._unsubscribers = [this._unsub];
      }
    } else {
      this._contentEl.textContent = 'No service available to load item.';
    }

    this.root = container;
    return container;
  }

  _renderItem() {
    if (!this._contentEl) return;
    if (!this._item) {
      this._contentEl.textContent = 'Item not found';
      return;
    }
    // Simple rendered representation (title/meta/text)
    const frag = fragmentFromHTML(`<article class="story-article">
      <h3>${String(this._item.title || '')}</h3>
      <div class="meta">${this._item.score || 0} points by ${this._item.by || 'unknown'} · ${timeAgoFromUnix(this._item.time || Date.now()/1000)}</div>
      <div class="story-text">${String(this._item.text || '')}</div>
    </article>`);
    // replace content
    this._contentEl.innerHTML = '';
    this._contentEl.appendChild(frag);
  }

  cleanup() {
    try { if (typeof this._unsub === 'function') this._unsub(); } catch (e) {}
    super.cleanup && super.cleanup();
  }
}

export class UserView extends View {
  constructor(context = {}) {
    super(context);
    this.userId = (context.params && context.params.id) || (context.options && context.options.id) || null;
    this._unsub = null;
    this._user = null;
  }

  render() {
    const container = createEl('div', { attrs: { class: 'view user-view' } });
    const title = createEl('h2', {}, `User ${this.userId || ''}`);
    container.appendChild(title);

    this._contentEl = createEl('div', { attrs: { class: 'user-content' } }, 'Loading user…');
    container.appendChild(this._contentEl);

    const hn = this.services && this.services.hnService;
    if (hn && typeof hn.onUserValue === 'function' && this.userId) {
      this._unsub = hn.onUserValue(this.userId, (user) => {
        this._user = user;
        this._renderUser();
      });
      if (typeof this._unsub === 'function') {
        if (Array.isArray(this._unsubscribers)) this._unsubscribers.push(this._unsub);
        else this._unsubscribers = [this._unsub];
      }
    } else {
      this._contentEl.textContent = 'User data service unavailable.';
    }

    this.root = container;
    return container;
  }

  _renderUser() {
    if (!this._contentEl) return;
    if (!this._user) {
      this._contentEl.textContent = 'User not found';
      return;
    }
    const frag = fragmentFromHTML(`<section class="user-profile">
      <h3>${String(this._user.id || '')}</h3>
      <div class="meta">karma: ${String(this._user.karma || 0)} · created: ${timeAgoFromUnix(this._user.created || Date.now()/1000)}</div>
      <div class="about">${String(this._user.about || '')}</div>
    </section>`);
    this._contentEl.innerHTML = '';
    this._contentEl.appendChild(frag);
  }

  cleanup() {
    try { if (typeof this._unsub === 'function') this._unsub(); } catch (e) {}
    super.cleanup && super.cleanup();
  }
}
