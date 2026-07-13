/**
 * firebase.example.js
 *
 * Example Firebase configuration helper for the vanilla-hn scaffold.
 *
 * Purpose:
 * - Provide a single place where developers can add their Firebase config without
 *   committing secrets to the repository.
 * - Offer safe fallbacks and clear instructions for how to wire real credentials.
 *
 * Usage notes:
 * - This file is an example only and does not contain real credentials.
 * - Recommended patterns to provide real credentials for client apps:
 *    1) Serve a small server-side endpoint that injects config into the page as
 *       `window.__FIREBASE_CONFIG__` (safe for public keys; still do not commit).
 *    2) During local development, create a `.env.local` (or similar) file and set
 *       the variables; use your dev server to replace them in index.html or a tiny
 *       build step. (This project is intentionally no-bundler; choose an approach
 *       that matches your deployment.)
 *    3) For quick local testing you can copy values into a `firebase.config.js`
 *       file and import it in this module (but do not commit that file).
 *
 * Security reminder:
 * - The Firebase web config contains public-facing keys; although they are not
 *   secret in the same way as server API keys, you still should not commit your
 *   production project's identifiers or database URLs to a public repository.
 *
 * Example environment (.env.example) contents you can use locally:
 *
 * FIREBASE_API_KEY=your_api_key_here
 * FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
 * FIREBASE_DATABASE_URL=https://your-project-default-rtdb.firebaseio.com
 * FIREBASE_PROJECT_ID=your-project-id
 * FIREBASE_STORAGE_BUCKET=your-project.appspot.com
 * FIREBASE_MESSAGING_SENDER_ID=123456789
 * FIREBASE_APP_ID=1:123456:web:abcdef012345
 *
 * How this module resolves config (in order):
 * 1) `window.__FIREBASE_CONFIG__` (useful to inject config at runtime from server templates)
 * 2) `import.meta.env` (if using a bundler/dev server that exposes env vars via import.meta)
 * 3) `process.env` (Node-like environments; not available in browsers without bundling)
 * 4) Falls back to `null` (the caller should handle missing config and optionally run the app in mock mode)
 *
 * Example of initializing Firebase (commented; uncomment if you install firebase SDK):
 *
 * // // Modular SDK import (example using CDN):
 * // import { initializeApp } from 'https://www.gstatic.com/firebasejs/9.22.1/firebase-app.js';
 * // import { getDatabase } from 'https://www.gstatic.com/firebasejs/9.22.1/firebase-database.js';
 * // const config = getFirebaseConfig();
 * // const app = initializeApp(config);
 * // export const db = getDatabase(app);
 *
 * The helper below does not import Firebase. It only returns a configuration object.
 */

/**
 * Attempt to read a single env-like key from multiple sources.
 * Accepts a list of candidate names and returns the first defined non-empty value.
 */
function _readEnv(candidates = []) {
  for (const name of candidates) {
    // 1) Runtime-injected config on `window`
    try {
      if (
        typeof window !== "undefined" &&
        window.__FIREBASE_CONFIG__ &&
        window.__FIREBASE_CONFIG__[name] != null
      ) {
        return window.__FIREBASE_CONFIG__[name];
      }
    } catch (e) {
      // ignore
    }

    // 2) import.meta.env (bundler-provided)
    try {
      const metaEnv = import.meta.env;
      if (metaEnv) {
        // Common convention: VITE_* env vars or direct names
        for (const cand of [name, `VITE_${name}`]) {
          if (metaEnv[cand] != null && metaEnv[cand] !== "") return metaEnv[cand];
        }
      }
    } catch (e) {
      // ignore
    }

    // 3) process.env (Node-like builds / server-side)
    try {
      if (typeof process !== "undefined" && process.env) {
        for (const cand of [name, `VITE_${name}`]) {
          if (process.env[cand] != null && process.env[cand] !== "") return process.env[cand];
        }
      }
    } catch (e) {
      // ignore
    }
  }
  return undefined;
}

/**
 * Build a firebase config object by checking multiple env keys / injection points.
 * Returns null when no configuration was found.
 */
export function getFirebaseConfig() {
  // If the whole config object was injected at runtime via window, prefer it.
  try {
    if (typeof window !== "undefined" && window.__FIREBASE_CONFIG__) {
      return Object.assign({}, window.__FIREBASE_CONFIG__);
    }
  } catch (e) {
    // ignore
  }

  // Candidate value resolution (try common variable names)
  const apiKey = _readEnv(["FIREBASE_API_KEY", "API_KEY"]);
  const authDomain = _readEnv(["FIREBASE_AUTH_DOMAIN", "AUTH_DOMAIN"]);
  const databaseURL = _readEnv(["FIREBASE_DATABASE_URL", "DATABASE_URL"]);
  const projectId = _readEnv(["FIREBASE_PROJECT_ID", "PROJECT_ID"]);
  const storageBucket = _readEnv(["FIREBASE_STORAGE_BUCKET", "STORAGE_BUCKET"]);
  const messagingSenderId = _readEnv(["FIREBASE_MESSAGING_SENDER_ID", "MESSAGING_SENDER_ID"]);
  const appId = _readEnv(["FIREBASE_APP_ID", "APP_ID"]);
  const measurementId = _readEnv(["FIREBASE_MEASUREMENT_ID", "MEASUREMENT_ID"]);

  // If none of the required values present, return null so caller can fallback to mock mode
  if (!apiKey || !projectId || !appId) {
    return null;
  }

  return {
    apiKey,
    authDomain: authDomain || undefined,
    databaseURL: databaseURL || undefined,
    projectId,
    storageBucket: storageBucket || undefined,
    messagingSenderId: messagingSenderId || undefined,
    appId,
    measurementId: measurementId || undefined,
  };
}

/**
 * Convenience function that returns a ready-to-use Firebase config or throws with a helpful message.
 * Callers can use this to fail-fast during development when a real Firebase config is expected.
 */
export function requireFirebaseConfig() {
  const cfg = getFirebaseConfig();
  if (!cfg) {
    throw new Error(
      "Firebase config not found. Provide config by one of the following methods:\n" +
        "  - Set window.__FIREBASE_CONFIG__ = { apiKey: ..., projectId: ..., appId: ..., databaseURL: ... } before loading the app\n" +
        "  - Provide environment variables (e.g., FIREBASE_API_KEY, FIREBASE_PROJECT_ID, FIREBASE_APP_ID) via your dev server/build\n" +
        "  - Create a non-committed local file that exports the config and import it in your local setup\n\n" +
        "See firebase.example.js and .env.example for examples. Do not commit real credentials to source control.",
    );
  }
  return cfg;
}

/**
 * Example helper that returns a promise which resolves to a minimal Firebase-like client
 * if you want to dynamically load the Firebase SDK from the CDN in environments with no bundler.
 *
 * This function is only a guideline and intentionally commented so you can enable it when you
 * install/choose a specific version of the Firebase SDK.
 *
 * Example usage (uncomment and adapt to your needs):
 *
 *   import { initializeApp } from 'https://www.gstatic.com/firebasejs/9.22.1/firebase-app.js';
 *   import { getDatabase } from 'https://www.gstatic.com/firebasejs/9.22.1/firebase-database.js';
 *
 *   export async function initFirebase() {
 *     const cfg = requireFirebaseConfig();
 *     const app = initializeApp(cfg);
 *     const db = getDatabase(app);
 *     return { app, db };
 *   }
 *
 * Notes:
 * - If you choose to dynamically import from the CDN, pin the firebase SDK version you want.
 * - For local development with no bundler, loading via CDN is the simplest approach.
 * - Consider applying stricter CSP rules and Subresource Integrity (SRI) in production.
 */
export const exampleInitComment = `See comments in this module for example initialization code when you install the Firebase SDK.`;

/* Export defaults for convenience */
export default {
  getFirebaseConfig,
  requireFirebaseConfig,
  exampleInitComment,
};
