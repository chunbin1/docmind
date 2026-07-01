#!/usr/bin/env bash
# Deploy DocMind to the remote server with a single local command.
#
# It builds & runs the containers ON the remote Docker daemon via an SSH
# "docker context" — you never have to SSH in or run anything on the server.
# Your API keys stay local: compose reads packages/server/.env here and injects
# the values into the remote containers; the file is never copied to the server.
#
# Usage:
#   ./deploy.sh                 # deploy using context "docmind"
#   DOCKER_CONTEXT=foo ./deploy.sh
#
# One-time prerequisite: ./scripts/setup-remote.sh user@SERVER_IP
set -euo pipefail

cd "$(dirname "$0")"

CONTEXT="${DOCKER_CONTEXT:-docmind}"
COMPOSE_FILE="docker-compose.prod.yml"
# Production env (separate from local dev's .env): LLM keys + GitHub OAuth +
# APP_URL + COOKIE_SECRET. Read locally by compose and injected into the
# remote container; the file itself never leaves this machine.
ENV_FILE="packages/server/.env.prod"

# --- sanity checks ----------------------------------------------------------
if ! docker context inspect "$CONTEXT" >/dev/null 2>&1; then
  echo "✗ Docker context '$CONTEXT' not found."
  echo "  Run the one-time setup first:  ./scripts/setup-remote.sh user@SERVER_IP"
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "✗ Missing $ENV_FILE (production config: LLM key, GitHub OAuth, APP_URL, COOKIE_SECRET)."
  echo "  Create it:  cp packages/server/.env.example $ENV_FILE"
  echo "  then set APP_URL=https://your-domain plus the GitHub OAuth + COOKIE_SECRET values."
  echo "  (See docs/DEPLOY.md.)"
  exit 1
fi

echo "→ Deploying to remote context '$CONTEXT' (port ${CLIENT_PORT:-8080})..."

# --- build + run on the remote daemon --------------------------------------
docker --context "$CONTEXT" compose -f "$COMPOSE_FILE" up -d --build --remove-orphans

echo
echo "→ Running containers:"
docker --context "$CONTEXT" compose -f "$COMPOSE_FILE" ps

APP_URL="$(grep -E '^APP_URL=' "$ENV_FILE" | cut -d= -f2-)"
echo
echo "✓ Done. App should be live at:  ${APP_URL:-your configured domain (APP_URL)}"
