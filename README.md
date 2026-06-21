# vanilla-hn

A lightweight, framework-free recreation of a Hacker News reader. This repository is a scaffolded, vanilla JavaScript implementation intended to be small, accessible, and easy to extend. It includes simple stores, a router, component-like modules, and a mockable `HNService` so you can develop without committing any external secrets.

This README explains how to run the scaffold locally, where to find important files, and how to swap in a real realtime backend (Firebase) when you choose to.

---

## Quick start

Requirements
- Node.js >= 24 to run the included dev server (see `.nvmrc`).
- A modern browser that supports ES modules (Chrome, Firefox, Safari, Edge).

1. Serve the project root (so `/src` is reachable by the browser):
   - From the repository root run:
     ```
     npm run dev
     ```
     This runs `node serve.js` by default and serves the unbundled development app.
   - Alternatively, run any static file server that serves the repository root and navigate to `http://localhost:5001/` or `http://localhost:5001/public/index.html` depending on your server configuration (the included `public/index.html` imports `/src/main.js`).

2. Open the app in the browser:
   - Visit `http://localhost:5001/` (or the port your dev server used).
   - The app uses the public Hacker News Firebase API by default and falls back to mock data if Firebase cannot load.

Notes:
- The project is intentionally unbundled to remain simple. `type: "module"` is set in `package.json` and source modules are loaded by the browser.
- If your dev server only serves the `public/` directory, the `index.html` contains a fallback that attempts to import `/src/main.js`. Running a server from the repository root is recommended so that `/src` can be directly imported.

Production build:
```
npm run build
```

This writes `dist/` with minified, hashed assets. Firebase is resolved from the npm package during this build rather than from `public/vendor/`.

---

## Project layout

Top-level files
- `RECREATION_PROMPT.md` — The original recreation prompt and design notes (copied into the repo root).
- `package.json` — Minimal scripts for local development.
- `.env.example` — Example environment variables, including Firebase placeholders.
- `firebase.example.js` — Example helper for resolving Firebase config (DO NOT put real credentials here).
- `.gitignore` — Recommended ignore rules.

Main folders
- `public/` — Static assets and `index.html` (app shell).
- `src/` — Application source (ES modules).
  - `src/main.js` — App bootstrap and route registration.
  - `src/router/Router.js` — Small hash-based router.
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
  The included implementation runs a mock backend by default and simulates realtime updates for development.
- Components: `CommentElement` renders threaded comments, supports collapse/expand and lazy-loading child comments. `createStoryListItem` returns a keyable `<li>` for story lists.
- Stores: `SettingsStore` persists preferences in `localStorage`. `ReadStoriesStore` tracks read stories. `StoryCommentThreadStore` contains per-thread metadata (collapsed flags, lastVisit, maxCommentId heuristics) and is designed to be light and stored in `sessionStorage` by default.

---

## Configuration & Firebase

The scaffold intentionally does not include any real Firebase credentials.

- Example config: `firebase.example.js` and `.env.example` explain expected environment variables.
- If you want to wire a real Firebase Realtime Database:
  1. Create a non-committed file or runtime injection that provides the configuration. For local development you can set `window.__FIREBASE_CONFIG__` before loading the app.
  2. Replace or extend `src/api/hn-service.js` to initialize Firebase (or add a new file that wraps Firebase SDK) and implement the same surface described above.
  3. Keep sensitive information out of version control — add any config files to `.gitignore`.

Mock mode
- By default `HNService` runs in mock mode to let you develop without credentials. You can switch to real mode by providing `databaseURL` or disabling `mock` in the `HNService` constructor when you integrate Firebase.

---

## Scripts

`package.json` includes lightweight scripts:

- `npm run build` — Build minified, hashed production assets into `dist/`.
- `npm run dev` — Start the included dev server (requires Node >= 24). This runs `node serve.js`.
- `npm start` — Alias to `dev`.
- `npm run preview` — Alias to `dev`.
- `npm run lint` / `npm test` — Placeholders.

Because the project intentionally omits a bundler, these commands simply serve files for development.

---

## Development tips

- Editing modules: Because the browser loads ES modules directly, changes to files under `src/` will require a page reload. Consider using a dev server with live-reload if you want automatic reloads.
- Debugging: `window.vanillaHN` is exposed by the bootstrap for quick inspection (stores, services, router).
- Accessibility: The scaffold uses semantic markup and `aria-*` attributes on interactive controls while keeping initial focus behavior aligned with React HN.
- Styling: All colors, sizes, and spacing are controlled by CSS variables in `src/styles.css`. Toggle themes by updating `SettingsStore` (or `document.body.classList` for quick testing).

---

## Tests & quality

- There are no automated tests in this scaffold yet. For logic-heavy utilities (traversal, new-comment detection), consider adding small Node-based unit tests or using a lightweight test runner (e.g., AVA, Jest).
- Linting is not configured — add ESLint/Prettier to enforce code style if desired.

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

Suggested changes to make this scaffold production-ready:
- Add a lightweight bundling step (esbuild, Vite) to allow environment injection and asset fingerprinting.
- Add integration with a real HN backend or Firebase and follow secure practices for keys/config.
- Add unit tests for stores and traversal utilities.
- Implement optional virtual scrolling for extremely long threads.

---

## License

The scaffold is provided under the MIT license. Replace with your preferred license if needed.

---

If you want, I can:
- Add a simple `README` badge or CI config,
- Wire a minimal Vite setup if you later decide you want a dev-bundler,
- Or implement a production-capable `hn-service` that initializes Firebase (I will not commit keys; I will keep placeholder instructions and an `.env.example`).
