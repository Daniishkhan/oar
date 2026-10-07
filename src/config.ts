import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { OarError } from './errors.js'
import { registerSecret, type Exec } from './exec.js'

export interface Paths {
  home: string
  configDir: string
  configFile: string
  envFile: string
  stateDir: string
  stateFile: string
  lockFile: string
  tasksDir: string
  shotsDir: string
  sshDir: string
  sshConfig: string
  aliasFile: string
  knownHosts: string
  keyFile: string
  pubFile: string
  /** KnownHostsCommand for tailnet aliases (installed by `pnpm install:local`). */
  hostkeysCmd: string
}

export function paths(home: string = homedir()): Paths {
  const configDir = join(home, '.config', 'oar')
  const stateDir = join(home, '.local', 'state', 'oar')
  const sshDir = join(home, '.ssh')
  return {
    home,
    configDir,
    configFile: join(configDir, 'config.json'),
    envFile: join(configDir, 'env'),
    stateDir,
    stateFile: join(stateDir, 'state.json'),
    lockFile: join(stateDir, 'state.lock'),
    tasksDir: join(stateDir, 'tasks'),
    shotsDir: join(stateDir, 'shots'),
    sshDir,
    sshConfig: join(sshDir, 'config'),
    aliasFile: join(sshDir, 'oar_config'),
    knownHosts: join(sshDir, 'oar_known_hosts'),
    keyFile: join(sshDir, 'oar_ed25519'),
    pubFile: join(sshDir, 'oar_ed25519.pub'),
    hostkeysCmd: join(home, '.local', 'bin', 'oar-ts-hostkeys'),
  }
}

export const RepoSchema = z.object({
  /** Regex tested against `git remote get-url origin` to identify this repo on the Mac. */
  remoteMatch: z.string().min(1),
  github: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  envName: z.string().min(1),
  vmPath: z.string().startsWith('/home/user/'),
  setupScript: z.string().min(1),
  gate: z.string().min(1),
  branchPrefix: z.string().default('codex/'),
  baseBranch: z.string().default('main'),
  worktreeRoot: z.string().startsWith('/home/user/'),
  worktreeInit: z.array(z.string()).default([]),
  services: z.string().optional(),
  ports: z.array(z.number().int().positive()).default([]),
  herdrLabel: z.string().min(1),
})
export type RepoConfig = z.infer<typeof RepoSchema>

export const ConfigSchema = z.object({
  version: z.literal(1),
  defaults: z
    .object({
      ttlSeconds: z.number().int().min(60).max(2_592_000).default(43_200),
      type: z.enum(['small', 'default', 'large']).default('default'),
      keepHours: z.number().positive().default(10),
      autoKeep: z
        .object({
          enabled: z.boolean().default(true),
          leadMinutes: z.number().positive().default(45),
          extendHours: z.number().positive().default(4),
        })
        .default({ enabled: true, leadMinutes: 45, extendHours: 4 }),
      pollSeconds: z.number().int().min(5).default(30),
    })
    .default({
      ttlSeconds: 43_200,
      type: 'default',
      keepHours: 10,
      autoKeep: { enabled: true, leadMinutes: 45, extendHours: 4 },
      pollSeconds: 30,
    }),
  /** Applied with `git config --global` on every VM by `oar vm setup`, so PRs are credited to you. */
  gitIdentity: z
    .object({ name: z.string().min(1), email: z.string().email() })
    .default({ name: 'daniishkhan', email: 'danishafzalkhan@gmail.com' }),
  /** With `enabled` and a `suffix`, `oar-<repo>` resolves to the tailnet name and boat's NAT endpoint becomes `oar-<repo>-direct`. */
  tailscale: z
    .object({
      enabled: z.boolean().default(false),
      suffix: z.string().optional(),
      cli: z.string().default('/Applications/Tailscale.app/Contents/MacOS/Tailscale'),
      tag: z.string().default('tag:oar'),
    })
    .default({
      enabled: false,
      cli: '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
      tag: 'tag:oar',
    }),
  repos: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,15}$/), RepoSchema),
})
export type Config = z.infer<typeof ConfigSchema>

/** `oar-<repo>.<suffix>` when Tailscale is configured, else null. */
export function tailnetHost(config: Config, repo: string): string | null {
  const t = config.tailscale
  return t.enabled && t.suffix ? `${sshAlias(repo)}.${t.suffix}` : null
}

export const DEFAULT_CONFIG: Config = ConfigSchema.parse({
  version: 1,
  tailscale: { enabled: true, suffix: 'tail1d8b49.ts.net' },
  repos: {
    engine: {
      remoteMatch: 'nodes-engine',
      github: 'Ai-Synapse1/nodes-engine',
      envName: 'engine',
      vmPath: '/home/user/nodes-engine',
      setupScript: 'nodes-engine.sh',
      gate: 'pnpm verify',
      worktreeRoot: '/home/user/worktrees/engine',
      worktreeInit: [
        'cp /home/user/nodes-engine/.env .env',
        'pnpm install --frozen-lockfile --prefer-offline',
      ],
      services: 'pnpm db:up',
      ports: [3000],
      herdrLabel: 'engine',
    },
    cno: {
      remoteMatch: 'nodes-cno|Synapse-Django',
      github: 'Ai-Synapse1/nodes-cno',
      envName: 'cno',
      vmPath: '/home/user/nodes-cno',
      setupScript: 'nodes-cno.sh',
      gate: 'make lint && make test',
      worktreeRoot: '/home/user/worktrees/cno',
      worktreeInit: ['cp /home/user/nodes-cno/.env .env'],
      ports: [8000],
      herdrLabel: 'cno',
    },
  },
})

/** Reads ~/.config/oar/config.json, writing the shipped defaults first if it does not exist. */
export function loadConfig(p: Paths): Config {
  if (!existsSync(p.configFile)) {
    mkdirSync(p.configDir, { recursive: true })
    writeFileSync(p.configFile, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`)
    return DEFAULT_CONFIG
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(p.configFile, 'utf8'))
  } catch (e) {
    throw new OarError('config', `${p.configFile} is not valid JSON: ${(e as Error).message}`)
  }
  const parsed = ConfigSchema.safeParse(raw)
  if (!parsed.success) {
    throw new OarError(
      'config',
      `${p.configFile} is invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    )
  }
  return parsed.data
}

export function repoConfig(config: Config, name: string): RepoConfig {
  const repo = config.repos[name]
  if (!repo) {
    throw new OarError(
      'config',
      `unknown repo '${name}'`,
      `known repos: ${Object.keys(config.repos).join(', ')}`,
    )
  }
  return repo
}

export const sshAlias = (repo: string) => `oar-${repo}`

export interface Secrets {
  BOAT_API_KEY: string
  /** Reusable, pre-approved, tagged Tailscale auth key; only needed when a VM first joins. */
  TS_AUTHKEY?: string
}

/** KEY=value lines, `#` comments; the environment overrides the file. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (m && !line.trim().startsWith('#')) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, '')
  }
  return out
}

export function loadSecrets(p: Paths, env: NodeJS.ProcessEnv = process.env): Secrets {
  const fromFile = existsSync(p.envFile) ? parseEnvFile(readFileSync(p.envFile, 'utf8')) : {}
  const key = env.BOAT_API_KEY || fromFile.BOAT_API_KEY
  if (!key) {
    throw new OarError(
      'secrets',
      `no BOAT_API_KEY in ${p.envFile}`,
      `create it (chmod 600) with a line: BOAT_API_KEY=boat_...  (boat dashboard → API keys)`,
    )
  }
  registerSecret(key)
  const ts = env.TS_AUTHKEY || fromFile.TS_AUTHKEY
  registerSecret(ts)
  return { BOAT_API_KEY: key, TS_AUTHKEY: ts || undefined }
}

/** Which configured repo does the git checkout at `cwd` belong to? */
export async function inferRepo(config: Config, exec: Exec, cwd: string): Promise<string> {
  const res = await exec.run('git', ['remote', 'get-url', 'origin'], { cwd })
  const url = res.stdout.trim()
  if (res.code !== 0 || !url) {
    throw new OarError(
      'usage',
      `not inside a git checkout with an origin; pass --repo <${Object.keys(config.repos).join('|')}>`,
    )
  }
  for (const [name, repo] of Object.entries(config.repos)) {
    if (new RegExp(repo.remoteMatch).test(url)) return name
  }
  throw new OarError(
    'usage',
    `origin '${url}' matches none of ${Object.keys(config.repos).join(', ')}; pass --repo`,
  )
}
