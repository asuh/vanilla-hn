# vanilla-hn

A lightweight, framework-free recreation of the React HN reader. It uses native browser APIs, Firebase realtime subscriptions, modern CSS, and an esbuild production pipeline without shipping a UI framework runtime.

This README explains how to run the scaffold locally, where to find important files, and how to swap in a real realtime backend (Firebase) when you choose to.

---

## Quick start

Requirements

- Node.js >= 24 to run the included dev server (see `.nvmrc`).
- A modern browser that supports ES modules (Chrome, Firefox, Safari, Edge).

1. Start the development server:
   - From the repository root run:
     ```
     npm run dev
     ```
     This runs `node serve.js` by default and serves the unbundled development app.

2. Open the app in the browser:
   - Visit `http://localhost:5001/` (or the port your dev server used).
   - The app uses the public Hacker News Firebase API by default and falls back to mock data if Firebase cannot load.

Notes:

- Development stays unbundled for fast startup and direct source debugging. Production uses esbuild for minification, hashing, tree shaking, and route-level code splitting.

Production build:

```
npm run build
```

This writes `dist/` with minified, hashed assets. Firebase is resolved from the npm package during this build rather than from `public/vendor/`.

---

## Project layout

Top-level files

- `RECREATION_PROMPT.md` — The original recreation prompt and design notes (copied into the repo root).
- `package.json` — Development, build, quality, test, and benchmark scripts.
- `.env.example` — Example environment variables, including Firebase placeholders.
- `firebase.example.js` — Example helper for resolving Firebase config (DO NOT put real credentials here).
- `.gitignore` — Recommended ignore rules.

Main folders

- `public/` — Static assets and `index.html` (app shell).
- `src/` — Application source (ES modules).
  - `src/main.js` — App bootstrap and route registration.
  - `src/router/Router.js` — Pathname router using the Navigation API with a History API fallback.
  - `src/views/` — `View` base class and view implementations (`ListView.js`, `ItemView`, `UserView`).
  - `src/api/hn-service.js` — `HNService` abstraction. Uses the public HN Firebase API by default, with mock fallback.
  - `src/components/` — Reusable UI components (`CommentElement.js`, `StoryListItem.js`).
  - `src/stores/` — Lightweight stores (`SettingsStore.js`, `ReadStoriesStore.js`, `StoryCommentThreadStore.js`).
  - `src/utils/` — Utility helpers for DOM, time formatting, etc.
  - `src/styles.css` — Core styles and variables.

---

## How the scaffold works (overview)

- Router: A minimal pathname router (`src/router/Router.js`) registers routes and mounts views into `#app`. Views follow a common `View` base class API (render, attach listeners, cleanup).
- Views: `ListView` shows story lists; `ItemView` displays a story and comments; `UserView` shows basic user info. The views subscribe to stores and use `HNService` to receive data.
- HNService: `src/api/hn-service.js` provides a clean surface:
  - `onStoriesValue(listType, callback)` -> unsubscribe
  - `onItemValue(itemId, callback)` -> unsubscribe
  - `fetchItem(itemId)` -> Promise
  - `onUserValue(userId, callback)` -> unsubscribe
  - `onUpdatesValue(callback)` -> unsubscribe
    The included implementation uses the public HN Firebase database by default. Tests opt into a deterministic in-memory backend.
- Components: `CommentElement` renders threaded comments, supports collapse/expand and lazy-loading child comments. `createStoryListItem` returns a keyable `<li>` for story lists.
- Stores: `SettingsStore` persists preferences in `localStorage`. `ReadStoriesStore` tracks read stories. `StoryCommentThreadStore` contains per-thread metadata (collapsed flags, lastVisit, maxCommentId heuristics) and is designed to be light and stored in `sessionStorage` by default.

---

## Configuration & Firebase

The HN public Firebase database does not require private credentials. Do not commit credentials when adapting the service to another Firebase project.

- Example config: `firebase.example.js` and `.env.example` explain expected environment variables.
- If you want to wire a real Firebase Realtime Database:
  1. Create a non-committed file or runtime injection that provides the configuration. For local development you can set `window.__FIREBASE_CONFIG__` before loading the app.
  2. Replace or extend `src/api/hn-service.js` to initialize Firebase (or add a new file that wraps Firebase SDK) and implement the same surface described above.
  3. Keep sensitive information out of version control — add any config files to `.gitignore`.

Mock mode

- Pass `{ mock: true }` to `HNService` to use deterministic local data without network access. The browser workflow tests set this flag before application startup.

---

## Scripts

`package.json` includes lightweight scripts:

- `npm run build` — Build minified, hashed production assets into `dist/`.
- `npm run dev` — Start the included dev server (requires Node >= 24). This runs `node serve.js`.
- `npm start` — Alias to `dev`.
- `npm run preview` — Alias to `dev`.
- `npm run check` — Run Biome linting and verify Oxfmt formatting.
- `npm run format` — Format the repository with Oxfmt.
- `npm test` — Run dependency-free Node unit tests.
- `npm run test:e2e` — Run Playwright workflows on desktop and mobile Chromium.
- `npm run benchmark` — Compare production Vanilla HN with React HN and write raw results to `artifacts/performance-comparison.json`.

The benchmark defaults to the deployed React HN site. Set `REACT_HN_URL` and `VANILLA_HN_URL` to compare two locally hosted production builds under the same network conditions. Set `BENCHMARK_SAMPLES` to control the median sample count.

---

## Development tips

- Editing modules: Because the browser loads ES modules directly, changes to files under `src/` will require a page reload. Consider using a dev server with live-reload if you want automatic reloads.
- Debugging: `window.vanillaHN` is exposed by the bootstrap for quick inspection (stores, services, router).
- Accessibility: The scaffold uses semantic markup and `aria-*` attributes on interactive controls while keeping initial focus behavior aligned with React HN.
- Styling: All colors, sizes, and spacing are controlled by CSS variables in `src/styles.css`. Toggle themes by updating `SettingsStore` (or `document.body.classList` for quick testing).

---

## Tests & quality

- Node tests cover spinner construction and subscription cleanup behavior.
- Playwright covers routing, link interaction, startup focus, settings persistence, dark first paint, loading spinners, and cached ranking reconciliation.
- Biome provides correctness and accessibility linting; Oxfmt owns formatting.

---

## Contributing

This repository is a personal recreation scaffold. If you plan to extend it:

- Keep the `src/api/hn-service.js` surface stable so views and stores remain backend-agnostic.
- Prefer small, well-documented changes over large refactors.
- Add examples and tests for any non-trivial algorithms (comment traversal, new-comment detection).

---

## Troubleshooting

- If `index.html` shows the fallback message about `/src/main.js` not being reachable:
  - Ensure your dev server serves the repository root (not just `public/`), or copy the relevant scripts into `public/` for a server that only serves that folder.
  - Confirm `package.json` script `dev` is running from the repo root (`npm run dev`).
- If you see CORS errors when integrating a live backend, check your database/public hosting rules and ensure the dev server origin is allowed.

---

## Notes / Next steps

Potential future work includes broader Firefox/WebKit workflow coverage and profiling exceptionally deep comment threads.

---

## License

The scaffold is provided under the MIT license. Replace with your preferred license if needed.
