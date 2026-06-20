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
ENV_FILE="packages/server/.env"

# --- sanity checks ----------------------------------------------------------
if ! docker context inspect "$CONTEXT" >/dev/null 2>&1; then
  echo "✗ Docker context '$CONTEXT' not found."
  echo "  Run the one-time setup first:  ./scripts/setup-remote.sh user@SERVER_IP"
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "✗ Missing $ENV_FILE (your API keys / config)."
  echo "  Copy the example and fill it in:  cp packages/server/.env.example $ENV_FILE"
  exit 1
fi

echo "→ Deploying to remote context '$CONTEXT' (port ${CLIENT_PORT:-8080})..."

# --- build + run on the remote daemon --------------------------------------
docker --context "$CONTEXT" compose -f "$COMPOSE_FILE" up -d --build --remove-orphans

echo
echo "→ Running containers:"
docker --context "$CONTEXT" compose -f "$COMPOSE_FILE" ps

REMOTE_HOST="$(docker context inspect "$CONTEXT" --format '{{.Endpoints.docker.Host}}' | sed -E 's#ssh://[^@]+@##; s#:.*##')"
echo
echo "✓ Done. App should be live at:  http://${REMOTE_HOST}:${CLIENT_PORT:-8080}"
