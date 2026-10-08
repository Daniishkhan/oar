import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import { runCommand, type BoatClient } from './boat.js'
import type { RepoConfig } from './config.js'
import { shq, type Exec } from './exec.js'
import type { PrSnapshot } from './factory/types.js'
import type { PrInfo } from './state.js'

const PrList = z.array(
  z.looseObject({
    number: z.number().int(),
    url: z.string(),
    isDraft: z.boolean().default(false),
    state: z.string().default('OPEN'),
  }),
)

const parsePrs = (json: string): PrInfo[] => {
  const parsed = PrList.safeParse(JSON.parse(json))
  return parsed.success ? parsed.data : []
}

const ghArgs = (repo: RepoConfig, branch: string) => [
  'pr',
  'list',
  '--repo',
  repo.github,
  '--head',
  branch,
  '--state',
  'all',
  '--json',
  'number,url,isDraft,state',
]

/** The PR for a branch: Mac `gh` first, the VM's `gh` (boat-injected GITHUB_TOKEN) when that fails. */
export async function prForBranch(
  exec: Exec,
  boat: BoatClient | null,
  sandboxId: string | null,
  repo: RepoConfig,
  branch: string,
): Promise<PrInfo | null> {
  const local = await exec.run('gh', ghArgs(repo, branch), { timeoutMs: 30_000 })
  if (local.code === 0) {
    try {
      return parsePrs(local.stdout)[0] ?? null
    } catch {
      /* fall through to the VM */
    }
  }
  if (!boat || !sandboxId) return null
  const cmd = `gh ${ghArgs(repo, branch).map(shq).join(' ')}`
  const r = await runCommand(boat, sandboxId, cmd, { cwd: repo.vmPath, timeoutSeconds: 60 }).catch(
    () => null,
  )
  if (!r || r.exitCode !== 0) return null
  try {
    return parsePrs(r.stdout)[0] ?? null
  } catch {
    return null
  }
}

/** Run `gh` here first, then on the VM (boat-injected GITHUB_TOKEN). Null when both fail. */
export async function ghJson(
  exec: Exec,
  boat: BoatClient | null,
  sandboxId: string | null,
  repo: RepoConfig,
  args: string[],
): Promise<unknown | null> {
  const local = await exec.run('gh', args, { timeoutMs: 30_000 })
  if (local.code === 0) {
    try {
      return JSON.parse(local.stdout) as unknown
    } catch {
      /* fall through to the VM */
    }
  }
  if (!boat || !sandboxId) return null
  const r = await runCommand(boat, sandboxId, `gh ${args.map(shq).join(' ')}`, {
    cwd: repo.vmPath,
    timeoutSeconds: 60,
  }).catch(() => null)
  if (!r || r.exitCode !== 0) return null
  try {
    return JSON.parse(r.stdout) as unknown
  } catch {
    return null
  }
}

const SnapshotList = z.array(
  z.looseObject({
    number: z.number().int(),
    url: z.string(),
    isDraft: z.boolean().default(false),
    state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
    headRefOid: z.string().default(''),
    mergeCommit: z.looseObject({ oid: z.string() }).nullable().optional(),
    updatedAt: z.string().default(''),
    reviewDecision: z.string().nullable().default(''),
    mergeable: z.string().nullable().default('UNKNOWN'),
  }),
)

/** What the factory needs to know about a branch's PR: state, head SHA, merge commit. */
export async function prSnapshot(
  exec: Exec,
  boat: BoatClient | null,
  sandboxId: string | null,
  repo: RepoConfig,
  branch: string,
): Promise<PrSnapshot | null> {
  const json = await ghJson(exec, boat, sandboxId, repo, [
    'pr',
    'list',
    '--repo',
    repo.github,
    '--head',
    branch,
    '--state',
    'all',
    '--json',
    'number,url,isDraft,state,headRefOid,mergeCommit,updatedAt,reviewDecision,mergeable',
  ])
  if (json === null) return null
  const parsed = SnapshotList.safeParse(json)
  const pr = parsed.success ? parsed.data[0] : undefined
  if (!pr) return null
  return {
    number: pr.number,
    url: pr.url,
    isDraft: pr.isDraft,
    state: pr.state,
    headSha: pr.headRefOid,
    mergeSha: pr.mergeCommit?.oid ?? null,
    updatedAt: pr.updatedAt,
    reviewDecision: pr.reviewDecision ?? '',
    mergeable: pr.mergeable ?? 'UNKNOWN',
  }
}

export interface GhRunResult {
  ok: boolean
  stdout: string
  stderr: string
  via: 'local' | 'vm'
}

/** gh here is missing or not logged in, as opposed to gh refusing the request itself. */
const GH_UNAVAILABLE =
  /not logged in|gh auth login|GH_TOKEN|authentication|HTTP 401|Bad credentials/i

/**
 * A `gh` command that is not a JSON read (pr comment, pr ready, pr merge). Runs here first and on
 * the VM only when gh here is missing or unauthenticated: a refusal (a conflict, a moved head) is
 * not retried under another login. `input` goes to stdin; on the VM it is written to a file that
 * replaces the `-` argument. Runs outside any checkout so `--delete-branch` touches only the remote.
 */
export async function ghRun(
  exec: Exec,
  boat: BoatClient | null,
  sandboxId: string | null,
  args: string[],
  opts: { input?: string } = {},
): Promise<GhRunResult> {
  const local = await exec.run('gh', args, { input: opts.input, cwd: tmpdir(), timeoutMs: 90_000 })
  if (local.code === 0)
    return { ok: true, stdout: local.stdout, stderr: local.stderr, via: 'local' }
  const unavailable = local.code === 127 || GH_UNAVAILABLE.test(local.stderr)
  if (!unavailable || !boat || !sandboxId)
    return { ok: false, stdout: local.stdout, stderr: local.stderr, via: 'local' }
  let vmArgs = args
  if (opts.input !== undefined) {
    const path = `/home/user/oar/gh-input-${createHash('sha1').update(opts.input).digest('hex').slice(0, 12)}.txt`
    await boat.writeFile(sandboxId, path, opts.input)
    vmArgs = args.map((a) => (a === '-' ? path : a))
  }
  const r = await runCommand(boat, sandboxId, `gh ${vmArgs.map(shq).join(' ')}`, {
    timeoutSeconds: 120,
  }).catch((e: Error) => ({ exitCode: null, stdout: '', stderr: e.message, timedOut: false }))
  return { ok: r.exitCode === 0, stdout: r.stdout, stderr: r.stderr, via: 'vm' }
}

export async function macGhOk(exec: Exec): Promise<boolean> {
  return (
    (await exec.run('gh', ['auth', 'status', '-h', 'github.com'], { timeoutMs: 20_000 })).code === 0
  )
}
