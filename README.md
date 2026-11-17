
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/irji/SimpleBot)

# Telegram Webhook Forwarder (Cloudflare Worker)

This project is a simple Cloudflare Worker that acts as a bridge between your application (e.g., n8n) and Telegram. It receives HTTP POST requests with a message and forwards them to a specified Telegram chat using a bot.

## Features

- **Secure**: Uses two tokens:
  - `BOT_TOKEN`: Your Telegram Bot API token (stored as a secret).
  - `SENDER_TOKEN`: A custom token to authenticate requests from your application (stored as a secret).
- **Simple**: Only accepts `POST /message` requests.
- **One-way**: Ignores incoming messages from Telegram (webhooks are not used for receiving updates from Telegram, only for sending).
- **Easy Deploy**: Includes a script to deploy everything in one step.

## Prerequisites

1. Node.js installed on your machine.
2. A Cloudflare account.
3. A Telegram Bot created via @BotFather.
4. The Chat ID where you want to send messages.

## Setup & Deployment

1. **Clone or copy this project** to your local machine.

2. **Run the deployment script**:
   ```bash
   chmod +x deploy.sh
   ./deploy.sh
   ```
   - The script will install `wrangler`.
   - It will prompt you to enter your `BOT_TOKEN` (from @BotFather).
   - It will prompt you to enter your `SENDER_TOKEN` (you can generate any random string, e.g., using `openssl rand -hex 32`).
   - Finally, it will deploy the worker to Cloudflare.

3. **Get your Worker URL**:
   After deployment, the script will output a URL like `https://telegram-webhook-forwarder.<your-subdomain>.workers.dev`. Save this URL.

## Usage from n8n

In your n8n workflow, use an **HTTP Request** node configured as follows:

- **Method**: `POST`
- **URL**: `https://<your-worker-url>/message`
- **Authentication**: `Generic` -> `Header Auth`
  - **Name**: `Authorization`
  - **Value**: `Bearer <YOUR_SENDER_TOKEN>`
- **Send Body**: `JSON`
- **Body**:
  ```json
  {
    "text": "Hello from n8n!",
    "chat_id": "123456789"
  }
  ```
  *(Note: If you set `DEFAULT_CHAT_ID` in `wrangler.toml`, you can omit `chat_id` from the body.)*

## Configuration

### Environment Variables (Secrets)
These are set during deployment via `wrangler secret put`:
- `BOT_TOKEN`: Your Telegram Bot API Token.
- `SENDER_TOKEN`: The token your application uses to authenticate.

### Non-Secret Variables (`wrangler.toml`)
- `DEFAULT_CHAT_ID`: Optional. If set, the worker will use this chat ID if none is provided in the request body.

## Local Development

To test locally before deploying:

1. Set up environment variables in a `.dev.vars` file (create it):
   ```
   BOT_TOKEN="your-bot-token"
   SENDER_TOKEN="your-sender-token"
   DEFAULT_CHAT_ID=""
   ```
2. Run the dev server:
   ```bash
   npm run dev
   ```
3. Send a test request using curl:
   ```bash
   curl -X POST http://localhost:8787/message \
     -H "Authorization: Bearer your-sender-token" \
     -H "Content-Type: application/json" \
     -d '{"text": "Test message", "chat_id": "your-chat-id"}'
   ```

## File Structure

- `src/index.js`: Main worker logic.
- `wrangler.toml`: Cloudflare Workers configuration.
- `deploy.sh`: Automated deployment script.
- `package.json`: Project dependencies and scripts.
