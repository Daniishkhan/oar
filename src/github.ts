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
    'number,url,isDraft,state,headRefOid,mergeCommit,updatedAt',
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
  }
}

export async function macGhOk(exec: Exec): Promise<boolean> {
  return (
    (await exec.run('gh', ['auth', 'status', '-h', 'github.com'], { timeoutMs: 20_000 })).code === 0
  )
}
