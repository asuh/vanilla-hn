/**
 * Paginator.js
 *
 * Reusable pagination component for vanilla-hn.
 * Renders prev/next navigation links given the current page state
 * and a function to build hrefs for each page number.
 *
 * @module components/Paginator
 *
 * @example
 *   import { Paginator } from '../components/Paginator.js';
 *
 *   const paginator = new Paginator({
 *     page: 2,
 *     hasMore: true,
 *     buildHref: (p) => p <= 1 ? '#/newest' : `#/newest?page=${p}`,
 *   });
 *
 *   container.appendChild(paginator.render());
 *
 *   // Later, update without re-creating:
 *   paginator.update({ page: 3, hasMore: false });
 */

import { create } from "../utils/dom.js";

/**
 * Lightweight pagination UI.
 *
 * @class Paginator
 */
export class Paginator {
  /**
   * @param {Object}   options
   * @param {number}   options.page      - Current 1-based page number.
   * @param {boolean}  options.hasMore   - Whether a next page exists.
   * @param {Function} options.buildHref - `(pageNumber: number) => string` — builds the href for a given page.
   * @param {string}   [options.prevText='\u2190 prev'] - Label for the previous link.
   * @param {string}   [options.nextText='more \u2192'] - Label for the next/more link.
   * @param {string}   [options.className='pagination']  - CSS class for the outer `<nav>`.
   * @param {string}   [options.linkClassName='pagination__link'] - CSS class for each `<a>`.
   */
  constructor(options = {}) {
    this.page = options.page ?? 1;
    this.hasMore = options.hasMore ?? false;
    this.buildHref = options.buildHref ?? ((p) => `?page=${p}`);
    this.prevText = options.prevText ?? "\u2190 prev";
    this.nextText = options.nextText ?? "more \u2192";
    this.className = options.className ?? "pagination";
    this.linkClassName = options.linkClassName ?? "pagination__link";

    /** @type {HTMLElement|null} */
    this.el = null;
  }

  /**
   * Build (or rebuild) the pagination DOM and return it.
   *
   * @returns {HTMLElement} A `<nav>` element containing prev/next links.
   */
  render() {
    if (!this.el) {
      this.el = create("nav", {
        attrs: {
          class: this.className,
          "aria-label": "Pagination",
        },
      });
    }

    this._sync();
    return this.el;
  }

  /**
   * Update pagination state and re-render in place.
   *
   * @param {Object}  changes
   * @param {number}  [changes.page]
   * @param {boolean} [changes.hasMore]
   */
  update(changes = {}) {
    if ("page" in changes) this.page = changes.page;
    if ("hasMore" in changes) this.hasMore = changes.hasMore;
    if ("buildHref" in changes) this.buildHref = changes.buildHref;

    if (this.el) {
      this._sync();
    }
  }

  /**
   * Remove the element from the DOM and release references.
   */
  cleanup() {
    if (this.el && this.el.parentNode) {
      this.el.parentNode.removeChild(this.el);
    }
    this.el = null;
  }

  // ── Private ──────────────────────────────────────────────────────────

  /**
   * Synchronise the DOM contents of `this.el` with current state.
   * @private
   */
  _sync() {
    const children = [];

    if (this.page > 1) {
      children.push(
        create(
          "a",
          {
            attrs: {
              href: this.buildHref(this.page - 1),
              class: `${this.linkClassName} ${this.linkClassName}--prev`,
              rel: "prev",
            },
          },
          this.prevText,
        ),
      );
    }

    if (this.hasMore) {
      children.push(
        create(
          "a",
          {
            attrs: {
              href: this.buildHref(this.page + 1),
              class: `${this.linkClassName} ${this.linkClassName}--next`,
              rel: "next",
            },
          },
          this.nextText,
        ),
      );
    }

    // Single DOM write — replaceChildren is supported in all target browsers
    if (this.el.replaceChildren) {
      this.el.replaceChildren(...children);
    } else {
      this.el.innerHTML = "";
      for (const child of children) {
        this.el.appendChild(child);
      }
    }
  }
}

/**
 * Convenience factory that builds a pagination `<nav>` element in one call.
 *
 * @param {Object}   options           - Same options as the Paginator constructor.
 * @param {number}   options.page
 * @param {boolean}  options.hasMore
 * @param {Function} options.buildHref
 * @returns {HTMLElement} The rendered `<nav>` element.
 */
export function createPaginator(options = {}) {
  const p = new Paginator(options);
  return p.render();
}

export default Paginator;
