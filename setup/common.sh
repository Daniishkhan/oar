#!/usr/bin/env bash
# Shared VM bootstrap for oar. Runs as `user`, HOME=/home/user. Idempotent: re-run any time
# with `oar vm setup <repo>` after a tooling change.
set -euxo pipefail
export HOME="${HOME:-/home/user}"
export PATH="$HOME/.local/bin:$PATH"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # /home/user/oar/setup
VM_FILES="$HERE/../vm"                                  # /home/user/oar/vm
cd "$HOME"
mkdir -p "$HOME/.local/bin" "$HOME/.claude" "$HOME/oar/tasks" "$HOME/worktrees"

# Herdr server for this VM (the Mac attaches with `herdr --remote`, drives it with `herdr --machine`).
command -v herdr >/dev/null 2>&1 || curl -fsSL https://herdr.dev/install.sh | sh

# Keep the server alive across resumes: enabled systemd units restart with the snapshot.
if command -v systemctl >/dev/null 2>&1 && [ -f "$HERE/herdr-server.service" ]; then
  sudo install -m 644 "$HERE/herdr-server.service" /etc/systemd/system/herdr-server.service
  sudo systemctl daemon-reload
  sudo systemctl enable --now herdr-server || true
fi

# graft code graph (the sandbox CLAUDE.md tells Claude to use it).
command -v graft >/dev/null 2>&1 || npm install -g @nanonets/graft@latest

# uv: Python toolchain manager (Synapse-Django) and `uvx` for pre-commit.
command -v uv >/dev/null 2>&1 || curl -LsSf https://astral.sh/uv/install.sh | sh

# Claude Code: user-level config for the VM. The real login is `claude auth login`, done once
# interactively (oar vm new does it; `oar vm ssh <repo> -- claude auth login` repeats it).
if [ -d "$VM_FILES" ]; then
  [ -f "$HOME/.claude/settings.json" ] || cp "$VM_FILES/claude-settings.json" "$HOME/.claude/settings.json"
  cp "$VM_FILES/CLAUDE.md" "$HOME/.claude/CLAUDE.md"
fi
claude update || true

# Lets Herdr resume Claude panes into their native sessions after a server restart.
herdr integration install claude || true

# PATH for login shells (phone SSH, Herdr panes).
grep -qs 'local/bin' "$HOME/.bashrc" || echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
