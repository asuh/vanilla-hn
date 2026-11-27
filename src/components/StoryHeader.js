/**
 * StoryHeader.js
 *
 * Title and metadata bar for a story page. Renders once from cached or fresh
 * item data, then patches only the fields a realtime update changed, so focus
 * and unchanged title links survive refreshes.
 */

import { toAppPath } from "../utils/app-url.js";
import { create, timeAgoFromUnix } from "../utils/dom.js";
import { parseHost, pluralise } from "../utils/helpers.js";
import { itemPath } from "../utils/item-ancestors.js";

function commentsLabel(item) {
  const count = item.descendants != null ? item.descendants : 0;
  return count > 0 ? `${count} ${pluralise(count, "comment")}` : "discuss";
}

function scoreLabel(item) {
  return `${item.score || 0} ${pluralise(item.score || 0, "point")}`;
}

export default class StoryHeader {
  /**
   * @param {Object} [opts]
   * @param {Object} [opts.settingsStore] - Provides `titleFontSize`.
   */
  constructor({ settingsStore = null } = {}) {
    this.settingsStore = settingsStore;
    this.el = null;
    this.metaEl = null;
    this._titleEl = null;
    this._item = null;
  }

  /**
   * @param {Object} item - HN story payload.
   * @returns {HTMLElement} The `.header` element.
   */
  render(item) {
    this._item = item;
    this._titleEl = this._buildTitle(item);
    this.metaEl = this._buildMeta(item);
    this.el = create("div", { attrs: { class: "header" } }, this._titleEl, this.metaEl);
    return this.el;
  }

  /**
   * Patch fields that changed since the previous payload.
   *
   * @param {Object} item
   */
  update(item) {
    const previous = this._item;
    this._item = item;
    if (!this.el || !previous) return;

    if (["title", "url", "dead", "type"].some((key) => item[key] !== previous[key])) {
      const title = this._buildTitle(item);
      this._titleEl.replaceWith(title);
      this._titleEl = title;
    }

    const meta = this.metaEl;
    const score = meta.querySelector(".score");
    if (score) score.textContent = scoreLabel(item);
    const time = meta.querySelector(".time");
    if (time) time.textContent = timeAgoFromUnix(item.time);
    const by = meta.querySelector(".by");
    if (by && item.by !== previous.by) {
      by.textContent = item.by || "unknown";
      by.setAttribute("href", toAppPath(`/user/${item.by}`));
    }
    const comments = meta.querySelector(".comments-link");
    if (comments) comments.textContent = commentsLabel(item);
  }

  _buildTitle(item) {
    const titleText = item.dead ? `[dead] ${item.title || ""}` : item.title || `Item ${item.id}`;
    const fontSize = this.settingsStore?.get?.("titleFontSize") || 18;
    const wrapper = create("div", {
      attrs: { class: "title" },
      style: { fontSize: `${fontSize}px` },
    });

    if (item.url && !item.dead) {
      wrapper.appendChild(create("a", { attrs: { href: item.url } }, titleText));
      const host = parseHost(item.url);
      if (host) wrapper.appendChild(create("span", { attrs: { class: "host" } }, ` (${host})`));
    } else {
      wrapper.appendChild(create("a", { attrs: { href: itemPath(item) } }, titleText));
    }
    return wrapper;
  }

  _buildMeta(item) {
    const meta = create("div", { attrs: { class: "meta" } });
    const time = create("span", { attrs: { class: "time" } }, timeAgoFromUnix(item.time));

    // Job posts only show time.
    if (item.type === "job") {
      meta.appendChild(time);
      return meta;
    }

    meta.append(
      create("span", { attrs: { class: "score" } }, scoreLabel(item)),
      " by ",
      create("a", { attrs: { href: `/user/${item.by}`, class: "by" } }, item.by || "unknown"),
      " ",
      time,
      " | ",
      create("a", { attrs: { href: itemPath(item), class: "comments-link" } }, commentsLabel(item)),
    );
    return meta;
  }
}
