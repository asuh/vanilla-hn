import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { createStaticServer, listen } from "../scripts/lib/static-server.mjs";

function request(port, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: urlPath, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        resolve({
          body: Buffer.concat(chunks),
          headers: response.headers,
          status: response.statusCode,
        });
      });
    });
    req.on("error", reject);
  });
}

test("production server negotiates compression and applies cache policies", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vanilla-hn-server-"));
  const assets = path.join(directory, "assets");
  const index = Buffer.from("<!doctype html><main>Vanilla HN</main>");
  const script = Buffer.from("console.log('production');");

  await mkdir(assets);
  await Promise.all([
    writeFile(path.join(directory, "index.html"), index),
    writeFile(path.join(directory, "index.html.br"), brotliCompressSync(index)),
    writeFile(path.join(assets, "app-ABCDEFGH.js"), script),
    writeFile(path.join(assets, "app-ABCDEFGH.js.br"), brotliCompressSync(script)),
    writeFile(path.join(assets, "app-ABCDEFGH.js.gz"), gzipSync(script)),
  ]);

  const server = createStaticServer({ root: directory });
  const address = await listen(server, { host: "127.0.0.1", port: 0 });
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  const compressedHtml = await request(address.port, "/deep/link", {
    "Accept-Encoding": "br, gzip",
  });
  assert.equal(compressedHtml.status, 200);
  assert.equal(compressedHtml.headers["content-encoding"], "br");
  assert.equal(compressedHtml.headers["cache-control"], "no-cache");
  assert.equal(compressedHtml.headers.vary, "Accept-Encoding");
  assert.deepEqual(compressedHtml.body, brotliCompressSync(index));

  const compressedScript = await request(address.port, "/assets/app-ABCDEFGH.js", {
    "Accept-Encoding": "br;q=0.2, gzip",
  });
  assert.equal(compressedScript.headers["content-encoding"], "gzip");
  assert.equal(compressedScript.headers["cache-control"], "public, max-age=31536000, immutable");

  const identityScript = await request(address.port, "/assets/app-ABCDEFGH.js");
  assert.equal(identityScript.headers["content-encoding"], undefined);
  assert.equal(identityScript.headers.vary, "Accept-Encoding");
  assert.deepEqual(identityScript.body, script);

  const cached = await request(address.port, "/assets/app-ABCDEFGH.js", {
    "If-None-Match": identityScript.headers.etag,
  });
  assert.equal(cached.status, 304);
  assert.equal(cached.body.byteLength, 0);
});

test("production server scopes files and SPA routes to a deployment base path", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vanilla-hn-base-path-"));
  const assets = path.join(directory, "assets");
  await mkdir(assets);
  await Promise.all([
    writeFile(path.join(directory, "index.html"), "<!doctype html><main>Project site</main>"),
    writeFile(path.join(assets, "app-ABCDEFGH.js"), "console.log('project site');"),
  ]);

  const server = createStaticServer({ root: directory, basePath: "/vanilla-hn/" });
  const address = await listen(server, { host: "127.0.0.1", port: 0 });
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  const home = await request(address.port, "/vanilla-hn/");
  const deepLink = await request(address.port, "/vanilla-hn/story/33");
  const asset = await request(address.port, "/vanilla-hn/assets/app-ABCDEFGH.js");
  const outside = await request(address.port, "/story/33");

  assert.equal(home.status, 200);
  assert.equal(deepLink.status, 200);
  assert.equal(asset.status, 200);
  assert.equal(asset.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal(outside.status, 404);
});
