#!/usr/bin/env node
/**
 * serve.js — zero-dependency dev server for vanilla-hn
 *
 * Serves the contents of ./public on http://localhost:PORT
 * with correct MIME types so ES modules load properly.
 *
 * Usage:
 *   node serve.js           # serves on port 5001
 *   PORT=3000 node serve.js # serves on port 3000
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 5001;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.txt':  'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
  // strip query string
  const urlPath = req.url.split('?')[0];

  // resolve to a file path under ROOT
  let filePath = path.join(ROOT, urlPath);

  // if it's a directory, serve index.html inside it
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  // if path has no extension, try appending .html
  if (!path.extname(filePath) && !fs.existsSync(filePath)) {
    filePath = filePath + '.html';
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end(`404 Not Found: ${urlPath}`);
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`500 Server Error: ${err.message}`);
      }
      return;
    }

    res.writeHead(200, {
      'Content-Type': contentType,
      // disable caching during development
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`vanilla-hn dev server running at http://localhost:${PORT}/`);
  console.log(`Serving files from: ${ROOT}`);
  console.log('Press Ctrl+C to stop.\n');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Error: port ${PORT} is already in use.`);
    console.error(`Try a different port: PORT=3000 node serve.js`);
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});
