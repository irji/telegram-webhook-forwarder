/**
 * Node.js entry point for running the same worker code outside Cloudflare —
 * primarily for Google Cloud Run (see deploy-gcp.sh), but it also works for
 * plain local hosting (`npm start`).
 *
 * All business logic lives in src/index.js and only uses web-standard APIs
 * (Request / Response / URL / fetch), so a thin HTTP adapter is all that's
 * needed to serve it from Node.
 *
 * Configuration (environment variables, same names as on Cloudflare):
 *   BOT_TOKEN        (required)  Telegram bot token
 *   SENDER_TOKEN     (required)  shared secret for /message and /mcp
 *   DEFAULT_CHAT_ID  (optional)  fallback chat id
 *   PORT             (optional)  HTTP port, default 8080 (Cloud Run sets it)
 */

import http from 'node:http';
import worker from './src/index.js';

const PORT = Number(process.env.PORT) || 8080;
const HOST = '0.0.0.0';

// src/index.js reads configuration from the `env` object — on Node that's
// simply process.env (same variable names as the Cloudflare secrets/vars).
const env = process.env;

// Minimal stand-in for the Cloudflare execution context.
const ctx = {
  waitUntil(promise) {
    Promise.resolve(promise).catch((e) => console.error('waitUntil error:', e));
  },
  passThroughOnException() {},
};

// Hop-by-hop headers that must not be forwarded into the Request constructor.
const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
]);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

    const headers = new Headers();
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i];
      if (!HOP_BY_HOP.has(name.toLowerCase())) {
        headers.append(name, req.rawHeaders[i + 1]);
      }
    }

    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      if (chunks.length > 0) body = Buffer.concat(chunks);
    }

    const response = await worker.fetch(new Request(url, { method: req.method, headers, body }), env, ctx);

    const responseHeaders = {};
    response.headers.forEach((value, name) => {
      responseHeaders[name] = value;
    });
    res.writeHead(response.status, responseHeaders);

    if (response.body) {
      res.end(Buffer.from(await response.arrayBuffer()));
    } else {
      res.end();
    }
  } catch (err) {
    console.error('Unhandled error:', err && err.stack ? err.stack : String(err));
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    }
    res.end(JSON.stringify({ error: 'Internal error', details: String(err && err.message ? err.message : err) }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`telegram-webhook-forwarder (Node adapter) listening on http://${HOST}:${PORT}`);
});
