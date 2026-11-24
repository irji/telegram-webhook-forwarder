/**
 * Minimal MCP (Model Context Protocol) server over the Streamable HTTP transport.
 *
 * Implements JSON-RPC 2.0 directly on the Worker (no SDK needed — Cloudflare
 * Workers can't run stdio-based MCP servers). Supported methods:
 *   - initialize
 *   - notifications/initialized (notification -> no response)
 *   - ping
 *   - tools/list      -> exposes the "send_message" tool
 *   - tools/call      -> executes "send_message"
 *
 * send_message(text): converts light markdown to Telegram-safe HTML and
 * forwards it to Telegram as JSON:
 *   { "text": <converted text>, "parse_mode": "HTML" }
 */

const PROTOCOL_VERSION = '2025-03-26';
const SERVER_INFO = { name: 'telegram-webhook-forwarder', version: '1.0.0' };

/**
 * Convert lightweight markdown to Telegram-safe HTML.
 *
 * The message is sent with parse_mode: "HTML", which — unlike MarkdownV2 —
 * cannot be broken by ordinary text: only "&", "<" and ">" are special, and
 * they are escaped below. On top of that a small markdown subset is
 * translated into HTML entities:
 *
 *   *bold*  _italic_  ~strikethrough~  ||spoiler||
 *   `inline code`  ```code block```  [text](https://example.com)
 *
 * A backslash escapes the next markup character (\* \_ \` \~ \| \[ \] \\),
 * making it render literally. Everything else renders exactly as typed.
 */
const PUA = '\uE000'; // private-use marker; stripped from input so it can never collide

export function markdownToTelegramHtml(text) {
  const stash = [];
  const protect = (html) => PUA + (stash.push(html) - 1) + PUA;
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  let s = String(text).replace(/\uE000/g, '');

  // Code spans first: no markup is interpreted inside them.
  s = s.replace(/```([\s\S]+?)```/g, (_, c) =>
    protect(`<pre>${esc(c.replace(/^\n/, '').replace(/\n$/, ''))}</pre>`)
  );
  s = s.replace(/`([^`\n]+)`/g, (_, c) => protect(`<code>${esc(c)}</code>`));

  // Escape everything the HTML parser cares about. After this step the
  // remaining text is safe no matter what it contains.
  s = esc(s);

  // Backslash-escaped markup characters become literal characters.
  s = s.replace(/\\([\\_*~`|[\]()])/g, (_, ch) => protect(ch));

  // Markdown subset -> Telegram HTML entities.
  // Links: protect the <a> tag so later passes can't rewrite the URL.
  s = s.replace(/\[([^\]\n]+)\]\(([^()\s]+)\)/g, (m, label, url) => {
    if (!/^(https?:\/\/|tg:\/\/)/i.test(url)) return m; // unknown/unsafe scheme -> stay literal
    return protect(`<a href="${url.replace(/"/g, '%22')}">`) + label + protect('</a>');
  });
  s = s.replace(/\|\|([^|\n]+)\|\|/g, '<tg-spoiler>$1</tg-spoiler>');
  s = s.replace(/\*([^*\n]+)\*/g, '<b>$1</b>');
  s = s.replace(/_([^_\n]+)_/g, '<i>$1</i>');
  s = s.replace(/~{1,2}([^~\n]+)~{1,2}/g, '<s>$1</s>');

  // Restore stashed fragments (code spans, literal characters, link tags).
  return s.replace(/\uE000(\d+)\uE000/g, (_, i) => stash[+i]);
}

const TOOLS = [
  {
    name: 'send_message',
    description:
      'Send a text message to the configured Telegram chat. Light markdown is rendered: ' +
      '*bold*, _italic_, ~strikethrough~, ||spoiler||, `inline code`, ```code blocks``` and [text](https://example.com) links. ' +
      'Everything else is sent literally as typed; to show a markup character, escape it with a backslash (\\* \\_ \\` \\|).',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description:
            'Message text. Supports *bold*, _italic_, ~strikethrough~, ||spoiler||, `code`, ' +
            '[text](url) links and ```code blocks```. Prefix a markup character with a backslash to send it literally.',
        },
      },
      required: ['text'],
    },
  },
];

export async function handleMcp(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (request.method !== 'POST') {
    return new Response(
      'MCP endpoint expects POST (JSON-RPC 2.0). Try method "initialize" or "tools/list".\n',
      { status: 200, headers: { ...corsHeaders(), 'Content-Type': 'text/plain; charset=utf-8' } }
    );
  }

  let msg;
  try {
    msg = await request.json();
  } catch (e) {
    return new Response(
      JSON.stringify(rpcError(null, -32700, 'Parse error: invalid JSON')),
      { status: 200, headers: { ...corsHeaders(), 'Content-Type': 'application/json; charset=utf-8' } }
    );
  }

  // Batch requests are allowed by JSON-RPC — handle arrays too.
  if (Array.isArray(msg)) {
    const responses = [];
    for (const m of msg) {
      const res = await processMessage(m, env);
      if (res) responses.push(res);
    }
    return new Response(JSON.stringify(responses), {
      status: 200,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  const result = await processMessage(msg, env);

  // Notifications get no response body (HTTP 202 Accepted).
  if (!result) {
    return new Response(null, { status: 202, headers: corsHeaders() });
  }

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json; charset=utf-8' },
  });
}

async function processMessage(msg, env) {
  const id = msg && msg.id !== undefined ? msg.id : null;
  const method = msg && msg.method;

  if (!method) {
    // Probably a response from a client — nothing to do.
    return null;
  }

  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });

    case 'notifications/initialized':
    case 'initialized':
      return null; // notification, no reply

    case 'ping':
      return rpcResult(id, {});

    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });

    case 'tools/call':
      return handleToolCall(id, msg.params || {}, env);

    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

async function handleToolCall(id, params, env) {
  const toolName = params.name;
  const args = params.arguments || {};

  if (toolName !== 'send_message') {
    return rpcResult(id, toolTextError(`Unknown tool: ${toolName}. Available tools: send_message`));
  }

  const text = args.text;
  if (typeof text !== 'string' || text.length === 0) {
    return rpcResult(id, toolTextError('Missing required argument: text (non-empty string)'));
  }

  const chatId = args.chat_id || env.DEFAULT_CHAT_ID;
  if (!chatId) {
    return rpcResult(id, toolTextError('chat_id is not provided and DEFAULT_CHAT_ID is not configured'));
  }

  if (!env.BOT_TOKEN) {
    return rpcResult(id, toolTextError('Server configuration error: BOT_TOKEN secret is not set'));
  }

  // Light markdown is converted to Telegram-safe HTML. parse_mode "HTML"
  // cannot be broken by ordinary text (only & < > are special and they are
  // escaped), so plain text always renders exactly as typed.
  const tgPayload = {
    text: markdownToTelegramHtml(text),
    parse_mode: 'HTML',
    chat_id: chatId,
    disable_web_page_preview: true,
  };

  try {
    const tgResponse = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tgPayload),
    });

    const tgData = await tgResponse.json().catch(() => null);

    if (!tgData || !tgData.ok) {
      const desc = tgData ? tgData.description : `Non-JSON response (HTTP ${tgResponse.status})`;
      return rpcResult(id, toolTextError(`Telegram API error: ${desc}`));
    }

    return rpcResult(id, {
      content: [
        {
          type: 'text',
          text: `Message sent successfully. message_id=${tgData.result.message_id}`,
        },
      ],
      isError: false,
    });
  } catch (err) {
    return rpcResult(id, toolTextError(`Failed to contact Telegram: ${String(err && err.message ? err.message : err)}`));
  }
}

function toolTextError(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Auth-Token, MCP-Session-Id, MCP-Protocol-Version',
    'Access-Control-Max-Age': '86400',
  };
}
