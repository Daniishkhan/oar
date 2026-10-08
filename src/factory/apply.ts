import { readFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { ensureDeadline, runCommand } from '../boat.js'
import { validateSlug, vmDoneMarker, writeBrief } from '../brief.js'
import { dispatchTask } from '../commands/task.js'
import { ensureUp } from '../commands/vm.js'
import { repoConfig, type RepoConfig } from '../config.js'
import type { Ctx } from '../context.js'
import { OarError } from '../errors.js'
import { redact, scrubSecrets, shq } from '../exec.js'
import { ghRun, prSnapshot } from '../github.js'
import {
  promptAgent,
  resumeHerdr,
  stopAgent,
  taskAgentIdentity,
  type HerdrHandle,
} from '../runner.js'
import { loadState, mutateState, type Task } from '../state.js'
import { hoursFromNow, nowIso } from '../time.js'
import {
  factoryFooter,
  issueBrief,
  type ParentPlan,
  questionPath,
  reviewBrief,
  reviewPath,
  roundToken,
} from './brief.js'
import type { FactoryDb } from './db.js'
import { checkRuns, GhFeed, verificationRequestKey } from './github.js'
import type { Jobs } from './jobs.js'
import { LinearClient, LinearError, newCommentId } from './linear.js'
import { deliveryBusy } from './observe.js'
import {
  findingsComment,
  findingsLine,
  findingsSummary,
  parseReviewOutput,
  REVIEW_SCHEMA,
  reviewCheckout,
  reviewCommand,
  reviewFiles,
  reviewPrompt,
  reviewWorktree,
  verdictOf,
  type ReviewOutput,
} from './review.js'
import { runIsolatedReview } from './review-sandbox.js'
import type {
  Action,
  HumanComment,
  IssueRow,
  MergeMethod,
  ReviewComment,
  ReviewVerdict,
  StateKey,
} from './types.js'

export interface ApplyDeps {
  db: FactoryDb
  jobs: Jobs
  linear: LinearClient
  stateNames: Record<StateKey, string>
  stateId(team: string, key: StateKey): Promise<string>
  mention?: string
  log: (line: string) => void
}

const STATE_TYPES: Record<StateKey, string> = {
  ready: 'unstarted',
  inProgress: 'started',
  needsInput: 'started',
  inReview: 'started',
  done: 'completed',
  canceled: 'canceled',
}

const firstLine = (e: unknown) => ((e as Error).message ?? String(e)).split('\n')[0] ?? ''

/** Registered secrets and GitHub tokens out, last lines only: safe to post on an issue. */
const scrub = (text: string, lines = 6) =>
  scrubSecrets(text).trim().split('\n').slice(-lines).join('\n')

const kebab = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

/** `eng-12-fix-the-thing` (≤ 27 chars, valid Herdr agent name) and a deterministic id from the issue id. */
export function taskIdentity(row: IssueRow): { slug: string; id: string } {
  const base = row.identifier.toLowerCase()
  const room = 27 - base.length - 1
  const title = room > 1 ? kebab(row.title).slice(0, room).replace(/-+$/, '') : ''
  const slug = validateSlug(title ? `${base}-${title}` : base.length >= 2 ? base : `${base}-x`)
  const hash = createHash('sha1').update(row.id).digest('hex').slice(0, 4)
  return { slug, id: `${slug}-${hash}` }
}

const taskFor = (ctx: Ctx, row: IssueRow): Task | undefined =>
  row.taskId ? loadState(ctx.paths).tasks[row.taskId] : undefined

/** The oar task for an issue, created on first use; the brief is rewritten with the latest discussion. */
async function ensureTask(
  ctx: Ctx,
  row: IssueRow,
  cfg: RepoConfig,
  db: FactoryDb,
  parent: ParentPlan | null,
): Promise<Task> {
  const { slug, id } = taskIdentity(row)
  const brief = issueBrief(row, db.commentsFor(row.id), row.repo, parent)
  const briefPath = writeBrief(ctx.paths, id, brief)
  const existing = loadState(ctx.paths).tasks[id]
  if (existing) return existing
  const task: Task = {
    id,
    repo: row.repo,
    slug,
    branch: `${cfg.branchPrefix}${slug}`,
    worktreePath: `${cfg.worktreeRoot}/${slug}`,
    status: 'draft',
    hours: ctx.config.defaults.keepHours,
    createdAt: nowIso(),
    briefPath,
    runner: 'herdr',
  }
  await mutateState(ctx.paths, (s) => {
    s.tasks[id] = task
  })
  return task
}

const herdrHandle = (task: Task | undefined): HerdrHandle | null =>
  task?.handle?.runner === 'herdr' ? task.handle : null

export class Applier {
  constructor(
    private readonly ctx: Ctx,
    private readonly deps: ApplyDeps,
  ) {}

  /** A timed-out or canceled background operation may finish later, but cannot revive the run. */
  private async jobCurrent(
    row: IssueRow,
    handle?: HerdrHandle,
    taskId = row.taskId,
  ): Promise<boolean> {
    const current = this.deps.db.issue(row.id)
    if (current?.phase === row.phase && current.jobStartedAt === row.jobStartedAt) return true
    if (handle)
      await stopAgent(this.ctx, repoConfig(this.ctx.config, row.repo), handle).catch(
        () => undefined,
      )
    if (taskId)
      await mutateState(this.ctx.paths, (state) => {
        const task = state.tasks[taskId]
        if (task) task.status = 'closed'
      })
    return false
  }

  /** Post a comment once per (issue, key); a crash between the reservation and Linear is retried with the same id. */
  async comment(row: IssueRow, key: string, body: string): Promise<void> {
    const { db, linear } = this.deps
    const text = scrubSecrets(body)
    const existing = db.ownComment(row.id, key)
    if (existing?.status === 'sent') return
    const id = existing?.id ?? newCommentId()
    if (!existing) db.reserveOwnComment(id, row.id, key, text)
    try {
      await linear.createComment({ id, issueId: row.id, body: text })
      db.ownCommentSent(id)
    } catch (e) {
      if (e instanceof LinearError && /duplicate|already exists|unique/i.test(e.message)) {
        db.ownCommentSent(id)
        return
      }
      throw e
    }
    db.event('comment', key, row.id)
  }

  async setState(row: IssueRow, key: StateKey): Promise<void> {
    const name = this.deps.stateNames[key]
    if (row.linearState === name && row.lastSetState === name) return
    const id = await this.deps.stateId(row.team, key)
    await this.deps.linear.setState(row.id, id)
    this.deps.db.setLinearState(row.id, name, STATE_TYPES[key])
    this.deps.db.event('state', name, row.id)
  }

  private async resetRoundFiles(row: IssueRow): Promise<void> {
    const task = taskFor(this.ctx, row)
    const vm = loadState(this.ctx.paths).vms[row.repo]
    if (!task || !vm) return
    await runCommand(
      this.ctx.boat,
      vm.sandboxId,
      `rm -f ${shq(vmDoneMarker(task.id))} ${shq(questionPath(task.id))}`,
      { timeoutSeconds: 30 },
    ).catch(() => undefined)
  }

  private async deliver(
    row: IssueRow,
    c: HumanComment,
    mode: 'steer' | 'prompt' | 'undeliverable',
  ) {
    const { db, log } = this.deps
    const task = taskFor(this.ctx, row)
    const handle = herdrHandle(task)
    if (!handle) return
    const cfg = repoConfig(this.ctx.config, row.repo)
    if (mode === 'undeliverable') {
      await this.comment(
        row,
        `attach-${c.id}`,
        `${this.deps.mention ? `${this.deps.mention} ` : ''}The agent is at a dialog, so your reply is waiting. Attach with \`oar factory attach ${row.identifier}\` to answer the dialog; the reply is sent as soon as the agent is free.`,
      )
      return
    }
    try {
      if (mode === 'steer') {
        await promptAgent(this.ctx, cfg, handle, c.body.trim(), { confirm: false })
        db.markDelivered(c.id, 'steered')
      } else {
        const ok = await promptAgent(this.ctx, cfg, handle, c.body, { confirm: true, log })
        db.markDelivered(c.id, ok ? 'prompted' : 'unconfirmed')
      }
      db.event('delivered', `${mode} ${c.id}`, row.id, task?.id ?? null)
    } catch (e) {
      log(`${row.identifier}: could not deliver comment ${c.id}: ${firstLine(e)}`)
    }
  }

  async apply(row: IssueRow, actions: Action[]): Promise<void> {
    const { db, jobs, log } = this.deps
    let current = row
    for (const a of actions) {
      switch (a.kind) {
        case 'set_phase': {
          const { kind: _k, phase, ...rest } = a
          current = db.updateIssue(current.id, { phase, ...rest })
          break
        }
        case 'set_state':
          await this.setState(current, a.state)
          current = db.issue(current.id) ?? current
          break
        case 'comment':
          await this.comment(current, a.key, a.body)
          break
        case 'link_pr':
          await this.deps.linear
            .linkPr(current.id, a.url)
            .catch((e: Error) =>
              log(`${current.identifier}: could not attach the PR: ${firstLine(e)}`),
            )
          break
        case 'record_evidence':
          db.recordEvidence(current.id, a.stage, a.data)
          break
        case 'acknowledge':
          for (const comment of a.comments) db.markDelivered(comment.id, a.reason)
          break
        case 'event':
          db.event(a.name, a.detail ?? '', current.id, current.taskId)
          break
        case 'stop_agent': {
          const task = taskFor(this.ctx, current)
          const handle = herdrHandle(task)
          if (handle && this.ctx.config.repos[current.repo])
            await stopAgent(this.ctx, repoConfig(this.ctx.config, current.repo), handle).catch(
              () => undefined,
            )
          break
        }
        case 'close_task': {
          const task = taskFor(this.ctx, current)
          if (task)
            await mutateState(this.ctx.paths, (s) => {
              const t = s.tasks[task.id]
              if (t) t.status = 'closed'
            })
          break
        }
        case 'reset_round_files':
          await this.resetRoundFiles(current)
          break
        case 'deliver':
          await this.deliver(current, a.comment, a.mode)
          break
        case 'dispatch':
          void jobs.run(
            current.id,
            current.repo,
            () => this.dispatchJob(current.id),
            (e) => log(`${current.identifier}: dispatch job failed: ${firstLine(e)}`),
          )
          break
        case 'resume':
          void jobs.run(
            current.id,
            current.repo,
            () => this.resumeJob(current.id, a.message, a.deliver ?? []),
            (e) => log(`${current.identifier}: resume job failed: ${firstLine(e)}`),
          )
          break
        case 'review_round':
          void jobs.run(
            current.id,
            current.repo,
            () => this.roundJob(current.id, a),
            (e) => log(`${current.identifier}: review round failed: ${firstLine(e)}`),
          )
          break
        case 'auto_review':
          void jobs.run(
            current.id,
            current.repo,
            () => this.autoReviewJob(current.id, a.sha),
            (e) => log(`${current.identifier}: automated review failed: ${firstLine(e)}`),
          )
          break
        case 'verify_staging':
          void jobs.run(
            current.id,
            current.repo,
            () => this.verifyStagingJob(current.id, a),
            (e) => log(`${current.identifier}: verification dispatch failed: ${firstLine(e)}`),
          )
          break
        case 'merge':
          void jobs.run(
            current.id,
            current.repo,
            () => this.mergeJob(current.id, a),
            (e) => log(`${current.identifier}: merge failed: ${firstLine(e)}`),
          )
          break
        default:
          break
      }
    }
  }

  private async fail(row: IssueRow, what: string, e: unknown): Promise<void> {
    const { db } = this.deps
    const msg = firstLine(e)
    db.updateIssue(row.id, { phase: 'failed', jobStartedAt: null })
    db.event('failed', `${what}: ${msg}`, row.id, row.taskId)
    this.deps.log(`${row.identifier}: ${what} failed: ${msg}`)
    const fresh = db.issue(row.id) ?? row
    await this.comment(
      fresh,
      `failed-${what}-${fresh.round}`,
      `${this.deps.mention ? `${this.deps.mention} ` : ''}Could not ${what}: ${msg}. Move the issue back to ${this.deps.stateNames.ready} to retry${e instanceof OarError && e.hint ? ` (${e.hint})` : ''}.`,
    ).catch(() => undefined)
    await this.setState(fresh, 'needsInput').catch(() => undefined)
  }

  /** The issue's Linear parent when it is a plan, for the brief; null when there is none or Linear fails. */
  private async parentPlan(row: IssueRow): Promise<ParentPlan | null> {
    const { linear, log } = this.deps
    try {
      const self = await linear.issue(row.id)
      if (!self?.parentId) return null
      const p = await linear.issue(self.parentId)
      return p
        ? { identifier: p.identifier, title: p.title, url: p.url, description: p.description }
        : null
    } catch (e) {
      log(`${row.identifier}: could not read the parent plan: ${firstLine(e)}`)
      return null
    }
  }

  /** The job-side twin of decide's needsInput: park the issue and tell the human, never terminally. */
  private async needInput(row: IssueRow, key: string, body: string): Promise<void> {
    const { db, log } = this.deps
    db.updateIssue(row.id, { phase: 'needs_input', jobStartedAt: null })
    const fresh = db.issue(row.id) ?? row
    const text = this.deps.mention ? `${this.deps.mention} ${body}` : body
    await this.comment(fresh, key, text).catch((e: Error) =>
      log(`${row.identifier}: could not comment ${key}: ${firstLine(e)}`),
    )
    await this.setState(fresh, 'needsInput').catch(() => undefined)
  }

  /** What follows a review, for the PR and issue comments. */
  private reviewNext(row: IssueRow, verdict: ReviewVerdict): string {
    const f = this.ctx.config.factory
    if (verdict === 'block')
      return row.reviewRounds >= f.review.maxRounds
        ? 'The automated round limit is reached, so a human decides next.'
        : 'The agent gets the blocking items as its next review round.'
    if (row.labels.some((l) => l.toLowerCase() === f.holdLabel.toLowerCase()))
      return `Ready to merge, but held by the \`${f.holdLabel}\` label; remove it to merge.`
    if (!this.ctx.config.repos[row.repo]?.autoMerge)
      return 'Ready to merge; auto-merge is off for this repo.'
    return 'CI is green and nothing blocks, so the PR merges next.'
  }

  /**
   * Check out the PR head in the configured isolated environment, run the reviewer, record its
   * verdict for this SHA (an error too, so a broken reviewer runs once per SHA, never in a loop),
   * and post the findings on the PR and the issue.
   */
  private async autoReviewJob(rowId: string, sha: string): Promise<void> {
    const { db, log } = this.deps
    const row = db.issue(rowId)
    if (!row || row.phase !== 'review' || row.reviewedSha === sha) return
    const task = taskFor(this.ctx, row)
    if (!task) return this.reviewFailed(row, sha, 'no task is recorded for the issue')
    const cfg = repoConfig(this.ctx.config, row.repo)
    const review = this.ctx.config.factory.review
    const builder = taskAgentIdentity(task, cfg)
    if (
      review.runner === builder.kind &&
      !(builder.model && review.model && builder.model !== review.model)
    )
      return this.reviewFailed(
        row,
        sha,
        'review must use a different runner, or explicitly different buildModel and review.model values',
      )
    const files = reviewFiles(task.id)
    const wt = reviewWorktree(cfg, task.id)
    db.updateIssue(row.id, { jobStartedAt: new Date(this.ctx.now()).toISOString() })
    db.event('review-start', `${review.runner} ${sha.slice(0, 7)}`, row.id, task.id)
    let sandboxId: string | null = null
    let out: ReviewOutput
    try {
      if (review.isolation === 'sandbox') {
        out = await this.isolatedReview(row, task, cfg, sha)
      } else {
        const up = await ensureUp(this.ctx, row.repo, log, { herdr: false })
        sandboxId = up.vm.sandboxId
        const prep = await runCommand(
          this.ctx.boat,
          sandboxId,
          reviewCheckout(cfg, { wt, sha, branch: task.branch, files }),
          { cwd: cfg.vmPath, timeoutSeconds: 300 },
        )
        if (prep.exitCode !== 0)
          throw new Error(`could not check out ${sha.slice(0, 7)}: ${prep.stderr || prep.stdout}`)
        await this.ctx.boat.writeFile(
          sandboxId,
          files.prompt,
          reviewPrompt(row, cfg, { url: row.prUrl ?? '', headSha: sha }, review.blocking, files),
        )
        await this.ctx.boat.writeFile(sandboxId, files.schema, JSON.stringify(REVIEW_SCHEMA))
        const timeoutSeconds = Math.round(review.timeoutMinutes * 60)
        const r = await runCommand(
          this.ctx.boat,
          sandboxId,
          reviewCommand(review.runner, { cwd: wt, files, timeoutSeconds, model: review.model }),
          { timeoutSeconds: timeoutSeconds + 60 },
        )
        const text = await this.ctx.boat.readFile(sandboxId, files.out).catch(() => null)
        if (r.exitCode !== 0 || !text?.trim()) {
          const runLog = await this.ctx.boat.readFile(sandboxId, files.log).catch(() => null)
          const how = r.timedOut || r.exitCode === 124 ? 'timed out' : `exited ${r.exitCode ?? '?'}`
          throw new Error(`${review.runner} ${how}\n${runLog || r.stderr || r.stdout}`)
        }
        out = parseReviewOutput(review.runner, text)
      }
    } catch (e) {
      return this.reviewFailed(row, sha, (e as Error).message ?? String(e))
    } finally {
      if (sandboxId)
        await runCommand(
          this.ctx.boat,
          sandboxId,
          `git -c core.hooksPath=/dev/null worktree remove --force ${shq(wt)} 2>/dev/null; git worktree prune`,
          { cwd: cfg.vmPath, timeoutSeconds: 60 },
        ).catch(() => undefined)
    }
    if (db.issue(row.id)?.phase !== 'review') return
    const verdict = verdictOf(out.findings, review.blocking)
    db.recordEvidence(row.id, 'review', {
      sha,
      runner: review.runner,
      model: review.model ?? null,
      verdict,
      findings: out.findings,
    })
    db.updateIssue(row.id, {
      reviewedSha: sha,
      reviewVerdict: verdict,
      reviewFindings: out.findings,
      jobStartedAt: null,
    })
    db.event(
      'review',
      `${verdict} ${sha.slice(0, 7)}: ${findingsLine(out.findings, review.blocking)}`,
      row.id,
      task.id,
    )
    const fresh = db.issue(row.id) ?? row
    const next = this.reviewNext(fresh, verdict)
    const commentSandboxId = loadState(this.ctx.paths).vms[row.repo]?.sandboxId ?? null
    if (row.prNumber) {
      const posted = await ghRun(
        this.ctx.exec,
        this.ctx.boat,
        commentSandboxId,
        ['pr', 'comment', String(row.prNumber), '--repo', cfg.github, '--body-file', '-'],
        {
          input: scrubSecrets(
            findingsComment(out, { sha, runner: review.runner, blocking: review.blocking, next }),
          ),
        },
      )
      if (!posted.ok)
        log(`${row.identifier}: could not comment on the PR: ${scrub(posted.stderr, 2)}`)
    }
    await this.comment(
      fresh,
      `review-${sha}`,
      findingsSummary(out, {
        sha,
        runner: review.runner,
        blocking: review.blocking,
        prUrl: row.prUrl ?? '',
        next,
      }),
    )
  }

  private async isolatedReview(
    row: IssueRow,
    task: Task,
    cfg: RepoConfig,
    sha: string,
  ): Promise<ReviewOutput> {
    const { db } = this.deps
    const review = this.ctx.config.factory.review
    const history = db.evidence(row.id)
    let previous = history
      .filter((e) => e.stage === 'review-attempt' && e.data.sha === sha)
      .at(-1)?.data
    if (
      previous &&
      (previous.runner !== review.runner || previous.model !== (review.model ?? null))
    ) {
      if (typeof previous.sandboxId !== 'string')
        throw new Error(
          'the previous review creation outcome is unknown under a different model configuration; restore that configuration to reconcile it before changing reviewers',
        )
      const sandbox = await this.ctx.boat.get(previous.sandboxId)
      if (sandbox.state !== 'archived') await this.ctx.boat.stop(previous.sandboxId, true)
      db.recordEvidence(row.id, 'review-attempt', {
        ...previous,
        status: 'failed',
        reason: 'reviewer configuration changed',
      })
      previous = undefined
    }
    const prior = previous
    const receipt = prior
      ? history
          .filter(
            (e) => e.stage === 'review-artifacts' && e.data.idempotencyKey === prior.idempotencyKey,
          )
          .at(-1)?.data
      : undefined
    const completedReceipt =
      receipt && receipt.exitCode === 0 && !receipt.error && typeof receipt.output === 'string'
    // An unknown create outcome must reuse its key: it may already own a remote sandbox.
    // Completed artifacts survive a crash at any point between capture and cleanup receipts.
    const recover = prior && (prior.status !== 'failed' || !prior.sandboxId || completedReceipt)
    const idempotencyKey =
      recover && typeof prior.idempotencyKey === 'string'
        ? prior.idempotencyKey
        : `oar-review-${randomUUID()}`
    const sandboxId = recover && typeof prior.sandboxId === 'string' ? prior.sandboxId : undefined
    if (recover && completedReceipt && sandboxId) {
      const sandbox = await this.ctx.boat.get(sandboxId)
      if (sandbox.state !== 'archived') await this.ctx.boat.stop(sandboxId, true)
      db.recordEvidence(row.id, 'review-attempt', { ...prior, status: 'stopped' })
      return parseReviewOutput(review.runner, receipt.output as string)
    }
    const identity = { sha, idempotencyKey, runner: review.runner, model: review.model ?? null }
    if (!recover) db.recordEvidence(row.id, 'review-attempt', { ...identity, status: 'started' })
    let currentSandboxId = sandboxId
    try {
      const result = await runIsolatedReview(this.ctx.boat, {
        cfg,
        row,
        taskId: task.id,
        headSha: sha,
        branch: task.branch,
        runner: review.runner,
        model: review.model,
        blocking: review.blocking,
        timeoutSeconds: Math.round(review.timeoutMinutes * 60),
        environment: cfg.reviewEnvName,
        attempt: { idempotencyKey, sandboxId },
        onSandbox: async (id) => {
          currentSandboxId = id
          db.recordEvidence(row.id, 'review-attempt', {
            ...identity,
            status: 'running',
            sandboxId: id,
          })
        },
        onEvidence: async (evidence) => {
          db.recordEvidence(row.id, 'review-artifacts', {
            ...identity,
            ...evidence,
            output: evidence.output ? redact(evidence.output) : null,
            log: evidence.log ? redact(evidence.log) : null,
            diff: evidence.diff ? redact(evidence.diff) : null,
            error: evidence.error ? redact(evidence.error) : null,
          })
        },
        onStopped: async (id) => {
          db.recordEvidence(row.id, 'review-attempt', {
            ...identity,
            status: 'stopped',
            sandboxId: id,
          })
        },
      })
      return result.out
    } catch (error) {
      db.recordEvidence(row.id, 'review-attempt', {
        ...identity,
        status: 'failed',
        sandboxId: currentSandboxId ?? null,
      })
      throw error
    }
  }

  private async reviewFailed(row: IssueRow, sha: string, why: string): Promise<void> {
    const { db, log } = this.deps
    db.updateIssue(row.id, {
      reviewedSha: sha,
      reviewVerdict: 'error',
      reviewFindings: [],
      jobStartedAt: null,
    })
    db.event('review-error', `${sha.slice(0, 7)}: ${firstLine(scrub(why, 1))}`, row.id, row.taskId)
    log(`${row.identifier}: automated review of ${sha.slice(0, 7)} failed: ${firstLine(why)}`)
    const detail = scrub(why)
    await this.needInput(
      row,
      `review-error-${sha}`,
      `The automated review of ${row.prUrl ?? 'the PR'} failed, so nothing was merged. Reply here to run it again, or merge by hand.${detail ? `\n\n\`\`\`\n${detail}\n\`\`\`` : ''}`,
    )
  }

  /**
   * Merge once per head SHA: recorded before gh runs, `--match-head-commit` refuses a head that
   * moved since the review. Success needs no follow-up: the next tick sees MERGED and closes out.
   */
  private async mergeJob(
    rowId: string,
    a: { number: number; sha: string; method: MergeMethod; isDraft: boolean },
  ): Promise<void> {
    const { db, log } = this.deps
    const row = db.issue(rowId)
    if (!row || row.phase !== 'review' || row.mergeSha === a.sha) return
    const cfg = repoConfig(this.ctx.config, row.repo)
    // Jobs serialize each repo, so reserve this head only after the prior delivery has released staging.
    if (deliveryBusy(db, row, cfg.deliveryMode)) return
    db.updateIssue(row.id, {
      mergeSha: a.sha,
      jobStartedAt: new Date(this.ctx.now()).toISOString(),
    })
    db.event('merge-start', `#${a.number} ${a.sha.slice(0, 7)} (${a.method})`, row.id, row.taskId)
    const sandboxId = loadState(this.ctx.paths).vms[row.repo]?.sandboxId ?? null
    const gh = (args: string[]) => ghRun(this.ctx.exec, this.ctx.boat, sandboxId, args)
    try {
      const latest = await this.deps.linear.issue(row.id)
      if (
        !latest ||
        latest.trashed ||
        latest.archivedAt ||
        ['completed', 'canceled'].includes(latest.state.type)
      )
        throw new Error('the Linear issue is unavailable, canceled, archived or already complete')
      if (
        latest.labels.some(
          (label) => label.toLowerCase() === this.ctx.config.factory.holdLabel.toLowerCase(),
        ) ||
        !cfg.autoMerge
      )
        throw new Error('auto-merge is disabled or the Linear issue is held')
      if (row.reviewedSha !== a.sha || row.reviewVerdict !== 'pass')
        throw new Error('the current head has no passing automated review')
      if (cfg.deliveryMode === 'staging' && (!cfg.deployWorkflow || !cfg.verifyWorkflow))
        throw new Error('staging delivery requires deployWorkflow and verifyWorkflow')
      const ci = await checkRuns(new GhFeed(this.ctx.exec, this.ctx.boat, sandboxId, cfg), a.sha)
      if (ci) db.recordEvidence(row.id, 'ci', { ...ci, sha: a.sha })
      if (!ci?.passed || ci.pending || ci.headSha !== a.sha)
        throw new Error(
          `required checks are not successful for ${a.sha}${ci?.missing.length ? `; missing: ${ci.missing.join(', ')}` : ''}`,
        )
      if (a.isDraft) {
        const ready = await gh(['pr', 'ready', String(a.number), '--repo', cfg.github])
        if (!ready.ok) throw new Error(`gh pr ready: ${ready.stderr || ready.stdout}`)
      }
      const m = await gh([
        'pr',
        'merge',
        String(a.number),
        '--repo',
        cfg.github,
        `--${a.method}`,
        '--delete-branch',
        '--match-head-commit',
        a.sha,
      ])
      if (!m.ok) {
        // `--delete-branch` can fail after the merge itself went through.
        const task = taskFor(this.ctx, row)
        const pr = task
          ? await prSnapshot(this.ctx.exec, this.ctx.boat, sandboxId, cfg, task.branch).catch(
              () => null,
            )
          : null
        if (pr?.state !== 'MERGED') throw new Error(`gh pr merge: ${m.stderr || m.stdout}`)
      }
      db.updateIssue(row.id, { jobStartedAt: null })
      db.event('merged-by-oar', `#${a.number} ${a.sha.slice(0, 7)}`, row.id, row.taskId)
      log(`${row.identifier}: merged #${a.number} (${a.method})`)
    } catch (e) {
      const why = (e as Error).message ?? String(e)
      db.event('merge-failed', firstLine(scrub(why, 1)), row.id, row.taskId)
      await this.needInput(
        db.issue(row.id) ?? row,
        `merge-failed-${a.sha}`,
        `Could not merge ${row.prUrl ?? `#${a.number}`}. Fix the cause and reply here to retry, or merge by hand.\n\n\`\`\`\n${scrub(why)}\n\`\`\``,
      )
    }
  }

  /** Reserve first, then dispatch once. An uncertain HTTP response is reconciled by run identity. */
  private async verifyStagingJob(
    rowId: string,
    action: { sha: string; deploymentRunId: number; deploymentAttempt: number },
  ): Promise<void> {
    const { db, log } = this.deps
    const row = db.issue(rowId)
    if (!row || !['merged', 'verifying'].includes(row.phase) || row.roundStartSha !== action.sha)
      return
    const cfg = repoConfig(this.ctx.config, row.repo)
    if (!cfg.verifyWorkflow) return
    const requestKey = verificationRequestKey(
      row.id,
      action.sha,
      action.deploymentRunId,
      action.deploymentAttempt,
      row.roundStartedAt,
    )
    if (
      db
        .evidence(row.id)
        .some((e) => e.stage === 'verification-dispatch' && e.data.requestKey === requestKey)
    )
      return
    const identity = {
      requestKey,
      sha: action.sha,
      workflow: cfg.verifyWorkflow,
      deploymentRunId: action.deploymentRunId,
      deploymentAttempt: action.deploymentAttempt,
      deliveryStartedAt: row.roundStartedAt,
    }
    db.recordEvidence(row.id, 'verification-dispatch', { ...identity, status: 'intent' })
    try {
      // Delivery credentials belong to the controller; never fall back to a coding VM.
      const result = await ghRun(this.ctx.exec, null, null, [
        'api',
        '--method',
        'POST',
        `repos/${cfg.github}/actions/workflows/${encodeURIComponent(cfg.verifyWorkflow)}/dispatches`,
        '-f',
        `ref=${cfg.baseBranch}`,
        '-f',
        `inputs[expected_sha]=${action.sha}`,
        '-f',
        `inputs[oar_run_id]=${requestKey}`,
      ])
      db.recordEvidence(row.id, 'verification-dispatch', {
        ...identity,
        status: result.ok ? 'accepted' : 'unknown',
        error: result.ok ? null : scrub(result.stderr || result.stdout),
      })
      if (!result.ok)
        log(
          `${row.identifier}: verification dispatch outcome is unknown; observing ${requestKey} before any retry`,
        )
    } catch (error) {
      db.recordEvidence(row.id, 'verification-dispatch', {
        ...identity,
        status: 'unknown',
        error: scrub(firstLine(error)),
      })
      log(
        `${row.identifier}: verification dispatch outcome is unknown; observing ${requestKey} before any retry`,
      )
    }
  }

  private async dispatchJob(rowId: string): Promise<void> {
    const { db, linear, log } = this.deps
    const row = db.issue(rowId)
    if (!row || !['dispatching', 'resuming'].includes(row.phase)) return
    const cfg = repoConfig(this.ctx.config, row.repo)
    try {
      const all = await linear.comments([row.id], null).catch(() => [])
      for (const c of all) {
        if (c.userIsApp || c.isBot || db.isOwnComment(c.id)) continue
        db.addComment({
          id: c.id,
          issueId: row.id,
          author: c.userName ?? '',
          body: c.body,
          createdAt: c.createdAt,
        })
      }
      const parent = await this.parentPlan(row)
      const task = await ensureTask(this.ctx, row, cfg, db, parent)
      if (!(await this.jobCurrent(row))) return
      const builder = taskAgentIdentity(task, cfg)
      const round = row.round + 1
      db.recordEvidence(row.id, 'input', {
        taskId: task.id,
        round,
        description: row.description,
        brief: readFileSync(task.briefPath, 'utf8'),
        runner: builder.kind,
        model: builder.model ?? null,
        branch: task.branch,
        baseBranch: cfg.baseBranch,
        parentPlan: parent,
      })
      const result = await dispatchTask(this.ctx, task, {
        log,
        reuseBranch: true,
        footer: factoryFooter(task, row),
      })
      if (!(await this.jobCurrent(row, result.handle, task.id))) return
      for (const c of db.undelivered(row.id)) db.markDelivered(c.id, 'brief')
      db.updateIssue(row.id, {
        phase: 'building',
        taskId: task.id,
        round,
        roundStartSha: null,
        roundStartedAt: new Date(this.ctx.now()).toISOString(),
        jobStartedAt: null,
      })
      db.event('dispatched', `${task.id} on ${row.repo} (${task.branch})`, row.id, task.id)
      const fresh = db.issue(row.id) ?? row
      await this.comment(
        fresh,
        `started-${round}`,
        `Started on \`${row.repo}\`: branch \`${task.branch}\`, worktree \`${task.worktreePath}\`. Attach with \`oar factory attach ${row.identifier}\`.${result.note ? ` Note: ${result.note}` : ''}`,
      )
      await this.setState(fresh, 'inProgress')
    } catch (e) {
      if (!['failed', 'closed'].includes(db.issue(row.id)?.phase ?? 'closed'))
        await this.fail(row, 'start the agent', e)
    }
  }

  private async resumeJob(rowId: string, message: string, deliver: HumanComment[]): Promise<void> {
    const { db, log } = this.deps
    const row = db.issue(rowId)
    if (!row || row.phase !== 'resuming') return
    const task = taskFor(this.ctx, row)
    const handle = herdrHandle(task)
    if (!task || !handle) return this.dispatchJob(rowId)
    const cfg = repoConfig(this.ctx.config, row.repo)
    try {
      const up = await ensureUp(this.ctx, row.repo, log)
      if (!up.herdrReachable) throw new OarError('herdr', `Herdr on ${row.repo} is not reachable`)
      if (!(await this.jobCurrent(row, handle))) return
      const next = await resumeHerdr(this.ctx, task, cfg, up.vm.sandboxId, handle, log, message)
      if (!(await this.jobCurrent(row, next))) return
      await mutateState(this.ctx.paths, (s) => {
        const t = s.tasks[task.id]
        if (t) {
          t.handle = next
          t.status = 'working'
          t.note = undefined
        }
      })
      await ensureDeadline(
        this.ctx.boat,
        up.vm.sandboxId,
        hoursFromNow(Math.max(2, task.hours / 2), this.ctx.now()),
        { log, now: this.ctx.now },
      ).catch(() => null)
      if (!(await this.jobCurrent(row, next))) return
      for (const c of deliver) db.markDelivered(c.id, 'resumed')
      db.updateIssue(row.id, {
        phase: 'building',
        jobStartedAt: null,
        roundStartedAt: new Date(this.ctx.now()).toISOString(),
      })
      db.event('resumed', message.slice(0, 80), row.id, task.id)
      const fresh = db.issue(row.id) ?? row
      await this.setState(fresh, 'inProgress')
    } catch (e) {
      if (!['failed', 'closed'].includes(db.issue(row.id)?.phase ?? 'closed'))
        await this.fail(row, 'resume the agent', e)
    }
  }

  private async roundJob(
    rowId: string,
    a: {
      comments: ReviewComment[]
      failed: string[]
      ciSha?: string
      cursor?: string | null
      deliver?: HumanComment[]
      reviewSha?: string
    },
  ): Promise<void> {
    const { db, log } = this.deps
    const row = db.issue(rowId)
    if (!row) return
    const task = taskFor(this.ctx, row)
    const handle = herdrHandle(task)
    const vm = loadState(this.ctx.paths).vms[row.repo]
    if (!task || !handle || !vm)
      return this.fail(row, 'start the review round', new Error('no task'))
    const cfg = repoConfig(this.ctx.config, row.repo)
    const round = row.round + 1
    const now = new Date(this.ctx.now()).toISOString()
    let active = row
    try {
      active = db.updateIssue(row.id, {
        phase: 'building',
        round,
        roundStartedAt: now,
        jobStartedAt: now,
        handledCiSha: a.ciSha ?? row.handledCiSha ?? undefined,
        ciRounds: a.ciSha ? row.ciRounds + 1 : row.ciRounds,
        reviewCursor: a.cursor ?? row.reviewCursor ?? undefined,
        reviewRoundSha: a.reviewSha,
        reviewRounds: a.reviewSha ? row.reviewRounds + 1 : undefined,
        // Whatever the round changes, the next head gets its own merge attempt.
        mergeSha: null,
      })
      db.event(
        'round',
        `round ${round}: ${a.comments.length} comment(s), ${a.failed.length} failed check(s)`,
        row.id,
        task.id,
      )
      const up = await ensureUp(this.ctx, row.repo, log)
      if (!up.herdrReachable) throw new OarError('herdr', `Herdr on ${row.repo} is not reachable`)
      if (!(await this.jobCurrent(active, handle))) return
      const path = reviewPath(task.id, round)
      await this.ctx.boat.writeFile(
        up.vm.sandboxId,
        path,
        reviewBrief(row, round, a.comments, a.failed, row.prUrl),
      )
      await runCommand(
        this.ctx.boat,
        up.vm.sandboxId,
        `rm -f ${shq(vmDoneMarker(task.id))} ${shq(questionPath(task.id))}`,
        { timeoutSeconds: 30 },
      ).catch(() => undefined)
      const text = `${roundToken(round)} Read ${path} and address it. Then run the gate, push to the same branch, \`touch ${vmDoneMarker(task.id)}\` again, and reply with a summary.`
      let ok = true
      try {
        ok = await promptAgent(this.ctx, cfg, handle, text, { confirm: true, marker: path, log })
      } catch (e) {
        if (!(e instanceof OarError) || e.code !== 'herdr') throw e
        const next = await resumeHerdr(this.ctx, task, cfg, up.vm.sandboxId, handle, log, text)
        await mutateState(this.ctx.paths, (s) => {
          const t = s.tasks[task.id]
          if (t) t.handle = next
        })
      }
      if (!(await this.jobCurrent(active, herdrHandle(taskFor(this.ctx, row)) ?? handle))) return
      await mutateState(this.ctx.paths, (s) => {
        const t = s.tasks[task.id]
        if (t) t.status = 'working'
      })
      await ensureDeadline(
        this.ctx.boat,
        up.vm.sandboxId,
        hoursFromNow(Math.max(2, task.hours / 2), this.ctx.now()),
        {
          log,
          now: this.ctx.now,
        },
      ).catch(() => null)
      if (!(await this.jobCurrent(active, herdrHandle(taskFor(this.ctx, row)) ?? handle))) return
      for (const c of a.deliver ?? []) db.markDelivered(c.id, 'round')
      db.updateIssue(row.id, { jobStartedAt: null })
      const fresh = db.issue(row.id) ?? row
      await this.comment(
        fresh,
        `round-${round}`,
        `Round ${round} started: ${a.reviewSha ? `${a.comments.filter((c) => c.blocking).length} blocking finding(s) from the automated review` : `${a.comments.length} review comment(s)`}${a.failed.length ? `, red CI (${a.failed.join(', ')})` : ''}.${ok ? '' : ' The prompt was sent but not confirmed; attach to check.'}`,
      )
      await this.setState(fresh, 'inProgress')
    } catch (e) {
      if (!['failed', 'closed'].includes(db.issue(row.id)?.phase ?? 'closed'))
        await this.fail(row, 'start the review round', e)
    }
  }
}
