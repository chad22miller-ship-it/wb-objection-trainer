// Local dev API server — runs the Vercel functions on port 3001.
// Vite (port 5173) proxies /api to this. Only used for `npm run dev`; production uses Vercel.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env so process.env has GEMINI_API_KEY etc.
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

const { default: chatHandler } = await import('./api/chat.js');
const { default: chatStreamHandler } = await import('./api/chat-stream.js');
const { default: adminHandler } = await import('./api/admin.js');
const { default: statsHandler } = await import('./api/stats.js');

const handlers = {
  '/api/chat-stream': chatStreamHandler,
  '/api/chat': chatHandler,
  '/api/admin': adminHandler,
  '/api/stats': statsHandler,
};

const PORT = 3001;
http
  .createServer(async (req, res) => {
    const route = Object.keys(handlers).find((r) => req.url.startsWith(r));
    if (!route) {
      res.writeHead(404).end('Not found');
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        req.body = body ? JSON.parse(body) : {};
      } catch {
        req.body = {};
      }
      const vercelRes = {
        status(code) {
          res.statusCode = code;
          return vercelRes;
        },
        json(data) {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(data));
          return vercelRes;
        },
        // --- streaming passthrough (used by /api/chat-stream) ---
        setHeader(k, v) { res.setHeader(k, v); return vercelRes; },
        flushHeaders() { if (res.flushHeaders) res.flushHeaders(); return vercelRes; },
        write(chunk) { return res.write(chunk); },
        end(chunk) { res.end(chunk); return vercelRes; },
      };
      try {
        await handlers[route](req, vercelRes);
      } catch (err) {
        console.error(err);
        if (!res.writableEnded) res.writeHead(500).end('Internal error');
      }
    });
  })
  .listen(PORT, () => console.log(`Local API ready on http://localhost:${PORT}`));
