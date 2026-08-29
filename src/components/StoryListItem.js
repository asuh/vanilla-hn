/**
 * StoryListItem.js
 *
 * Factory for a story list item DOM node.
 * Returns an <li> element styled similarly to HN list rows.
 *
 * Exports:
 *  - createStoryListItem (named + default)
 *  - StoryListItem (semantic alias)
 */

import { create, timeAgoFromUnix } from "../utils/dom.js";
import { parseHost } from "../utils/helpers.js";
import { itemPath } from "../utils/item-ancestors.js";

/**
 * Create a story list item element.
 *
 * @param {Object} story - Story object from the HN API (id, title, by, time, score, descendants, url, kids).
 * @param {Object} [opts={}] - Display options.
 * @param {boolean} [opts.showHost=true] - Whether to display the hostname next to the title.
 * @param {boolean} [opts.showNewBadge=false] - Whether to display a "new" badge on the item.
 * @param {Function} [opts.onClick] - Click handler invoked with (event, story) when the row is clicked
 *   (clicks on anchor elements are ignored so default navigation can proceed).
 * @returns {HTMLElement} An <li> element representing the story row.
 */
export function createStoryListItem(story = {}, opts = {}) {
  const { showHost = true, showNewBadge = false, onClick } = opts;
  const id = story.id || String(Math.random()).slice(2, 8);
  const titleText = story.title || `Story ${id}`;
  const by = story.by || "unknown";
  const score = story.score != null ? story.score : 0;
  const descendants =
    story.descendants != null
      ? story.descendants
      : Array.isArray(story.kids)
        ? story.kids.length
        : 0;
  const url = story.url || null;

  const li = create("li", {
    attrs: { class: "item", "data-id": String(id) },
  });

  const titleDiv = create("div", { attrs: { class: "col" } });
  const titleEl = create("div", { attrs: { class: "title" } });
  const a = create("a", { attrs: { href: itemPath(story) } }, titleText);
  titleEl.appendChild(a);
  titleDiv.appendChild(titleEl);

  const meta = create(
    "div",
    { attrs: { class: "meta" } },
    `${score} points by ${by} · ${timeAgoFromUnix(story.time || Date.now() / 1000)} · ${descendants} comments`,
  );
  titleDiv.appendChild(meta);
  li.appendChild(titleDiv);

  if (showHost && url) {
    const host = parseHost(url);
    if (host) {
      const hostEl = create("div", { attrs: { class: "host" } }, host);
      li.appendChild(hostEl);
    }
  }

  if (showNewBadge) {
    const badge = create("span", { attrs: { class: "badge new" } }, "new");
    li.appendChild(badge);
  }

  if (typeof onClick === "function") {
    li.addEventListener("click", (ev) => {
      // If click target is a link, allow default navigation
      if (ev.target && ev.target.tagName === "A") return;
      ev.preventDefault();
      onClick(ev, story);
    });
  }

  return li;
}

/**
 * Semantic alias for consumers who prefer a constructor-style name.
 * Returns the same element as `createStoryListItem`.
 *
 * @param {Object} story - Story object.
 * @param {Object} [opts] - Display options.
 * @returns {HTMLElement} An <li> element representing the story row.
 */
export const StoryListItem = createStoryListItem;

export default createStoryListItem;
