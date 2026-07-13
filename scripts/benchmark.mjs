import { chromium } from "@playwright/test";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "dist");
const outputDir = path.join(root, "artifacts");
const samples = Math.max(1, Number(process.env.BENCHMARK_SAMPLES) || 3);
const port = Number(process.env.BENCHMARK_PORT) || 5010;
const vanillaURL = process.env.VANILLA_HN_URL || `http://127.0.0.1:${port}/`;
const reactURL = process.env.REACT_HN_URL || "https://insin.github.io/react-hn/";

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarize(runs) {
  const keys = Object.keys(runs[0]);
  return Object.fromEntries(
    keys.map((key) => [key, Math.round(median(runs.map((run) => run[key])))]),
  );
}

async function startDistServer() {
  if (process.env.VANILLA_HN_URL) return null;
  await execFileAsync(process.execPath, [path.join(root, "build.js")], { cwd: root });

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", vanillaURL);
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
      let file = path.resolve(dist, relative);
      if (!file.startsWith(`${dist}${path.sep}`)) throw new Error("Invalid path");
      try {
        if (!(await stat(file)).isFile()) file = path.join(dist, "index.html");
      } catch {
        file = path.join(dist, "index.html");
      }
      const body = await readFile(file);
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": mimeTypes[path.extname(file)] || "application/octet-stream",
      });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

async function measure(browser, url) {
  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  let transferBytes = 0;
  let requests = 0;

  await session.send("Network.enable");
  await session.send("Performance.enable");
  session.on("Network.requestWillBeSent", ({ request }) => {
    if (!request.url.startsWith("data:")) requests++;
  });
  session.on("Network.loadingFinished", ({ encodedDataLength }) => {
    transferBytes += encodedDataLength;
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

  await context.close();
  return {
    ...timing,
    requests,
    transferBytes,
    jsHeapBytes: metricMap.JSHeapUsedSize || 0,
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
    requests: result.requests,
    "transfer KB": (result.transferBytes / 1024).toFixed(1),
    "FCP ms": result.firstContentfulPaintMs,
    "LCP ms": result.largestContentfulPaintMs,
    "load ms": result.loadMs,
    "heap MB": (result.jsHeapBytes / 1024 / 1024).toFixed(1),
  }));
  console.table(rows);
  console.log("Detailed results: artifacts/performance-comparison.json");
} finally {
  await browser.close();
  if (server) await new Promise((resolve) => server.close(resolve));
}
