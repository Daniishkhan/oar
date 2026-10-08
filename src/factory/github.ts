import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { BoatClient } from '../boat.js'
import type { RepoConfig } from '../config.js'
import type { Exec } from '../exec.js'
import { ghJson } from '../github.js'
import type { ReviewComment, WorkflowSnapshot } from './types.js'

/** `gh api …` for one repo, run here first and on the worker VM when that fails. */
export class GhFeed {
  constructor(
    private readonly exec: Exec,
    private readonly boat: BoatClient | null,
    private readonly sandboxId: string | null,
    readonly repo: RepoConfig,
  ) {}

  api(path: string, paginate = false): Promise<unknown | null> {
    return ghJson(this.exec, this.boat, this.sandboxId, this.repo, [
      'api',
      ...(paginate ? ['--paginate', '--slurp'] : []),
      path,
    ])
  }
}

const User = z.looseObject({ login: z.string().default(''), type: z.string().default('User') })
const Review = z.looseObject({
  id: z.number(),
  state: z.string(),
  body: z.string().nullable().default(''),
  submitted_at: z.string().nullable().default(null),
  user: User.nullable().default(null),
})
const IssueComment = z.looseObject({
  id: z.number(),
  body: z.string().nullable().default(''),
  created_at: z.string(),
  user: User.nullable().default(null),
  path: z.string().optional(),
  line: z.number().nullable().optional(),
  original_line: z.number().nullable().optional(),
})
const CheckRun = z.looseObject({
  id: z.number(),
  name: z.string(),
  head_sha: z.string(),
  app: z.looseObject({ id: z.number(), slug: z.string().default('') }).optional(),
  check_suite: z.looseObject({ id: z.number() }).optional(),
  status: z.string(),
  conclusion: z.string().nullable().default(null),
})
const CheckRuns = z.looseObject({ check_runs: z.array(CheckRun) })
const CommitStatus = z.looseObject({
  id: z.number(),
  context: z.string(),
  state: z.string(),
})
const WorkflowRuns = z.looseObject({
  workflow_runs: z.array(
    z.looseObject({
      id: z.number(),
      run_attempt: z.number().default(1),
      status: z.string(),
      conclusion: z.string().nullable().default(null),
      html_url: z.string().default(''),
      head_sha: z.string(),
      head_branch: z.string(),
      display_title: z.string().default(''),
      run_started_at: z.string().nullable().default(null),
      updated_at: z.string().nullable().default(null),
    }),
  ),
})

/** `--paginate --slurp` wraps pages in an array; a single page comes back unwrapped. A failed fetch throws so the caller keeps its cursor. */
const flatten = (json: unknown): unknown[] => {
  if (json === null) throw new Error('gh api failed')
  if (!Array.isArray(json)) return []
  return json.flatMap((page) => (Array.isArray(page) ? page : [page]))
}

const isBot = (login: string, type: string) => type === 'Bot' || login.endsWith('[bot]')

/** Marks the controller's own PR comments (it posts under the same GitHub login as the human). */
export const OAR_MARKER = '<!-- oar -->'
const ours = (body: string | null | undefined) => Boolean(body?.includes(OAR_MARKER))
const after = (iso: string, since: string | null) => !since || iso > since

export interface ReviewFeed {
  comments: ReviewComment[]
  changesRequested: boolean
  /** The newest comment time seen; becomes the next cursor. */
  cursor: string | null
}

/**
 * Everything a human said on the PR since `since`: review summaries, inline comments and
 * conversation comments. The agent never writes on the PR (it reports on the issue), so every
 * non-bot comment counts as feedback, except the controller's own (marked with OAR_MARKER).
 */
export async function reviewFeed(
  gh: GhFeed,
  number: number,
  since: string | null,
): Promise<ReviewFeed> {
  const [o, r] = gh.repo.github.split('/')
  const out: ReviewComment[] = []
  let changesRequested = false
  const reviews = flatten(await gh.api(`repos/${o}/${r}/pulls/${number}/reviews`, true))
  for (const raw of reviews) {
    const p = Review.safeParse(raw)
    if (!p.success || !p.data.submitted_at) continue
    const login = p.data.user?.login ?? ''
    if (isBot(login, p.data.user?.type ?? 'User') || ours(p.data.body)) continue
    if (p.data.state === 'CHANGES_REQUESTED' && after(p.data.submitted_at, since))
      changesRequested = true
    if (p.data.body && after(p.data.submitted_at, since)) {
      out.push({
        id: `review-${p.data.id}`,
        author: login,
        body: p.data.body,
        createdAt: p.data.submitted_at,
        kind: 'review',
      })
    }
  }
  const sinceQ = since ? `?since=${encodeURIComponent(since)}` : ''
  const inline = flatten(await gh.api(`repos/${o}/${r}/pulls/${number}/comments${sinceQ}`, true))
  for (const raw of inline) {
    const p = IssueComment.safeParse(raw)
    if (!p.success || !after(p.data.created_at, since)) continue
    const login = p.data.user?.login ?? ''
    if (isBot(login, p.data.user?.type ?? 'User') || !p.data.body || ours(p.data.body)) continue
    out.push({
      id: `inline-${p.data.id}`,
      author: login,
      body: p.data.body,
      createdAt: p.data.created_at,
      kind: 'inline',
      path: p.data.path,
      line: p.data.line ?? p.data.original_line ?? undefined,
    })
  }
  const conv = flatten(await gh.api(`repos/${o}/${r}/issues/${number}/comments${sinceQ}`, true))
  for (const raw of conv) {
    const p = IssueComment.safeParse(raw)
    if (!p.success || !after(p.data.created_at, since)) continue
    const login = p.data.user?.login ?? ''
    if (isBot(login, p.data.user?.type ?? 'User') || !p.data.body || ours(p.data.body)) continue
    out.push({
      id: `conv-${p.data.id}`,
      author: login,
      body: p.data.body,
      createdAt: p.data.created_at,
      kind: 'conversation',
    })
  }
  out.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const cursor = out.length ? out[out.length - 1]!.createdAt : since
  return { comments: out, changesRequested, cursor }
}

export interface CheckSummary {
  headSha: string
  failed: string[]
  missing: string[]
  pending: boolean
  passed: boolean
  checks: Array<{ name: string; state: string; source: 'check' | 'status'; app?: string }>
}

/** Fetch every page, including legacy status contexts. Any failed read blocks the gate. */
export async function checkRuns(gh: GhFeed, sha: string): Promise<CheckSummary | null> {
  const [o, r] = gh.repo.github.split('/')
  const [runJson, statusJson] = await Promise.all([
    gh.api(`repos/${o}/${r}/commits/${sha}/check-runs?filter=latest&per_page=100`, true),
    gh.api(`repos/${o}/${r}/commits/${sha}/statuses?per_page=100`, true),
  ])
  if (runJson === null || !Array.isArray(statusJson)) return null
  const runPages = z.array(CheckRuns).safeParse(Array.isArray(runJson) ? runJson : [runJson])
  const statuses = z.array(CommitStatus).safeParse(flatten(statusJson))
  if (!runPages.success || !statuses.success) return null
  const runs = runPages.data.flatMap((page) => page.check_runs)
  if (runs.some((run) => run.head_sha !== sha)) return null
  // GitHub returns status history, so retain the newest entry per context; likewise rerun checks.
  const latestRuns = new Map<string, z.infer<typeof CheckRun>>()
  for (const run of runs) {
    // A rerun replaces its predecessor within one check suite; a same-named job in another
    // workflow (another suite) is a separate check and must not mask it.
    const key = `${run.app?.id ?? 'unknown'}:${run.check_suite?.id ?? 'suite'}:${run.name}`
    if (!latestRuns.has(key) || latestRuns.get(key)!.id < run.id) latestRuns.set(key, run)
  }
  const latestStatuses = new Map<string, z.infer<typeof CommitStatus>>()
  for (const status of statuses.data) {
    if (!latestStatuses.has(status.context) || latestStatuses.get(status.context)!.id < status.id)
      latestStatuses.set(status.context, status)
  }
  const checks: CheckSummary['checks'] = [
    ...[...latestRuns.values()].map((run) => ({
      name: run.name,
      state: run.status === 'completed' ? (run.conclusion ?? 'unknown') : 'pending',
      source: 'check' as const,
      app: run.app?.slug ?? '',
    })),
    ...[...latestStatuses.values()].map((status) => ({
      name: status.context,
      state: status.state,
      source: 'status' as const,
    })),
  ]
  // Only a check run from a trusted GitHub App can satisfy a check: a commit status, or a check
  // run from any other app, can be posted by whoever holds a write token (the builder does).
  // Every source can still fail the gate.
  const trusted = new Set(gh.repo.checkApps)
  const trustedRun = (c: CheckSummary['checks'][number]) =>
    c.source === 'check' && trusted.has(c.app ?? '')
  const required = gh.repo.requiredChecks
  const selected = required.length
    ? checks.filter((check) => required.includes(check.name))
    : checks
  const names = required.length
    ? required
    : [...new Set(checks.filter(trustedRun).map((c) => c.name))]
  const missing = names.filter((name) => !checks.some((c) => c.name === name && trustedRun(c)))
  const failed = [
    ...new Set(
      selected.filter((c) => !['success', 'pending'].includes(c.state)).map((c) => c.name),
    ),
  ]
  const pending = missing.length > 0 || selected.some((c) => c.state === 'pending')
  const satisfied = names.every((name) =>
    checks.some((c) => c.name === name && trustedRun(c) && c.state === 'success'),
  )
  return {
    headSha: sha,
    failed,
    missing,
    pending,
    passed: names.length > 0 && !pending && !failed.length && satisfied,
    checks,
  }
}

export type RunSummary = WorkflowSnapshot

/** Latest run for this exact merged revision and branch; never trust the server filter alone. */
export async function workflowRun(
  gh: GhFeed,
  workflowFile: string,
  sha: string,
  branch: string,
  requestKey?: string,
): Promise<RunSummary | null> {
  const [o, r] = gh.repo.github.split('/')
  const json = await gh.api(
    `repos/${o}/${r}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?head_sha=${sha}&branch=${encodeURIComponent(branch)}&per_page=100`,
    true,
  )
  if (json === null) return null
  const p = z.array(WorkflowRuns).safeParse(Array.isArray(json) ? json : [json])
  if (!p.success) return null
  const run = p.data
    .flatMap((page) => page.workflow_runs)
    .filter(
      (candidate) =>
        candidate.head_sha === sha &&
        candidate.head_branch === branch &&
        (!requestKey || candidate.display_title.includes(`[oar:${requestKey}]`)),
    )
    .sort((a, b) => b.id - a.id || b.run_attempt - a.run_attempt)[0]
  return run
    ? {
        headSha: run.head_sha,
        status: run.status,
        conclusion: run.conclusion,
        url: run.html_url,
        runId: run.id,
        attempt: run.run_attempt,
        startedAt: run.run_started_at,
        completedAt: run.status === 'completed' ? run.updated_at : null,
        runName: run.display_title,
      }
    : null
}

/** Stable within one delivery attempt; a human retry opens a fresh attempt window. */
export function verificationRequestKey(
  issueId: string,
  sha: string,
  deploymentRunId: number,
  deploymentAttempt: number,
  startedAt: string | null,
): string {
  return `oar-verify-${createHash('sha256')
    .update(JSON.stringify([issueId, sha, deploymentRunId, deploymentAttempt, startedAt]))
    .digest('hex')
    .slice(0, 24)}`
}

const PrFile = z.looseObject({ filename: z.string(), previous_filename: z.string().optional() })

/** Every path the PR touches, with the old name of a rename. Null when the list could not be read. */
export async function prFiles(gh: GhFeed, number: number): Promise<string[] | null> {
  const [o, r] = gh.repo.github.split('/')
  const json = await gh.api(`repos/${o}/${r}/pulls/${number}/files?per_page=100`, true)
  if (json === null) return null
  const p = z.array(z.array(PrFile)).safeParse(Array.isArray(json) ? json : [json])
  if (!p.success) return null
  return [
    ...new Set(
      p.data
        .flat()
        .flatMap((f) => [f.filename, ...(f.previous_filename ? [f.previous_filename] : [])]),
    ),
  ]
}

/** The touched paths that match a protected entry: a directory when the entry ends in "/". */
export function protectedChanges(files: readonly string[], patterns: readonly string[]): string[] {
  return files.filter((file) =>
    patterns.some((p) => (p.endsWith('/') ? file.startsWith(p) : file === p)),
  )
}
