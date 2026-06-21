#!/usr/bin/env node

import * as esbuild from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = import.meta.dirname;
const distDir = path.join(root, "dist");
const assetsDir = path.join(distDir, "assets");
const publicDir = path.join(root, "public");

function outputForEntry(metafile, entryPoint, suffix) {
  for (const [file, output] of Object.entries(metafile.outputs)) {
    if (output.entryPoint === entryPoint && file.endsWith(suffix)) {
      return `/${path.relative(distDir, path.join(root, file))}`;
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

await rm(distDir, { recursive: true, force: true });
await mkdir(assetsDir, { recursive: true });

const result = await esbuild.build({
  entryPoints: {
    app: path.join(root, "src/main.js"),
    styles: path.join(root, "src/styles.css"),
  },
  outdir: assetsDir,
  bundle: true,
  splitting: true,
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
const html = stripDevImportMap(sourceHtml)
  .replace('href="/src/styles.css"', `href="${stylesPath}"`)
  .replace('src="/src/main.js"', `src="${appPath}"`);

await writeFile(path.join(distDir, "index.html"), html);
await writeFile(
  path.join(distDir, "meta.json"),
  JSON.stringify(result.metafile, null, 2),
);

console.log(`Built ${path.relative(root, distDir)}/`);
console.log(`  ${stylesPath}`);
console.log(`  ${appPath}`);
