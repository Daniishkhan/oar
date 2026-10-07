import { vmDoneMarker } from '../brief.js'
import { repoConfig } from '../config.js'
import type { Ctx } from '../context.js'
import { prSnapshot } from '../github.js'
import { agentState, readAgent, type LiveAgent } from '../runner.js'
import { loadState, type Task } from '../state.js'
import { cleanTail, questionPath } from './brief.js'
import type { FactoryDb } from './db.js'
import { checkRuns, GhFeed, reviewFeed, workflowRun } from './github.js'
import type { Jobs } from './jobs.js'
import { SLOT_PHASES, type Facts, type IssueRow, type StateKey } from './types.js'

export interface ObserveDeps {
  db: FactoryDb
  jobs: Jobs
  /** Linear state name/type → our logical state. */
  stateKeyOf(name: string, type: string): StateKey | 'other'
  concurrency(repo: string): number
  /** Sandbox state per repo, fetched once per tick; `null` = no VM recorded. */
  vmState(repo: string): 'up' | 'changing' | 'down' | null
  sandboxId(repo: string): string | null
  /** The expensive GitHub reads (reviews, checks, deploy runs) happen only on these ticks. */
  githubDue: boolean
}

const DONE_TYPES = new Set(['completed', 'canceled'])

/** Everything `decide` needs about one issue, read without side effects. */
export async function observeIssue(ctx: Ctx, row: IssueRow, deps: ObserveDeps): Promise<Facts> {
  const nowIso = new Date(ctx.now()).toISOString()
  const vmState = deps.vmState(row.repo)
  const facts: Facts = {
    vmUp: vmState === null ? null : vmState !== 'down',
    agent: null,
    pr: null,
    marker: false,
    question: null,
    paneTail: '',
    undelivered: deps.db.undelivered(row.id),
    review: { comments: [], changesRequested: false, cursor: row.reviewCursor },
    ci: null,
    staging: null,
    linearKey: deps.stateKeyOf(row.linearState, row.linearStateType),
    humanMoved: row.linearState !== row.lastSetState,
    nowIso,
    slotFree: deps.db.countInPhases(row.repo, SLOT_PHASES) < deps.concurrency(row.repo),
    jobRunning: deps.jobs.has(row.id),
    jobAgeMs: row.jobStartedAt ? Math.max(0, ctx.now() - Date.parse(row.jobStartedAt)) : 0,
    blocked: row.blockedBy.some((id) => {
      const b = deps.db.issue(id)
      return Boolean(b && !DONE_TYPES.has(b.linearStateType))
    }),
  }
  if (!row.taskId) return facts
  const task: Task | undefined = loadState(ctx.paths).tasks[row.taskId]
  if (!task) return facts
  const cfg = repoConfig(ctx.config, row.repo)
  const sandboxId = deps.sandboxId(row.repo)
  const gh = new GhFeed(ctx.exec, ctx.boat, sandboxId, cfg)

  // The PR is cheap (one `gh pr list`) and decides merges, so it is read on every tick.
  if (row.phase !== 'merged')
    facts.pr = await prSnapshot(ctx.exec, ctx.boat, sandboxId, cfg, task.branch).catch(() => null)

  if (vmState === 'down' || !sandboxId) {
    facts.agent = 'vm-down'
  } else if (vmState === 'changing') {
    // boat is resuming, updating or snapshotting the VM: nothing can be read; wait a tick.
    facts.agent = 'unknown'
  } else if (task.handle?.runner === 'herdr') {
    const handle = task.handle
    const { status } = await agentState(ctx, cfg, handle).catch(() => ({
      status: 'unknown' as LiveAgent,
      info: null,
    }))
    facts.agent = status
    if (row.phase === 'building' || row.phase === 'needs_input') {
      facts.marker =
        (await ctx.boat.readFile(sandboxId, vmDoneMarker(task.id)).catch(() => null)) !== null
      if (status !== 'working')
        facts.question = await ctx.boat.readFile(sandboxId, questionPath(task.id)).catch(() => null)
    }
    if (status !== 'working' && status !== 'exited' && status !== 'unknown')
      facts.paneTail = cleanTail(await readAgent(ctx, cfg, handle, 60).catch(() => ''))
  }

  if (deps.githubDue && facts.pr && row.phase === 'review') {
    facts.review = await reviewFeed(gh, facts.pr.number, row.reviewCursor).catch(() => facts.review)
    const ci = await checkRuns(gh, facts.pr.headSha).catch(() => null)
    if (ci) facts.ci = { headSha: ci.headSha, failed: ci.failed, pending: ci.pending }
  }
  if (deps.githubDue && row.phase === 'merged' && cfg.deployWorkflow && row.roundStartSha) {
    const run = await workflowRun(gh, cfg.deployWorkflow, row.roundStartSha, cfg.baseBranch).catch(
      () => null,
    )
    facts.staging = run
      ? { conclusion: run.status === 'completed' ? run.conclusion : null, url: run.url }
      : null
  }
  return facts
}
