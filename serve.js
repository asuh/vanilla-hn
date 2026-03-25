#!/usr/bin/env node
/**
 * serve.js — zero-dependency dev server for vanilla-hn
 *
 * Serves files from two roots:
 *   1. ./public  — static assets and index.html
 *   2. ./src     — ES modules (so /src/main.js etc. resolve directly from source)
 *
 * Request resolution order:
 *   1. Try ./public/<path>
 *   2. Try ./src/<path minus leading /src>  (i.e. /src/foo.js → ./src/foo.js)
 *   3. 404
 *
 * This means edits to src/ are live immediately — no copy step needed.
 *
 * Usage:
 *   node serve.js             # port 5001
 *   PORT=3000 node serve.js   # custom port
 */

import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "public");
const SRC = path.join(__dirname, "src");
const PORT = Number(process.env.PORT) || 5001;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Return the first existing file path from the candidate list, or null.
 * Automatically appends /index.html for directories.
 */
function resolve(candidates) {
  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isDirectory()) {
        const idx = path.join(candidate, "index.html");
        if (fs.existsSync(idx)) return idx;
        continue;
      }
      return candidate;
    } catch (_) {
      // not found — try next candidate
    }
  }
  return null;
}

const server = http.createServer((req, res) => {
  // Strip query string and decode URI
  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split("?")[0]);
  } catch (_) {
    urlPath = req.url.split("?")[0];
  }

  // Prevent path traversal
  const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, "");

  // Build candidate file paths:
  // 1. ./public/<path>        — handles /index.html, /src/main.js (copied), /styles.css etc.
  // 2. ./src/<path>           — handles /src/main.js from live source
  // 3. ./src/<path - /src/>   — handles /src/views/Foo.js → ./src/views/Foo.js
  const fromPublic = path.join(PUBLIC, safe);
  const fromSrc = path.join(SRC, safe);
  const srcStripped = safe.startsWith("/src/")
    ? path.join(SRC, safe.slice("/src/".length))
    : null;

  const candidates = [fromPublic, fromSrc];
  if (srcStripped) candidates.push(srcStripped);

  const filePath = resolve(candidates);

  if (!filePath) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end(`404 Not Found: ${urlPath}`);
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || "application/octet-stream";

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`500 Internal Server Error: ${err.message}`);
      return;
    }

    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    });
    res.end(data);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\nvanilla-hn dev server → http://localhost:${PORT}/`);
  console.log(`  public/ : ${PUBLIC}`);
  console.log(`  src/    : ${SRC}  (live — no copy needed)`);
  console.log(`\nPress Ctrl+C to stop.\n`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\nError: port ${PORT} is already in use.`);
    console.error(`Run with a different port:  PORT=3000 node serve.js\n`);
  } else {
    console.error("Server error:", err);
  }
  process.exit(1);
});
