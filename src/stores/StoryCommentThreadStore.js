/**
 * StoryCommentThreadStore.js
 *
 * Derived class that extends CommentThreadStore with story-specific behaviour:
 * persistence, loading tracking, settings integration, and HN-specific
 * new-comment detection.
 *
 * Responsibilities
 * ----------------
 *  - Track every comment payload, parent→child relationships and per-comment
 *    flags (isNew, isCollapsed, dead) for a single story thread.
 *  - Detect "new" comments by comparing comment ids against the highest id seen
 *    on the previous visit (prevMaxCommentId).
 *  - Persist a lightweight snapshot (lastVisit, commentCount, maxCommentId) to
 *    storage on every meaningful state change, debounced to 123 ms.
 *  - Auto-collapse threads that contain no new comments once the initial load
 *    completes (when SettingsStore.autoCollapse is on).
 *  - Expose an observer API (addListener / notify) so views can react to changes
 *    without coupling to any specific framework.
 *
 * Data structures (all per-instance, keyed by comment id)
 * -------------------------------------------------------
 *  comments        {id → comment object}          full payloads       (base class)
 *  children        {id → id[]}                    story root + every comment (base class)
 *  parents         {commentId → parentId}         excludes story root (base class)
 *  isNew           {commentId → true}             comments newer than last visit (base class)
 *  isCollapsed     {commentId → true}             collapsed comment roots (base class)
 *  deadComments    {commentId → true}             dead comments       (base class)
 *
 * Scalar state
 * ------------
 *  lastVisit           unix-ms timestamp of previous visit (null on first visit)
 *  prevMaxCommentId    highest comment id from previous visit
 *  maxCommentId        highest comment id seen this visit
 *  commentCount        loaded non-deleted (and non-dead-if-showDead-off) comments
 *  newCommentCount     loaded comments that are "new"
 *  expectedComments    number of comments still expected to arrive
 *  itemDescendantCount item.descendants from the API
 *  loading             true until initial load completes
 *
 * Usage
 * -----
 *  import StoryCommentThreadStore, { loadState } from './StoryCommentThreadStore.js';
 *
 *  const store = new StoryCommentThreadStore(storyId, { storage: localStorage });
 *  store.addListener(change => render(change));
 *  store.initForItem(item);   // call once when the story payload arrives
 *  // … feed comments via store.commentAdded(comment) as they stream in …
 */

import { cancellableDebounce, pluralise } from "../utils/helpers.js";
import CommentThreadStore from "./CommentThreadStore.js";
import SettingsStoreClass from "./SettingsStore.js";

// ---------------------------------------------------------------------------
// Module-level SettingsStore singleton
//
// react-hn's SettingsStore is a plain singleton object with direct property
// access (SettingsStore.autoCollapse, SettingsStore.showDead, etc.).
// vanilla-hn's SettingsStore is a class whose state lives in this._state and
// is accessed via instance.get(key).
//
// To match react-hn's usage pattern throughout this file we create one shared
// module-level instance and expose a thin adapter object with the same
// property names that react-hn's code reads directly.  Callers can override
// the instance via `options.settings` in the constructor (useful for tests).
// ---------------------------------------------------------------------------

/**
 * Create a duck-typed adapter around a SettingsStore instance so that code
 * written against react-hn's plain-object SettingsStore (i.e. `Settings.autoCollapse`)
 * works without change.
 *
 * @param {InstanceType<SettingsStoreClass>} instance
 * @returns {{ autoCollapse: boolean, showDead: boolean, showDeleted: boolean }}
 */
function makeSettingsAdapter(instance) {
  return {
    get autoCollapse() {
      return Boolean(instance.get("autoCollapse"));
    },
    get showDead() {
      return Boolean(instance.get("showDead"));
    },
    get showDeleted() {
      return Boolean(instance.get("showDeleted"));
    },
  };
}

/**
 * Shared default settings instance.  Created lazily on first import so that
 * tests can import the module without a real `window.localStorage`.
 */
let _defaultSettingsInstance = null;
function getDefaultSettings() {
  if (!_defaultSettingsInstance) {
    _defaultSettingsInstance = makeSettingsAdapter(new SettingsStoreClass());
  }
  return _defaultSettingsInstance;
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/**
 * Safe localStorage/sessionStorage wrapper so the rest of the code never has
 * to guard against missing storage or quota errors.
 */
const defaultStorage = {
  get(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  },
  set(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (e) {
      /* quota / private mode */
    }
  },
};

// ---------------------------------------------------------------------------
// Exported named helper — mirrors StoryCommentThreadStore.loadState
// ---------------------------------------------------------------------------

/**
 * Load the persisted comment-thread state for a story from storage.
 *
 * Returns a default shape when the story has never been visited.
 * This is exported as a named export so that list pages can peek at
 * the stored state without instantiating a full store.
 *
 * @param {number|string} storyId   The HN story ID whose persisted state
 *                                   should be loaded.
 * @param {object}        [storage]  Object with `.get(key)` → string | null.
 *                                   Defaults to localStorage via `defaultStorage`.
 * @returns {{ lastVisit: number|null, commentCount: number, maxCommentId: number }}
 *   An object containing the last-visit timestamp (ms), the persisted
 *   descendant count, and the highest comment ID seen on the previous visit.
 */
export function loadState(storyId, storage = defaultStorage) {
  const raw = storage.get(String(storyId));
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch (e) {
      // Malformed JSON — fall through to defaults.
    }
  }
  return { lastVisit: null, commentCount: 0, maxCommentId: 0 };
}

// ---------------------------------------------------------------------------
// Main class
// ---------------------------------------------------------------------------

export default class StoryCommentThreadStore extends CommentThreadStore {
  /**
   * Create a new StoryCommentThreadStore for a single story thread.
   *
   * Loads any previously persisted snapshot (lastVisit, commentCount,
   * maxCommentId) from storage so that returning visits can detect which
   * comments are "new". Sets up debounced persistence and count-change
   * notification callbacks (both at 123 ms to match react-hn).
   *
   * @param {number|string} storyId   The HN story ID this store tracks.
   * @param {Object}        [options] Configuration overrides.
   * @param {string}        [options.storageKey]  Override the key used for persistence.
   *                                              Defaults to the storyId itself (react-hn
   *                                              stores each story under its own id).
   * @param {Object}        [options.storage]     Injectable storage; must expose
   *                                              `.get(key)` and `.set(key, value)`.
   *                                              Defaults to localStorage.
   * @param {Object}        [options.settings]    A SettingsStore instance or a plain
   *                                              adapter object with `autoCollapse`,
   *                                              `showDead`, and `showDeleted` boolean
   *                                              properties.
   */
  constructor(storyId, options = {}) {
    super();

    this.storyId = storyId;
    this._storageKey =
      options.storageKey != null ? options.storageKey : String(storyId);
    this._storage = options.storage != null ? options.storage : defaultStorage;

    /**
     * Settings adapter — provides `.autoCollapse`, `.showDead`, `.showDeleted`.
     * Consumers can inject a custom adapter via `options.settings` (handy for
     * tests or when the app already holds a SettingsStore instance).
     *
     * Accepted shapes:
     *   - A raw SettingsStoreClass instance  → wrapped in makeSettingsAdapter
     *   - A plain adapter object with the expected boolean properties
     *   - Omitted / null                     → module-level default singleton
     */
    if (options.settings != null) {
      this._settings =
        options.settings instanceof SettingsStoreClass
          ? makeSettingsAdapter(options.settings)
          : options.settings;
    } else {
      this._settings = getDefaultSettings();
    }

    // -----------------------------------------------------------------
    // Scalar state  (StoryCommentThreadStore layer in react-hn)
    // -----------------------------------------------------------------

    /** Number of non-deleted (and non-dead-when-showDead-off) comments loaded. */
    this.commentCount = 0;

    /** Number of comments that are "new" (id > prevMaxCommentId). */
    this.newCommentCount = 0;

    /** Highest comment id observed this session. */
    this.maxCommentId = 0;

    /** True while the initial wave of comments is still streaming in. */
    this.loading = true;

    /**
     * How many comments we are currently waiting for.
     * Starts as the number of top-level kids; grows as nested kids are discovered.
     */
    this.expectedComments = 0;

    /**
     * item.descendants from the API — includes deleted comments so may never
     * equal commentCount, but we persist it for the "new comments since last
     * visit" heuristic on list pages.
     */
    this.itemDescendantCount = 0;

    // -----------------------------------------------------------------
    // Persisted state loaded from storage
    // -----------------------------------------------------------------

    const saved = loadState(this._storageKey, this._storage);

    /** Unix-ms timestamp of the previous visit; null on first ever visit. */
    this.lastVisit = saved.lastVisit;

    /**
     * Highest comment id seen during the previous visit.
     * Used to decide which comments are "new" this time round.
     */
    this.prevMaxCommentId = saved.maxCommentId;

    /** True when this is the user's very first visit to this story. */
    this.isFirstVisit = saved.lastVisit === null;

    // -----------------------------------------------------------------
    // Internal bookkeeping
    // -----------------------------------------------------------------

    /** Unix-ms time this instance was created, for load-time logging. */
    this._startedLoading = Date.now();

    /**
     * Debounced version of _notifyCountChanged so we don't spam the view
     * with re-renders while hundreds of comments are streaming in.
     * Matches react-hn's 123 ms debounce interval exactly.
     */
    this._debouncedCountChanged = cancellableDebounce(
      () => this.notify({ type: "number" }),
      123,
    );

    /**
     * Debounced persistence.  Also fires at 123 ms to match react-hn.
     */
    this._debouncedSave = cancellableDebounce(() => this._persistState(), 123);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Initialise the store for a story item once its payload has been fetched.
   *
   * Sets up the root children entry, records `item.descendants` for the
   * new-comment heuristic, seeds `expectedComments` from the item's top-level
   * `kids` array, and runs an immediate completion check so that stories with
   * zero comments finish loading right away.
   *
   * This must be called exactly once per store instance before any
   * `commentAdded` / `commentDeleted` calls.
   *
   * @param {Object} item  HN item payload. Expected shape:
   *                        `{ id: number, kids?: number[], descendants?: number }`.
   */
  initForItem(item) {
    // Seed the root children entry so BFS always has a starting point.
    this.children[item.id] = this.children[item.id] || [];

    this.itemDescendantCount = item.descendants || 0;
    this.expectedComments = item.kids ? item.kids.length : 0;

    // Run an immediate check: if there are genuinely zero comments the loading
    // spinner should disappear without waiting for any comment events.
    this.checkLoadCompletion();
  }

  // -------------------------------------------------------------------------
  // Comment ingestion
  // -------------------------------------------------------------------------

  /**
   * Ingest a comment that has arrived from the API.
   *
   * Processing steps:
   *  1. **Deleted comments** — decrement `expectedComments` and return early
   *     (no payload is stored).
   *  2. **Graph wiring** — delegate to base class `CommentThreadStore.commentAdded`.
   *  3. **Dead handling** — flag dead comments; when `showDead` is off they do
   *     not contribute to `commentCount` or `expectedComments`.
   *  4. **New-comment detection** — comments whose `id` exceeds
   *     `prevMaxCommentId` are marked as new.
   *  5. **Completion check** — during the initial load, every ingestion
   *     re-evaluates whether all expected comments have arrived.
   *
   * @param {Object} comment  HN comment payload. Expected shape:
   *   `{ id: number, parent: number, deleted?: boolean, dead?: boolean, kids?: number[] }`.
   */
  commentAdded(comment) {
    const previous = this.comments[comment.id];
    if (previous) {
      const prevKids = Array.isArray(previous.kids) ? previous.kids.length : 0;
      const nextKids = Array.isArray(comment.kids) ? comment.kids.length : 0;
      this.comments[comment.id] = comment;
      if (this.loading && nextKids !== prevKids) {
        this.adjustExpectedComments(nextKids - prevKids);
      }
      if (!previous.deleted && comment.deleted) {
        this.commentDeleted(previous);
      } else if (!previous.dead && comment.dead) {
        this.commentDied(comment);
      }
      return;
    }

    // ------------------------------------------------------------------
    // Deleted comments do not count; just reduce what we're waiting for.
    // ------------------------------------------------------------------
    if (comment.deleted) {
      if (this.loading) {
        this.expectedComments--;
        this.checkLoadCompletion();
      }
      return;
    }

    // ------------------------------------------------------------------
    // Wire into the comment graph (CommentThreadStore base class).
    // ------------------------------------------------------------------
    super.commentAdded(comment);

    // ------------------------------------------------------------------
    // Count and "new" detection  (StoryCommentThreadStore layer).
    // ------------------------------------------------------------------

    // Dead comments don't contribute to the visible count when showDead is off.
    if (comment.dead && !this._settings.showDead) {
      // Reduce expectedComments so the loading indicator isn't stalled waiting
      // for a comment that will never appear in the count.
      this.expectedComments--;
    } else {
      this.commentCount++;
    }

    // Expand expectedComments to include this comment's own children.
    if (this.loading && comment.kids) {
      this.expectedComments += comment.kids.length;
    }

    // Mark as new if it arrived after the last visit.
    if (
      this.prevMaxCommentId > 0 &&
      comment.id > this.prevMaxCommentId &&
      (!comment.dead || this._settings.showDead)
    ) {
      this.newCommentCount++;
      this.isNew[comment.id] = true;
    }

    // Track the high-water mark for comment ids and debounce-persist so that
    // a reload always sees the latest maxCommentId without depending solely on
    // beforeunload (which may fire before lazy-loaded comments arrive).
    if (comment.id > this.maxCommentId) {
      this.maxCommentId = comment.id;
      this._debouncedSave();
    }

    // Record parent relationship (the story root itself is excluded).
    if (comment.parent !== this.storyId) {
      this.parents[comment.id] = comment.parent;
    }

    // Debounced notification so the view isn't thrashed during bulk load.
    this._debouncedCountChanged();

    if (this.loading) {
      this.checkLoadCompletion();
    }
  }

  /**
   * Remove a comment that was previously registered but has since been deleted.
   *
   * Undoes the graph wiring performed by {@link commentAdded}: delegates to
   * the base class for graph cleanup, then decrements `commentCount` /
   * `newCommentCount` as appropriate.
   *
   * @param {Object|null} comment  The comment object to remove. May be `null`
   *   for comments that never fully loaded before being deleted — in which
   *   case this method is a no-op.
   */
  commentDeleted(comment) {
    if (!comment) return;

    // --- CommentThreadStore base class (graph wiring) ---
    super.commentDeleted(comment);

    // --- StoryCommentThreadStore layer ---
    this.commentCount--;

    if (this.isNew[comment.id]) {
      this.newCommentCount--;
      delete this.isNew[comment.id];
    }

    delete this.parents[comment.id];

    this._debouncedCountChanged();
  }

  commentDied(comment) {
    if (!comment) return;
    this.deadComments[comment.id] = true;
    if (!this._settings.showDead) {
      this.commentCount--;
      if (this.isNew[comment.id]) {
        this.newCommentCount--;
        delete this.isNew[comment.id];
      }
      this._debouncedCountChanged();
    }
  }

  /**
   * Called when a comment that was expected to arrive has been delayed
   * (e.g. Firebase returned null and the retry is pending).
   * We stop waiting for it so the loading indicator can resolve.
   *
   * Mirrors react-hn StoryCommentThreadStore#commentDelayed.
   *
   * @param {number} commentId
   */
  commentDelayed(commentId) {
    // eslint-disable-line no-unused-vars
    this.expectedComments--;
    // No checkLoadCompletion here: react-hn doesn't call it in commentDelayed either.
  }

  /**
   * Adjust expectedComments by a delta (positive or negative) and re-check
   * whether loading has completed.
   *
   * Mirrors react-hn StoryCommentThreadStore#adjustExpectedComments.
   *
   * @param {number} delta
   */
  adjustExpectedComments(delta) {
    this.expectedComments += delta;
    this.checkLoadCompletion();
  }

  /**
   * Update the item descriptor when a fresh version of the story arrives from
   * the API (e.g. a Firebase realtime update).
   *
   * Mirrors react-hn StoryCommentThreadStore#itemUpdated.
   *
   * @param {object} item
   */
  itemUpdated(item) {
    this.itemDescendantCount = item.descendants;
  }

  // -------------------------------------------------------------------------
  // Load completion
  // -------------------------------------------------------------------------

  /**
   * Check whether all expected comments have arrived and, if so, finalise the
   * loading state and trigger any post-load side-effects.
   *
   * Mirrors react-hn StoryCommentThreadStore#checkLoadCompletion.
   */
  checkLoadCompletion() {
    if (!this.loading) return;
    if (this.commentCount < this.expectedComments) return;

    // Log load timing in non-production environments.
    if (
      typeof process === "undefined" ||
      process.env.NODE_ENV !== "production"
    ) {
      const elapsed = ((Date.now() - this._startedLoading) / 1000).toFixed(2);
      console.info(
        `Initial load of ${this.commentCount} comment${pluralise(this.commentCount)}` +
          ` for ${this.storyId} took ${elapsed}s`,
      );
    }

    this.loading = false;

    if (this.isFirstVisit) {
      // First ever visit: establish the baseline for future new-comment detection.
      this.firstLoadComplete();
    } else if (this._settings.autoCollapse && this.newCommentCount > 0) {
      // Returning visit with new comments: fold away threads without new content.
      this.collapseThreadsWithoutNewComments();
    }

    // Persist state, advancing stored maxCommentId to the current session max.
    // This matches react-hn's _storeState() behaviour: after the initial load
    // completes the current comments are "seen", so a reload will not re-show
    // them as new. Only comments that arrive *after* the previous dispose()
    // (i.e. posted between sessions) will appear highlighted on the next visit.
    this._persistState();
  }

  /**
   * Called the very first time a story finishes loading.
   * Establishes the visit timestamp and prevMaxCommentId baseline that future
   * visits will use for new-comment detection.
   *
   * Mirrors react-hn StoryCommentThreadStore#firstLoadComplete.
   */
  firstLoadComplete() {
    this.lastVisit = Date.now();
    this.prevMaxCommentId = this.maxCommentId;
    this.isFirstVisit = false;
    this.notify({ type: "first_load_complete" });
  }

  // -------------------------------------------------------------------------
  // Collapse management
  // -------------------------------------------------------------------------

  /**
   * Collapse every comment thread that contains no new comments.
   *
   * Uses a two-pass BFS algorithm (matches react-hn exactly):
   *
   * **Pass 1 — ancestor tagging:** Walk up the `parents` chain from every
   * comment in `isNew`, recording each ancestor id in a `hasNewComments`
   * lookup. This marks the *path* from the story root to each new comment.
   *
   * **Pass 2 — BFS collapse:** Starting from the story root's direct
   * children, iterate one level at a time:
   *  - If a comment id is **not** in `hasNewComments` and is **not** itself
   *    new → mark it for collapsing (its entire subtree has nothing new).
   *  - If a comment id **is** in `hasNewComments` → recurse into its children
   *    to find the exact subtree boundary.
   *
   * After the BFS, `isCollapsed` is replaced wholesale and listeners are
   * notified with `{ type: 'collapse' }`.
   */
  collapseThreadsWithoutNewComments() {
    // Step 1 — build ancestor lookup from isNew comments.
    const newCommentIds = Object.keys(this.isNew);
    const hasNewComments = {};

    for (let i = 0; i < newCommentIds.length; i++) {
      let parent = this.parents[newCommentIds[i]];
      while (parent) {
        if (hasNewComments[parent]) break; // already visited this chain
        hasNewComments[parent] = true;
        parent = this.parents[parent];
      }
    }

    // Step 2 — BFS from story root, marking subtrees for collapse.
    const shouldCollapse = {};
    let commentIds = this.children[this.storyId] || [];

    while (commentIds.length) {
      const nextCommentIds = [];

      for (let i = 0; i < commentIds.length; i++) {
        const commentId = commentIds[i];

        if (!hasNewComments[commentId]) {
          // This subtree has no new comments.
          // Collapse it unless the root comment is itself new (its children
          // must then all be new too, so collapsing would hide them).
          if (!this.isNew[commentId]) {
            shouldCollapse[commentId] = true;
          }
        } else {
          // This subtree contains new comments — keep it open and go deeper.
          const childIds = this.children[commentId];
          if (childIds && childIds.length) {
            nextCommentIds.push(...childIds);
          }
        }
      }

      commentIds = nextCommentIds;
    }

    // Step 3 — apply and notify.
    this.isCollapsed = shouldCollapse;
    this.notify({ type: "collapse" });
  }

  // -------------------------------------------------------------------------
  // Time-index / highlight helpers
  // -------------------------------------------------------------------------

  /**
   * Return the comment at a given 1-based chronological position.
   *
   * All stored comment ids are sorted in ascending order (ascending id ≈
   * chronological order on HN). Dead comments are excluded from the sorted
   * list when `showDead` is off.
   *
   * @param {number} timeIndex  1-based index into the sorted comment list.
   * @returns {Object|undefined} The comment object at that position, or
   *   `undefined` if the index is out of range.
   */
  getCommentByTimeIndex(timeIndex) {
    let sortedIds = Object.keys(this.comments).map(Number);

    if (!this._settings.showDead) {
      sortedIds = sortedIds.filter((id) => !this.deadComments[id]);
    }

    sortedIds.sort((a, b) => a - b);

    const commentId = sortedIds[timeIndex - 1];
    return this.comments[commentId];
  }

  /**
   * Re-define which comments are "new" based on a chronological cut-off and
   * then collapse threads that contain none of them.
   *
   * This powers the "show comments since N" slider: every comment whose `id`
   * is greater than the reference comment's `id` is marked as new, then
   * {@link collapseThreadsWithoutNewComments} is called to fold away threads
   * that have no new content.
   *
   * @param {number} timeIndex  1-based chronological index passed to
   *   {@link getCommentByTimeIndex} to obtain the reference comment.
   */
  highlightNewCommentsSince(timeIndex) {
    const referenceComment = this.getCommentByTimeIndex(timeIndex);
    if (!referenceComment) return;

    // BFS the tree, rebuilding isNew for any comment with id > reference.id.
    const isNew = {};
    let commentIds = this.children[this.storyId] || [];

    while (commentIds.length) {
      const nextCommentIds = [];

      for (let i = 0; i < commentIds.length; i++) {
        const commentId = commentIds[i];

        if (commentId > referenceComment.id) {
          isNew[commentId] = true;
        }

        const childIds = this.children[commentId];
        if (childIds && childIds.length) {
          nextCommentIds.push(...childIds);
        }
      }

      commentIds = nextCommentIds;
    }

    this.isNew = isNew;
    this.collapseThreadsWithoutNewComments();
  }

  // -------------------------------------------------------------------------
  // Mark as read
  // -------------------------------------------------------------------------

  /**
   * Mark the current thread as fully read.
   *
   * Resets all new-comment tracking state:
   *  - `newCommentCount` is set to `0`.
   *  - `isNew` map is cleared.
   *  - `prevMaxCommentId` is advanced to `maxCommentId` so that the next
   *    visit starts fresh.
   *  - `lastVisit` is updated to the current time.
   *  - The updated state is persisted to storage immediately.
   */
  markAsRead() {
    this.lastVisit = Date.now();
    this.newCommentCount = 0;
    this.prevMaxCommentId = this.maxCommentId;
    this.isNew = {};
    this._persistState();
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  /**
   * Write the lightweight persistence snapshot to storage immediately (no debounce).
   *
   * Schema mirrors react-hn StoryCommentThreadStore#_storeState:
   *   { lastVisit: ms, commentCount: itemDescendantCount, maxCommentId }
   *
   * Always saves the current maxCommentId so that after load completes the
   * current comments are considered "seen". A reload will therefore show no
   * highlights; only comments posted between sessions (id > saved maxCommentId)
   * will be highlighted on the next visit from the list page.
   */
  _persistState() {
    this._storage.set(
      this._storageKey,
      JSON.stringify({
        lastVisit: Date.now(),
        commentCount: this.itemDescendantCount,
        maxCommentId: this.maxCommentId,
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  /**
   * Persist state and tear down the store.
   *
   * Cancels any in-flight debounced callbacks (`_debouncedCountChanged` and
   * `_debouncedSave`) to avoid stale writes after the instance is logically
   * dead, then performs one final synchronous write so the current session's
   * data is not lost.
   *
   * Call this when navigating away from the story page or during test cleanup.
   */
  dispose() {
    // Cancel any in-flight debounced calls to avoid stale writes after
    // the instance is logically dead.
    this._debouncedCountChanged.cancel();
    this._debouncedSave.cancel();

    // One final synchronous write so we don't lose the current session's data.
    this._persistState();
  }
}
