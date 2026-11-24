/**
 * Telegram Webhook Forwarder for Cloudflare Workers
 *
 * Accepts HTTP POST requests from n8n and forwards messages to a Telegram chat.
 * Does NOT receive anything from Telegram (no webhook set on the bot),
 * so replies from the chat are ignored by design.
 * Authenticates senders via a special token header.
 *
 * Secrets (env): BOT_TOKEN, SENDER_TOKEN  (set via `wrangler secret put`)
 * Optional vars: DEFAULT_CHAT_ID          (set in wrangler.toml [vars])
 *
 * Endpoints:
 *   POST /message  -> HTTP forwarder (n8n), authenticated with SENDER_TOKEN
 *   ANY  /mcp      -> MCP server (JSON-RPC 2.0, Streamable HTTP), tool: send_message
 *   GET  / or /health -> health-check
 */

import { handleMcp } from './mcp.js';

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      // --- MCP server endpoint (Streamable HTTP transport) ---
      // Authenticated the same way as /message: SENDER_TOKEN required,
      // so random strangers can't call the MCP tools either.
      if (url.pathname === '/mcp' || url.pathname === '/mcp/') {
        if (!checkToken(request, env)) {
          return jsonResponse(401, {
            error: 'Unauthorized. Send header "Authorization: Bearer <SENDER_TOKEN>" or "X-Auth-Token: <SENDER_TOKEN>"',
          });
        }
        return await handleMcp(request, env);
      }

      return await handleRequest(request, env);
    } catch (err) {
      // Last-resort handler: never let an uncaught exception escape,
      // otherwise Cloudflare returns "Bad gateway".
      console.error('Unhandled error:', err && err.stack ? err.stack : String(err));
      return jsonResponse(500, {
        error: 'Internal error',
        details: err && err.message ? String(err.message) : String(err),
      });
    }
  },
};

async function handleRequest(request, env) {
  const url = new URL(request.url);

  // Health-check: GET / or GET /health
  if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
    return new Response('telegram-webhook-forwarder is running. Use POST /message\n', {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Auth-Token',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  // Only POST /message is the real endpoint
  if (request.method !== 'POST' || url.pathname !== '/message') {
    return jsonResponse(405, { error: 'Method not allowed or invalid path. Use POST /message' });
  }

  // --- Authentication ---
  // Token may come from "Authorization: Bearer <token>" OR "X-Auth-Token: <token>"
  if (!checkToken(request, env)) {
    return jsonResponse(401, {
      error: 'Missing or invalid token. Send header "Authorization: Bearer <SENDER_TOKEN>" or "X-Auth-Token: <SENDER_TOKEN>"',
    });
  }

  // --- Parse Body ---
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse(400, { error: 'Invalid JSON body. Content-Type must be application/json' });
  }

  const text = body.text;
  const chatId = body.chat_id || env.DEFAULT_CHAT_ID;

  if (!text) {
    return jsonResponse(400, { error: 'Missing required field: text' });
  }

  if (!chatId) {
    return jsonResponse(400, {
      error: 'Missing chat_id in body and DEFAULT_CHAT_ID is not configured',
    });
  }

  // --- Send to Telegram ---
  if (!env.BOT_TOKEN) {
    return jsonResponse(500, {
      error: 'Server configuration error: BOT_TOKEN secret is not set. Run: npx wrangler secret put BOT_TOKEN',
    });
  }

  const telegramApiUrl = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`;

  const tgPayload = {
    chat_id: chatId,
    text: String(text),
    disable_web_page_preview: true,
  };

  // parse_mode only if explicitly requested ("HTML" or "MarkdownV2").
  // Default: no parse_mode -> raw text, no escaping issues with <>_& symbols.
  if (body.parse_mode === 'HTML' || body.parse_mode === 'Markdown' || body.parse_mode === 'MarkdownV2') {
    tgPayload.parse_mode = body.parse_mode;
  }

  try {
    const tgResponse = await fetch(telegramApiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tgPayload),
    });

    const tgData = await tgResponse.json().catch(() => null);

    if (!tgData || !tgData.ok) {
      console.error('Telegram API Error:', tgData);
      return jsonResponse(502, {
        error: 'Failed to send message to Telegram',
        details: tgData ? tgData.description : 'Non-JSON response from Telegram API (HTTP ' + tgResponse.status + ')',
      });
    }

    return jsonResponse(200, { ok: true, message_id: tgData.result.message_id });
  } catch (err) {
    console.error('Fetch to Telegram failed:', err);
    return jsonResponse(500, {
      error: 'Internal server error while contacting Telegram',
      details: String(err && err.message ? err.message : err),
    });
  }
}

/**
 * Shared token check for /message and /mcp.
 * Returns true when the request carries a valid SENDER_TOKEN.
 */
function checkToken(request, env) {
  const authHeader = request.headers.get('Authorization');
  const xToken = request.headers.get('X-Auth-Token');

  let token = '';
  if (authHeader) {
    token = authHeader.replace(/^Bearer\s+/i, '').trim();
  } else if (xToken) {
    token = xToken.trim();
  }

  return Boolean(token) && token === env.SENDER_TOKEN;
}

/**
 * Helper function to create consistent JSON responses
 */
function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
