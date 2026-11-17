/**
 * Telegram Webhook Forwarder for Cloudflare Workers
 * 
 * Accepts HTTP POST requests from n8n and forwards messages to a Telegram chat.
 * Ignores any incoming messages from the chat itself.
 * Authenticates senders via a special token in the Authorization header.
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Only allow POST to /message endpoint
    if (request.method !== 'POST' || url.pathname !== '/message') {
      return jsonResponse(405, { error: 'Method not allowed or invalid path. Use POST /message' });
    }

    // --- Authentication ---
    const authHeader = request.headers.get('Authorization');
    if (!authHeader) {
      return jsonResponse(401, { error: 'Missing Authorization header' });
    }

    // Expecting "Bearer <token>" format
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    
    if (!env.SENDER_TOKEN) {
      return jsonResponse(500, { error: 'Server configuration error: SENDER_TOKEN not set' });
    }

    if (token !== env.SENDER_TOKEN) {
      return jsonResponse(403, { error: 'Forbidden: Invalid token' });
    }

    // --- Parse Body ---
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse(400, { error: 'Invalid JSON body' });
    }

    const text = body.text;
    const chatId = body.chat_id || env.DEFAULT_CHAT_ID;

    if (!text) {
      return jsonResponse(400, { error: 'Missing required field: text' });
    }

    if (!chatId) {
      return jsonResponse(400, { error: 'Missing chat_id in body and DEFAULT_CHAT_ID is not configured' });
    }

    // --- Send to Telegram ---
    if (!env.BOT_TOKEN) {
      return jsonResponse(500, { error: 'Server configuration error: BOT_TOKEN not set' });
    }

    const telegramApiUrl = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`;
    
    const tgPayload = {
      chat_id: chatId,
      text: text,
      parse_mode: body.parse_mode || 'HTML',
      disable_web_page_preview: true,
    };

    try {
      const tgResponse = await fetch(telegramApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(tgPayload),
      });

      const tgData = await tgResponse.json();

      if (!tgData.ok) {
        console.error('Telegram API Error:', tgData);
        return jsonResponse(502, { 
          error: 'Failed to send message to Telegram', 
          details: tgData.description 
        });
      }

      return jsonResponse(200, { ok: true, message_id: tgData.result.message_id });

    } catch (err) {
      console.error('Fetch Error:', err);
      return jsonResponse(500, { error: 'Internal server error while contacting Telegram' });
    }
  },
};

/**
 * Helper function to create consistent JSON responses
 */
function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
