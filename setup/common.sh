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

# npm's global prefix on the boat image is nvm's, which login shells see but `ssh host cmd`,
# boat's command API and systemd do not. Install globals there, then expose them in ~/.local/bin.
# pnpm 12.3.4 is what nodes-engine pins (corepack cannot write /usr/bin here).
# graft is pinned to the Mac's version: the repos commit graft's hook files, and a newer graft
# rewrites them on SessionStart, which dirties the worktree and fails the gate.
npm install -g pnpm@12.3.4 @nanonets/graft@0.19.0
# npm 11 refuses graft's native-build install scripts; the grammars ship prebuilds, so a rebuild is enough.
npm rebuild -g @nanonets/graft >/dev/null 2>&1 || true
GBIN="$(npm prefix -g)/bin"
for b in pnpm pnpx graft; do [ -x "$GBIN/$b" ] && ln -sf "$GBIN/$b" "$HOME/.local/bin/$b"; done
hash -r
pnpm --version; graft --version

# uv: Python toolchain manager (nodes-cno). The installer here ships only `uv`; `uvx` is a shim.
command -v uv >/dev/null 2>&1 || curl -LsSf https://astral.sh/uv/install.sh | sh
if [ ! -x "$HOME/.local/bin/uvx" ]; then
  printf '#!/bin/sh\nexec uv tool run "$@"\n' > "$HOME/.local/bin/uvx"
  chmod +x "$HOME/.local/bin/uvx"
fi

# Claude Code: user-level config for the VM. The real login is `claude auth login`, done once
# interactively (oar vm new does it; `oar vm ssh <repo> -- claude auth login` repeats it).
if [ -d "$VM_FILES" ]; then
  cp "$VM_FILES/claude-settings.json" "$HOME/.claude/settings.json"   # oar-owned; the Herdr integration re-adds its hook below
  cp "$VM_FILES/CLAUDE.md" "$HOME/.claude/CLAUDE.md"
fi
claude update || true

# Codex CLI: minimal VM config. The login itself is copied from the Mac once:
#   scp ~/.codex/auth.json oar-<repo>:~/.codex/auth.json
mkdir -p "$HOME/.codex" && chmod 700 "$HOME/.codex"
[ -f "$VM_FILES/codex-config.toml" ] && cp "$VM_FILES/codex-config.toml" "$HOME/.codex/config.toml"

# Our own agent logins survive boat's resume-time scrub: copy under /srv/oar/creds, restore at boot.
install -m 755 "$VM_FILES/oar-creds" "$HOME/.local/bin/oar-creds"
sudo install -m 644 "$HERE/oar-creds-restore.service" /etc/systemd/system/oar-creds-restore.service
sudo systemctl daemon-reload && sudo systemctl enable oar-creds-restore >/dev/null
oar-creds restore || true
oar-creds save || true

# Lets Herdr resume Claude panes into their native sessions after a server restart.
herdr integration install claude || true

# Agent desktop & browser (agent Chrome on :0, MCP servers, Electron prerequisites, shot helpers).
bash "$HERE/desktop.sh"

# PATH for login shells (phone SSH, Herdr panes).
grep -qs 'local/bin' "$HOME/.bashrc" || echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
