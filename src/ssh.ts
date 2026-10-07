import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { SshKeyResponse } from '@boatdev/sdk'
import type { Paths } from './config.js'
import { OarError } from './errors.js'
import type { Exec } from './exec.js'
import type { Endpoint } from './state.js'
import { sleep } from './time.js'

/** boat answers with either a NATed `host:port` or a machine IP on port 22. */
export function endpointFrom(res: SshKeyResponse): Endpoint {
  if (res.sshEndpoint) {
    const i = res.sshEndpoint.lastIndexOf(':')
    const host = res.sshEndpoint.slice(0, i)
    const port = Number(res.sshEndpoint.slice(i + 1))
    if (host && Number.isInteger(port)) return { host, port }
  }
  if (res.machineIp) return { host: res.machineIp, port: 22 }
  throw new OarError(
    'ssh',
    'boat returned neither sshEndpoint nor machineIp',
    'the sandbox may still be provisioning; retry in a moment',
  )
}

export const knownHostsName = (e: Endpoint) => (e.port === 22 ? e.host : `[${e.host}]:${e.port}`)

/** Drop every line whose host field matches one of the names. */
export function knownHostsWithout(text: string, names: string[]): string {
  const drop = new Set(names)
  return text
    .split('\n')
    .filter((line) => line.trim() !== '' && !drop.has(line.split(/\s+/)[0] ?? ''))
    .join('\n')
}

/** One line per key type boat returns (it may return several, newline separated). */
export function knownHostsLines(e: Endpoint, hostKey: string): string[] {
  return hostKey
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((k) => `${knownHostsName(e)} ${k}`)
}

export function aliasBlock(alias: string, e: Endpoint, p: Paths): string {
  return [
    `Host ${alias}`,
    `  HostName ${e.host}`,
    `  Port ${e.port}`,
    '  User user',
    `  IdentityFile ${p.keyFile}`,
    '  IdentitiesOnly yes',
    `  UserKnownHostsFile ${p.knownHosts}`,
    '  StrictHostKeyChecking yes',
    '  ServerAliveInterval 30',
    '  ServerAliveCountMax 4',
    '',
  ].join('\n')
}

/** Replace (or append) the `Host <alias>` block; other blocks are untouched. */
export function replaceHostBlock(text: string, alias: string, block: string): string {
  const kept: string[] = []
  let skipping = false
  for (const line of text.split('\n')) {
    if (/^Host\s/.test(line)) skipping = line.trim().split(/\s+/).slice(1).includes(alias)
    if (!skipping) kept.push(line)
  }
  let head = kept.join('\n').replace(/\n+$/, '')
  if (head) head += '\n\n'
  return head + block
}

export function ensureInclude(configText: string, includeLine: string): string {
  if (configText.split('\n').some((l) => l.trim() === includeLine)) return configText
  return `${includeLine}\n${configText}`
}

export async function ensurePublicKey(p: Paths, exec: Exec): Promise<string> {
  if (!existsSync(p.pubFile)) {
    mkdirSync(p.sshDir, { recursive: true, mode: 0o700 })
    const r = await exec.run('ssh-keygen', [
      '-q',
      '-t',
      'ed25519',
      '-N',
      '',
      '-C',
      'oar',
      '-f',
      p.keyFile,
    ])
    if (r.code !== 0) throw new OarError('ssh', `ssh-keygen failed: ${r.stderr.trim()}`)
  }
  return readFileSync(p.pubFile, 'utf8').trim()
}

export interface PinArgs {
  alias: string
  endpoint: Endpoint
  hostKey: string
  previous?: Endpoint
  /** When set, `<alias>` points at the tailnet name and `<alias>-direct` at boat's endpoint. */
  tailnet?: { host: string; hostkeysCmd: string }
}

export const directAlias = (alias: string) => `${alias}-direct`

/** Tailscale publishes each node's current SSH host key; the KnownHostsCommand reads it, so no file is ever stale. */
export function tailnetBlock(alias: string, host: string, hostkeysCmd: string, p: Paths): string {
  return [
    `Host ${alias}`,
    `  HostName ${host}`,
    '  User user',
    `  IdentityFile ${p.keyFile}`,
    '  IdentitiesOnly yes',
    '  UserKnownHostsFile /dev/null',
    `  KnownHostsCommand ${hostkeysCmd} %H`,
    '  StrictHostKeyChecking yes',
    '  ServerAliveInterval 15',
    '  ServerAliveCountMax 4',
    '',
  ].join('\n')
}

/** Record the sandbox's current machine: pinned host key, alias block, Include line. */
export function pin(p: Paths, a: PinArgs): void {
  mkdirSync(p.sshDir, { recursive: true, mode: 0o700 })
  const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : '')
  const stale = [knownHostsName(a.endpoint), ...(a.previous ? [knownHostsName(a.previous)] : [])]
  const kh = knownHostsWithout(read(p.knownHosts), stale)
  writeFileSync(
    p.knownHosts,
    `${[kh, ...knownHostsLines(a.endpoint, a.hostKey)].filter(Boolean).join('\n')}\n`,
  )
  chmodSync(p.knownHosts, 0o600)
  let aliases = read(p.aliasFile)
  if (a.tailnet) {
    aliases = replaceHostBlock(
      aliases,
      a.alias,
      tailnetBlock(a.alias, a.tailnet.host, a.tailnet.hostkeysCmd, p),
    )
    aliases = replaceHostBlock(
      aliases,
      directAlias(a.alias),
      aliasBlock(directAlias(a.alias), a.endpoint, p),
    )
  } else {
    aliases = replaceHostBlock(aliases, a.alias, aliasBlock(a.alias, a.endpoint, p))
    aliases = replaceHostBlock(aliases, directAlias(a.alias), '').replace(/\n+$/, '\n')
  }
  writeFileSync(p.aliasFile, aliases)
  chmodSync(p.aliasFile, 0o600)
  const include = `Include ${p.aliasFile.replace(p.home, '~')}`
  const cfg = ensureInclude(read(p.sshConfig), include)
  writeFileSync(p.sshConfig, cfg)
  chmodSync(p.sshConfig, 0o600)
}

export const batchArgs = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10']

/** sshd lags boat's "ready" by a few seconds after a resume. */
export async function probe(exec: Exec, alias: string, attempts = 6): Promise<void> {
  let last = ''
  for (let i = 0; i < attempts; i++) {
    const r = await exec.run('ssh', [...batchArgs, alias, 'true'], { timeoutMs: 20_000 })
    if (r.code === 0) return
    last = r.stderr.trim()
    await sleep(5_000)
  }
  throw new OarError('ssh', `cannot reach ${alias}: ${last}`, `try: ssh -v ${alias} true`)
}

/** First alias that answers, with few attempts for the preferred one (a tailnet name may not exist yet). */
export async function probeAny(exec: Exec, aliases: string[]): Promise<string> {
  let last = ''
  for (const [i, alias] of aliases.entries()) {
    const attempts = i === aliases.length - 1 ? 6 : 2
    try {
      await probe(exec, alias, attempts)
      return alias
    } catch (e) {
      last = (e as Error).message
    }
  }
  throw new OarError('ssh', last, `try: ssh -v ${aliases[0]} true`)
}

export const remote = (exec: Exec, alias: string, command: string, timeoutMs = 120_000) =>
  exec.run('ssh', [...batchArgs, alias, command], { timeoutMs })

export const interactive = (exec: Exec, alias: string, command?: string) =>
  exec.interactive('ssh', command ? ['-t', alias, command] : [alias])

export const tunnel = (exec: Exec, alias: string, ports: number[]) =>
  exec.interactive('ssh', ['-N', ...ports.flatMap((p) => ['-L', `${p}:localhost:${p}`]), alias])
