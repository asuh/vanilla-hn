/vanilla-hn/src/stores/StoryCommentThreadStore.js
/**
 * StoryCommentThreadStore.js
 *
 * Manages per-story thread metadata used to:
 *  - track last visit timestamps for stories
 *  - record maximum seen comment id for a story (heuristic for new comment detection)
 *  - store per-comment collapsed state for individual threads
 *  - compute counts of new/total child comments for a given comment subtree
 *  - persist lightweight per-session state (sessionStorage preferred, localStorage fallback)
 *
 * The store is intentionally lightweight and does not keep full comment payloads.
 * To compute child aggregates it can accept a `getItemById` helper (in constructor options)
 * which should return an item object with a `kids` array (if available). If no helper is
 * provided, `getChildCounts()` will make conservative estimates based on stored metadata.
 *
 * API (selected):
 *  - constructor(options)
 *    - options.getItemById: optional function(id) => item payload (with .kids array)
 *    - options.storageKey: optional override for persistence key
 *  - loadState()
 *  - saveState()
 *  - commentAdded(storyId, commentId, parentId, commentTime)
 *  - toggleCollapse(storyId, commentId, collapsed?) -> boolean
 *  - isCollapsed(storyId, commentId)
 *  - getChildCounts(storyId, rootCommentId) -> { total, new }
 *  - collapseThreadsWithoutNewComments(predictive = true) -> void
 *  - markAsRead(storyId) -> void
 *  - addListener(fn) -> unsubscribe
 *  - getState(storyId) -> shallow state object
 *
 * Notes:
 *  - "new" determination uses two heuristics:
 *      1) commentId > stored maxCommentId
 *      2) commentTime (seconds) > lastVisit (seconds)
 *    If commentId is not numeric or unavailable, time-based heuristic is used.
 *
 *  - Persistence uses sessionStorage when available so state is per-tab. A fallback
 *    to localStorage is attempted when sessionStorage is unavailable.
 *
 *  - The store is NOT responsible for fetching comments; views/services should call
 *    `commentAdded()` when realtime updates arrive so the store can keep counts.
 *
 *  - This implementation focuses on correctness and clarity rather than extreme optimization.
 */

const DEFAULT_KEY = 'vanilla-hn:thread-state:v1';

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function safeParse(jsonStr, fallback = {}) {
  try {
    const v = JSON.parse(jsonStr);
    return v && typeof v === 'object' ? v : fallback;
  } catch (e) {
    return fallback;
  }
}

/**
 * Small debounce helper used to coalesce saves.
 * Not exported.
 */
function debounce(fn, wait = 150) {
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      try { fn(...args); } catch (e) { /* swallow */ }
    }, wait);
  };
}

/**
 * Normalize id to string
 */
function sid(id) {
  return id == null ? '' : String(id);
}

export default class StoryCommentThreadStore {
  /**
   * @param {Object} options
   * @param {Function} [options.getItemById] optional function(id) => item (with .kids[])
   * @param {string} [options.storageKey] override persistence key
   * @param {Storage} [options.storage] optional injected storage (sessionStorage/localStorage)
   */
  constructor(options = {}) {
    this.getItemById = typeof options.getItemById === 'function' ? options.getItemById : null;
    this.storageKey = options.storageKey || DEFAULT_KEY;
    // prefer sessionStorage for per-tab caching, fallback to localStorage
    this._storage = options.storage || (typeof sessionStorage !== 'undefined' ? sessionStorage : (typeof localStorage !== 'undefined' ? localStorage : null));

    // Internal shape:
    // this._map = {
    //   [storyId]: {
    //     lastVisit: unixSeconds,
    //     commentCount: number,
    //     maxCommentId: number, // highest numeric id seen
    //     collapsed: { [commentId]: true }
    //   }
    // }
    this._map = Object.create(null);
    this._listeners = new Set();

    // Debounced save
    this._saveDebounced = debounce(() => this.saveState(), 150);

    // Try to load persisted state
    this.loadState();
  }

  /* ---------------------------
   * Persistence
   * --------------------------- */

  loadState() {
    if (!this._storage) return;
    try {
      const raw = this._storage.getItem(this.storageKey);
      if (!raw) return;
      const parsed = safeParse(raw, {});
      // Validate structure: expect object with keys mapping to small objects
      for (const [k, v] of Object.entries(parsed)) {
        // Normalize entry
        const entry = {
          lastVisit: typeof v.lastVisit === 'number' ? v.lastVisit : (typeof v.lastVisit === 'string' ? Number(v.lastVisit) || 0 : 0),
          commentCount: typeof v.commentCount === 'number' ? v.commentCount : (v.commentCount ? Number(v.commentCount) || 0 : 0),
          maxCommentId: typeof v.maxCommentId === 'number' ? v.maxCommentId : (v.maxCommentId ? Number(v.maxCommentId) || 0 : 0),
          collapsed: (v.collapsed && typeof v.collapsed === 'object') ? Object.assign({}, v.collapsed) : {}
        };
        this._map[sid(k)] = entry;
      }
    } catch (e) {
      // ignore parse errors
      // console.warn('StoryCommentThreadStore.loadState failed', e);
    }
  }

  saveState() {
    if (!this._storage) return;
    try {
      // Persist a lightweight snapshot (avoid storing transient large objects)
      const snapshot = Object.create(null);
      for (const [storyId, entry] of Object.entries(this._map)) {
        snapshot[storyId] = {
          lastVisit: entry.lastVisit || 0,
          commentCount: entry.commentCount || 0,
          maxCommentId: entry.maxCommentId || 0,
          collapsed: entry.collapsed || {}
        };
      }
      this._storage.setItem(this.storageKey, JSON.stringify(snapshot));
    } catch (e) {
      // ignore storage errors (quota etc.)
      // console.warn('StoryCommentThreadStore.saveState failed', e);
    }
  }

  _scheduleSave() {
    this._saveDebounced();
  }

  /* ---------------------------
   * Listener API
   * --------------------------- */

  addListener(fn) {
    if (typeof fn !== 'function') throw new TypeError('addListener expects a function');
    this._listeners.add(fn);
    // call immediately with no args so subscribers can initialize if desired
    try { fn(); } catch (e) { /* ignore subscriber errors */ }
    return () => this._listeners.delete(fn);
  }

  removeListener(fn) {
    this._listeners.delete(fn);
  }

  _notify(change = {}) {
    for (const fn of Array.from(this._listeners)) {
      try { fn(change); } catch (e) { /* swallow subscriber errors */ }
    }
  }

  /* ---------------------------
   * Basic getters / setters
   * --------------------------- */

  /**
   * Ensure a thread entry exists and return it.
   * @param {string|number} storyId
   */
  _ensureEntry(storyId) {
    const sidKey = sid(storyId);
    if (!this._map[sidKey]) {
      this._map[sidKey] = {
        lastVisit: 0,
        commentCount: 0,
        maxCommentId: 0,
        collapsed: Object.create(null)
      };
    }
    return this._map[sidKey];
  }

  /**
   * Return shallow snapshot of state for a story
   * @param {string|number} storyId
   */
  getState(storyId) {
    const e = this._map[sid(storyId)];
    if (!e) return null;
    return {
      lastVisit: e.lastVisit,
      commentCount: e.commentCount,
      maxCommentId: e.maxCommentId,
      collapsed: Object.assign({}, e.collapsed)
    };
  }

  /**
   * Set commentCount / maxCommentId directly for a story (rarely needed externally)
   * @param {string|number} storyId
   * @param {Object} opts { commentCount, maxCommentId, lastVisit }
   */
  update(storyId, opts = {}) {
    const entry = this._ensureEntry(storyId);
    if (typeof opts.commentCount === 'number') entry.commentCount = opts.commentCount;
    if (typeof opts.maxCommentId === 'number') entry.maxCommentId = opts.maxCommentId;
    if (typeof opts.lastVisit === 'number') entry.lastVisit = opts.lastVisit;
    this._scheduleSave();
    this._notify({ type: 'update', storyId: sid(storyId) });
  }

  /* ---------------------------
   * New-comment detection / updates
   * --------------------------- */

  /**
   * Notify the store that a comment was added.
   * This function is expected to be called by the service layer when an update arrives.
   *
   * @param {string|number} storyId - top-level story id the comment belongs to
   * @param {string|number} commentId - id of the new comment
   * @param {string|number|null} parentId - id of the parent comment (may be null)
   * @param {number|null} commentTime - unix seconds timestamp for the comment (optional)
   */
  commentAdded(storyId, commentId, parentId = null, commentTime = null) {
    if (storyId == null || commentId == null) return;
    const entry = this._ensureEntry(storyId);
    // Update total comment count heuristic
    entry.commentCount = Math.max(entry.commentCount || 0, (entry.commentCount || 0) + 1);

    // Try to interpret numeric commentId to update maxCommentId
    const numericId = Number(commentId);
    if (!Number.isNaN(numericId) && numericId > (entry.maxCommentId || 0)) {
      entry.maxCommentId = numericId;
    }

    // If we have a commentTime and it's newer than lastVisit, this indicates "new"
    if (typeof commentTime === 'number' && commentTime > (entry.lastVisit || 0)) {
      // nothing to store per-comment here; getChildCounts will use heuristics when asked
    }

    this._scheduleSave();
    this._notify({ type: 'commentAdded', storyId: sid(storyId), commentId: sid(commentId), parentId: sid(parentId) });
  }

  /**
   * Mark the entire story as read: update lastVisit time and reset max/new heuristics.
   * @param {string|number} storyId
   */
  markAsRead(storyId) {
    if (storyId == null) return;
    const entry = this._ensureEntry(storyId);
    entry.lastVisit = nowSeconds();
    // Resetting maxCommentId is optional; keep it to avoid treating old comments as new.
    // But we also reset commentCount to 0 if desired. Here we keep commentCount.
    this._scheduleSave();
    this._notify({ type: 'markAsRead', storyId: sid(storyId) });
  }

  /* ---------------------------
   * Collapse state management
   * --------------------------- */

  /**
   * Toggle collapse state for a comment inside a story.
   * If commentId is falsy, toggles a top-level "story collapsed" flag under special key '__story'
   *
   * @param {string|number} storyId
   * @param {string|number|null} commentId
   * @param {boolean|null} explicit optional explicit boolean to set state
   * @returns {boolean} resulting collapsed state
   */
  toggleCollapse(storyId, commentId = '__story', explicit = null) {
    if (storyId == null) return false;
    const entry = this._ensureEntry(storyId);
    const key = sid(commentId == null ? '__story' : commentId);
    const current = Boolean(entry.collapsed && entry.collapsed[key]);
    const next = explicit === null ? !current : Boolean(explicit);
    entry.collapsed = entry.collapsed || Object.create(null);
    if (next) entry.collapsed[key] = true;
    else delete entry.collapsed[key];
    this._scheduleSave();
    this._notify({ type: 'toggleCollapse', storyId: sid(storyId), commentId: key, collapsed: next });
    return next;
  }

  isCollapsed(storyId, commentId = '__story') {
    const entry = this._map[sid(storyId)];
    if (!entry || !entry.collapsed) return false;
    return Boolean(entry.collapsed[sid(commentId == null ? '__story' : commentId)]);
  }

  /* ---------------------------
   * Child traversal and counts
   * --------------------------- */

  /**
   * Compute child counts for a subtree rooted at rootCommentId under storyId.
   *
   * If `getItemById` helper was provided at construction, this will traverse
   * the kids arrays to count total children and number of children considered "new".
   *
   * Heuristics for "new":
   *  - If a child's numeric id > stored maxCommentId -> considered new
   *  - Else if child's time (seconds) > lastVisit -> considered new
   *
   * If no getItemById is available, the method can still return best-effort values
   * based on stored commentCount and lastVisit (conservative).
   *
   * @param {string|number} storyId
   * @param {string|number|null} rootCommentId - if null/undefined, compute for entire story (using top-level kids if available)
   * @returns {{ total: number, new: number }}
   */
  getChildCounts(storyId, rootCommentId = null) {
    const entry = this._map[sid(storyId)];
    const result = { total: 0, new: 0 };

    if (!entry) {
      return result;
    }

    // If we have a traversal helper, perform iterative traversal
    if (this.getItemById) {
      const stack = [];
      if (rootCommentId) stack.push(sid(rootCommentId));
      else {
        // try to get the story item and push its kids
        const storyItem = this.getItemById(sid(storyId));
        if (storyItem && Array.isArray(storyItem.kids) && storyItem.kids.length > 0) {
          for (let i = storyItem.kids.length - 1; i >= 0; i--) stack.push(sid(storyItem.kids[i]));
        } else {
          // nothing to traverse
          return result;
        }
      }

      while (stack.length > 0) {
        const id = stack.pop();
        const item = this.getItemById(id);
        if (!item) continue;
        result.total++;
        // determine new via id comparison or time
        const numericId = Number(item.id);
        if (!Number.isNaN(numericId) && numericId > (entry.maxCommentId || 0)) {
          result.new++;
        } else if (typeof item.time === 'number' && item.time > (entry.lastVisit || 0)) {
          result.new++;
        }
        // push children
        if (Array.isArray(item.kids) && item.kids.length > 0) {
          for (let i = item.kids.length - 1; i >= 0; i--) stack.push(sid(item.kids[i]));
        }
      }

      return result;
    }

    // No traversal helper: best-effort using stored totals
    // If rootCommentId is falsy, return the stored commentCount as total
    if (!rootCommentId) {
      result.total = entry.commentCount || 0;
      // For new count, we cannot compute accurately; assume 0 unless maxCommentId indicates something
      // Best-effort: if maxCommentId > 0 and lastVisit < now then any maxCommentId > 0 might imply new comments
      // But that's too noisy; return 0 so UI can conservatively hide new badges without service assistance.
      result.new = 0;
      return result;
    }

    // If rootCommentId provided but no helper, return 0s (unknown)
    return result;
  }

  /**
   * Collapse threads that do not contain new comments.
   * If `predictive` is true, will use stored/getItem heuristics to detect new comments.
   *
   * This will set collapsed=true for comment nodes (by id) that have zero new children.
   * The exact behavior depends on getItemById; if that helper is not present, the method
   * will operate only at the story level (collapsing whole story threads with no new comments).
   *
   * @param {boolean} [predictive=true]
   */
  collapseThreadsWithoutNewComments(predictive = true) {
    // Iterate all known stories
    for (const [storyId, entry] of Object.entries(this._map)) {
      if (!entry) continue;
      // If no traversal helper, collapse the whole story if it has no "recent" comments (best-effort)
      if (!this.getItemById) {
        const hasNew = (entry.maxCommentId || 0) > 0 && (entry.lastVisit || 0) < nowSeconds();
        if (!hasNew) {
          // collapse top-level story marker
          entry.collapsed = entry.collapsed || Object.create(null);
          entry.collapsed['__story'] = true;
          this._notify({ type: 'autoCollapse', storyId });
        }
        continue;
      }

      // With traversal helper, check each top-level child; collapse those without new children
      const storyItem = this.getItemById(storyId);
      if (!storyItem || !Array.isArray(storyItem.kids) || storyItem.kids.length === 0) {
        // nothing to collapse; if the story itself has no new comment, collapse top-level
        const totals = this.getChildCounts(storyId, null);
        if (!totals || totals.new === 0) {
          entry.collapsed = entry.collapsed || Object.create(null);
          entry.collapsed['__story'] = true;
          this._notify({ type: 'autoCollapse', storyId });
        }
        continue;
      }

      // For each top-level kid, collapse if its subtree reports zero new comments
      entry.collapsed = entry.collapsed || Object.create(null);
      for (const kidId of storyItem.kids) {
        try {
          const counts = this.getChildCounts(storyId, kidId);
          if (counts && counts.new === 0) {
            entry.collapsed[sid(kidId)] = true;
            this._notify({ type: 'autoCollapse', storyId, commentId: sid(kidId) });
          }
        } catch (e) {
          // ignore
        }
      }
    }

    this._scheduleSave();
  }
}
