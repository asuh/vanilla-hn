# vanilla-hn

A lightweight, framework-free recreation of the React HN reader. It uses native browser APIs, Firebase realtime subscriptions, modern CSS, and an esbuild production pipeline without shipping a UI framework runtime.

This README explains how to run the app locally, create and preview a production build, and work with its realtime Firebase backend.

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

- Development stays unbundled for fast startup and direct source debugging. Production uses esbuild for minification, hashing, tree shaking, and a single application bundle to minimize cold-start requests.

Production build:

```
npm run build
```

This writes `dist/` with minified, hashed assets and precompressed Brotli and gzip representations. Firebase is resolved from the npm package during this build rather than from `public/vendor/`.

Preview the production output with the same compression and caching behavior used by the benchmark:

```
npm run preview
```

The preview is available at `http://127.0.0.1:5002/` by default. Set `BUILD_SPLITTING=true` to produce an experimental route-split build instead of the measured single-bundle default.

### GitHub Pages

Pushes to `main` deploy through [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml). The workflow checks formatting and linting, runs the unit and browser suites, builds the project-site artifact, and deploys it with GitHub's Pages actions. For this repository, the production URL is:

```
https://asuh.github.io/vanilla-hn/
```

The Pages build derives `/vanilla-hn/` from `GITHUB_REPOSITORY`, so hashed assets and internal routes stay inside the project path. It also emits `404.html` as an application-shell fallback. GitHub Pages returns that file with a 404 status for a cold nested request such as `/vanilla-hn/story/33`, but the client router renders the requested view without redirecting or switching to hash URLs.

Run the same project-path build and browser check locally with:

```
npm run test:e2e:pages
```

Use `BASE_PATH=/another-path/ npm run build` for another static host. Set `BUILD_404=true` to emit the clean-route fallback outside a GitHub Pages build and `BUILD_PRECOMPRESS=false` when the host handles compression itself.

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
- `npm start` — Serve an existing production build; equivalent to `preview`.
- `npm run preview` — Serve an existing `dist/` build with Brotli/gzip negotiation and production cache headers.
- `npm run check` — Run Biome linting and verify Oxfmt formatting.
- `npm run format` — Format the repository with Oxfmt.
- `npm test` — Run dependency-free Node unit tests.
- `npm run test:e2e` — Run Playwright workflows on desktop and mobile Chromium.
- `npm run test:e2e:pages` — Build and test the app at its `/vanilla-hn/` project path.
- `npm run benchmark` — Compare production Vanilla HN with React HN and write raw results to `artifacts/performance-comparison.json`.

The benchmark uses a fresh Chromium context for every sample, blocks service workers, and observes each app for a fixed 1.5 seconds so realtime connections do not prevent completion. It reports first-party application requests separately from backend traffic and records request-level transfer, content encoding, and realtime WebSocket payload details.

The comparison defaults to a locally served Vanilla HN production build and the deployed React HN site. Transfer sizes are compression-aware, but local-versus-remote timings are not directly comparable and the benchmark prints a warning accordingly. Set both `REACT_HN_URL` and `VANILLA_HN_URL` to production or local URLs under equivalent network conditions for timing comparisons. Set `BENCHMARK_SAMPLES` to control the median sample count.

---

## Development tips

- Editing modules: Because the browser loads ES modules directly, changes to files under `src/` will require a page reload. Consider using a dev server with live-reload if you want automatic reloads.
- Debugging: `window.vanillaHN` is exposed by the bootstrap for quick inspection (stores, services, router).
- Accessibility: The scaffold uses semantic markup and `aria-*` attributes on interactive controls while keeping initial focus behavior aligned with React HN.
- Styling: All colors, sizes, and spacing are controlled by CSS variables in `src/styles.css`. Toggle themes by updating `SettingsStore` (or `document.body.classList` for quick testing).

---

## Tests & quality

- Node tests cover spinner construction, subscription cleanup, and production server behavior.
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
