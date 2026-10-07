#!/usr/bin/env bash
# oar VM setup for the `cno` repo (Ai-Synapse1/Synapse-Django at /home/user/Synapse-Django).
# boat clones the repo and drops the secret file Synapse-Django/.env before this runs.
set -euxo pipefail
export HOME="${HOME:-/home/user}"; export PATH="$HOME/.local/bin:$PATH"
REPO="$HOME/Synapse-Django"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$HERE/common.sh"

cd "$REPO"
# Host Python 3.10 for editors, scripts and `make cr`; tests run in Docker.
uv python install 3.10
[ -d .venv ] || uv venv --python 3.10 .venv
REQ=""
for f in config/requirements/dev.txt config/requirements/test.txt config/requirements/prod.txt; do
  [ -f "$f" ] && { REQ="$f"; break; }
done
[ -n "$REQ" ] && uv pip install --python .venv/bin/python -r "$REQ" || true

# Pre-build the isolated test image so the first `make test` is fast.
docker compose -f deploy/local/compose.test.yml build django || true

# Interview screen deps (make check.frontend).
( cd frontend/interview && npm ci --ignore-scripts --no-audit --no-fund ) || true

# pre-commit hooks as `make lint` expects.
uvx --from pre-commit==3.7.1 pre-commit install || true

graft build || echo "graft build failed; run it by hand once"
echo "Synapse-Django (cno) ready"
