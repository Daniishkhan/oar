import { vmDoneMarker } from '../brief.js'
import { repoConfig } from '../config.js'
import type { Ctx } from '../context.js'
import { prSnapshot } from '../github.js'
import { agentState, readAgent, type LiveAgent } from '../runner.js'
import { loadState, type Task } from '../state.js'
import { cleanTail, questionPath } from './brief.js'
import type { FactoryDb } from './db.js'
import {
  checkRuns,
  GhFeed,
  prFiles,
  protectedChanges,
  reviewFeed,
  verificationRequestKey,
  workflowRun,
} from './github.js'
import type { Jobs } from './jobs.js'
import { DELIVERY_PHASES, SLOT_PHASES, type Facts, type IssueRow, type StateKey } from './types.js'

/** True while another issue of the repo holds the base branch between merge and verified delivery. */
export function deliveryBusy(
  db: FactoryDb,
  row: Pick<IssueRow, 'id' | 'repo'>,
  mode: 'staging' | 'merge',
): boolean {
  if (mode !== 'staging') return false
  return db
    .allIssues()
    .some(
      (other) =>
        other.id !== row.id &&
        other.repo === row.repo &&
        (DELIVERY_PHASES.has(other.phase) ||
          (['review', 'needs_input'].includes(other.phase) && Boolean(other.mergeSha))),
    )
}

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
    verification: null,
    verificationRequested: false,
    linearKey: deps.stateKeyOf(row.linearState, row.linearStateType),
    humanMoved: row.linearState !== row.lastSetState,
    nowIso,
    slotFree: deps.db.countInPhases(row.repo, SLOT_PHASES) < deps.concurrency(row.repo),
    deliveryBusy: false,
    protectedChanges: null,
    jobRunning: deps.jobs.has(row.id),
    jobAgeMs: row.jobStartedAt ? Math.max(0, ctx.now() - Date.parse(row.jobStartedAt)) : 0,
    blocked: row.blockedBy.some((id) => {
      const b = deps.db.issue(id)
      return Boolean(b && !DONE_TYPES.has(b.linearStateType))
    }),
    idleForMs: 0,
  }
  const cfg = repoConfig(ctx.config, row.repo)
  facts.deliveryBusy = deliveryBusy(deps.db, row, cfg.deliveryMode)
  const sandboxId = deps.sandboxId(row.repo)
  const gh = new GhFeed(ctx.exec, ctx.boat, sandboxId, cfg)
  if (DELIVERY_PHASES.has(row.phase)) {
    if (deps.githubDue && row.roundStartSha) {
      const deployment = cfg.deployWorkflow
        ? await workflowRun(gh, cfg.deployWorkflow, row.roundStartSha, cfg.baseBranch).catch(
            () => null,
          )
        : null
      facts.staging = deployment
      if (deployment && cfg.verifyWorkflow) {
        const requestKey = verificationRequestKey(
          row.id,
          row.roundStartSha,
          deployment.runId,
          deployment.attempt,
          row.roundStartedAt,
        )
        facts.verificationRequested = deps.db
          .evidence(row.id)
          .some((e) => e.stage === 'verification-dispatch' && e.data.requestKey === requestKey)
        if (facts.verificationRequested)
          facts.verification = await workflowRun(
            gh,
            cfg.verifyWorkflow,
            row.roundStartSha,
            cfg.baseBranch,
            requestKey,
          ).catch(() => null)
      }
    }
    return facts
  }
  if (!row.taskId) return facts
  const task: Task | undefined = loadState(ctx.paths).tasks[row.taskId]
  if (!task) return facts

  // The PR is cheap (one `gh pr list`) and decides merges, so it is read on every tick.
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
    if (ci) facts.ci = ci
    if (ci?.passed) {
      const files = await prFiles(gh, facts.pr.number).catch(() => null)
      facts.protectedChanges = files ? protectedChanges(files, cfg.protectedPaths) : null
    }
  }
  return facts
}
