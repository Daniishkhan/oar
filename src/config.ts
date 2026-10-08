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
  }
}

/** Changing these files is a human's merge in every repo (see `protectedPaths`). */
export const DEFAULT_PROTECTED_PATHS = ['.github/', 'AGENTS.md', 'CLAUDE.md', '.claude/', '.codex/']

export const RepoSchema = z
  .object({
    /** Regex tested against `git remote get-url origin` to identify this repo on the Mac. */
    remoteMatch: z.string().min(1),
    github: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    envName: z.string().min(1),
    vmPath: z.string().startsWith('/home/user/'),
    setupScript: z.string().min(1),
    gate: z.string().min(1),
    branchPrefix: z.string().default('codex/'),
    buildRunner: z.enum(['claude', 'codex']).default('claude'),
    buildModel: z.string().min(1).optional(),
    baseBranch: z.string().default('main'),
    worktreeRoot: z.string().startsWith('/home/user/'),
    worktreeInit: z.array(z.string()).default([]),
    services: z.string().optional(),
    ports: z.array(z.number().int().positive()).default([]),
    herdrLabel: z.string().min(1),
    /** The repo's suites need Playwright's own browsers (doctor checks they survive resumes). */
    playwright: z.boolean().default(false),
    /** Exact check/status names required for merge; empty means every observed check must succeed. */
    requiredChecks: z.array(z.string().min(1)).default([]),
    /**
     * GitHub App slugs whose check runs may satisfy a check. A commit status or another app's run
     * can still fail the gate but never pass it: anyone holding a write token can post those.
     */
    checkApps: z.array(z.string().min(1)).default(['github-actions']),
    /**
     * Paths the factory never merges on its own: a PR touching them goes to Needs Input for a
     * human merge. CI runs the workflow version from the PR, so a PR could make its own checks
     * green, and the reviewer reads the agent instruction files from it. An entry ending in "/"
     * matches a directory.
     */
    protectedPaths: z.array(z.string().min(1)).default([...DEFAULT_PROTECTED_PATHS]),
    /** Staging is the default completion contract; merge-only delivery must be explicitly selected. */
    deliveryMode: z.enum(['staging', 'merge']).default('staging'),
    /** GitHub Actions workflow that deploys the merged revision on `baseBranch`. */
    deployWorkflow: z.string().min(1).optional(),
    /** Separate workflow that verifies the deployed revision, started after deployment completes. */
    verifyWorkflow: z.string().min(1).optional(),
    /** Dedicated Boat environment for review; must differ from the builder environment. */
    reviewEnvName: z.string().min(1).optional(),
    /** Factory: merge the PR once CI is green and the automated review has no blocking findings. */
    autoMerge: z.boolean().default(true),
    mergeMethod: z.enum(['squash', 'merge', 'rebase']).default('squash'),
  })
  .refine((repo) => !repo.verifyWorkflow || repo.verifyWorkflow !== repo.deployWorkflow, {
    message: 'verifyWorkflow must be separate from deployWorkflow',
    path: ['verifyWorkflow'],
  })
export type RepoConfig = z.infer<typeof RepoSchema>

const DEFAULT_STATES = {
  ready: 'Ready',
  inProgress: 'In Progress',
  needsInput: 'Needs Input',
  inReview: 'In Review',
  done: 'Done',
  canceled: 'Canceled',
}

const DEFAULT_REVIEW = {
  runner: 'codex' as const,
  isolation: 'sandbox' as const,
  timeoutMinutes: 15,
  maxRounds: 3,
  blocking: ['P0' as const, 'P1' as const],
}

/** The always-on controller that turns Linear issues into tasks (see README "Factory"). */
export const FactorySchema = z.object({
  /** `controller` on the oar-factory VM itself; a `client` forwards `oar factory …` to it over ssh. */
  role: z.enum(['client', 'controller']).default('client'),
  controller: z
    .object({
      name: z.string().default('oar-factory'),
      type: z.enum(['small', 'default', 'large']).default('small'),
      /** The controller's own sandbox id; written into the controller's config by `oar factory setup`. */
      sandboxId: z.string().optional(),
    })
    .default({ name: 'oar-factory', type: 'small' }),
  linear: z
    .object({
      /** Linear team key → repo key. */
      teams: z.record(z.string(), z.string()).default({ ENG: 'engine', CNO: 'cno' }),
      /** Workflow state names per logical state; created by `oar factory setup` when missing. */
      states: z
        .object({
          ready: z.string().default('Ready'),
          inProgress: z.string().default('In Progress'),
          needsInput: z.string().default('Needs Input'),
          inReview: z.string().default('In Review'),
          done: z.string().default('Done'),
          canceled: z.string().default('Canceled'),
        })
        .default(DEFAULT_STATES),
      /** Pasted into question comments so Linear notifies you (a profile URL becomes a mention). */
      mention: z.string().optional(),
    })
    .default({ teams: { ENG: 'engine', CNO: 'cno' }, states: DEFAULT_STATES }),
  /** Agents building at once per repo (one until forks exist). */
  concurrency: z.record(z.string(), z.number().int().positive()).default({}),
  idleStopMinutes: z.number().positive().default(45),
  githubPollSeconds: z.number().int().min(15).default(60),
  maxCiRounds: z.number().int().min(0).default(3),
  jobTimeoutMinutes: z.number().positive().default(30),
  /** Maximum total time waiting for deployment and verification after merge (or a delivery retry). */
  deliveryTimeoutMinutes: z.number().positive().default(180),
  /** Minutes an agent may sit idle without the done marker or a question before it is reported stalled. */
  stallGraceMinutes: z.number().min(0).default(20),
  /** The automated PR review that runs on the repo VM once CI is green (see README "Factory"). */
  review: z
    .object({
      runner: z.enum(['codex', 'claude']).default('codex'),
      /** Fresh reviewer sandbox by default; shared-VM worktrees are an explicit compatibility mode. */
      isolation: z.enum(['sandbox', 'worktree']).default('sandbox'),
      /** Overrides the runner's own default model. */
      model: z.string().optional(),
      timeoutMinutes: z.number().positive().default(15),
      /** Automated review rounds per issue before a human is asked. */
      maxRounds: z.number().int().min(0).default(3),
      /** Severities that block the merge; the rest are advisory. */
      blocking: z.array(z.enum(['P0', 'P1', 'P2', 'P3'])).default(['P0', 'P1']),
    })
    .default(DEFAULT_REVIEW),
  /** A Linear label that stops auto-merge for an issue (case-insensitive). */
  holdLabel: z.string().default('hold'),
})
export type FactoryConfig = z.infer<typeof FactorySchema>

export const DEFAULT_FACTORY: FactoryConfig = FactorySchema.parse({})

const TAILSCALE_CLI =
  process.platform === 'darwin'
    ? '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
    : 'tailscale'

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
      cli: z.string().default(TAILSCALE_CLI),
      tag: z.string().default('tag:oar'),
    })
    .default({
      enabled: false,
      cli: TAILSCALE_CLI,
      tag: 'tag:oar',
    }),
  repos: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,15}$/), RepoSchema),
  factory: FactorySchema.default(DEFAULT_FACTORY),
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
      playwright: true,
      // The four jobs of nodes-engine's CI workflow; all must succeed on the PR head.
      requiredChecks: [
        'Verify',
        'Integration tests',
        'End-to-end tests',
        'Package and drive the desktop app',
      ],
      // A merge to dev packages a staging build; the verify workflow drives that exact revision.
      baseBranch: 'dev',
      deployWorkflow: 'staging.yml',
      verifyWorkflow: 'staging-verify.yml',
      reviewEnvName: 'oar-review',
    },
    cno: {
      remoteMatch: 'nodes-cno|Synapse-Django',
      github: 'Ai-Synapse1/nodes-cno',
      envName: 'cno',
      vmPath: '/home/user/nodes-cno',
      setupScript: 'nodes-cno.sh',
      gate: 'make lint && make test',
      baseBranch: 'dev',
      worktreeRoot: '/home/user/worktrees/cno',
      worktreeInit: ['cp /home/user/nodes-cno/.env .env'],
      ports: [8000],
      herdrLabel: 'cno',
      deployWorkflow: 'staging.yml',
      verifyWorkflow: 'staging-verify.yml',
      reviewEnvName: 'oar-review',
      // Only the `checks` job runs on PRs; `release` is skipped there and must not count.
      requiredChecks: ['checks'],
      // The files that define the gate the `checks` job runs: a PR may not weaken its own gate.
      protectedPaths: [
        ...DEFAULT_PROTECTED_PATHS,
        'Makefile',
        'setup.cfg',
        'pyproject.toml',
        '.pre-commit-config.yaml',
        'deploy/local/compose.test.yml',
      ],
    },
  },
})

/**
 * Stored configs are not re-merged with the shipped defaults. For repos whose default deploys
 * staging from its base branch (cno → dev), fill in the deploy workflow and align the base branch.
 * Mutates `config`; returns one note per change.
 */
export function backfillRepoDefaults(config: Config): string[] {
  const notes: string[] = []
  for (const [name, repo] of Object.entries(config.repos)) {
    const d = DEFAULT_CONFIG.repos[name]
    if (!d) continue
    if (d.deployWorkflow) {
      if (!repo.deployWorkflow) {
        repo.deployWorkflow = d.deployWorkflow
        notes.push(`${name}.deployWorkflow = ${d.deployWorkflow}`)
      }
      if (repo.baseBranch !== d.baseBranch) {
        notes.push(`${name}.baseBranch ${repo.baseBranch} → ${d.baseBranch}`)
        repo.baseBranch = d.baseBranch
      }
    }
    for (const field of ['verifyWorkflow', 'reviewEnvName'] as const) {
      if (!repo[field] && d[field]) {
        repo[field] = d[field]
        notes.push(`${name}.${field} = ${d[field]}`)
      }
    }
    // An empty list means "every observed check", which counts a skipped job as a failure.
    if (!repo.requiredChecks.length && d.requiredChecks.length) {
      repo.requiredChecks = [...d.requiredChecks]
      notes.push(`${name}.requiredChecks = ${d.requiredChecks.join(', ')}`)
    }
    // A stored entry still on the generic list takes the repo's own protected paths.
    const generic = JSON.stringify(DEFAULT_PROTECTED_PATHS)
    if (
      JSON.stringify(repo.protectedPaths) === generic &&
      JSON.stringify(d.protectedPaths) !== generic
    ) {
      repo.protectedPaths = [...d.protectedPaths]
      notes.push(`${name}.protectedPaths = ${d.protectedPaths.join(', ')}`)
    }
    // A repo whose shipped default has no staging completes on merge; a stored entry predating
    // `deliveryMode` would otherwise wait for a deployment that never comes.
    if (d.deliveryMode === 'merge' && !repo.deployWorkflow && repo.deliveryMode !== 'merge') {
      repo.deliveryMode = 'merge'
      notes.push(`${name}.deliveryMode = merge (no staging)`)
    }
  }
  return notes
}

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
  /** Linear OAuth application (client credentials): the controller's own identity. */
  LINEAR_CLIENT_ID?: string
  LINEAR_CLIENT_SECRET?: string
  /** Fallback: a personal Linear API key (comments then look like yours). */
  LINEAR_API_KEY?: string
  /** Optional GitHub token for the controller's `gh` (boat's injected token is invisible to systemd). */
  GH_TOKEN?: string
}

const OPTIONAL_SECRETS = [
  'TS_AUTHKEY',
  'LINEAR_CLIENT_ID',
  'LINEAR_CLIENT_SECRET',
  'LINEAR_API_KEY',
  'GH_TOKEN',
] as const

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
  const out: Secrets = { BOAT_API_KEY: key }
  for (const name of OPTIONAL_SECRETS) {
    const v = env[name] || fromFile[name]
    if (v) {
      registerSecret(v)
      out[name] = v
    }
  }
  return out
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
