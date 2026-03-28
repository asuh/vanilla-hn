import { create } from '../utils/dom.js';
import { pluralise } from '../utils/helpers.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Given a unix-seconds timestamp for the last visit, produce a human-readable
 * duration string like "3 hours" or "2 days" (without the trailing "ago").
 *
 * NOTE: This is intentionally separate from `dom.js`'s `formatRelativeTime` /
 * `timeAgoFromUnix`, which return strings such as "3 hours ago". Here we need
 * only the bare duration portion (e.g. for "N new comments in the last 3 hours").
 *
 * @param {number} lastVisitSeconds  unix timestamp in seconds
 * @returns {string} Human-readable duration, e.g. "3 hours", or "" if falsy input
 */
export function sinceLastVisit(lastVisitSeconds) {
  if (!lastVisitSeconds) return '';
  const diffMs = Date.now() - lastVisitSeconds * 1000;
  const diffSeconds = Math.max(0, Math.round(diffMs / 1000));

  const units = [
    { name: 'year', secs: 60 * 60 * 24 * 365 },
    { name: 'month', secs: 60 * 60 * 24 * 30 },
    { name: 'week', secs: 60 * 60 * 24 * 7 },
    { name: 'day', secs: 60 * 60 * 24 },
    { name: 'hour', secs: 60 * 60 },
    { name: 'minute', secs: 60 },
  ];

  for (const u of units) {
    const val = Math.floor(diffSeconds / u.secs);
    if (val >= 1) return `${val} ${pluralise(val, u.name)}`;
  }
  return 'a moment';
}

// ─── ItemControls ────────────────────────────────────────────────────────────

/**
 * ItemControls — controls bar for the story detail view.
 * Shows new comment count, auto-collapse button, and mark-as-read button.
 * Only visible on return visits when there are new comments.
 *
 * Extracted from ItemView._renderControls(), _handleAutoCollapse(), and
 * _handleMarkAsRead() to improve modularity.
 */
export default class ItemControls {
  /**
   * @param {Object} options
   * @param {Object} options.item - The HN story item
   * @param {Object} options.threadStore - StoryCommentThreadStore instance
   * @param {Object} options.readStoriesStore - ReadStoriesStore instance
   * @param {Function} [options.onAutoCollapse] - Callback when auto-collapse is clicked
   * @param {Function} [options.onMarkAsRead] - Callback when mark-as-read is clicked
   * @param {Function} [options.getNewCommentCount] - Returns current new comment count
   * @param {Function} [options.getCommentCount] - Returns current comment count
   */
  constructor(options = {}) {
    this.item = options.item || null;
    this.threadStore = options.threadStore || null;
    this.readStoriesStore = options.readStoriesStore || null;
    this.onAutoCollapse = options.onAutoCollapse || null;
    this.onMarkAsRead = options.onMarkAsRead || null;
    this.getNewCommentCount = options.getNewCommentCount || (() => 0);
    this.getCommentCount = options.getCommentCount || (() => 0);
    this.el = null;
  }

  /**
   * Render the controls bar. Returns a <div>.
   * May render empty if this is a first visit or no new comments.
   * @returns {HTMLElement}
   */
  render() {
    this.el = create('div', { attrs: { class: 'item-controls' } });
    this._buildContents();
    return this.el;
  }

  /**
   * Re-render the controls (e.g. after state changes).
   * Replaces the contents of the existing element.
   */
  update() {
    this._buildContents();
  }

  /**
   * Build (or rebuild) the inner contents of the controls bar.
   *
   * Shows nothing on first visit. On revisits shows:
   * "N new comments in the last X | auto collapse | mark as read"
   *
   * @returns {void}
   */
  _buildContents() {
    const el = this.el;
    if (!el) return;

    // Clear existing content
    while (el.firstChild) el.removeChild(el.firstChild);

    if (!this.threadStore) return;

    const storyId = this.item && this.item.id;
    const state =
      storyId && typeof this.threadStore.getState === 'function'
        ? this.threadStore.getState(storyId)
        : null;

    const lastVisit = state
      ? state.lastVisit
      : this.threadStore.lastVisit || null;
    const newCommentCount = this.getNewCommentCount();

    // Only show the controls bar when we've been here before and have new comments.
    if (!lastVisit || newCommentCount <= 0) return;

    el.setAttribute('class', 'item-controls item-controls--visible');

    const since = sinceLastVisit(lastVisit);

    // "N new comments in the last X"
    const newInfo = create(
      'span',
      { attrs: { class: 'item-controls__new-info' } },
      create(
        'em',
        {},
        `${newCommentCount} new ${pluralise(newCommentCount, 'comment')}`,
      ),
      ` in the last ${since}`,
    );
    el.appendChild(newInfo);

    el.appendChild(document.createTextNode(' | '));

    // "auto collapse" button
    const autoCollapseBtn = create(
      'button',
      {
        attrs: {
          type: 'button',
          class: 'item-controls__btn item-controls__btn--collapse',
          title: 'Collapse threads without new comments',
        },
        events: {
          click: (e) => {
            e.preventDefault();
            if (typeof this.onAutoCollapse === 'function') {
              this.onAutoCollapse();
            }
          },
        },
      },
      'auto collapse',
    );
    el.appendChild(autoCollapseBtn);

    el.appendChild(document.createTextNode(' | '));

    // "mark as read" button
    const markReadBtn = create(
      'button',
      {
        attrs: {
          type: 'button',
          class: 'item-controls__btn item-controls__btn--read',
        },
        events: {
          click: (e) => {
            e.preventDefault();
            if (typeof this.onMarkAsRead === 'function') {
              this.onMarkAsRead();
            }
          },
        },
      },
      'mark as read',
    );
    el.appendChild(markReadBtn);
  }

  /**
   * Clean up references.
   */
  cleanup() {
    this.item = null;
    this.threadStore = null;
    this.readStoriesStore = null;
    this.onAutoCollapse = null;
    this.onMarkAsRead = null;
    this.getNewCommentCount = null;
    this.getCommentCount = null;
    this.el = null;
  }
}
