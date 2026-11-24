#!/bin/bash

# Exit on error
set -e

echo "🚀 Starting deployment to Google Cloud Run..."

# Check if gcloud is installed
if ! command -v gcloud &> /dev/null
then
    echo "❌ gcloud could not be found. Install the Google Cloud CLI first:"
    echo "   https://cloud.google.com/sdk/docs/install"
    exit 1
fi

# --- Settings (override via environment variables) ---
#   GCP_PROJECT_ID   GCP project (falls back to `gcloud config get-value project`)
#   GCP_REGION       Cloud Run region, default: europe-west1
#   GCP_SERVICE_NAME service name, default: telegram-webhook-forwarder
#   DEFAULT_CHAT_ID  optional non-secret var passed to the service
PROJECT_ID="${GCP_PROJECT_ID:-}"
REGION="${GCP_REGION:-europe-west1}"
SERVICE_NAME="${GCP_SERVICE_NAME:-telegram-webhook-forwarder}"

if [ -z "$PROJECT_ID" ]; then
    PROJECT_ID=$(gcloud config get-value project 2>/dev/null || true)
fi
if [ -z "$PROJECT_ID" ]; then
    echo "❌ No GCP project selected. Set GCP_PROJECT_ID or run: gcloud config set project <project-id>"
    exit 1
fi

echo "📦 Project: $PROJECT_ID | Region: $REGION | Service: $SERVICE_NAME"
gcloud config set project "$PROJECT_ID"

# --- Enable required APIs ---
echo "🔌 Enabling required APIs (Cloud Run, Cloud Build, Secret Manager)..."
gcloud services enable run.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com

# --- Secrets in Secret Manager ---
# Reads from the environment (BOT_TOKEN / SENDER_TOKEN) if set, otherwise
# prompts. Already-existing secrets are kept as is.
create_secret_if_missing() {
    local SECRET_NAME="$1" SECRET_PROMPT="$2"
    if gcloud secrets describe "$SECRET_NAME" --project="$PROJECT_ID" >/dev/null 2>&1; then
        echo "🔐 Secret $SECRET_NAME already exists — keeping the current value."
        return
    fi
    local SECRET_VALUE="${!SECRET_NAME}"
    if [ -z "$SECRET_VALUE" ]; then
        read -rsp "$SECRET_PROMPT" SECRET_VALUE
        echo
    fi
    printf '%s' "$SECRET_VALUE" | gcloud secrets create "$SECRET_NAME" --project="$PROJECT_ID" --data-file=-
    echo "🔐 Secret $SECRET_NAME created."
}
create_secret_if_missing BOT_TOKEN "Enter BOT_TOKEN (from @BotFather): "
create_secret_if_missing SENDER_TOKEN "Enter SENDER_TOKEN (random string): "

# Grant the Cloud Run runtime service account access to the secrets
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
RUN_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
for SECRET_NAME in BOT_TOKEN SENDER_TOKEN; do
    gcloud secrets add-iam-policy-binding "$SECRET_NAME" \
        --project="$PROJECT_ID" \
        --member="serviceAccount:$RUN_SA" \
        --role="roles/secretmanager.secretAccessor" \
        --quiet >/dev/null
done
echo "🔑 Secret Manager access granted to the runtime service account."

# --- Deploy ---
# The service is deployed with public ingress: the app itself authenticates
# callers via the SENDER_TOKEN header (same model as the Cloudflare Worker).
# To additionally require Google IAM tokens, remove --allow-unauthenticated
# and call the service with signed ID tokens.
DEPLOY_ARGS=(
    deploy "$SERVICE_NAME"
    --project "$PROJECT_ID"
    --region "$REGION"
    --source .
    --allow-unauthenticated
    --set-secrets "BOT_TOKEN=BOT_TOKEN:latest,SENDER_TOKEN=SENDER_TOKEN:latest"
    --quiet
)
if [ -n "$DEFAULT_CHAT_ID" ]; then
    DEPLOY_ARGS+=(--update-env-vars "DEFAULT_CHAT_ID=$DEFAULT_CHAT_ID")
fi

echo "🌍 Building and deploying to Cloud Run..."
gcloud run "${DEPLOY_ARGS[@]}"

URL=$(gcloud run services describe "$SERVICE_NAME" --project="$PROJECT_ID" --region="$REGION" --format='value(status.url)')
echo "✅ Deployment complete!"
echo "Service URL: $URL"
echo ""
echo "Use it in n8n / MCP clients:"
echo "  POST $URL/message   (header: Authorization: Bearer <SENDER_TOKEN>)"
echo "  POST $URL/mcp       (MCP endpoint, same auth)"
