import { z } from 'zod'
import { runCommand, type BoatClient } from './boat.js'
import type { RepoConfig } from './config.js'
import { shq, type Exec } from './exec.js'
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

export async function macGhOk(exec: Exec): Promise<boolean> {
  return (
    (await exec.run('gh', ['auth', 'status', '-h', 'github.com'], { timeoutMs: 20_000 })).code === 0
  )
}
