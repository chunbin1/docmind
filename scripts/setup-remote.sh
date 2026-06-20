#!/usr/bin/env bash
# One-time setup so `./deploy.sh` can build & run on the remote server.
#
# This is the ONLY step that touches the server over SSH. It:
#   1. installs Docker on the server (if missing)
#   2. creates a local Docker "context" pointing at the server over SSH
#
# After this, you only ever run ./deploy.sh locally.
#
# Usage:
#   ./scripts/setup-remote.sh user@SERVER_IP [context-name]
set -euo pipefail

TARGET="${1:-}"
CONTEXT="${2:-docmind}"

if [[ -z "$TARGET" ]]; then
  echo "Usage: ./scripts/setup-remote.sh user@SERVER_IP [context-name]"
  exit 1
fi

echo "→ Checking SSH access to $TARGET ..."
if ! ssh -o BatchMode=yes -o ConnectTimeout=8 "$TARGET" true 2>/dev/null; then
  echo "✗ Cannot SSH into $TARGET without a password."
  echo "  Set up key auth first:  ssh-copy-id $TARGET"
  exit 1
fi

echo "→ Ensuring Docker is installed on $TARGET ..."
ssh "$TARGET" 'command -v docker >/dev/null 2>&1 || (curl -fsSL https://get.docker.com | sh)'

echo "→ Ensuring your user can run docker without sudo ..."
ssh "$TARGET" 'id -nG "$USER" | grep -qw docker || sudo usermod -aG docker "$USER" || true'

echo "→ Creating local Docker context '$CONTEXT' → $TARGET ..."
docker context rm "$CONTEXT" >/dev/null 2>&1 || true
docker context create "$CONTEXT" --docker "host=ssh://$TARGET"

echo "→ Verifying remote daemon is reachable ..."
docker --context "$CONTEXT" version --format '{{.Server.Version}}' >/dev/null

echo
echo "✓ Setup complete. Deploy any time with:  ./deploy.sh"
echo "  (If 'docker' needed a fresh group membership, reconnect SSH once: ssh $TARGET)"
