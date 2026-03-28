/**
 * UserView.js
 *
 * Renders a Hacker News user profile page.
 *
 * Exports:
 *  - default: UserView — user profile view (karma, created, about, HN link)
 *
 * Context shape expected by this view:
 *  {
 *    params:   { id?: string },
 *    services: { hnService },
 *  }
 *
 * DOM structure:
 *   <div class="view user-view">
 *     <div class="container user-view__content">
 *       <h2 class="user-view__name">username</h2>
 *       <dl class="user-view__stats">
 *         <dt>karma</dt>  <dd>NNN</dd>
 *         <dt>joined</dt> <dd>X years ago</dd>
 *       </dl>
 *       <div class="user-view__about">…HTML from HN…</div>
 *       <p class="user-view__hn-link">
 *         <a href="https://news.ycombinator.com/user?id=username">profile on HN ↗</a>
 *       </p>
 *     </div>
 *   </div>
 */

import View from "./View.js";
import { create, timeAgoFromUnix } from "../utils/dom.js";

export default class UserView extends View {
  /**
   * Create a new UserView instance.
   *
   * @param {Object} context
   * @param {Object} [context.params]       - Route parameters.
   * @param {string} [context.params.id]    - The username to display.
   * @param {Object} [context.options]      - Additional options.
   * @param {string} [context.options.id]   - Alternative location for the username.
   * @param {Object} [context.services]     - Application services.
   * @param {Object} [context.services.hnService] - Hacker News data service.
   */
  constructor(context = {}) {
    super(context);

    this.userId =
      (context.params && context.params.id) ||
      (context.options && context.options.id) ||
      null;

    this._unsub = null;
    this._contentEl = null;
  }

  /* ─────────────────────────────────────
     Lifecycle
  ───────────────────────────────────── */

  /**
   * Build the initial shell and subscribe to user data.
   *
   * Returns the root HTMLElement synchronously so the Router can mount it
   * right away; the profile content is filled in once data arrives.
   *
   * @returns {HTMLElement} The root element for this view.
   */
  render() {
    document.title = `${this.userId || "User"} | vanilla-hn`;

    const wrapper = create("div", { attrs: { class: "view user-view" } });

    this._contentEl = create("div", {
      attrs: { class: "container user-view__content" },
    });

    // Show a loading indicator immediately
    this._contentEl.appendChild(
      create(
        "p",
        { attrs: { class: "user-view__loading" } },
        create("span", {
          attrs: {
            class: "spinner",
            role: "status",
            "aria-label": "Loading user profile…",
          },
        }),
      ),
    );

    wrapper.appendChild(this._contentEl);
    this.root = wrapper;

    this._subscribe();
    return wrapper;
  }

  /**
   * Unsubscribe from hnService and tear down any active listeners.
   * The base class cleanup() handles the AbortController and any extra
   * unsubscribers registered via watchEvent().
   *
   * @returns {void}
   */
  cleanup() {
    if (typeof this._unsub === "function") {
      try {
        this._unsub();
      } catch (_) {}
      this._unsub = null;
    }
    try {
      super.cleanup();
    } catch (_) {}
  }

  /* ─────────────────────────────────────
     Private
  ───────────────────────────────────── */

  /**
   * Subscribe to hnService for the user profile data.
   * Calls _renderUser() when data arrives or _renderError() on failure.
   */
  _subscribe() {
    const hn = this.services && this.services.hnService;

    if (!hn || typeof hn.onUserValue !== "function" || !this.userId) {
      this._renderError(
        "User data service unavailable or no user id provided.",
      );
      return;
    }

    this._unsub = hn.onUserValue(this.userId, (user) => {
      try {
        if (!user) {
          this._renderError(`User "${this.userId}" not found.`);
        } else {
          document.title = `${user.id || this.userId} | vanilla-hn`;
          this._renderUser(user);
        }
      } catch (err) {
        console.warn("UserView: error rendering user", err);
      }
    });
  }

  /**
   * Replace the content element's children with the fully rendered user profile.
   *
   * @param {Object} user  — { id, karma, created (unix seconds), about (HTML string) }
   */
  _renderUser(user) {
    if (!this._contentEl) return;

    const id = user.id || this.userId || "Unknown";
    const karma = user.karma != null ? user.karma : 0;
    const created =
      user.created != null ? timeAgoFromUnix(user.created) : "unknown";
    const about = user.about || ""; // may contain HTML (HN returns <a>, <p>, etc.)
    const hnUrl = `https://news.ycombinator.com/user?id=${encodeURIComponent(id)}`;

    // ── Name heading ───────────────────────────────────────────────────────
    const heading = create("h2", { attrs: { class: "user-view__name" } }, id);

    // ── Stats table (karma + joined date) ──────────────────────────────────
    const stats = create(
      "dl",
      { attrs: { class: "user-view__stats" } },
      create("dt", {}, "karma"),
      create("dd", { attrs: { class: "user-view__karma" } }, String(karma)),
      create("dt", {}, "joined"),
      create("dd", { attrs: { class: "user-view__joined" } }, created),
    );

    // ── About section ──────────────────────────────────────────────────────
    // HN returns the `about` field as pre-rendered HTML (links, paragraphs, etc.)
    // so we must use innerHTML here. This is fine because the content originates
    // directly from HN's API and is the user's own self-description.
    const aboutSection = create("div", {
      attrs: { class: "user-view__about" },
    });
    if (about) {
      aboutSection.innerHTML = about;
    }

    // ── External HN profile link ───────────────────────────────────────────
    const hnLink = create(
      "p",
      { attrs: { class: "user-view__hn-link" } },
      create(
        "a",
        {
          attrs: {
            href: hnUrl,
            target: "_blank",
            rel: "noopener noreferrer",
            class: "user-view__hn-link-anchor",
          },
        },
        `View ${id}'s profile on Hacker News ↗`,
      ),
    );

    // ── Replace content ────────────────────────────────────────────────────
    this._contentEl.replaceChildren(heading, stats, aboutSection, hnLink);
  }

  /**
   * Show a plain-text error message in the content area.
   *
   * @param {string} msg  The error message to display.
   */
  _renderError(msg) {
    if (!this._contentEl) return;
    this._contentEl.replaceChildren(
      create("p", { attrs: { class: "user-view__error" } }, msg),
    );
  }
}
