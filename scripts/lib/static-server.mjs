import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const MIME_TYPES = {
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const HASHED_ASSET = /-[A-Z0-9_-]{8,}\.[A-Z0-9]+$/i;
const ENCODINGS = [
  ["br", ".br"],
  ["gzip", ".gz"],
];

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeBasePath(value = "/") {
  const segments = String(value || "/")
    .split(/[?#]/, 1)[0]
    .split("/")
    .filter(Boolean);
  return segments.length ? `/${segments.join("/")}/` : "/";
}

function stripBasePath(urlPath, basePath) {
  if (basePath === "/") return urlPath;
  const baseWithoutSlash = basePath.slice(0, -1);
  if (urlPath === baseWithoutSlash) return "/";
  if (!urlPath.startsWith(basePath)) return null;
  return urlPath.slice(baseWithoutSlash.length) || "/";
}

function cacheControl(urlPath, filePath) {
  if (path.extname(filePath) === ".html") return "no-cache";
  if (urlPath.startsWith("/assets/") && HASHED_ASSET.test(path.basename(filePath))) {
    return "public, max-age=31536000, immutable";
  }
  return "public, max-age=3600";
}

function acceptedEncodings(header = "") {
  return new Map(
    header
      .split(",")
      .map((value) => value.trim().split(";"))
      .filter(([name]) => name)
      .map(([name, ...parameters]) => {
        const quality = parameters
          .map((parameter) => parameter.trim())
          .find((parameter) => parameter.startsWith("q="));
        const parsedQuality = quality ? Number(quality.slice(2)) : 1;
        return [name.toLowerCase(), Number.isFinite(parsedQuality) ? parsedQuality : 0];
      }),
  );
}

async function encodedFile(sourcePath, acceptEncoding) {
  const accepted = acceptedEncodings(acceptEncoding);
  const candidates = ENCODINGS.map(([encoding, suffix], preference) => ({
    encoding,
    preference,
    quality: accepted.get(encoding) ?? accepted.get("*") ?? 0,
    suffix,
  })).sort((a, b) => b.quality - a.quality || a.preference - b.preference);

  for (const { encoding, quality, suffix } of candidates) {
    if (quality <= 0) continue;
    const filePath = `${sourcePath}${suffix}`;
    try {
      const fileStat = await stat(filePath);
      if (fileStat.isFile()) return { encoding, filePath, fileStat };
    } catch {
      // Try the next available representation.
    }
  }
  return null;
}

async function hasEncodedFile(sourcePath) {
  for (const [, suffix] of ENCODINGS) {
    try {
      if ((await stat(`${sourcePath}${suffix}`)).isFile()) return true;
    } catch {
      // Try the next representation.
    }
  }
  return false;
}

async function resolveSource(root, urlPath, fallback) {
  let relativePath;
  try {
    relativePath = decodeURIComponent(urlPath).replace(/^\/+/, "") || "index.html";
  } catch {
    return { error: 400 };
  }

  if (relativePath.endsWith(".br") || relativePath.endsWith(".gz")) return { error: 404 };

  const requestedPath = path.resolve(root, relativePath);
  if (!isInside(root, requestedPath)) return { error: 403 };

  try {
    const fileStat = await stat(requestedPath);
    if (fileStat.isFile()) return { filePath: requestedPath, fileStat };
  } catch {
    // Fall through to the SPA entry point when appropriate.
  }

  const extension = path.extname(relativePath);
  if (!fallback || (extension && extension !== ".html")) return { error: 404 };

  const fallbackPath = path.resolve(root, fallback);
  if (!isInside(root, fallbackPath)) return { error: 403 };
  try {
    const fileStat = await stat(fallbackPath);
    return fileStat.isFile() ? { filePath: fallbackPath, fileStat } : { error: 404 };
  } catch {
    return { error: 404 };
  }
}

function sendError(response, status) {
  const message = http.STATUS_CODES[status] || "Error";
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(`${status} ${message}\n`);
}

export function createStaticServer({ root, fallback = "index.html", basePath = "/" }) {
  const resolvedRoot = path.resolve(root);
  const normalizedBasePath = normalizeBasePath(basePath);

  return http.createServer(async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      sendError(response, 405);
      return;
    }

    const url = new URL(request.url || "/", "http://localhost");
    const sourcePath = stripBasePath(url.pathname, normalizedBasePath);
    if (sourcePath == null) {
      sendError(response, 404);
      return;
    }

    const source = await resolveSource(resolvedRoot, sourcePath, fallback);
    if (source.error) {
      sendError(response, source.error);
      return;
    }

    const representation = await encodedFile(source.filePath, request.headers["accept-encoding"]);
    const filePath = representation?.filePath || source.filePath;
    const fileStat = representation?.fileStat || source.fileStat;
    const variesByEncoding = Boolean(representation) || (await hasEncodedFile(source.filePath));
    const etag = `W/"${fileStat.size.toString(16)}-${Math.trunc(fileStat.mtimeMs).toString(16)}"`;
    const headers = {
      "Cache-Control": cacheControl(sourcePath, source.filePath),
      "Content-Length": String(fileStat.size),
      "Content-Type":
        MIME_TYPES[path.extname(source.filePath).toLowerCase()] || "application/octet-stream",
      ETag: etag,
      "Last-Modified": new Date(source.fileStat.mtimeMs).toUTCString(),
      "X-Content-Type-Options": "nosniff",
    };

    if (representation) headers["Content-Encoding"] = representation.encoding;
    if (variesByEncoding) headers.Vary = "Accept-Encoding";

    if (request.headers["if-none-match"] === etag) {
      response.writeHead(304, headers);
      response.end();
      return;
    }

    response.writeHead(200, headers);
    if (request.method === "HEAD") {
      response.end();
      return;
    }

    try {
      await pipeline(createReadStream(filePath), response);
    } catch (error) {
      if (!response.headersSent) sendError(response, 500);
      else response.destroy(error);
    }
  });
}

export async function listen(server, { host, port }) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return server.address();
}
