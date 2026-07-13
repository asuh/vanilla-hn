# Vanilla HN: Recreation Prompt

## Mission

Recreate the React HN v2 Hacker News reader application using modern vanilla HTML, CSS, and JavaScript (as available in March 2026) to eliminate React's ~90KB bundle overhead while maintaining identical functionality and user experience. The result is a framework-free, lightweight, accessible HN reader that uses modern Web APIs and a clean, maintainable architecture.

## Current Application Overview

### What It Does

React HN v2 is a frontend for Hacker News that provides:

- **Story listings**: Top, New, Show, Ask, Jobs stories (30 items per page with pagination)
- **Full story view**: Story details with collapsible comment threads
- **User profiles**: Basic user information display
- **Smart comment tracking**: Highlights new comments since last visit, tracks read status in localStorage
- **Configurable settings**: Auto-collapse threads, theme selection (light/dark), font sizes, list spacing, show/hide dead and deleted items, reply links
- **Real-time updates**: Firebase Realtime Database subscriptions for live data
- **Read story tracking**: Mark stories as read, view reading history
- **Session caching**: Story lists cached in sessionStorage for instant back-button navigation
- **Time-based comment slider**: Highlight comments from a specific time range

### Key Features to Preserve

1. **Collapsible comment threads** with child counts and "new comment" badges
2. **Last visit tracking** — stores timestamp and comment count per story in localStorage
3. **New comment highlighting** — visual indicators for comments added since last visit
4. **Auto-collapse** — automatically collapse threads without new comments (configurable)
5. **Read story tracking** — mark stories as read with timestamps, evict old entries
6. **Session caching** — story lists cached in sessionStorage for instant back-button navigation
7. **Time-based comment slider** — highlight comments from a specific time range
8. **Dead/deleted item handling** — show/hide based on user preference
9. **Responsive design** — works on mobile and desktop
10. **Accessibility** — keyboard navigation, ARIA labels, skip links, focus management

### Current Tech Stack (To Replace)

- **React 19** + **React Router 7** (~90KB gzipped) → Replace with vanilla routing and DOM management
- **Firebase SDK** (~46KB) → Keep (Firebase integration is required for real-time features)
- **react-timeago** → Replace with `Intl.RelativeTimeFormat`
- **nwb** build tool → Replace with zero-dependency custom dev server (`serve.js`)
- **ReactFire mixins** → Replace with direct Firebase SDK subscriptions

**Target bundle size**: ~60KB total (Firebase ~46KB + app ~14KB), down from ~143KB

---

## Technical Architecture

### Data Layer

**Firebase Realtime Database API** (MUST keep this):

```javascript
// Hacker News Firebase API endpoints
const DB_URL = "https://hacker-news.firebaseio.com/v0";

// Available endpoints:
// - /topstories.json   — top 500 story IDs
// - /newstories.json   — newest 500 story IDs
// - /beststories.json  — best stories
// - /askstories.json   — Ask HN stories
// - /showstories.json  — Show HN stories
// - /jobstories.json   — job postings
// - /item/{id}.json    — individual item (story, comment, poll, etc.)
// - /user/{id}.json    — user profile
// - /updates/items.json — recently changed item IDs

// Item types: "story" | "comment" | "job" | "poll" | "pollopt"
```

**Firebase SDK Integration**:

- Use Firebase Realtime Database SDK for real-time subscriptions
- Load Firebase via importmap from local vendor files (no CDN, no bundler)
- Subscribe to story lists and get updates automatically
- Subscribe to individual items for live comment updates
- Use `onValue()` for real-time listeners, `get()` for one-time fetches
- Automatic fallback to a built-in `MockBackend` if Firebase init fails

### Type Definitions

(Described here for developer clarity; implement as JSDoc in plain JS.)

```typescript
interface HNItem {
  id: number;
  type: "story" | "comment" | "job" | "poll" | "pollopt";
  by: string; // username
  time: number; // Unix timestamp
  text?: string; // HTML content for comments
  url?: string; // External link for stories
  title?: string; // Story title
  score?: number; // Points
  descendants?: number; // Total comment count
  kids?: number[]; // Child item IDs
  parts?: number[]; // Poll option IDs
  parent?: number; // Parent item ID
  dead?: boolean; // Flagged as dead
  deleted?: boolean; // Deleted by user
}

interface HNUser {
  id: string;
  created: number; // Unix timestamp
  karma: number;
  about?: string; // HTML bio
  submitted?: number[]; // Submitted item IDs
}

interface ThreadState {
  lastVisit: number | null; // Timestamp of last visit
  commentCount: number; // Comment count at last visit
  maxCommentId: number; // Highest comment ID seen
}
```

### Routing Strategy

Use **hash-based routing** to avoid server configuration:

```
#/              — Top stories (default, alias for /news)
#/news          — Top stories
#/newest        — New stories
#/show          — Show HN
#/ask           — Ask HN
#/jobs          — Jobs
#/item/:id      — Story detail view with comments
#/user/:id      — User profile
```

**Implementation approach**: Listen to `hashchange` event, parse hash with regex route matching, render the appropriate view. Keep route handling synchronous; only async-load data inside the view.

### State Management

Replace React component state with small, focused store classes using the observer pattern:

1. **`SettingsStore`** — user preferences persisted to localStorage (`vanilla-hn:settings:v1`)
2. **`ReadStoriesStore`** — marks stories as read with timestamps, persisted to localStorage (`vanilla-hn:read:v1`), max 500 entries with LRU eviction
3. **`StoryCommentThreadStore`** — per-story comment thread state: collapse map, new/dead/deleted tracking, parent→child relationships, persisted visit metadata

Stores expose:

- `get()` / `update()` for state access and mutation
- `addListener(fn)` / `subscribe(fn)` → returns an `unsubscribe` callback
- `notify()` to broadcast changes to all listeners

Views subscribe to stores and update the DOM on changes; the View base class tracks subscriptions and automatically unsubscribes on `cleanup()`.

### Key Algorithms

#### 1. New Comment Detection

```javascript
// When loading a story:
// 1. Load ThreadState from localStorage using story ID as key
// 2. If lastVisit is null, this is first visit — mark all as read on load
// 3. If lastVisit exists, compare:
//    - Any comment with ID > maxCommentId is NEW
//    - Any comment with time > lastVisit is NEW
// 4. On page unload / navigation away, save current state back to localStorage

// Format: localStorage key = `thread_${storyId}`, value = JSON ThreadState
```

#### 2. Auto-Collapse Logic

```javascript
// After loading all comments:
// 1. Build tree of comment relationships (parent → child map)
// 2. For each top-level comment, traverse children via BFS
// 3. Count: total descendants, new comment descendants
// 4. If a thread has 0 new comments AND the comment itself is not new, collapse it
// 5. Store collapsed state in StoryCommentThreadStore.isCollapsed[commentId]
// 6. Only apply when SettingsStore.autoCollapse is true
```

#### 3. Comment Tree Traversal

```javascript
// Iterative BFS to avoid stack overflow on deeply nested threads:
// 1. Story has kids[] array with top-level comment IDs
// 2. Each comment can have kids[] with reply IDs
// 3. Subscribe to each comment via Firebase onItemValue()
// 4. Use IntersectionObserver to lazy-load children only when visible
// 5. Build parent → child relationships for collapse/expand count aggregation
// 6. Use a queue (not recursion) for getChildCounts() to compute totals
```

#### 4. Session Caching

```javascript
// StoryStore caching:
// - On first load of story list (e.g., /topstories), cache story IDs
// - As items load, cache full HNItem objects
// - On beforeunload, serialize to sessionStorage
// - On page load, check sessionStorage first before Firebase
// - Cache keys: "idCache" (type → ID arrays), "itemCache" (id → HNItem)
// - Persist only metadata (ids, counts, collapsed state), not full DOM
```

---

## Implementation Guide

### Modern Web APIs to Use

1. **CSS Custom Properties** (CSS Variables):

   ```css
   :root {
     --font-size-title: 18px;
     --list-spacing: 16px;
     --comment-level: 0;
     --bg: #f5f5f5;
     --text: #000;
     --muted: #666;
     --accent: #ff6600;
   }

   .comment {
     margin-left: calc(var(--comment-level) * 1.5em);
   }
   ```

2. **CSS Nesting**:

   ```css
   .comment {
     color: var(--text);

     &--new {
       background: #fffacd;
     }

     &--collapsed {
       opacity: 0.7;
     }

     & .comment-meta {
       font-size: 0.9em;
     }
   }
   ```

3. **`:has()` selector**:

   ```css
   .comment:has(.comment--new) {
     border-left: 2px solid var(--accent);
   }
   ```

4. **View Transitions API** (optional, progressive enhancement):

   ```javascript
   if (document.startViewTransition) {
     document.startViewTransition(() => updateDOM());
   }
   ```

5. **`Intl.RelativeTimeFormat`** for time-ago formatting:

   ```javascript
   const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
   // rtf.format(-3, 'hour') → "3 hours ago"
   ```

6. **`IntersectionObserver`** for lazy-loading comment children:

   ```javascript
   const observer = new IntersectionObserver(
     (entries) => {
       for (const entry of entries) {
         if (entry.isIntersecting) {
           loadComment(entry.target.dataset.commentId);
           observer.unobserve(entry.target);
         }
       }
     },
     { rootMargin: "200px" },
   );
   ```

7. **`AbortController`** for cancellable async operations:

   ```javascript
   this.abortController = new AbortController();
   // In cleanup(): this.abortController.abort();
   ```

8. **`structuredClone()`** for deep cloning:
   ```javascript
   const clonedItem = structuredClone(originalItem);
   ```

### File Structure

```
vanilla-hn/
├── public/
│   ├── index.html              # App shell, importmap, header/nav/settings panel
│   ├── img/                    # Logo, favicon, icons
│   ├── src/ -> ../src/         # Symlink or served by dev server
│   └── vendor/                 # Local Firebase SDK files (no CDN)
│       ├── firebase-app.js
│       └── firebase-database.js
│
├── src/
│   ├── main.js                 # Entry point: router init, store wiring, settings panel binding
│   ├── styles.css              # All CSS: reset, variables, components, responsive, dark mode
│   │
│   ├── api/
│   │   └── hn-service.js       # Firebase wrapper with MockBackend fallback
│   │
│   ├── views/
│   │   ├── View.js             # Abstract base class (params, subscriptions, cleanup, abort)
│   │   ├── ListView.js         # Paginated story list + UserView export
│   │   ├── ItemView.js         # Story detail with comment thread
│   │   └── UserView.js         # Re-export of UserView from ListView.js
│   │
│   ├── components/
│   │   ├── CommentElement.js   # Comment class + createStoryListItem factory
│   │   └── StoryListItem.js    # Re-export alias for createStoryListItem
│   │
│   ├── stores/
│   │   ├── SettingsStore.js    # User preferences (theme, font size, spacing, toggles)
│   │   ├── ReadStoriesStore.js # Read story tracking with LRU eviction
│   │   └── StoryCommentThreadStore.js  # Per-story comment state (~900 lines)
│   │
│   ├── router/
│   │   └── Router.js           # Hash-based router with View Transitions, focus management
│   │
│   └── utils/
│       └── dom.js              # DOM helpers, event delegation, escapeHTML, timeago
│
├── firebase.example.js         # Example Firebase config (DO NOT commit real keys)
├── serve.js                    # Zero-dependency Node.js dev server (port 5001)
├── package.json                # Minimal, no runtime deps, type: "module"
├── .gitignore
├── README.md
└── RECREATION_PROMPT.md        # This file
```

### Router Implementation Pattern

```javascript
// router/Router.js
class Router {
  constructor() {
    this.routes = new Map();
    this.currentView = null;

    window.addEventListener("hashchange", () => this.handleRoute());
    window.addEventListener("load", () => this.handleRoute());
  }

  register(pattern, handler) {
    // pattern: string like '/item/:id' or regex
    // handler: async (params) => View instance (supports lazy-loaded view factories)
    this.routes.set(pattern, handler);
  }

  handleRoute() {
    const hash = window.location.hash.slice(1) || "/";

    for (const [pattern, handler] of this.routes) {
      const match = this.matchRoute(pattern, hash);
      if (match) {
        this.loadView(handler, match.params);
        return;
      }
    }

    // 404 fallback
    this.loadView(this.notFoundHandler, {});
  }

  matchRoute(pattern, path) {
    // Convert '/item/:id' to regex, extract named params
    // Return { params: { id: '123' } } or null
  }

  navigate(path) {
    window.location.hash = path;
  }

  async loadView(viewFactory, params) {
    // Cancel stale navigations — only the latest navigation wins
    if (this.currentView?.cleanup) {
      this.currentView.cleanup();
    }

    // Instantiate the new view (may be async for lazy imports)
    this.currentView = await viewFactory(params);

    const appContent = document.querySelector("#app");
    appContent.innerHTML = "";

    // Use View Transitions API if available
    if (document.startViewTransition) {
      document.startViewTransition(() => {
        appContent.appendChild(this.currentView.render());
      });
    } else {
      appContent.appendChild(this.currentView.render());
    }

    // Accessibility: move focus to main content after route change
    this.currentView.element?.focus?.();
  }
}

// Usage in main.js
const router = new Router();
router.register("/", (params) => new StoriesView("topstories", params));
router.register("/item/:id", async (params) => {
  const { default: ItemView } = await import("./views/ItemView.js");
  return new ItemView(params.id);
});
router.register("/user/:id", async (params) => {
  const { default: UserView } = await import("./views/UserView.js");
  return new UserView(params.id);
});
```

### View Base Class Pattern

```javascript
// views/View.js
class View {
  constructor(context = {}) {
    this.params = context.params || {};
    this.stores = context.stores || {};
    this.services = context.services || {};
    this.element = null;
    this.subscriptions = [];
    this.eventCleanups = [];
    this.abortController = new AbortController();
  }

  render() {
    // Override in subclass — must return a DOM element
    throw new Error("Subclass must implement render()");
  }

  createElement(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "className") el.className = value;
      else if (key.startsWith("on")) el.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === "dataset") Object.assign(el.dataset, value);
      else el.setAttribute(key, value);
    }
    for (const child of children) {
      if (typeof child === "string") el.appendChild(document.createTextNode(child));
      else if (child) el.appendChild(child);
    }
    return el;
  }

  subscribe(store, callback) {
    const unsub = store.addListener(callback);
    this.subscriptions.push(unsub);
    return unsub;
  }

  watchEvent(el, event, handler, options) {
    el.addEventListener(event, handler, options);
    this.eventCleanups.push(() => el.removeEventListener(event, handler, options));
  }

  cleanup() {
    // Abort any pending async work
    this.abortController.abort();

    // Unsubscribe from all stores
    this.subscriptions.forEach((unsub) => unsub());
    this.subscriptions = [];

    // Remove event listeners
    this.eventCleanups.forEach((fn) => fn());
    this.eventCleanups = [];

    // Remove DOM
    this.element?.remove();
    this.element = null;
  }

  static createPlaceholderView(message = "Loading…") {
    // Returns a minimal View for loading / not-found states
  }
}
```

### Store Pattern

```javascript
// stores/SettingsStore.js
class SettingsStore {
  constructor() {
    this.data = {
      autoCollapse: true,
      replyLinks: true,
      showDead: false,
      showDeleted: false,
      titleFontSize: 18,
      listSpacing: 16,
      theme: "light", // 'light' | 'dark'
    };
    this.listeners = new Set();
    this.load();
  }

  load() {
    const json = localStorage.getItem("vanilla-hn:settings:v1");
    if (json) {
      Object.assign(this.data, JSON.parse(json));
    }
    this.applyTheme();
  }

  save() {
    localStorage.setItem("vanilla-hn:settings:v1", JSON.stringify(this.data));
  }

  update(changes) {
    Object.assign(this.data, changes);
    if ("theme" in changes) {
      this.applyTheme();
    }
    if ("titleFontSize" in changes) {
      document.documentElement.style.setProperty(
        "--font-size-title",
        `${this.data.titleFontSize}px`,
      );
    }
    if ("listSpacing" in changes) {
      document.documentElement.dataset.listSpacing = this.data.listSpacing;
    }
    this.save();
    this.notify();
  }

  applyTheme() {
    document.body.classList.toggle("dark", this.data.theme === "dark");
  }

  get(key) {
    return this.data[key];
  }

  addListener(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  notify() {
    this.listeners.forEach((cb) => cb(this.data));
  }

  reset() {
    this.data = { ...SettingsStore.DEFAULTS };
    this.save();
    this.applyTheme();
    this.notify();
  }
}

// Singleton export
export const settingsStore = new SettingsStore();
```

```javascript
// stores/ReadStoriesStore.js
class ReadStoriesStore {
  constructor(storageKey = "vanilla-hn:read:v1", maxEntries = 500) {
    this.storageKey = storageKey;
    this.maxEntries = maxEntries;
    this.readMap = {}; // { storyId: timestampSeconds }
    this.listeners = new Set();
    this.load();
  }

  load() {
    const json = localStorage.getItem(this.storageKey);
    if (json) this.readMap = JSON.parse(json);
  }

  save() {
    // Debounced in real implementation
    localStorage.setItem(this.storageKey, JSON.stringify(this.readMap));
  }

  markAsRead(storyId) {
    this.readMap[storyId] = Math.floor(Date.now() / 1000);
    this.evictIfNeeded();
    this.save();
    this.notify();
  }

  isRead(storyId) {
    return storyId in this.readMap;
  }

  unmarkAsRead(storyId) {
    delete this.readMap[storyId];
    this.save();
    this.notify();
  }

  evictIfNeeded() {
    const ids = Object.keys(this.readMap);
    if (ids.length <= this.maxEntries) return;
    // Sort by timestamp ascending, remove oldest
    ids.sort((a, b) => this.readMap[a] - this.readMap[b]);
    const toRemove = ids.slice(0, ids.length - this.maxEntries);
    for (const id of toRemove) delete this.readMap[id];
  }

  clearOlderThan(days) {
    /* ... */
  }
  clearAll() {
    this.readMap = {};
    this.save();
    this.notify();
  }

  addListener(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  notify() {
    this.listeners.forEach((cb) => cb(this.readMap));
  }
}
```

### Component Pattern (Without Web Components)

```javascript
// components/CommentElement.js — class-based component
export class CommentElement {
  constructor(comment, threadStore, level = 0) {
    this.comment = comment;
    this.threadStore = threadStore;
    this.level = level;
    this.element = null;
    this.childObserver = null;
  }

  render() {
    const div = document.createElement("div");
    div.className = "comment";
    div.dataset.commentId = this.comment.id;
    div.style.setProperty("--comment-level", this.level);

    if (this.threadStore.isCollapsed[this.comment.id]) {
      div.classList.add("comment--collapsed");
    }
    if (this.threadStore.isNew[this.comment.id]) {
      div.classList.add("comment--new");
    }

    const meta = this.createMeta();
    div.appendChild(meta);

    if (!this.threadStore.isCollapsed[this.comment.id]) {
      const text = this.createText();
      div.appendChild(text);

      if (this.comment.kids?.length) {
        const kidsContainer = document.createElement("div");
        kidsContainer.className = "comment-kids";

        for (const kidId of this.comment.kids) {
          this.loadChild(kidId, kidsContainer);
        }

        div.appendChild(kidsContainer);
      }
    }

    this.element = div;
    return div;
  }

  createMeta() {
    const meta = document.createElement("div");
    meta.className = "comment-meta";

    const collapsed = this.threadStore.isCollapsed[this.comment.id];
    const toggle = document.createElement("button");
    toggle.className = "comment-toggle";
    toggle.textContent = collapsed ? "[+]" : "[–]";
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.setAttribute("aria-controls", `comment-body-${this.comment.id}`);

    toggle.addEventListener("click", () => {
      this.threadStore.toggleCollapse(this.comment.id);
      this.update();
    });

    meta.appendChild(toggle);

    const by = document.createElement("a");
    by.href = `#/user/${this.comment.by}`;
    by.textContent = this.comment.by;
    meta.appendChild(document.createTextNode(" "));
    meta.appendChild(by);

    const time = document.createElement("span");
    time.className = "comment-time";
    time.textContent = ` ${formatTimeAgo(this.comment.time * 1000)}`;
    meta.appendChild(time);

    if (collapsed) {
      const counts = this.threadStore.getChildCounts(this.comment);
      meta.appendChild(document.createTextNode(` [${counts.children} more]`));
      if (counts.newComments > 0) {
        const newBadge = document.createElement("span");
        newBadge.className = "comment-new-badge";
        newBadge.textContent = ` ${counts.newComments} new`;
        meta.appendChild(newBadge);
      }
    }

    return meta;
  }

  createText() {
    const text = document.createElement("div");
    text.className = "comment-text";
    text.id = `comment-body-${this.comment.id}`;
    text.innerHTML = this.comment.text; // HN API returns pre-sanitized HTML
    return text;
  }

  update() {
    const parent = this.element.parentNode;
    const newElement = this.render();
    parent.replaceChild(newElement, this.element);
  }

  async loadChild(kidId, container) {
    // Create a placeholder observed by IntersectionObserver
    const placeholder = document.createElement("div");
    placeholder.className = "comment-loading";
    placeholder.dataset.commentId = kidId;
    container.appendChild(placeholder);

    // Lazy-load: only subscribe to Firebase when placeholder is near viewport
    this.childObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const unsub = HNService.onItemValue(kidId, (item) => {
              if (item) {
                const childComment = new CommentElement(item, this.threadStore, this.level + 1);
                const childElement = childComment.render();
                container.replaceChild(childElement, placeholder);
              }
            });
            this.childObserver.unobserve(entry.target);
          }
        }
      },
      { rootMargin: "200px" },
    );

    this.childObserver.observe(placeholder);
  }
}
```

```javascript
// components/StoryListItem.js — factory function pattern
export function createStoryListItem(item, threadState, settingsStore) {
  const li = document.createElement("li");
  li.className = "item";
  if (item.dead) li.classList.add("item--dead");

  li.style.marginBottom = `${settingsStore.get("listSpacing")}px`;

  // Title
  const titleDiv = document.createElement("div");
  titleDiv.className = "item__title";
  titleDiv.style.fontSize = `${settingsStore.get("titleFontSize")}px`;

  const titleLink = document.createElement("a");
  titleLink.className = "item__title-link";
  titleLink.href = item.url || `#/item/${item.id}`;
  titleLink.textContent = item.title;
  titleDiv.appendChild(titleLink);

  if (item.url) {
    const host = document.createElement("span");
    host.className = "item__host";
    try {
      host.textContent = ` (${new URL(item.url).hostname.replace(/^www\./, "")})`;
    } catch {
      /* invalid URL */
    }
    titleDiv.appendChild(host);
  }

  // Meta
  const metaDiv = document.createElement("div");
  metaDiv.className = "item__meta";
  metaDiv.innerHTML = `
    <span class="item__score">${item.score || 0} point${item.score !== 1 ? "s" : ""}</span>
    by <a href="#/user/${item.by}">${item.by}</a>
    <span class="item__time">${formatTimeAgo(item.time * 1000)}</span>
    | <a href="#/item/${item.id}">${item.descendants || 0} comment${item.descendants !== 1 ? "s" : ""}</a>
  `;

  // New comment badge
  if (threadState?.lastVisit != null) {
    const newCount = (item.descendants || 0) - (threadState.commentCount || 0);
    if (newCount > 0) {
      const newBadge = document.createElement("span");
      newBadge.className = "item__new-comments";
      newBadge.innerHTML = ` (<a href="#/item/${item.id}">${newCount} new</a>)`;
      metaDiv.appendChild(newBadge);
    }
  }

  li.appendChild(titleDiv);
  li.appendChild(metaDiv);

  return li;
}
```

### Efficient DOM Updates

```javascript
// Use DocumentFragment to batch inserts — never re-render entire trees
function renderCommentList(comments, container) {
  const fragment = document.createDocumentFragment();

  for (const comment of comments) {
    const commentEl = new CommentElement(comment, threadStore, 0);
    fragment.appendChild(commentEl.render());
  }

  container.innerHTML = ""; // Clear once
  container.appendChild(fragment); // Insert once
}

// For targeted updates, patch only what changed:
function updateCommentCount(itemId, newCount) {
  const el = document.querySelector(`[data-item-id="${itemId}"] .item__descendants`);
  if (el) {
    el.textContent = `${newCount} comment${newCount !== 1 ? "s" : ""}`;
  }
}

// Use event delegation on lists for better performance:
storyList.addEventListener("click", (e) => {
  const link = e.target.closest("[data-story-id]");
  if (link) {
    readStoriesStore.markAsRead(link.dataset.storyId);
  }
});
```

### Firebase Integration (Keep From Original)

```javascript
// api/hn-service.js
import { initializeApp } from "firebase/app";
import { getDatabase, ref, onValue, get, child } from "firebase/database";

const app = initializeApp({
  databaseURL: "https://hacker-news.firebaseio.com",
});

const db = getDatabase(app);
const api = ref(db, "/v0");

export const HNService = {
  // Subscribe to story list (returns unsubscribe function)
  onStoriesValue(type, callback) {
    const storiesRef = child(api, type);
    return onValue(storiesRef, (snapshot) => {
      callback(snapshot.val()); // Array of IDs
    });
  },

  // Subscribe to individual item
  onItemValue(id, callback) {
    const itemRef = child(api, `item/${id}`);
    return onValue(itemRef, (snapshot) => {
      callback(snapshot.val()); // HNItem or null
    });
  },

  // One-time fetch (returns Promise)
  async fetchItem(id) {
    const itemRef = child(api, `item/${id}`);
    const snapshot = await get(itemRef);
    return snapshot.val();
  },

  // Subscribe to user
  onUserValue(id, callback) {
    const userRef = child(api, `user/${id}`);
    return onValue(userRef, (snapshot) => {
      callback(snapshot.val());
    });
  },

  // Subscribe to updates feed
  onUpdatesValue(callback) {
    const updatesRef = child(api, "updates/items");
    return onValue(updatesRef, (snapshot) => {
      callback(snapshot.val()); // Array of recently changed IDs
    });
  },

  // Cleanup
  destroy() {
    // Remove all listeners, delete app
  },
};
```

**MockBackend fallback**: When Firebase initialization fails (no credentials, network error), `hn-service.js` automatically falls back to a built-in `MockBackend` that generates fake stories and comments, periodically bumps scores, and adds mock comments — enabling development without real Firebase credentials.

Do not commit real Firebase credentials. Use the `firebase.example.js` helper which resolves config from `window.__FIREBASE_CONFIG__`, `import.meta.env`, or `process.env`.

---

## Styling Guidelines

### Use Modern CSS

1. **CSS Custom Properties** for theming:

   ```css
   :root {
     --bg: #f5f5f5;
     --text: #000;
     --muted: #666;
     --accent: #ff6600;
     --font-size-title: 18px;
     --font-size-meta: 13px;
     --list-spacing: 16px;
     --new-comment-bg: #fffacd;
     --dead-color: #999;
   }

   body.dark {
     --bg: #1a1a1a;
     --text: #e0e0e0;
     --muted: #888;
     --new-comment-bg: #3a3520;
   }
   ```

2. **CSS Nesting** for component styles:

   ```css
   .comment {
     color: var(--text);
     border-left: 2px solid transparent;

     &--new {
       background: var(--new-comment-bg);
       border-left-color: var(--accent);
     }

     &--collapsed {
       opacity: 0.7;
     }

     &--dead {
       color: var(--dead-color);
     }

     & .comment-meta {
       font-size: var(--font-size-meta);
       color: var(--muted);
     }
   }
   ```

3. **Container Queries** for responsive components:

   ```css
   .comment-thread {
     container-type: inline-size;
   }

   @container (width < 500px) {
     .comment-meta {
       font-size: 0.85em;
     }
   }
   ```

4. **Skeleton loading shimmers** for async content:

   ```css
   .skeleton {
     background: linear-gradient(90deg, var(--bg) 25%, #e0e0e0 50%, var(--bg) 75%);
     background-size: 200% 100%;
     animation: shimmer 1.5s infinite;
   }

   @keyframes shimmer {
     0% {
       background-position: 200% 0;
     }
     100% {
       background-position: -200% 0;
     }
   }
   ```

5. **`prefers-reduced-motion`** support:
   ```css
   @media (prefers-reduced-motion: reduce) {
     *,
     *::before,
     *::after {
       animation-duration: 0.01ms !important;
       transition-duration: 0.01ms !important;
     }
   }
   ```

### Preserve Original Color Scheme

```css
:root {
  --hn-primary: #00d8ff; /* Cyan accent from React HN */
  --hn-header-bg: #222;
  --hn-bg-light: #f5f5f5;
  --hn-bg-dark: #242424;
  --hn-text-light: #000;
  --hn-text-dark: #e0e0e0;
  --hn-new-comment-bg: #fffacd;
  --hn-dead-color: #999;
}

body {
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
```

---

## Performance Optimizations

### 1. Lazy Loading Comments

```javascript
// Only load visible comments initially
// Use IntersectionObserver to load more as user scrolls

const observer = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        const commentId = entry.target.dataset.commentId;
        loadComment(commentId);
        observer.unobserve(entry.target);
      }
    });
  },
  { rootMargin: "200px" },
); // Prefetch slightly before visible

// Observe placeholder elements
document.querySelectorAll(".comment-placeholder").forEach((el) => {
  observer.observe(el);
});
```

### 2. Debouncing and Throttling

```javascript
// Debounce settings save (avoid excessive localStorage writes)
function debounce(fn, delay) {
  let timeoutId;
  return (...args) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
}

const saveSettings = debounce(() => {
  settingsStore.save();
}, 500);

// Throttle scroll handlers
function throttle(fn, limit) {
  let inThrottle;
  return (...args) => {
    if (!inThrottle) {
      fn(...args);
      inThrottle = true;
      setTimeout(() => (inThrottle = false), limit);
    }
  };
}

const handleScroll = throttle(() => {
  // Handle scroll-linked behavior
}, 100);
```

### 3. Virtual Scrolling (Optional)

For very long comment threads (500+ comments):

```javascript
class VirtualScroller {
  constructor(container, items, itemHeight) {
    this.container = container;
    this.items = items;
    this.itemHeight = itemHeight;
    this.visibleRange = { start: 0, end: 20 };

    this.container.addEventListener(
      "scroll",
      throttle(() => {
        this.updateVisibleRange();
        this.render();
      }, 50),
    );
  }

  updateVisibleRange() {
    const scrollTop = this.container.scrollTop;
    const viewportHeight = this.container.clientHeight;

    this.visibleRange.start = Math.floor(scrollTop / this.itemHeight);
    this.visibleRange.end = Math.ceil((scrollTop + viewportHeight) / this.itemHeight);
  }

  render() {
    // Only render items in visibleRange + small buffer
    // Set container height to accommodate all items
    // Position visible items with transform
  }
}
```

Make virtual scrolling opt-in; the default lazy-loading via `IntersectionObserver` is sufficient for most threads.

---

## Critical Features Implementation

### 1. Comment Collapse/Expand

See the `CommentElement` class above in Component Pattern. Key accessibility requirements:

- `<button>` for collapse toggle with `aria-expanded` and `aria-controls`
- Toggle text changes between `[+]` (collapsed) and `[–]` (expanded)
- Collapsed state shows child count and new-comment count
- Proper heading order for story titles and comment structure
- Focus remains on the toggle button after collapse/expand

### 2. New Comment Highlighting

```javascript
// stores/StoryCommentThreadStore.js
class StoryCommentThreadStore {
  constructor(item) {
    this.itemId = item.id;
    this.comments = {};
    this.isNew = {};
    this.isCollapsed = {};
    this.children = {}; // commentId → [childIds]

    // Load previous visit state
    this.threadState = this.loadState();
    this.lastVisit = this.threadState.lastVisit;
    this.prevMaxCommentId = this.threadState.maxCommentId;
    this.commentCount = 0;
    this.maxCommentId = 0;
    this.listeners = new Set();
  }

  loadState() {
    const json = localStorage.getItem(`thread_${this.itemId}`);
    if (json) return JSON.parse(json);
    return { lastVisit: null, commentCount: 0, maxCommentId: 0 };
  }

  saveState() {
    localStorage.setItem(
      `thread_${this.itemId}`,
      JSON.stringify({
        lastVisit: Date.now(),
        commentCount: this.commentCount,
        maxCommentId: this.maxCommentId,
      }),
    );
  }

  commentAdded(comment) {
    this.comments[comment.id] = comment;
    this.commentCount++;

    if (comment.id > this.maxCommentId) {
      this.maxCommentId = comment.id;
    }

    // Mark as new if:
    // 1. This is NOT the first visit AND
    // 2. Comment ID > previous max OR comment time > last visit
    if (this.lastVisit !== null) {
      if (comment.id > this.prevMaxCommentId || comment.time * 1000 > this.lastVisit) {
        this.isNew[comment.id] = true;
      }
    }

    // Build parent → child tree
    this.children[comment.id] = [];
    if (comment.parent !== undefined) {
      if (!this.children[comment.parent]) {
        this.children[comment.parent] = [];
      }
      this.children[comment.parent].push(comment.id);
    }
  }

  toggleCollapse(commentId) {
    this.isCollapsed[commentId] = !this.isCollapsed[commentId];
    this.notify();
  }

  // BFS traversal — iterative to avoid stack overflow
  getChildCounts(comment) {
    let children = 0;
    let newComments = 0;

    const queue = [comment.id];

    while (queue.length > 0) {
      const parentId = queue.shift();
      const kids = this.children[parentId] || [];

      for (const kidId of kids) {
        children++;
        if (this.isNew[kidId]) newComments++;
        queue.push(kidId);
      }
    }

    return { children, newComments };
  }

  collapseThreadsWithoutNewComments() {
    for (const commentId in this.comments) {
      const comment = this.comments[commentId];
      // Only auto-collapse top-level comments
      if (comment.parent === this.itemId) {
        const counts = this.getChildCounts(comment);
        if (counts.newComments === 0 && !this.isNew[comment.id]) {
          this.isCollapsed[comment.id] = true;
        }
      }
    }
    this.notify();
  }

  // Highlight comments newer than a chosen time (for the slider)
  highlightNewCommentsSince(cutoffTime) {
    this.isNew = {};
    for (const id in this.comments) {
      if (this.comments[id].time >= cutoffTime) {
        this.isNew[id] = true;
      }
    }
    this.notify();
  }

  markAsRead() {
    this.isNew = {};
    this.saveState();
    this.notify();
  }

  dispose() {
    this.saveState();
    this.listeners.clear();
  }

  addListener(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  notify() {
    this.listeners.forEach((cb) => cb());
  }
}

// Standalone helper: read persisted state without full store instantiation
export function loadState(storyId) {
  const json = localStorage.getItem(`thread_${storyId}`);
  return json ? JSON.parse(json) : null;
}
```

### 3. Read Story Tracking

See the `ReadStoriesStore` class above in Store Pattern. Key behaviors:

- `markAsRead(storyId)` records timestamp when a story link is clicked
- `isRead(storyId)` checks read status (optionally with a recency window)
- Max 500 entries — oldest are evicted via LRU when limit is exceeded
- Debounced persistence to avoid excessive localStorage writes
- Persisted under `vanilla-hn:read:v1` key

### 4. Time-based Comment Slider

```javascript
// Inside ItemView
createCommentSlider(threadStore) {
  const container = document.createElement('div');
  container.className = 'item-slider';

  if (threadStore.commentCount <= 1) {
    container.style.opacity = '0';
    return container;
  }

  // Sort comments by time
  const comments = Object.values(threadStore.comments)
    .sort((a, b) => a.time - b.time);

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = String(comments.length - 1);
  slider.value = String(comments.length - 1);
  slider.setAttribute('aria-label', 'Highlight comments from time range');

  const label = document.createElement('span');
  label.className = 'item-slider__label';
  label.setAttribute('aria-live', 'polite');

  const updateLabel = (index) => {
    const count = comments.length - index;
    const comment = comments[index];
    label.textContent = `Highlight ${count} comment${count !== 1 ? 's' : ''} from ${formatTimeAgo(comment.time * 1000)}`;
  };

  updateLabel(Number(slider.value));

  slider.addEventListener('input', (e) => {
    const index = Number(e.target.value);
    updateLabel(index);

    const cutoffTime = comments[index].time;
    threadStore.highlightNewCommentsSince(cutoffTime);
  });

  container.appendChild(slider);
  container.appendChild(label);

  return container;
}
```

---

## Error Handling

### Network Failures

- Wrap all Firebase subscriptions in try/catch and display inline error messages
- Provide a "Retry" button when a story or comment list fails to load
- Show cached data from sessionStorage when available, even if Firebase is unreachable
- Use the MockBackend fallback when Firebase initialization itself fails

### Invalid Data

- Gracefully handle `null` responses from Firebase (deleted items, invalid IDs)
- Show "[deleted]" or "[dead]" placeholders based on `showDead`/`showDeleted` settings
- Validate route params (e.g., ensure `:id` is numeric) and show a not-found view for invalid routes

### Stale Navigation

- Use `AbortController` in each View to cancel pending work when navigating away
- In the Router, only the latest `loadView()` call wins — earlier navigations are discarded

---

## Testing Strategy

### 1. Manual Testing Checklist

- [ ] Load all story types (top, new, show, ask, jobs)
- [ ] Navigate between pages with pagination
- [ ] Load story with comments
- [ ] Collapse/expand comment threads
- [ ] Mark story as read, verify visual indicator
- [ ] Visit story, leave, return — verify new comments highlighted
- [ ] Test auto-collapse feature
- [ ] Test comment time slider
- [ ] Change all settings, verify persistence across reload
- [ ] Test theme switching (light ↔ dark)
- [ ] Test on mobile viewport
- [ ] Test keyboard navigation (Tab, Enter, Space)
- [ ] Test with screen reader (VoiceOver / NVDA)
- [ ] Test back/forward buttons (session cache)
- [ ] Test with Firebase credentials removed (MockBackend)
- [ ] Test in multiple browsers

### 2. Performance Testing

- Measure total JS size served (target: < 60KB gzipped with Firebase)
- Test with Chrome DevTools Lighthouse (target: Performance ≥ 90, Accessibility = 100)
- Test with large comment threads (500+ comments) — verify lazy-loading prevents layout thrashing
- Monitor memory usage during long sessions
- Test on low-end devices / slow networks (DevTools throttling)

### 3. Browser Compatibility (March 2026)

Target browsers:

- Chrome/Edge 110+
- Firefox 115+
- Safari 17+
- Mobile browsers (iOS Safari 17+, Chrome Android 110+)

Graceful degradation:

- If `IntersectionObserver` is unavailable, fall back to eager-loading all comments
- If View Transitions API is unavailable, render without animation
- No polyfills should be needed for target browsers

---

## Build Setup

### No Bundler

This project intentionally avoids a bundler. The dev server (`serve.js`) is a zero-dependency Node.js script that serves `public/` and `src/` on port 5001 with proper MIME types and no caching.

Firebase is loaded via an **importmap** in `index.html` pointing to local vendor files:

```html
<script type="importmap">
  {
    "imports": {
      "firebase/app": "/vendor/firebase-app.js",
      "firebase/database": "/vendor/firebase-database.js"
    }
  }
</script>
<script type="module" src="/src/main.js"></script>
```

### package.json (Minimal)

```json
{
  "name": "vanilla-hn",
  "version": "0.1.0",
  "description": "A lightweight, vanilla JavaScript recreation of a Hacker News reader.",
  "type": "module",
  "private": true,
  "scripts": {
    "dev": "node serve.js",
    "start": "node serve.js",
    "preview": "node serve.js",
    "lint": "echo \"no linter configured\"",
    "test": "echo \"no tests configured\""
  },
  "engines": {
    "node": ">=14"
  }
}
```

No runtime dependencies in `package.json`. Firebase SDK files live in `public/vendor/` and are loaded via importmap.

### Dev Server

```javascript
// serve.js — zero-dependency static file server
// Serves public/ for static assets and src/ for ES modules
// Port 5001 (configurable via PORT env var)
// Automatic MIME typing, path-traversal prevention, no caching headers
```

---

## Accessibility Requirements

1. **Semantic HTML**: Use `<nav>`, `<main>`, `<article>`, `<section>`, `<header>`, `<footer>`
2. **Skip link**: `<a href="#app" class="visually-hidden">Skip to content</a>` at top of page
3. **ARIA attributes**:
   - `aria-expanded` and `aria-controls` on comment collapse toggles
   - `aria-label` on the comment time slider
   - `aria-live="polite"` on dynamically updated text (slider label, comment counts)
4. **Keyboard navigation**: All interactive elements reachable via Tab, activated with Enter/Space
5. **Focus management**: Move focus to `<main>` content after route changes
6. **Color contrast**: WCAG AA (4.5:1 for normal text, 3:1 for large text)
7. **Reduced motion**: Respect `prefers-reduced-motion` for all animations
8. **Screen reader support**: `.visually-hidden` / `.sr-only` utility class for offscreen-but-accessible text

---

## Progressive Enhancement

1. **Core content without JS**: Show a static message linking to `news.ycombinator.com` inside `<noscript>` or as the default `#app` content
2. **CSS graceful degradation**: Base layout works without CSS nesting, `:has()`, or container queries
3. **API fallbacks**: If `IntersectionObserver` is unavailable, load all comments eagerly
4. **MockBackend**: The app remains usable (with synthetic data) even without Firebase credentials

---

## Success Criteria

- [ ] Bundle size reduced from ~143KB to ~60KB (Firebase ~46KB + app ~14KB)
- [ ] All features from React version working identically
- [ ] Lighthouse Performance score ≥ 90
- [ ] Lighthouse Accessibility score = 100
- [ ] Zero framework dependencies (Firebase SDK is the only external JS)
- [ ] Works on all target browsers (Chrome/Edge 110+, Firefox 115+, Safari 17+)
- [ ] Maintains visual design and UX parity with React HN v2
- [ ] Session state persists (back button, localStorage, sessionStorage)
- [ ] Real-time Firebase updates working
- [ ] MockBackend works for development without Firebase credentials
- [ ] Keyboard and screen reader accessible
- [ ] No secrets or production Firebase keys committed
- [ ] `RECREATION_PROMPT.md` (this file) included at repo root

---

## Additional Notes

- **No UI frameworks** — This includes Alpine.js, Petite Vue, Svelte, Lit, etc. Pure vanilla only.
- **Firebase SDK is required** — Don't try to replace with `fetch()` calls; you'll lose real-time subscription features.
- **Preserve original design** — Match the React HN v2 look and feel.
- **Modern JS is encouraged** — Use ES2024+ features: optional chaining, nullish coalescing, top-level await, `structuredClone()`, etc.
- **CSS-in-JS is banned** — Use external `.css` files only.
- **Template literals** — Prefer for generating HTML strings in components.
- **Event delegation** — Use on story lists for better performance (one listener, not N).
- **Focus on readability** — Code should be maintainable, not clever. Prefer clarity over cleverness.
- **JSDoc** — Add type annotations via JSDoc comments for IDE support without TypeScript.
- Add small unit tests for pure logic functions where useful (traversal, new-comment detection). Tests can be plain Node scripts or a lightweight test runner.

---

## Resources

- [Hacker News API Docs](https://github.com/HackerNews/API)
- [Firebase Realtime Database Docs](https://firebase.google.com/docs/database/web/start)
- [MDN: IntersectionObserver](https://developer.mozilla.org/en-US/docs/Web/API/IntersectionObserver)
- [MDN: AbortController](https://developer.mozilla.org/en-US/docs/Web/API/AbortController)
- [MDN: Intl.RelativeTimeFormat](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/RelativeTimeFormat)
- [MDN: View Transitions API](https://developer.mozilla.org/en-US/docs/Web/API/View_Transitions_API)
- [WCAG 2.2 Guidelines](https://www.w3.org/TR/WCAG22/)
- [ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/)
- [Can I Use](https://caniuse.com/) — Check feature support
- Original app: https://github.com/insin/react-hn
