import { chromium } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createStaticServer, listen } from "./lib/static-server.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "dist");
const outputDir = path.join(root, "artifacts");
const samples = Math.max(1, Number(process.env.BENCHMARK_SAMPLES) || 3);
const port = Number(process.env.BENCHMARK_PORT) || 5010;
const vanillaURL = process.env.VANILLA_HN_URL || `http://127.0.0.1:${port}/`;
const reactURL = process.env.REACT_HN_URL || "https://insin.github.io/react-hn/";

const metricKeys = [
  "domContentLoadedMs",
  "loadMs",
  "firstContentfulPaintMs",
  "largestContentfulPaintMs",
  "requests",
  "firstPartyRequests",
  "thirdPartyRequests",
  "transferBytes",
  "firstPartyTransferBytes",
  "thirdPartyTransferBytes",
  "jsHeapBytes",
];

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarize(runs) {
  return Object.fromEntries(
    metricKeys.map((key) => [key, Math.round(median(runs.map((run) => run[key])))]),
  );
}

function responseHeader(headers, name) {
  const key = Object.keys(headers || {}).find((header) => header.toLowerCase() === name);
  return key ? headers[key] : "";
}

function displayURL(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value;
  }
}

function webSocketPayloadBytes(frame) {
  if (frame.opcode !== 2) return Buffer.byteLength(frame.payloadData);
  const padding = frame.payloadData.endsWith("==") ? 2 : frame.payloadData.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((frame.payloadData.length * 3) / 4) - padding);
}

function representativeRun(runs, transferBytes) {
  return runs.reduce((closest, run) =>
    Math.abs(run.transferBytes - transferBytes) < Math.abs(closest.transferBytes - transferBytes)
      ? run
      : closest,
  );
}

async function startDistServer() {
  if (process.env.VANILLA_HN_URL) return null;
  await execFileAsync(process.execPath, [path.join(root, "build.js")], { cwd: root });
  const server = createStaticServer({ root: dist });
  await listen(server, { host: "127.0.0.1", port });
  return server;
}

async function measure(browser, url) {
  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  const targetOrigin = new URL(url).origin;
  const resources = new Map();

  await session.send("Network.enable");
  await session.send("Performance.enable");
  session.on("Network.requestWillBeSent", ({ requestId, request, type }) => {
    if (request.url.startsWith("data:")) return;
    resources.set(requestId, {
      url: displayURL(request.url),
      type: type || "Other",
      firstParty: new URL(request.url).origin === targetOrigin,
      status: 0,
      mimeType: "",
      contentEncoding: "identity",
      protocol: "",
      transferBytes: 0,
      sentBytes: 0,
    });
  });
  session.on("Network.responseReceived", ({ requestId, response }) => {
    const resource = resources.get(requestId);
    if (!resource) return;
    resource.status = response.status;
    resource.mimeType = response.mimeType;
    resource.contentEncoding = responseHeader(response.headers, "content-encoding") || "identity";
    resource.protocol = response.protocol;
  });
  session.on("Network.loadingFinished", ({ requestId, encodedDataLength }) => {
    const resource = resources.get(requestId);
    if (resource) resource.transferBytes = encodedDataLength;
  });
  session.on("Network.webSocketCreated", ({ requestId, url: socketURL }) => {
    resources.set(requestId, {
      url: displayURL(socketURL),
      type: "WebSocket",
      firstParty: new URL(socketURL).origin === targetOrigin,
      status: 0,
      mimeType: "application/websocket",
      contentEncoding: "identity",
      protocol: "websocket",
      transferBytes: 0,
      sentBytes: 0,
    });
  });
  session.on("Network.webSocketHandshakeResponseReceived", ({ requestId, response }) => {
    const resource = resources.get(requestId);
    if (!resource) return;
    resource.status = response.status;
    resource.transferBytes += Buffer.byteLength(response.headersText || "");
  });
  session.on("Network.webSocketFrameReceived", ({ requestId, response }) => {
    const resource = resources.get(requestId);
    if (resource) resource.transferBytes += webSocketPayloadBytes(response);
  });
  session.on("Network.webSocketFrameSent", ({ requestId, response }) => {
    const resource = resources.get(requestId);
    if (resource) resource.sentBytes += webSocketPayloadBytes(response);
  });
  await page.addInitScript(() => {
    globalThis.__benchmarkLCP = 0;
    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      globalThis.__benchmarkLCP = entries.at(-1)?.startTime || globalThis.__benchmarkLCP;
    }).observe({ type: "largest-contentful-paint", buffered: true });
  });

  await page.goto(url, { waitUntil: "load", timeout: 60_000 });
  // Use a fixed observation window because both apps intentionally keep
  // realtime Firebase connections open and never become truly network-idle.
  await page.waitForTimeout(1_500);

  const timing = await page.evaluate(() => {
    const navigation = performance.getEntriesByType("navigation")[0];
    const paint = Object.fromEntries(
      performance.getEntriesByType("paint").map((entry) => [entry.name, entry.startTime]),
    );
    return {
      domContentLoadedMs: navigation?.domContentLoadedEventEnd || 0,
      loadMs: navigation?.loadEventEnd || 0,
      firstContentfulPaintMs: paint["first-contentful-paint"] || 0,
      largestContentfulPaintMs: globalThis.__benchmarkLCP || 0,
    };
  });
  const performanceMetrics = await session.send("Performance.getMetrics");
  const metricMap = Object.fromEntries(
    performanceMetrics.metrics.map(({ name, value }) => [name, value]),
  );
  const resourceList = [...resources.values()];
  const firstParty = resourceList.filter((resource) => resource.firstParty);
  const thirdParty = resourceList.filter((resource) => !resource.firstParty);
  const totalBytes = (items) =>
    items.reduce((total, resource) => total + resource.transferBytes, 0);

  await context.close();
  return {
    ...timing,
    requests: resourceList.length,
    firstPartyRequests: firstParty.length,
    thirdPartyRequests: thirdParty.length,
    transferBytes: totalBytes(resourceList),
    firstPartyTransferBytes: totalBytes(firstParty),
    thirdPartyTransferBytes: totalBytes(thirdParty),
    jsHeapBytes: metricMap.JSHeapUsedSize || 0,
    resources: resourceList.sort((a, b) => b.transferBytes - a.transferBytes),
  };
}

const server = await startDistServer();
const browser = await chromium.launch();

try {
  const targets = [
    ["vanilla-hn", vanillaURL],
    ["react-hn", reactURL],
  ];
  const report = {
    generatedAt: new Date().toISOString(),
    samples,
    methodology: {
      browser: "Chromium",
      cache: "Cold browser context per run",
      observationWindowMs: 1_500,
      serviceWorkers: "Blocked",
      transferBytes: "Chrome DevTools Protocol encodedDataLength, including headers",
      webSocketBytes: "Received frame payload plus available response handshake headers",
      uploadBytes: "Reported per request but excluded from transfer totals",
      firstParty: "Requests whose origin matches the measured page",
    },
    targets: {},
  };

  for (const [name, url] of targets) {
    const runs = [];
    for (let sample = 0; sample < samples; sample++) runs.push(await measure(browser, url));
    report.targets[name] = { url, median: summarize(runs), runs };
  }

  await mkdir(outputDir, { recursive: true });
  await writeFile(
    path.join(outputDir, "performance-comparison.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );

  const rows = Object.entries(report.targets).map(([name, { median: result }]) => ({
    app: name,
    "app req": result.firstPartyRequests,
    "app KB": (result.firstPartyTransferBytes / 1024).toFixed(1),
    "backend req": result.thirdPartyRequests,
    "backend KB": (result.thirdPartyTransferBytes / 1024).toFixed(1),
    "total req": result.requests,
    "total KB": (result.transferBytes / 1024).toFixed(1),
    "FCP ms": result.firstContentfulPaintMs,
    "LCP ms": result.largestContentfulPaintMs,
    "load ms": result.loadMs,
    "heap MB": (result.jsHeapBytes / 1024 / 1024).toFixed(1),
  }));
  console.table(rows);

  for (const [name, target] of Object.entries(report.targets)) {
    const run = representativeRun(target.runs, target.median.transferBytes);
    console.log(`\n${name} request details (representative cold run):`);
    console.table(
      run.resources.map((resource) => ({
        party: resource.firstParty ? "app" : "backend",
        type: resource.type,
        status: resource.status,
        encoding: resource.contentEncoding,
        "transfer KB": (resource.transferBytes / 1024).toFixed(1),
        "sent KB": (resource.sentBytes / 1024).toFixed(1),
        url: resource.url,
      })),
    );
  }

  const localTargets = [vanillaURL, reactURL].map((url) => {
    const hostname = new URL(url).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost";
  });
  if (localTargets[0] !== localTargets[1]) {
    console.warn(
      "\nTiming warning: one target is local and the other is remote. Transfer sizes remain useful, but use two local or two deployed URLs for comparable timings.",
    );
  }
  console.log("Detailed results: artifacts/performance-comparison.json");
} finally {
  await browser.close();
  if (server) await new Promise((resolve) => server.close(resolve));
}
