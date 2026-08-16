import { stat } from "node:fs/promises";
import path from "node:path";
import { createStaticServer, listen } from "./lib/static-server.mjs";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "dist");
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT) || 5002;

try {
  if (!(await stat(path.join(dist, "index.html"))).isFile()) throw new Error();
} catch {
  console.error("Missing dist/index.html. Run `npm run build` before previewing.");
  process.exit(1);
}

const server = createStaticServer({ root: dist });
await listen(server, { host, port });

console.log(`Production preview: http://${host}:${port}`);

function close() {
  server.close(() => process.exit(0));
}

process.once("SIGINT", close);
process.once("SIGTERM", close);
