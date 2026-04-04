#!/usr/bin/env node
/**
 * serve.js — small zero-dependency dev server for vanilla-hn
 *
 * Polished iteration:
 * - Robust open-wait that listens to the AbortSignal to avoid races.
 * - Keeps a single manual per-request timer (controlled abort) and avoids
 *   using server.requestTimeout to prevent keep-alive bleed.
 * - Top-level await for root canonicalization and friendly startup errors.
 * - Clean, idempotent per-request cleanup.
 *
 * Notes:
 * - Intended for development convenience only (no TLS, limited features).
 * - Requires Node >= 24.
 */

import http from "node:http";
import { createReadStream } from "node:fs";
import { stat as fstat, realpath as frealpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "public");
const SRC = path.join(__dirname, "src");

const PORT = Number(process.env.PORT) || 5001;
const HOST = process.env.HOST || "127.0.0.1";
const REQUEST_TIMEOUT_MS = Number(process.env.DEV_SERVER_TIMEOUT_MS) || 10_000;
const DEV_LOG = Boolean(process.env.DEV_SERVER_DEBUG);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};

async function realRoot(root) {
  try {
    return await frealpath(root);
  } catch (_) {
    return path.resolve(root);
  }
}

const REAL_PUBLIC = await realRoot(PUBLIC);
const REAL_SRC = await realRoot(SRC);

// Ensure public/ and src/ exist and are directories; fail fast with a friendly message.
for (const [name, realPath] of [
  ["public", REAL_PUBLIC],
  ["src", REAL_SRC],
]) {
  try {
    const s = await fstat(realPath);
    if (!s.isDirectory()) {
      console.error(
        `\nMissing required directory: ${name}/ (${realPath}) — not a directory`,
      );
      process.exit(1);
    }
  } catch (err) {
    console.error(`\nMissing required directory: ${name}/ (${realPath})`);
    console.error(`Create the directory and re-run: mkdir -p ${name}`);
    process.exit(1);
  }
}

// Return first existing file and stat: { filePath, stat } or null
async function resolveFirstExisting(candidates) {
  for (const candidate of candidates) {
    try {
      const s = await fstat(candidate);
      if (s.isDirectory()) {
        const idx = path.join(candidate, "index.html");
        try {
          const idxStat = await fstat(idx);
          if (idxStat.isFile()) {
            const real = await frealpath(idx);
            return { filePath: real, stat: idxStat };
          }
        } catch (_) {
          // continue
        }
        continue;
      }
      if (s.isFile()) {
        const real = await frealpath(candidate);
        return { filePath: real, stat: s };
      }
    } catch (_) {
      // try next
    }
  }
  return null;
}

function isInsideRoot(allowedRealRoot, targetReal) {
  const rel = path.relative(allowedRealRoot, targetReal);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// Candidate builder — avoids src/src duplicates.
// Order:
//  - public/<safe>
//  - src/<stripped> if URL begins with /src/, otherwise src/<safe>
function buildCandidatesFromUrlPath(decodedPath) {
  const safe = path.normalize(decodedPath).replace(/^([.]{2}[\\/])+/, "");
  const candidates = [path.join(PUBLIC, safe)];

  if (safe.startsWith("/src/") || safe.startsWith("src/")) {
    const stripped = safe.replace(/^\/?src\//, "");
    candidates.push(path.join(SRC, stripped));
  } else {
    candidates.push(path.join(SRC, safe));
  }
  return candidates;
}

const server = http.createServer(async (req, res) => {
  // Per-request AbortController used to cancel pipeline if the request times out or client disconnects.
  const ac = new AbortController();
  const { signal } = ac;

  // Manual per-request timer that will call ac.abort() when elapsed.
  const timer = setTimeout(() => {
    if (!signal.aborted) {
      if (DEV_LOG)
        console.warn(`[serve] request timeout: ${req.method} ${req.url}`);
      ac.abort();
    }
  }, REQUEST_TIMEOUT_MS);

  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    clearTimeout(timer);
    try {
      req.removeListener("close", onReqClose);
    } catch (_) {}
    try {
      res.removeListener("finish", onResFinish);
    } catch (_) {}
    try {
      signal.removeEventListener &&
        signal.removeEventListener("abort", onSignalAbort);
    } catch (_) {}
  }

  function onSignalAbort() {
    // Do minimal work here. The streaming pipeline's catch will handle 408/cleanup
    if (DEV_LOG)
      console.warn(`[serve] abort signal for ${req.method} ${req.url}`);
    cleanup();
  }

  function onReqClose() {
    // Only abort if response is still in-flight.
    if (!res.writableEnded && !signal.aborted) ac.abort();
  }

  function onResFinish() {
    cleanup();
  }

  signal.addEventListener("abort", onSignalAbort, { once: true });
  req.on("close", onReqClose);
  res.on("finish", onResFinish);

  // Decode URL path; return 400 on malformed encoding
  let decodedPath;
  try {
    decodedPath = decodeURIComponent((req.url || "/").split("?")[0]);
  } catch (err) {
    if (!res.writableEnded) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("400 Bad Request: malformed URL encoding");
    }
    cleanup();
    return;
  }

  const rawCandidates = buildCandidatesFromUrlPath(decodedPath);
  if (!rawCandidates.length) {
    if (!res.writableEnded) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`404 Not Found: ${decodedPath}`);
    }
    cleanup();
    return;
  }

  let found = null;
  try {
    found = await resolveFirstExisting(rawCandidates);
  } catch (err) {
    console.error("[serve] filesystem error while resolving path:", err);
    if (!res.writableEnded) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("500 Internal Server Error");
    }
    cleanup();
    return;
  }

  if (!found) {
    // SPA fallback: for extensionless paths (app routes like /item/123, /newest, etc.)
    // serve index.html so the client-side router can handle the route.
    const reqExt = path.extname(decodedPath.split("?")[0]).toLowerCase();
    const isSpaRoute = !reqExt || reqExt === ".html";
    if (isSpaRoute) {
      const indexPath = path.join(REAL_PUBLIC, "index.html");
      try {
        const indexStat = await fstat(indexPath);
        if (indexStat.isFile()) {
          const spaHeaders = {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "Content-Length": String(indexStat.size),
            "Last-Modified": new Date(indexStat.mtimeMs).toUTCString(),
          };

          const spaStream = createReadStream(indexPath, { autoClose: true });

          try {
            await new Promise((resolve, reject) => {
              function teardownListeners() {
                spaStream.removeListener("open", onOpen);
                spaStream.removeListener("error", onError);
                signal.removeEventListener &&
                  signal.removeEventListener("abort", onAbort);
              }
              function onOpen() {
                teardownListeners();
                resolve();
              }
              function onError(err) {
                teardownListeners();
                reject(err);
              }
              function onAbort() {
                teardownListeners();
                const e = new Error("aborted");
                e.name = "AbortError";
                reject(e);
              }
              if (signal.aborted) return onAbort();
              spaStream.once("open", onOpen);
              spaStream.once("error", onError);
              signal.addEventListener("abort", onAbort, { once: true });
            });
          } catch (err) {
            if (err && err.name === "AbortError") {
              if (!res.headersSent) {
                try {
                  res.writeHead(408, {
                    "Content-Type": "text/plain; charset=utf-8",
                  });
                  res.end("408 Request Timeout");
                } catch (_) {
                  try {
                    res.destroy();
                  } catch (_) {}
                }
              } else {
                try {
                  res.destroy();
                } catch (_) {}
              }
              try {
                spaStream.destroy();
              } catch (_) {}
              cleanup();
              return;
            }
            // index.html failed to open — fall through to 404
            try {
              spaStream.destroy();
            } catch (_) {}
            if (!res.writableEnded) {
              res.writeHead(404, {
                "Content-Type": "text/plain; charset=utf-8",
              });
              res.end(`404 Not Found: ${decodedPath}`);
            }
            cleanup();
            return;
          }

          if (signal.aborted) {
            if (!res.headersSent) {
              try {
                res.writeHead(408, {
                  "Content-Type": "text/plain; charset=utf-8",
                });
                res.end("408 Request Timeout");
              } catch (_) {
                try {
                  res.destroy();
                } catch (_) {}
              }
            } else {
              try {
                res.destroy();
              } catch (_) {}
            }
            try {
              spaStream.destroy();
            } catch (_) {}
            cleanup();
            return;
          }

          if (!res.headersSent) {
            try {
              res.writeHead(200, spaHeaders);
            } catch (e) {
              if (DEV_LOG) console.warn("[serve] writeHead failed (spa):", e);
              try {
                spaStream.destroy();
              } catch (_) {}
              cleanup();
              return;
            }
          }

          try {
            await pipeline(spaStream, res, { signal });
            cleanup();
            return;
          } catch (err) {
            if (err && err.name === "AbortError") {
              if (!res.headersSent) {
                try {
                  res.writeHead(408, {
                    "Content-Type": "text/plain; charset=utf-8",
                  });
                  res.end("408 Request Timeout");
                } catch (_) {}
              } else {
                try {
                  res.destroy();
                } catch (_) {}
              }
            } else {
              console.error("[serve] spa streaming error:", err && err.message);
              if (!res.headersSent) {
                try {
                  res.writeHead(500, {
                    "Content-Type": "text/plain; charset=utf-8",
                  });
                  res.end("500 Internal Server Error");
                } catch (_) {}
              } else if (DEV_LOG) {
                console.warn("[serve] spa error after headers sent:", err);
              }
            }
            try {
              spaStream.destroy();
            } catch (_) {}
            cleanup();
            return;
          }
        }
      } catch (_) {
        // index.html missing — fall through to 404
      }
    }

    if (!res.writableEnded) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`404 Not Found: ${decodedPath}`);
    }
    cleanup();
    return;
  }

  const { filePath, stat } = found;

  // Ensure resolved path is inside one of our canonical roots.
  if (
    !isInsideRoot(REAL_PUBLIC, filePath) &&
    !isInsideRoot(REAL_SRC, filePath)
  ) {
    console.warn(`[serve] forbidden path escape attempt: ${filePath}`);
    if (!res.writableEnded) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("403 Forbidden");
    }
    cleanup();
    return;
  }

  // If-Modified-Since -> 304
  const ifMod = req.headers["if-modified-since"];
  if (ifMod) {
    const since = Date.parse(ifMod);
    if (
      !Number.isNaN(since) &&
      Math.floor(stat.mtimeMs / 1000) <= Math.floor(since / 1000)
    ) {
      if (!res.writableEnded) {
        res.writeHead(304);
        res.end();
      }
      cleanup();
      return;
    }
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || "application/octet-stream";
  const headers = {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Content-Length": String(stat.size),
    "Last-Modified": new Date(stat.mtimeMs).toUTCString(),
  };

  const stream = createReadStream(filePath, { autoClose: true });

  // Wait for stream 'open' but also respect the AbortSignal to avoid races.
  try {
    await new Promise((resolve, reject) => {
      function teardownListeners() {
        stream.removeListener("open", onOpen);
        stream.removeListener("error", onError);
        signal.removeEventListener &&
          signal.removeEventListener("abort", onAbort);
      }
      function onOpen() {
        teardownListeners();
        resolve();
      }
      function onError(err) {
        teardownListeners();
        reject(err);
      }
      function onAbort() {
        teardownListeners();
        const e = new Error("aborted");
        e.name = "AbortError";
        reject(e);
      }

      if (signal.aborted) return onAbort();

      stream.once("open", onOpen);
      stream.once("error", onError);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  } catch (err) {
    // Stream failed to open or we were aborted early.
    if (err && err.name === "AbortError") {
      if (!res.headersSent) {
        try {
          res.writeHead(408, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("408 Request Timeout");
        } catch (_) {
          try {
            res.destroy();
          } catch (_) {}
        }
      } else {
        try {
          res.destroy();
        } catch (_) {}
      }
      try {
        stream.destroy();
      } catch (_) {}
      cleanup();
      return;
    } else {
      if (!res.headersSent) {
        try {
          res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("500 Internal Server Error");
        } catch (_) {}
      } else if (DEV_LOG) {
        console.warn("[serve] stream error after headers sent:", err);
      }
      try {
        stream.destroy();
      } catch (_) {}
      cleanup();
      return;
    }
  }

  // At this point stream was opened successfully. If request was aborted concurrently, handle it.
  if (signal.aborted) {
    if (!res.headersSent) {
      try {
        res.writeHead(408, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("408 Request Timeout");
      } catch (_) {
        try {
          res.destroy();
        } catch (_) {}
      }
    } else {
      try {
        res.destroy();
      } catch (_) {}
    }
    try {
      stream.destroy();
    } catch (_) {}
    cleanup();
    return;
  }

  // Write headers then stream with pipeline (pipeline will honor AbortSignal).
  if (!res.headersSent) {
    try {
      res.writeHead(200, headers);
    } catch (e) {
      if (DEV_LOG) console.warn("[serve] writeHead failed:", e);
      try {
        stream.destroy();
      } catch (_) {}
      cleanup();
      return;
    }
  }

  try {
    await pipeline(stream, res, { signal });
    // Success — cleanup will run via 'finish' handler but call here as well for safety.
    cleanup();
    return;
  } catch (err) {
    if (err && err.name === "AbortError") {
      // Timeout/abort: if headers haven't been sent, return 408; otherwise destroy socket.
      if (!res.headersSent) {
        try {
          res.writeHead(408, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("408 Request Timeout");
        } catch (_) {}
      } else {
        try {
          res.destroy();
        } catch (_) {}
      }
      try {
        stream.destroy();
      } catch (_) {}
      cleanup();
      return;
    }

    // Other streaming error
    console.error("[serve] streaming error:", err && err.message);
    if (!res.headersSent) {
      try {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("500 Internal Server Error");
      } catch (_) {}
    } else if (DEV_LOG) {
      console.warn("[serve] error after headers sent:", err);
    }
    try {
      stream.destroy();
    } catch (_) {}
    cleanup();
    return;
  }
});

// Do NOT set server.requestTimeout to avoid keep-alive bleed; rely on manual per-request timer above.

server.listen(PORT, HOST, () => {
  console.log(`\nvanilla-hn dev server → http://${HOST}:${PORT}/`);
  console.log(`  public/ : ${PUBLIC}`);
  console.log(`  src/    : ${SRC}  (live — no copy needed)`);
  console.log(`  spa fallback: public/index.html`);
  console.log(`  request timeout: ${REQUEST_TIMEOUT_MS}ms`);
  console.log(`\nPress Ctrl+C to stop.\n`);
});

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error(`\nError: port ${PORT} is already in use.`);
    console.error(
      `Run with a different port:  PORT=3000 HOST=0.0.0.0 node serve.js\n`,
    );
  } else {
    console.error("Server error:", err);
  }
  process.exit(1);
});

// Graceful shutdown
let shuttingDown = false;
function shutdown(signalName) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\nReceived ${signalName}. Shutting down server...`);
  server.close((err) => {
    if (err) {
      console.error("Error closing server:", err);
      process.exit(1);
    } else {
      console.log("Server closed.");
      process.exit(0);
    }
  });
  setTimeout(() => {
    console.warn("Forcing shutdown.");
    process.exit(1);
  }, 5000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
