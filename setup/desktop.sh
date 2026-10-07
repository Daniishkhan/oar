#!/usr/bin/env bash
# Agent desktop & browser on a boat VM: persistent "agent Chrome" on :0 with CDP, Playwright and
# chrome-devtools MCP servers for Claude Code, Electron prerequisites, and the `shot` helpers.
# Called from common.sh. Idempotent. Runs as `user` with passwordless sudo.
set -euxo pipefail
export HOME="${HOME:-/home/user}"
export PATH="$HOME/.local/bin:$PATH"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VM_FILES="$HERE/../vm"
UID_NOW="$(id -u)"
CHROME_PROFILE=/srv/oar/chrome
PW_PATH="$HOME/.local/share/ms-playwright"
PW_MCP_VERSION="0.0.81"          # matches nodes-engine's pin
CDT_MCP_VERSION="${CDT_MCP_VERSION:-1.10.1}"   # pinned; bump deliberately

# 1. Electron's sandbox needs unprivileged user namespaces; Ubuntu 24.04 restricts them by default.
printf 'kernel.apparmor_restrict_unprivileged_userns = 0\n' | sudo tee /etc/sysctl.d/60-oar-userns.conf >/dev/null
sudo sysctl -q -w kernel.apparmor_restrict_unprivileged_userns=0

# 2. Display tooling and the libraries Electron/Chromium need (most are preinstalled with Chrome).
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
  xvfb x11-utils xdotool wmctrl ffmpeg libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2t64 libxss1 libxtst6 libnotify4
command -v google-chrome-stable

# 3. X sanity (warn only; boat runs Xorg :0 for the desktop stream).
if [ -S /tmp/.X11-unix/X0 ]; then DISPLAY=:0 xdpyinfo 2>/dev/null | grep dimensions || echo "WARN: X0 socket present but xdpyinfo failed (XAUTHORITY?)"; else echo "WARN: no X socket at :0"; fi

# 4. Lingering: boat's `computer` MCP daemon is a user service; /var/lib/systemd/linger is not snapshotted.
sudo loginctl enable-linger user
sudo install -m 644 "$HERE/oar-linger.service" /etc/systemd/system/oar-linger.service
sudo systemctl daemon-reload
sudo systemctl enable oar-linger >/dev/null

# 5. Persistent Chrome profile: outside /home/user (boat's rule for `boat browser --profile`), under /srv (snapshotted).
sudo mkdir -p "$CHROME_PROFILE"
sudo chown -R user:user /srv/oar
chmod 700 "$CHROME_PROFILE"

# 6. Agent Chrome as a system unit (user units would not auto-start after a resume).
sudo install -m 644 "$HERE/agent-chrome.service" /etc/systemd/system/agent-chrome.service
sudo systemctl daemon-reload
sudo systemctl enable agent-chrome >/dev/null
sudo systemctl restart agent-chrome
for i in $(seq 1 30); do curl -fsS -m 2 http://127.0.0.1:9222/json/version >/dev/null 2>&1 && break; sleep 1; done
curl -fsS -m 2 http://127.0.0.1:9222/json/version | head -c 200 || echo "WARN: CDP on 9222 not answering yet"

# 7. Playwright browsers in a snapshotted path (the default ~/.cache is lost on every resume).
mkdir -p "$PW_PATH" "$HOME/.config/environment.d" /tmp/oar
grep -qs PLAYWRIGHT_BROWSERS_PATH "$HOME/.bashrc" || echo "export PLAYWRIGHT_BROWSERS_PATH=\"$PW_PATH\"" >> "$HOME/.bashrc"
grep -qs 'export DISPLAY' "$HOME/.bashrc" || echo 'export DISPLAY="${DISPLAY:-:0}"' >> "$HOME/.bashrc"
printf 'PLAYWRIGHT_BROWSERS_PATH=%s\nDISPLAY=:0\n' "$PW_PATH" > "$HOME/.config/environment.d/oar.conf"

# 8. Herdr panes inherit the desktop and the user bus (herdr-server is a system unit with no login session).
TMP="$(mktemp)"
printf '[Service]\nEnvironment=XDG_RUNTIME_DIR=/run/user/%s\nEnvironment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/%s/bus\n' "$UID_NOW" "$UID_NOW" > "$TMP"
sudo mkdir -p /etc/systemd/system/herdr-server.service.d
if ! sudo cmp -s "$TMP" /etc/systemd/system/herdr-server.service.d/desktop.conf; then
  sudo install -m 644 "$TMP" /etc/systemd/system/herdr-server.service.d/desktop.conf
  sudo systemctl daemon-reload
  sudo systemctl restart herdr-server      # drops live panes; setup is a maintenance operation
fi
rm -f "$TMP"

# 9. MCP servers for Claude Code, registered with absolute paths (panes and boat commands lack nvm's bin).
npm install -g "@playwright/mcp@$PW_MCP_VERSION" "chrome-devtools-mcp@$CDT_MCP_VERSION" >/dev/null 2>&1 || npm install -g "@playwright/mcp@$PW_MCP_VERSION" "chrome-devtools-mcp@$CDT_MCP_VERSION"
GBIN="$(npm prefix -g)/bin"
ln -sf "$GBIN/playwright-mcp" "$HOME/.local/bin/playwright-mcp"
ln -sf "$GBIN/chrome-devtools-mcp" "$HOME/.local/bin/chrome-devtools-mcp"
for s in browser browser-headless chrome-devtools; do claude mcp remove -s user "$s" >/dev/null 2>&1 || true; done
claude mcp add -s user browser -- "$HOME/.local/bin/playwright-mcp" --cdp-endpoint http://127.0.0.1:9222 --output-dir /tmp/oar/pw
claude mcp add -s user browser-headless -- "$HOME/.local/bin/playwright-mcp" --browser chrome --headless --isolated --output-dir /tmp/oar/pw-headless
claude mcp add -s user chrome-devtools -- "$HOME/.local/bin/chrome-devtools-mcp" --browserUrl=http://127.0.0.1:9222
# boat's own `computer` MCP entry in ~/.claude.json is left alone.

# 10. Helpers.
install -m 755 "$VM_FILES/shot" "$HOME/.local/bin/shot"
install -m 755 "$VM_FILES/pr-shot" "$HOME/.local/bin/pr-shot"
echo "desktop setup done: chrome=$(systemctl is-active agent-chrome) profile=$CHROME_PROFILE pw=$PW_PATH"
