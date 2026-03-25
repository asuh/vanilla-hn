# Vanilla HN: Recreation Prompt

## Mission
Recreate a lightweight, fast, accessible Hacker News (HN) reader as a small "vanilla" JavaScript project suitable for modern browsers (progressive enhancement friendly). Preserve the UX and core features of the original reference app while using modern Web APIs and a clean, maintainable architecture that is framework-free.

## Current Application Overview

### What It Does
- Lists HN stories (news, new, ask, show, jobs) and allows opening a story to view comments.
- Streams live updates for story lists and individual items via a realtime backend.
- Displays threaded comments with collapse/expand, per-comment metadata, and "new comment" highlighting.
- Tracks read stories and marks new comments since the last visit.
- Provides settings (theme, font-size, collapse preferences) persisted locally.

### Key Features to Preserve
- Minimal, fast UI that emphasizes content over chrome.
- Threaded comment viewing with collapse/expand and lazy-loading of children.
- New-comment highlighting and read-tracking per story.
- Accessibility: semantic markup, keyboard navigation, proper ARIA where necessary.
- Offline resilience and progressive enhancement where APIs are unavailable.

### Current Tech Stack (To Replace)
- Existing repo is a React-based HN reader. This migration will create a new vanilla JS repository. Keep the Firebase integration pattern (realtime DB) from the original but replace framework code with hand-crafted patterns.

---

## Technical Architecture

This recreation aims for a modular yet simple architecture:

- `public/` for static assets.
- `src/` for application code organized into `api/`, `views/`, `components/`, and `stores/`.
- A thin `router` that handles hash-based routes.
- View classes that manage mounting, rendering, and teardown.
- Stores for application state (settings, read-stories, per-thread state).
- A small service layer (`HNService`) that abstracts Firebase or any HN API.

### Data Layer
- Centralized constants like `const DB_URL` for the realtime database endpoint.
- A thin `api` module that exposes:
  - `onStoriesValue(listType, callback)`
  - `onItemValue(itemId, callback)`
  - `fetchItem(itemId)` (one-off fetch)
  - `onUserValue(userId, callback)`
  - `onUpdatesValue(callback)` for top-level updates
- Keep Firebase-specific wiring inside `src/api/hn-service.js` and isolate it behind a simple API to ease testing/mocking.

### Type Definitions
(Described here for developer clarity; implement as JSDoc if using plain JS.)

- `interface HNItem`
  - `id`, `by`, `time`, `text`, `title`, `url`, `kids` (array of ids), `score`, `type`, `dead`, `deleted`
- `interface HNUser`
  - `id`, `about`, `created`, `karma`
- `interface ThreadState`
  - holds per-thread metadata: `collapsed` map, `newCommentCounts`, `maxCommentId`, `lastSeenCommentCount`

### Routing Strategy
- Hash-based routing (e.g. `#/`, `#/item/:id`, `#/user/:id`, `#/newest`, `#/ask`).
- Router matches routes and instantiates views, calling a `loadView()` which mounts into `#app`.
- Maintain scroll/restoration heuristics when navigating back to lists.

### State Management
- Small, focused stores:
  - `SettingsStore` (user preferences, persisted to `localStorage`)
  - `ReadStoriesStore` (mark stories read, persisted)
  - `StoryCommentThreadStore` (thread-specific state: collapse, new-comment markers)
- Stores expose `get()`, `update()`, and `addListener()` + `notify()` semantics.
- Views subscribe to stores and re-render on changes; stores return `unsubscribe` callbacks.

### Key Algorithms
1. New Comment Detection
   - Compare a thread's `commentCount` and the highest comment id against the stored `maxCommentId` for that thread; mark any newer ones as "new".
   - Consider time-based heuristics: comments after `lastVisit` are new.

2. Auto-Collapse Logic
   - Collapse threads without new comments depending on `SettingsStore.autoCollapse`.
   - When toggling collapse, update `StoryCommentThreadStore` and persist small state to `sessionStorage` for per-session speed.

3. Comment Tree Traversal
   - Use iterative traversal (stack/queue) to avoid recursion depth problems when computing aggregates (like child new counts).
   - Provide a utility to walk a subtree and compute counts, which can early-exit when possible.

4. Session Caching
   - Cache lightweight snapshots of opened threads in `sessionStorage` to minimize duplicate reads during a session.
   - Persist only metadata (ids, counts, collapsed state), not full DOM.

---

## Implementation Guide

Use modern Web APIs where appropriate: `fetch`, `AbortController`, `IntersectionObserver`, `localStorage/sessionStorage`, `URLSearchParams`, `history` (limited), `Intl.RelativeTimeFormat`, template literals, modules, and native CustomEvent patterns (not necessarily Web Components).

Example classes and patterns to implement:

- `class HNStoryItem` — small model wrapper for story items.
- `class HNComment` — wrapper around comment payloads for convenience methods.
- `class HNSpinner` — tiny DOM spinner utility for async loading states.

Use CSS variables at `:root` for theming and sizing.

Component CSS conventions:
- `.comment`, `.comment--collapsed`, `.comment--new`, `.item`, `.meta`, `.badge`, etc.

Avoid heavy DOM libraries; favor minimal helper functions such as `createElement(tag, attrs, ...children)`.

### File Structure (recommended)
- `public/` — static files (icons, plain HTML if needed)
- `src/`
  - `index.html` (or `public/index.html`)
  - `main.js`
  - `styles.css`
  - `api/hn-service.js`
  - `views/` — `ListView.js`, `ItemView.js`, `UserView.js`
  - `components/` — `CommentElement.js`, `StoryListItem.js`
  - `stores/` — `SettingsStore.js`, `ReadStoriesStore.js`, `StoryCommentThreadStore.js`
  - `router/` — `Router.js`
  - `utils/` — DOM helpers, time formatting, debounce, throttle, traversal utilities
  - `RECREATION_PROMPT.md` (this file)

### Router Implementation Pattern
- `class Router`:
  - `constructor()` sets route table and listens to `hashchange`.
  - `register(path, viewFactory)` to add routes.
  - `handleRoute()` reads `location.hash`, matches route and parameters, instantiates the view, calls `loadView()` on it.
  - `navigate(hash)` updates `location.hash`.
  - `matchRoute(hash)` returns `{route, params}` or null.

Keep route handling synchronous and only async-load data inside the view.

### View Base Class Pattern
- `class View`
  - `constructor(params)` — store route params.
  - `render()` — build DOM and return root element.
  - `createElement(tag, attrs)` — helper to create elements consistently.
  - `attachEventListeners()` — hook for derived views.
  - `update(state)` — incremental updates.
  - `subscribe(store)` — subscribe & keep `unsub` references.
  - `cleanup()` — remove listeners and abort pending operations.

### Store Pattern
- `class SettingsStore` example:
  - holds `autoCollapse`, `replyLinks`, `showDead`, `showDeleted`, `titleFontSize`, `listSpacing`, `theme`.
  - `load()` reads from `localStorage`.
  - `save()` writes to `localStorage`.
  - `update(updates)` shallow merges and notifies listeners.
  - `applyTheme()` updates `document.documentElement` CSS variables based on `theme`.
  - `addListener(fn)` to subscribe.
  - `notify()` calls listeners.

- Instantiate `const settingsStore = new SettingsStore()` for global use.

### Component Pattern (Without Web Components)
Provide factory functions that return DOM nodes and small lifecycle hooks.

Example: `createStoryListItem(story, options)`:
- Creates a `li` with `.item` class.
- Title link uses `a` with `href="#/item/:id"` for navigation.
- Meta block with score, by, time, comments count.
- `new` badge element for stories with unread comments.
- Attach event handlers for lightweight interactions (open external link vs open app view).

### Efficient DOM Updates
- For large lists and comment trees, use `DocumentFragment` to batch inserts.
- Use keyed updates: keep a map of child ids to DOM nodes and patch diffs rather than re-rendering entire trees.
- `renderCommentList(container, comments)` should build a fragment and replace needed children.
- `updateCommentCount(el, count)` updates only the text node containing the count.

### Firebase Integration (Keep From Original)
- Keep the Firebase data model and subscription patterns but isolate Firebase code in `src/api/hn-service.js`.
- Typical operations:
  - `const app = initializeApp({ databaseURL: '...' })`
  - `const db = getDatabase(app)`
  - `const api = { onStoriesValue, onItemValue, fetchItem, onUserValue, onUpdatesValue }`
  - `class HNService` wraps these methods and normalizes HN data shape for the app.

Do not commit real Firebase credentials. Provide an example config file (`firebase.example.js`) and `.env.example`.

---

## Styling Guidelines

### Use Modern CSS
- CSS variables for themeable values and sizes.
- Minimal utility classes to keep markup readable.
- Keep styles small and focused: `.item`, `.comment`, `.comment--collapsed`, `.comment--new`, `.comment-meta`, `.comment-thread`.
- Support user preference for reduced motion and dark mode.

Examples of helpful variables:
- `--bg`, `--text`, `--muted`, `--accent`, `--font-size-title`, `--font-size-meta`.

### Preserve Original Color Scheme
- Use the classic HN palette (muted gray text, orange accents for links/badges) while enabling a dark theme alternative.

---

## Performance Optimizations

### 1. Lazy Loading Comments
- Use `IntersectionObserver` to lazy-load deep comment children when their placeholder is visible.
- Observer callback should call `loadChild(commentId)` which wires up a realtime listener or does a one-off fetch.

Key parameters:
- `rootMargin` tuned to prefetch comments slightly before they enter the viewport.

### 2. Debouncing and Throttling
- `debounce(fn, wait)` for user input and settings save operations.
- `throttle(fn, wait)` for scroll handlers.
- Use `requestAnimationFrame` where appropriate for visual updates.

### 3. Virtual Scrolling (Optional)
- For long lists, implement an optional `VirtualScroller`:
  - Tracks `start` and `end` indexes based on `scrollTop` and `viewportHeight`.
  - Renders only visible items and a small buffer.
- Make virtual scrolling opt-in; simpler users/devs can skip it at first.

---

## Critical Features Implementation

### 1. Comment Collapse/Expand
- `class CommentElement`
  - `constructor(data, store)` creates DOM for a single comment and wires collapse state from `StoryCommentThreadStore`.
  - `render()` returns a `div.comment` containing meta, text, and a `kidsContainer`.
  - `createMeta()` builds byline, time, toggle control, new-badge, and reply link (if enabled).
  - `createText()` renders sanitized HTML/text safely.
  - `update()` patches visible changes (new badge, collapsed state).
  - `loadChild()` inserts placeholders while child listeners are attached; unsubscribes on cleanup.

Accessibility:
- `button` for collapse toggle with `aria-expanded`.
- Proper heading order for story titles and comment structure.

### 2. New Comment Highlighting
- `class StoryCommentThreadStore`
  - Maintains `lastVisit`, `commentCount`, `maxCommentId` per story.
  - `loadState()` from `localStorage/sessionStorage`.
  - `saveState()` to `localStorage`.
  - `commentAdded(commentId, parentId)` updates the tree's new counts.
  - `getChildCounts(rootId)` traverses child ids to compute how many are new.
  - `collapseThreadsWithoutNewComments()` uses the computed counts to auto-collapse.

### 3. Read Story Tracking
- `class ReadStoriesStore`
  - `markAsRead(storyId)` records timestamp when a story was viewed.
  - `isRead(storyId)` returns boolean based on store.
  - `getReadStories()` returns a compact map from `localStorage`.
  - `unmarkAsRead(storyId)` removes a mark (for debugging/UX).

### 4. Time-based Comment Slider
- `class ItemView`
  - `createCommentSlider()` builds a small control to jump between comment time windows (e.g., last 1h, 6h, 24h, 7d).
  - Slider updates the rendered comment subset by comparing comment `time` to `cutoffTime`.
  - Provides an index and buttons to move between windows and an accessible label that updates live.

---

## Testing Strategy

### 1. Manual Testing Checklist
- Navigation across lists and item views works via hash routes.
- Keyboard accessibility: tab order, toggle via keyboard.
- Settings persist and apply correctly.
- New-comment badges update when new comments appear.
- Collapse/expand behavior consistent across sessions when configured.

### 2. Performance Testing
- Lighthouse checks: aim for high scores on Performance, Accessibility, Best Practices.
- Load large threads and ensure lazy-loading / batching prevents layout thrashing.

### 3. Browser Compatibility (March 2026)
- Target evergreen browsers (latest Chrome, Firefox, Safari, Edge).
- Provide graceful degrade for older browsers; polyfills only where necessary (`IntersectionObserver` fallback could be a simple eager-loading fallback).

---

## Build Setup

Even though the app is vanilla JS with no bundler by your choice, provide a minimal `package.json` for convenience (dev scripts optional). The repo should still include a simple development workflow:

- `package.json` (minimal)
  - `name`, `version`, `type: "module"` to enable ES module imports in modern browsers.
  - Scripts (optional): `dev` could be a tiny static server (e.g., `serve` or `http-server`), `build` can be a placeholder or absent because no bundler is used.
  - Dependencies: none required for runtime; dev deps optional.

- `vite.config.js`: omit if strictly "no bundler"; otherwise provide a small config only if you later want to use Vite for convenience.

Suggested initial files:
- `index.html` (module entry: `<script type="module" src="/src/main.js"></script>`)
- `src/main.js`
- `src/styles.css`
- `.gitignore`
- `README.md`

### Example package.json (minimal)
- Keep it small. If you want an npm dev server, add `devDependencies` for `serve` or `http-server` and a `dev` script.

---

## Accessibility Requirements
- All interactive controls must be focusable.
- Toggle controls must expose `aria-expanded` and `aria-controls`.
- Use `role="region"` or landmarks where appropriate.
- Provide skip links (`#skip-to-content`).
- Ensure color contrast meets WCAG AA for text.

---

## Progressive Enhancement
- The app should render a usable list of stories with simple server-provided HTML if JS is unavailable or fails. At minimum, show a link to Hacker News.
- Features gated behind Web APIs should have simple fallbacks (e.g., load all comments if `IntersectionObserver` is not available).

---

## Success Criteria
- A new `vanilla-hn` repository containing:
  - A working vanilla JS HN reader skeleton.
  - Isolated Firebase integration stubs behind `src/api/hn-service.js`.
  - Stores, views, router, and components scaffolding.
  - RECREATION_PROMPT.md (this file) included at repo root.
- App is lightweight, accessible, and demonstrates the critical behaviors: list navigation, item view, threaded comments with collapse and new-comment indicators.
- No secrets or production Firebase keys committed.

---

## Additional Notes
- Keep code readable and well-commented; prefer clarity over cleverness.
- Add small unit tests for pure logic functions where useful (e.g. traversal, new-comment detection). Tests can be plain Node scripts or use a lightweight test runner if desired later.
- Consider adding a browser-extension friendly / embeddable mode that strips the UI down further for embedding in other pages.

---

## Resources
- Hacker News API documentation (official and community-maintained)
- Firebase Realtime Database docs (for existing realtime patterns)
- MDN Web Docs for modern Web APIs used (IntersectionObserver, web storage, AbortController)
- Accessibility guidelines (WCAG, ARIA Authoring Practices)
