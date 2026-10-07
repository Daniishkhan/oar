import { shq } from './exec.js'

/** Where the persistent, signed-in agent Chrome keeps its profile on the VM (snapshotted, outside /home/user). */
export const CHROME_PROFILE = '/srv/oar/chrome'
export const CDP_PORT = 9222
export const PLAYWRIGHT_BROWSERS_PATH = '/home/user/.local/share/ms-playwright'
export const VM_SHOT_PATH = '/tmp/oar/shot.png'

/** `shot` lives in ~/.local/bin on the VM (installed by setup/desktop.sh). */
export const shotCommand = (window?: string) =>
  `~/.local/bin/shot ${shq(VM_SHOT_PATH)}${window ? ` ${shq(window)}` : ''}`

/** One shell line that reports every desktop prerequisite as `key=value` lines. */
export const desktopProbeCommand = [
  'echo "x11=$([ -S /tmp/.X11-unix/X0 ] && echo ok || echo missing)"',
  'echo "chrome=$(systemctl is-active agent-chrome 2>/dev/null || echo inactive)"',
  `echo "cdp=$(curl -fsS -m 3 http://127.0.0.1:${CDP_PORT}/json/version 2>/dev/null | python3 -c 'import sys,json; print(json.load(sys.stdin).get("Browser",""))' 2>/dev/null || echo none)"`,
  `echo "profile=$([ -d ${CHROME_PROFILE}/Default ] && echo ok || echo missing)"`,
  'echo "sysctl=$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo unknown)"',
  `echo "pw=$(ls ${PLAYWRIGHT_BROWSERS_PATH} 2>/dev/null | tr '\\n' ' ')"`,
  'echo "linger=$(ls /var/lib/systemd/linger 2>/dev/null | tr "\\n" " ")"',
].join('; ')

export function parseProbe(stdout: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of stdout.split('\n')) {
    const m = line.match(/^([a-z0-9_]+)=(.*)$/)
    if (m) out[m[1]!] = m[2]!.trim()
  }
  return out
}

/** `claude mcp list` prints one line per server: `name: command … - ✓ Connected` or `… - ✗ Failed to connect`. */
export function parseMcpList(stdout: string): Record<string, 'connected' | 'failed'> {
  const out: Record<string, 'connected' | 'failed'> = {}
  for (const line of stdout.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_.-]+):\s.*?-\s*(✓|✗)/)
    if (m) out[m[1]!] = m[2] === '✓' ? 'connected' : 'failed'
  }
  return out
}
