/**
 * CommentThreadStore.js
 *
 * Base class providing pure comment-graph wiring, an observer pattern, and
 * collapse / child-count logic.  Contains no persistence, no loading tracking,
 * no settings, and no HN-specific new-comment detection.
 *
 * This mirrors the separation in react-hn where CommentThreadStore is the base
 * class and StoryCommentThreadStore is the derived class that adds
 * story-specific behaviour.
 *
 * @module CommentThreadStore
 */

export default class CommentThreadStore {
  /**
   * Initialise all core data structures and the observer list.
   *
   * Subclasses should call `super()` before adding their own state.
   */
  constructor() {
    /**
     * Full comment payloads keyed by id.
     * @type {Object.<number, object>}
     */
    this.comments = {};

    /**
     * Child id arrays keyed by parent id.
     * @type {Object.<number, number[]>}
     */
    this.children = {};

    /**
     * Parent id keyed by comment id.
     * @type {Object.<number, number>}
     */
    this.parents = {};

    /**
     * Truthy flags for comments that are newer than the last visit.
     * Set by the subclass, read by the base class for counts.
     * @type {Object.<number, true>}
     */
    this.isNew = {};

    /**
     * Truthy flags for comment roots that are collapsed.
     * @type {Object.<number, true>}
     */
    this.isCollapsed = {};

    /**
     * Truthy flags for dead comments.
     * @type {Object.<number, true>}
     */
    this.deadComments = {};

    /**
     * Registered listener callbacks.
     * @type {Function[]}
     * @private
     */
    this._listeners = [];
  }

  // -------------------------------------------------------------------------
  // Observer API
  // -------------------------------------------------------------------------

  /**
   * Register a listener function that will be called with a change descriptor
   * object whenever the store's state changes.
   *
   * The change descriptor always contains a `type` string (e.g. `'number'`,
   * `'collapse'`, `'first_load_complete'`) so listeners can decide whether to
   * re-render.
   *
   * @param {Function} fn  Callback invoked as `fn({ type: string, ... })`.
   * @returns {Function} An unsubscribe function — call it to remove the listener.
   */
  addListener(fn) {
    if (typeof fn !== "function") throw new TypeError("addListener: expected a function");
    this._listeners.push(fn);
    return () => {
      const idx = this._listeners.indexOf(fn);
      if (idx !== -1) this._listeners.splice(idx, 1);
    };
  }

  /**
   * Notify all registered listeners with a change descriptor.
   *
   * A snapshot of the listener array is taken before iteration so that
   * listeners which unsubscribe during notification do not affect the
   * current dispatch cycle. Errors thrown by individual listeners are
   * caught and swallowed to prevent one bad subscriber from breaking others.
   *
   * @param {Object} [change]      The change descriptor forwarded to each listener.
   * @param {string} change.type   A short label identifying what changed
   *                                (e.g. `'number'`, `'collapse'`, `'first_load_complete'`).
   */
  notify(change) {
    const snapshot = this._listeners.slice();
    for (let i = 0; i < snapshot.length; i++) {
      try {
        snapshot[i](change);
      } catch (_e) {
        /* never let a bad listener break the store */
      }
    }
  }

  // -------------------------------------------------------------------------
  // Comment graph wiring
  // -------------------------------------------------------------------------

  /**
   * Wire a comment into the in-memory comment graph.
   *
   * Stores the comment payload, initialises its children array, ensures the
   * parent's children array exists, appends the comment id to the parent's
   * children list, and flags dead comments.
   *
   * Subclasses should call `super.commentAdded(comment)` to perform this
   * graph wiring before adding their own story-specific logic.
   *
   * @param {Object} comment  Comment payload. Expected shape:
   *   `{ id: number, parent: number, dead?: boolean }`.
   */
  commentAdded(comment) {
    // Store the full payload.
    this.comments[comment.id] = comment;

    // Ensure this comment has a children entry (it may already exist if a
    // child arrived before its parent).
    this.children[comment.id] = this.children[comment.id] || [];

    // Guard against an orphaned comment whose parent entry doesn't exist yet.
    if (!this.children[comment.parent]) {
      this.children[comment.parent] = [];
    }

    // Append to parent's children list, avoiding duplicate wiring when a
    // realtime item listener emits an updated payload for an existing comment.
    if (!this.children[comment.parent].includes(comment.id)) {
      this.children[comment.parent].push(comment.id);
    }

    // Flag dead comments.
    if (comment.dead) {
      this.deadComments[comment.id] = true;
    }
  }

  /**
   * Remove a comment from the in-memory comment graph.
   *
   * Deletes the payload from `comments`, splices the id out of its parent's
   * `children` array, and removes the dead-comment flag.
   *
   * Subclasses should call `super.commentDeleted(comment)` to perform this
   * graph cleanup before adding their own story-specific logic.
   *
   * @param {Object|null} comment  The comment object to remove. May be `null`
   *   for comments that never fully loaded — in which case this method is a
   *   no-op.
   */
  commentDeleted(comment) {
    if (!comment) return;

    // Remove the payload.
    delete this.comments[comment.id];

    // Splice out of parent's children list.
    const siblings = this.children[comment.parent];
    if (siblings) {
      const idx = siblings.indexOf(comment.id);
      if (idx !== -1) siblings.splice(idx, 1);
    }

    // Remove dead flag.
    delete this.deadComments[comment.id];
  }

  // -------------------------------------------------------------------------
  // Collapse management
  // -------------------------------------------------------------------------

  /**
   * Toggle the collapsed state of a single comment thread.
   *
   * When `explicitState` is provided the collapsed state is set to that value
   * rather than toggled. Notifies listeners with `{ type: 'collapse' }` only
   * when the state actually changes.
   *
   * @param {number|string} commentId      The id of the comment to collapse / expand.
   * @param {boolean}       [explicitState] If provided, forces the collapsed
   *                                        state to this value instead of toggling.
   */
  toggleCollapse(commentId, explicitState) {
    const newState =
      explicitState !== undefined ? Boolean(explicitState) : !this.isCollapsed[commentId];
    const oldState = Boolean(this.isCollapsed[commentId]);

    if (newState === oldState) return;

    this.isCollapsed[commentId] = newState;
    this.notify({ type: "collapse" });
  }

  // -------------------------------------------------------------------------
  // Counts
  // -------------------------------------------------------------------------

  /**
   * Count the total descendants and new-comment descendants of a comment.
   *
   * Uses an iterative BFS over the in-memory `children` map so that deeply
   * nested threads do not risk a stack overflow. The comment itself is not
   * included in either count — only its descendants.
   *
   * @param {Object} comment  A comment object with a numeric `.id` property.
   * @returns {{ children: number, newComments: number }} An object with:
   *   - `children` — total number of descendants (all levels).
   *   - `newComments` — how many of those descendants are flagged as new.
   */
  getChildCounts(comment) {
    let childCount = 0;
    let newCommentCount = 0;

    // Each iteration of the while-loop processes one "generation".
    let nodes = [comment.id];

    while (nodes.length) {
      const nextNodes = [];

      for (let i = 0; i < nodes.length; i++) {
        const nodeChildren = this.children[nodes[i]];
        if (nodeChildren?.length) {
          nextNodes.push(...nodeChildren);
        }
      }

      // Count new comments in the next generation.
      for (let i = 0; i < nextNodes.length; i++) {
        if (this.isNew[nextNodes[i]]) newCommentCount++;
      }

      childCount += nextNodes.length;
      nodes = nextNodes;
    }

    return { children: childCount, newComments: newCommentCount };
  }
}
