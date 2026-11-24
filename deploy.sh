#!/bin/bash

# Exit on error
set -e

echo "🚀 Starting deployment for Telegram Webhook Forwarder..."

# Check if wrangler is installed
if ! command -v npx &> /dev/null
then
    echo "❌ npx could not be found. Please install Node.js and npm first."
    exit 1
fi

# Install dependencies (wrangler) locally if not present
echo "📦 Installing/Updating Wrangler..."
npm install --save-dev wrangler@latest

# Login to Cloudflare (interactive, but only needed once usually)
# We skip explicit login here as `wrangler secret put` will trigger it if needed.

# Set Secrets
echo "🔐 Setting up secrets..."
echo "Please enter your BOT_TOKEN when prompted:"
npx wrangler secret put BOT_TOKEN

echo "Please enter your SENDER_TOKEN when prompted:"
npx wrangler secret put SENDER_TOKEN

# Deploy the worker
echo "🌍 Deploying Worker to Cloudflare..."
npx wrangler deploy

echo "✅ Deployment complete!"
echo "Your Worker URL should be displayed above. Use it in your n8n HTTP Request node."
