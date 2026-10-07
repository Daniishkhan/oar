#!/usr/bin/env bash
# Join this VM to the developer's tailnet with a stable name that survives boat stop/resume.
#   OAR_TS_HOSTNAME=oar-engine bash /home/user/oar/setup/tailscale.sh
# Expects the auth key at /home/user/oar/ts-authkey on first join (deleted afterwards).
# Idempotent: a VM that is already joined under the right name only gets the daemon checked.
set -euxo pipefail
export HOME="${HOME:-/home/user}"
HOSTNAME_TS="${OAR_TS_HOSTNAME:?set OAR_TS_HOSTNAME, e.g. oar-engine}"
KEYFILE="$HOME/oar/ts-authkey"
STATE_DIR=/etc/tailscale   # /etc is in boat snapshots; /var/lib (the default) is not
trap 'rm -f "$KEYFILE"' EXIT   # the key is single-use here; never leave it on a snapshotted disk

EXTRA_FLAGS=''
[ -c /dev/net/tun ] || EXTRA_FLAGS='--tun=userspace-networking'

command -v tailscale >/dev/null 2>&1 || curl -fsSL https://tailscale.com/install.sh | sh

# Keep the node identity under /etc so a resumed VM rejoins as the same node.
sudo install -d -m 700 "$STATE_DIR"
sudo mkdir -p /etc/systemd/system/tailscaled.service.d
sudo tee /etc/systemd/system/tailscaled.service.d/boat-state.conf >/dev/null <<EOF
[Service]
ExecStart=
ExecStart=/usr/sbin/tailscaled --state=$STATE_DIR/tailscaled.state --statedir=$STATE_DIR --socket=/run/tailscale/tailscaled.sock --port=\${PORT} \$FLAGS $EXTRA_FLAGS
EOF
sudo systemctl daemon-reload
sudo systemctl enable tailscaled >/dev/null
sudo systemctl restart tailscaled
sleep 2

joined() {
  tailscale status --json 2>/dev/null | python3 -c '
import json, sys
d = json.load(sys.stdin)
s = d.get("Self") or {}
ok = d.get("BackendState") == "Running" and (s.get("HostName") or "").lower() == sys.argv[1].lower()
sys.exit(0 if ok else 1)' "$HOSTNAME_TS"
}

if joined; then
  echo "already joined as $HOSTNAME_TS"
else
  if [ ! -s "$KEYFILE" ]; then
    if [ "${OAR_TS_OPTIONAL:-0}" = 1 ]; then echo "tailscale: not joined and no auth key; skipping (set TS_AUTHKEY in ~/.config/oar/env)"; exit 0; fi
    echo "no auth key at $KEYFILE; run: oar vm setup <repo> with TS_AUTHKEY set" >&2; exit 1
  fi
  set +x   # keep the key out of the trace
  sudo tailscale up \
    --auth-key="file:$KEYFILE" \
    --hostname="$HOSTNAME_TS" \
    --ssh \
    --advertise-tags=tag:oar \
    --accept-dns=false \
    --reset
  set -x
  rm -f "$KEYFILE"
fi

# mosh for flaky phone connections (udp 60000-61000 over the tailnet)
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq mosh >/dev/null 2>&1 || true

echo "tailscale: $(tailscale ip -4 2>/dev/null || true) $(tailscale status --json | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("Self",{}).get("DNSName","?"), d.get("BackendState"))')"
