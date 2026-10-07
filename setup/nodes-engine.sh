#!/usr/bin/env bash
# oar VM setup for the `engine` repo (Ai-Synapse1/nodes-engine at /home/user/nodes-engine).
# boat clones the repo and drops the secret file nodes-engine/.env before this runs.
set -euxo pipefail
export HOME="${HOME:-/home/user}"; export PATH="$HOME/.local/bin:$PATH"
export PLAYWRIGHT_BROWSERS_PATH="$HOME/.local/share/ms-playwright"   # snapshotted; ~/.cache is not
REPO="$HOME/nodes-engine"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$HERE/common.sh"

cd "$REPO"
node --version                                   # needs 24.x (preinstalled on boat machines)
pnpm --version                                   # 12.3.4, installed and linked by common.sh
pnpm install --frozen-lockfile

# Postgres image for `pnpm db:up` (compose.yaml). Containers do not survive stop/resume; images do.
docker compose pull || true

# Chromium for test:component / test:e2e. Heavy; harmless if it fails.
pnpm exec playwright install --with-deps chromium || true

# Code graph for Claude. Re-run `graft build` after large pulls.
graft build || echo "graft build failed; run it by hand once"

pnpm typecheck && pnpm lint || true
echo "nodes-engine ready"
