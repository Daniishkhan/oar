#!/usr/bin/env bash
# Bootstrap for the oar factory controller VM. Runs as `user` over `ssh -t`; idempotent.
# The app bundle (dist/oar.mjs + setup/ + vm/ + templates/) is already under /home/user/oar/app.
set -euxo pipefail
export HOME="${HOME:-/home/user}"
export PATH="$HOME/.local/bin:$PATH"
APP="$HOME/oar/app"
cd "$HOME"
mkdir -p "$HOME/.local/bin" "$HOME/.config/oar" "$HOME/.local/state/oar/tasks" "$HOME/.ssh"
chmod 700 "$HOME/.ssh"

# The worker layout (/home/user/oar/setup, /home/user/oar/vm) also applies here, so the shared
# scripts (tailscale.sh) find their files.
ln -sfn "$APP/setup" "$HOME/oar/setup"
ln -sfn "$APP/vm" "$HOME/oar/vm"

# oar itself: the single-file bundle, resolved through a symlink so its assets sit beside it.
chmod +x "$APP/dist/oar.mjs"
ln -sf "$APP/dist/oar.mjs" "$HOME/.local/bin/oar"
node --version
oar --help >/dev/null

# Herdr client (drives the worker VMs with `herdr --machine`) and a server for the later
# front-door pane; enabled units come back after a resume.
command -v herdr >/dev/null 2>&1 || curl -fsSL https://herdr.dev/install.sh | sh
sudo install -m 644 "$APP/setup/herdr-server.service" /etc/systemd/system/herdr-server.service
sudo systemctl daemon-reload
sudo systemctl enable --now herdr-server || true

# gh is on the boat image; say so when it is not (PR polling then falls back to the worker VMs).
command -v gh >/dev/null 2>&1 || echo "WARNING: gh is missing on this VM; PR polling will go through the workers"

# The controller unit. Secrets come from ~/.config/oar/env (written by oar factory setup, mode 600).
sudo install -m 644 "$APP/setup/oar-factory.service" /etc/systemd/system/oar-factory.service
sudo systemctl daemon-reload
sudo systemctl enable oar-factory >/dev/null
[ -f "$HOME/.config/oar/env" ] && chmod 600 "$HOME/.config/oar/env" || true

grep -qs 'local/bin' "$HOME/.bashrc" || echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
echo "controller setup finished"
