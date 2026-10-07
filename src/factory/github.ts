import { z } from 'zod'
import type { BoatClient } from '../boat.js'
import type { RepoConfig } from '../config.js'
import type { Exec } from '../exec.js'
import { ghJson } from '../github.js'
import type { ReviewComment } from './types.js'

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
const CheckRuns = z.looseObject({
  check_runs: z.array(
    z.looseObject({
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullable().default(null),
    }),
  ),
})
const WorkflowRuns = z.looseObject({
  workflow_runs: z.array(
    z.looseObject({
      status: z.string(),
      conclusion: z.string().nullable().default(null),
      html_url: z.string().default(''),
      head_sha: z.string().default(''),
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
 * non-bot comment counts as feedback.
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
    if (isBot(login, p.data.user?.type ?? 'User')) continue
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
    if (isBot(login, p.data.user?.type ?? 'User') || !p.data.body) continue
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
    if (isBot(login, p.data.user?.type ?? 'User') || !p.data.body) continue
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
  pending: boolean
  passed: boolean
}

export async function checkRuns(gh: GhFeed, sha: string): Promise<CheckSummary | null> {
  const [o, r] = gh.repo.github.split('/')
  const json = await gh.api(`repos/${o}/${r}/commits/${sha}/check-runs?per_page=100`)
  const p = CheckRuns.safeParse(json)
  if (!p.success) return null
  const runs = p.data.check_runs
  const failed = runs
    .filter(
      (c) =>
        c.status === 'completed' &&
        ['failure', 'timed_out', 'cancelled'].includes(c.conclusion ?? ''),
    )
    .map((c) => c.name)
  const pending = runs.some((c) => c.status !== 'completed')
  return { headSha: sha, failed, pending, passed: runs.length > 0 && !pending && !failed.length }
}

export interface RunSummary {
  status: string
  conclusion: string | null
  url: string
}

/** The deploy workflow's run for a merge commit on the base branch, if it has started. */
export async function workflowRun(
  gh: GhFeed,
  workflowFile: string,
  sha: string,
  branch: string,
): Promise<RunSummary | null> {
  const [o, r] = gh.repo.github.split('/')
  const json = await gh.api(
    `repos/${o}/${r}/actions/workflows/${workflowFile}/runs?head_sha=${sha}&branch=${encodeURIComponent(branch)}&per_page=5`,
  )
  const p = WorkflowRuns.safeParse(json)
  const run = p.success ? p.data.workflow_runs[0] : undefined
  return run ? { status: run.status, conclusion: run.conclusion, url: run.html_url } : null
}
