import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");

test("GitHub Pages builds use a project base path and emit a route fallback", async (context) => {
  const output = await mkdtemp(path.join(os.tmpdir(), "vanilla-hn-pages-"));
  context.after(() => rm(output, { recursive: true, force: true }));

  await execFileAsync(process.execPath, [path.join(root, "build.js")], {
    cwd: root,
    env: {
      ...process.env,
      BUILD_OUTDIR: output,
      BUILD_PRECOMPRESS: "false",
      GITHUB_PAGES: "true",
      GITHUB_REPOSITORY: "asuh/vanilla-hn",
    },
  });

  const [index, fallback, metadata, files] = await Promise.all([
    readFile(path.join(output, "index.html"), "utf8"),
    readFile(path.join(output, "404.html"), "utf8"),
    readFile(path.join(output, "meta.json"), "utf8").then(JSON.parse),
    readdir(output, { recursive: true }),
  ]);

  assert.equal(fallback, index);
  assert.match(index, /<base href="\/vanilla-hn\/" \/>/);
  assert.match(index, /href="\/vanilla-hn\/assets\/styles-[^"]+\.css"/);
  assert.match(index, /src="\/vanilla-hn\/assets\/app-[^"]+\.js"/);
  assert.equal(metadata.vanillaHN.basePath, "/vanilla-hn/");
  assert.equal(
    files.some((file) => file.endsWith(".br") || file.endsWith(".gz")),
    false,
  );
});
