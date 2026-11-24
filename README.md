
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/irji/SimpleBot)
[![Run on Google Cloud](https://deploy.cloud.run/button.svg)](https://deploy.cloud.run?git_repo=https://github.com/irji/SimpleBot)

*Note: the Google Cloud button builds the repo's `Dockerfile` and deploys the service, but doesn't configure secrets. After deploying, set `BOT_TOKEN` and `SENDER_TOKEN` — the easiest way is to run [`deploy-gcp.sh`](#alternative-deploy-to-google-cloud-run), which also wires up Secret Manager.*

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
1. For using **Cloudflare Workers** please press button on top.

2. **It will prompt you to enter** your `BOT_TOKEN` (from @BotFather) and your `SENDER_TOKEN` (you can generate any random string, e.g., using `openssl rand -hex 32`).

3. **To get chat id** for `DEFAULT_CHAT_ID` use `curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates"` command and check `id` field.

Alternatively you may use commands: 

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

### Alternative: deploy to Google Cloud Run

The same code runs on **Google Cloud Run** — `src/index.js` only uses web-standard APIs (`Request` / `Response` / `fetch`), and `server.js` is a thin Node.js HTTP adapter for it. All endpoints (`/message`, `/mcp`) work identically.

Prerequisites: the [Google Cloud CLI](https://cloud.google.com/sdk/docs/install) (`gcloud`) and a GCP project with billing enabled.

```bash
export GCP_PROJECT_ID=my-project       # or: gcloud config set project my-project
export GCP_REGION=europe-west1         # optional, this is the default
export DEFAULT_CHAT_ID=123456789       # optional non-secret variable
chmod +x deploy-gcp.sh
./deploy-gcp.sh
```

The script:

1. enables the Cloud Run, Cloud Build and Secret Manager APIs;
2. stores `BOT_TOKEN` and `SENDER_TOKEN` in **Secret Manager** (reads them from the environment or prompts interactively; existing secrets are kept);
3. builds the container from the `Dockerfile` and deploys the service, then prints the URL.

On Windows, run the script from Git Bash or WSL.

The service uses public ingress because the app authenticates callers itself with the `SENDER_TOKEN` header — same as the Cloudflare version. To additionally require Google IAM authentication, deploy without `--allow-unauthenticated` and call it with signed ID tokens.

You can also run the Node adapter locally (handy for developing the Cloud Run path):

```bash
BOT_TOKEN=... SENDER_TOKEN=... DEFAULT_CHAT_ID=... npm start   # listens on :8080
```

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
    "chat_id": "123456789",
    "parse_mode": "MarkdownV2"
  }
  ```
  *(Note: If you set `DEFAULT_CHAT_ID` in `wrangler.toml`, you can omit `chat_id` from the body.)*

## MCP Server

The worker also exposes a built-in **MCP (Model Context Protocol) server** at the `/mcp` endpoint using the Streamable HTTP transport (JSON-RPC 2.0). It is protected by the same `SENDER_TOKEN` as `/message`.

Available tool: **`send_message(text)`** — converts light markdown to Telegram-safe HTML and sends:

```json
{ "text": "<converted text>", "parse_mode": "HTML" }
```

Supported markup:

| You write                     | Telegram shows                 |
| ----------------------------- | ------------------------------ |
| `*bold*`                      | **bold**                       |
| `_italic_`                    | italic                         |
| `~strikethrough~`             | ~~strikethrough~~              |
| `\|\|spoiler\|\|`             | spoiler (hidden until tapped)  |
| `` `inline code` ``           | `inline code`                  |
| `` ```code block``` ``        | monospace block                |
| `[text](https://example.com)` | link                           |

Everything else is sent exactly as typed. The worker no longer uses `parse_mode: "MarkdownV2"` (where characters like `. ! - ( )` had to be escaped and were easy to get wrong) — with `parse_mode: "HTML"` only `&`, `<` and `>` are special, and all three are escaped automatically, so ordinary text can never break the message.

To output a markup character literally, escape it with a backslash: `\*`, `\_`, `` \` ``, `\~`, `\|`, `\\`.

### Connecting an MCP client

Point your MCP client (Claude Desktop via proxy, Cursor, Windsurf, n8n AI Agent MCP client node, etc.) to:

```
URL:    https://<your-worker-url>/mcp
Header: Authorization: Bearer <YOUR_SENDER_TOKEN>
```

Example manual check with curl:

```bash
# List tools
curl -s https://<your-worker-url>/mcp \
  -H "Authorization: Bearer <SENDER_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# Call send_message
curl -s https://<your-worker-url>/mcp \
  -H "Authorization: Bearer <SENDER_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"send_message","arguments":{"text":"*Hello* from MCP"}}}'
```

Supported JSON-RPC methods: `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`.

## Configuration

You may modify environment variables via **Workers->Settings** after deployment.

### Environment Variables (Secrets)
These are set during deployment via `wrangler secret put`:
- `BOT_TOKEN`: Your Telegram Bot API Token.
- `SENDER_TOKEN`: The token your application uses to authenticate.

### Non-Secret Variables (`wrangler.toml`)
- `DEFAULT_CHAT_ID`: The worker will use this chat ID if none is provided in the request body. To get chat id use `curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates"` 

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
