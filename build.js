#!/usr/bin/env node

import * as esbuild from "esbuild";
import { brotliCompress, constants, gzip } from "node:zlib";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { normalizeBasePath } from "./src/utils/app-url.js";

const root = import.meta.dirname;
const distDir = path.resolve(process.env.BUILD_OUTDIR || path.join(root, "dist"));
const assetsDir = path.join(distDir, "assets");
const publicDir = path.join(root, "public");
const splitting = process.env.BUILD_SPLITTING === "true";
const githubPages = process.env.GITHUB_PAGES === "true";
const precompressEnabled = process.env.BUILD_PRECOMPRESS !== "false";
const writeFallback = githubPages || process.env.BUILD_404 === "true";
const compressibleExtensions = new Set([".css", ".html", ".js", ".json", ".mjs", ".svg"]);
const brotliCompressAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);
const packageData = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

function deploymentBasePath() {
  if (process.env.BASE_PATH) return normalizeBasePath(process.env.BASE_PATH);
  if (!githubPages) return "/";

  const repositoryName = process.env.GITHUB_REPOSITORY?.split("/").at(-1);
  if (!repositoryName || repositoryName.endsWith(".github.io")) return "/";
  return normalizeBasePath(repositoryName);
}

const basePath = deploymentBasePath();

function repositoryURL(repository) {
  const value = typeof repository === "string" ? repository : repository?.url;
  return String(value || "")
    .replace(/^git\+/, "")
    .replace(/\.git$/, "");
}

function repositoryLabel(url) {
  try {
    return new URL(url).pathname.replace(/^\//, "");
  } catch {
    return "source";
  }
}

function outputForEntry(metafile, entryPoint, suffix) {
  for (const [file, output] of Object.entries(metafile.outputs)) {
    if (output.entryPoint === entryPoint && file.endsWith(suffix)) {
      const relativePath = path.relative(distDir, path.join(root, file)).split(path.sep).join("/");
      return `${basePath}${relativePath}`;
    }
  }
  throw new Error(`Build output not found for ${entryPoint}`);
}

function stripDevImportMap(html) {
  return html.replace(
    /\s*(?:<!--[\s\S]*?-->\s*)?<script\s+type="importmap">[\s\S]*?<\/script>\n?/,
    "\n",
  );
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const entryPath = path.join(directory, entry.name);
      return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
    }),
  );
  return files.flat();
}

async function precompress(directory) {
  const files = await listFiles(directory);
  const candidates = files.filter(
    (file) => compressibleExtensions.has(path.extname(file)) && !file.endsWith("meta.json"),
  );

  await Promise.all(
    candidates.map(async (file) => {
      const contents = await readFile(file);
      if (contents.byteLength < 1_024) return;

      const [brotli, gzipped] = await Promise.all([
        brotliCompressAsync(contents, {
          params: {
            [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
            [constants.BROTLI_PARAM_QUALITY]: 11,
          },
        }),
        gzipAsync(contents, { level: 9 }),
      ]);
      await Promise.all([writeFile(`${file}.br`, brotli), writeFile(`${file}.gz`, gzipped)]);
    }),
  );
}

await rm(distDir, { recursive: true, force: true });
await mkdir(assetsDir, { recursive: true });

const result = await esbuild.build({
  entryPoints: {
    app: path.join(root, "src/main.js"),
    styles: path.join(root, "src/styles.css"),
  },
  outdir: assetsDir,
  bundle: true,
  splitting,
  format: "esm",
  platform: "browser",
  target: ["es2024"],
  conditions: ["browser", "import", "default"],
  mainFields: ["browser", "module", "main"],
  entryNames: "[name]-[hash]",
  chunkNames: "chunks/[name]-[hash]",
  assetNames: "assets/[name]-[hash]",
  minify: true,
  treeShaking: true,
  legalComments: "none",
  metafile: true,
  logLevel: "info",
});

await cp(path.join(publicDir, "img"), path.join(distDir, "img"), {
  recursive: true,
});

const appPath = outputForEntry(result.metafile, "src/main.js", ".js");
const stylesPath = outputForEntry(result.metafile, "src/styles.css", ".css");

const sourceHtml = await readFile(path.join(publicDir, "index.html"), "utf8");
const sourceURL = process.env.SOURCE_URL || repositoryURL(packageData.repository);
const html = stripDevImportMap(sourceHtml)
  .replace('<base href="/" />', `<base href="${basePath}" />`)
  .replace('href="src/styles.css"', `href="${stylesPath}"`)
  .replace('src="src/main.js"', `src="${appPath}"`)
  .replace(
    /(<span data-app-version>)[^<]*(<\/span>)/,
    (_match, before, after) => `${before}${packageData.version}${after}`,
  )
  .replace(
    /(<a data-source-link href=")[^"]*("[^>]*>)[^<]*(<\/a>)/,
    (_match, before, middle, after) =>
      `${before}${sourceURL}${middle}${repositoryLabel(sourceURL)}${after}`,
  );

await writeFile(path.join(distDir, "index.html"), html);
if (writeFallback) await writeFile(path.join(distDir, "404.html"), html);
await writeFile(path.join(distDir, ".nojekyll"), "");
await writeFile(
  path.join(distDir, "meta.json"),
  JSON.stringify({ ...result.metafile, vanillaHN: { basePath } }, null, 2),
);
if (precompressEnabled) await precompress(distDir);

console.log(`Built ${path.relative(root, distDir)}/`);
console.log(`  bundling: ${splitting ? "split" : "single"}`);
console.log(`  base path: ${basePath}`);
console.log(`  precompression: ${precompressEnabled ? "brotli + gzip" : "disabled"}`);
console.log(`  route fallback: ${writeFallback ? "404.html" : "disabled"}`);
console.log(`  ${stylesPath}`);
console.log(`  ${appPath}`);
