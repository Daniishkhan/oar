import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { sandboxState } from '../boat.js'
import { loadSecrets } from '../config.js'
import type { Ctx } from '../context.js'
import { OarError } from '../errors.js'
import { redact } from '../exec.js'
import { CHANGING_STATES, loadState, UP_STATES } from '../state.js'
import { sleep } from '../time.js'
import { Applier } from './apply.js'
import { FactoryDb } from './db.js'
import { Jobs } from './jobs.js'
import { keepSelf, keepWorkers } from './keeper.js'
import { LinearClient, LinearError, type LinearAuth, type LinearIssue } from './linear.js'
import { observeIssue } from './observe.js'
import { decide } from './reconcile.js'
import type { StateKey } from './types.js'

export const dbPath = (ctx: Ctx) => join(ctx.paths.stateDir, 'factory.sqlite')
export const pauseFile = (ctx: Ctx) => join(ctx.paths.stateDir, 'factory.paused')

/** Issue kinds the roadmap knows; only `build` runs today, the rest are recorded for later recipes. */
export const KINDS = new Set([
  'inspect',
  'spec',
  'build',
  'verify',
  'review',
  'prototype',
  'validate',
])

export function linearAuth(ctx: Ctx): LinearAuth {
  const s = loadSecrets(ctx.paths)
  if (s.LINEAR_CLIENT_ID && s.LINEAR_CLIENT_SECRET)
    return { mode: 'oauth', clientId: s.LINEAR_CLIENT_ID, clientSecret: s.LINEAR_CLIENT_SECRET }
  if (s.LINEAR_API_KEY) return { mode: 'apikey', key: s.LINEAR_API_KEY }
  throw new OarError(
    'secrets',
    `no Linear credentials in ${ctx.paths.envFile}`,
    'add LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET (an OAuth app with client credentials), or LINEAR_API_KEY',
  )
}

export interface FactoryOptions {
  db?: FactoryDb
  linear?: LinearClient
  log?: (line: string) => void
}

const STATE_COLORS: Record<StateKey, string> = {
  ready: '#4ea7fc',
  inProgress: '#f2c94c',
  needsInput: '#eb5757',
  inReview: '#9b51e0',
  done: '#27ae60',
  canceled: '#95a2b3',
}
const STATE_TYPES: Record<StateKey, string> = {
  ready: 'unstarted',
  inProgress: 'started',
  needsInput: 'started',
  inReview: 'started',
  done: 'completed',
  canceled: 'canceled',
}

/** The controller: one Linear sync, one observe/decide/apply per active issue, the keeper. */
export class Factory {
  readonly db: FactoryDb
  readonly linear: LinearClient
  readonly jobs: Jobs
  readonly log: (line: string) => void
  private readonly applier: Applier
  private readonly teamIds = new Map<string, string>()
  private readonly stateIds = new Map<string, Map<string, string>>()
  private readonly idleSince = new Map<string, number>()
  /** issue id → when its agent was first seen idle in the current idle spell (in memory; a restart resets it). */
  private readonly agentIdleSince = new Map<string, number>()
  private vmStates = new Map<string, 'up' | 'changing' | 'down' | null>()
  private linearRetryAt = 0
  tick = 0

  constructor(
    private readonly ctx: Ctx,
    opts: FactoryOptions = {},
  ) {
    this.db = opts.db ?? new FactoryDb(dbPath(ctx), ctx.now)
    this.linear =
      opts.linear ??
      new LinearClient({ auth: linearAuth(ctx), store: this.db.tokenStore(), now: ctx.now })
    this.jobs = new Jobs(ctx.now)
    this.log = opts.log ?? ((l) => ctx.io.out(`${new Date(ctx.now()).toISOString()} ${l}`))
    this.applier = new Applier(ctx, {
      db: this.db,
      jobs: this.jobs,
      linear: this.linear,
      stateNames: ctx.config.factory.linear.states,
      stateId: (team, key) => this.stateId(team, key),
      mention: ctx.config.factory.linear.mention,
      log: this.log,
    })
  }

  get teams(): Record<string, string> {
    return this.ctx.config.factory.linear.teams
  }

  stateKeyOf(name: string, type: string): StateKey | 'other' {
    const names = this.ctx.config.factory.linear.states
    for (const key of Object.keys(names) as StateKey[]) if (names[key] === name) return key
    if (type === 'completed') return 'done'
    if (type === 'canceled') return 'canceled'
    return 'other'
  }

  async teamId(key: string): Promise<string> {
    const cached = this.teamIds.get(key)
    if (cached) return cached
    const teams = await this.linear.teams(Object.keys(this.teams))
    for (const t of teams) this.teamIds.set(t.key, t.id)
    const id = this.teamIds.get(key)
    if (!id)
      throw new OarError(
        'config',
        `Linear team '${key}' not found`,
        'create it in Linear or fix factory.linear.teams',
      )
    return id
  }

  async stateId(team: string, key: StateKey): Promise<string> {
    const name = this.ctx.config.factory.linear.states[key]
    let states = this.stateIds.get(team)
    if (!states?.has(name)) {
      const teamId = await this.teamId(team)
      states = new Map((await this.linear.states(teamId)).map((s) => [s.name, s.id]))
      this.stateIds.set(team, states)
    }
    const id = states.get(name)
    if (!id)
      throw new OarError(
        'config',
        `team ${team} has no state '${name}'`,
        'oar factory setup creates it',
      )
    return id
  }

  /** Create the workflow states the controller needs in every configured team. Returns what it created. */
  async ensureStates(): Promise<string[]> {
    const created: string[] = []
    const names = this.ctx.config.factory.linear.states
    for (const team of Object.keys(this.teams)) {
      const teamId = await this.teamId(team)
      const have = new Set((await this.linear.states(teamId)).map((s) => s.name))
      for (const key of Object.keys(names) as StateKey[]) {
        const name = names[key]
        if (have.has(name)) continue
        await this.linear.createState({
          teamId,
          name,
          type: STATE_TYPES[key],
          color: STATE_COLORS[key],
        })
        created.push(`${team}: ${name}`)
      }
      this.stateIds.delete(team)
    }
    return created
  }

  private upsert(i: LinearIssue): void {
    const repo = this.teams[i.teamKey]
    if (!repo || !this.ctx.config.repos[repo]) return
    // A label names the kind; an issue with sub-issues is a plan even without the `spec` label.
    const kind =
      i.labels.map((l) => l.toLowerCase()).find((l) => KINDS.has(l)) ??
      (i.hasChildren ? 'spec' : 'build')
    const before = this.db.issue(i.id)
    const row = this.db.upsertIssue({
      id: i.id,
      identifier: i.identifier,
      team: i.teamKey,
      repo,
      title: i.title,
      description: i.description,
      url: i.url,
      priority: i.priority,
      labels: i.labels,
      kind,
      linearState: i.state.name,
      linearStateType: i.state.type,
      blockedBy: i.blockedBy,
      gone: Boolean(i.archivedAt) || i.trashed,
      updatedAt: i.updatedAt,
      createdAt: i.createdAt,
    })
    if (!before) this.db.event('seen', `${i.identifier} ${i.state.name}`, i.id)
    // Only `build` issues are built; a plan issue (label `spec`) and the later recipe kinds are recorded and left alone.
    if (kind !== 'build') {
      if (row.phase === 'queued') {
        this.db.updateIssue(row.id, { phase: 'closed' })
        this.db.event('not-built', `${i.identifier} is a ${kind} issue`, row.id)
      }
      return
    }
    const history = this.db.evidence(row.id)
    const delivered = history.some((e) => e.stage === 'merge')
    const deadline = history.filter((e) => e.stage === 'deadline').at(-1)
    const staleDeadlineState =
      deadline?.data.round === row.round &&
      Date.parse(i.updatedAt) <= Date.parse(deadline.createdAt) &&
      row.lastSetState !== this.ctx.config.factory.linear.states.needsInput
    const reopenable = !delivered && (row.phase === 'closed' || row.phase === 'failed')
    if (
      reopenable &&
      !staleDeadlineState &&
      this.stateKeyOf(row.linearState, row.linearStateType) === 'ready' &&
      row.linearState !== row.lastSetState
    ) {
      this.db.updateIssue(row.id, { phase: 'queued', jobStartedAt: null, taskId: row.taskId })
      this.db.event('requeued', row.identifier, row.id)
    }
  }

  async syncLinear(): Promise<void> {
    const now = this.ctx.now()
    const issueCursor =
      this.db.cursor('linear.issues') ?? new Date(now - 30 * 86_400_000).toISOString()
    const since = new Date(Date.parse(issueCursor) - 60_000).toISOString()
    const issues = await this.linear.issuesUpdatedSince(Object.keys(this.teams), since)
    let newest = issueCursor
    for (const i of issues) {
      this.upsert(i)
      if (i.updatedAt > newest) newest = i.updatedAt
    }
    this.db.setCursor('linear.issues', newest)

    const active = this.db.activeIssues()
    if (active.length) {
      const commentCursor = this.db.cursor('linear.comments') ?? since
      const comments = await this.linear.comments(
        active.map((r) => r.id),
        new Date(Date.parse(commentCursor) - 60_000).toISOString(),
      )
      let newestC = commentCursor
      for (const c of comments) {
        if (c.userIsApp || c.isBot || this.db.isOwnComment(c.id)) continue
        const added = this.db.addComment({
          id: c.id,
          issueId: c.issueId,
          author: c.userName ?? '',
          body: c.body,
          createdAt: c.createdAt,
        })
        if (added) this.db.event('human-comment', c.id, c.issueId)
        if (c.createdAt > newestC) newestC = c.createdAt
      }
      this.db.setCursor('linear.comments', newestC)
    }

    // Permanently deleted issues never show up as updated; look them up by id now and then.
    if (this.tick % 20 === 1) {
      for (const row of active) {
        const fresh = await this.linear.issue(row.id).catch(() => undefined)
        if (fresh === null && !row.gone) {
          this.db.updateIssue(row.id, { gone: true })
          this.db.event('gone', row.identifier, row.id)
        }
      }
    }
  }

  private async refreshVms(): Promise<void> {
    const state = loadState(this.ctx.paths)
    const next = new Map<string, 'up' | 'changing' | 'down' | null>()
    for (const repo of Object.keys(this.ctx.config.repos)) {
      const vm = state.vms[repo]
      if (!vm) {
        next.set(repo, null)
        continue
      }
      const sb = await this.ctx.boat.get(vm.sandboxId).catch(() => null)
      const st = sb ? sandboxState(sb) : null
      next.set(
        repo,
        st === null
          ? 'changing'
          : UP_STATES.has(st)
            ? 'up'
            : CHANGING_STATES.has(st)
              ? 'changing'
              : 'down',
      )
    }
    this.vmStates = next
  }

  get paused(): boolean {
    return existsSync(pauseFile(this.ctx))
  }

  async reconcileAll(allowActions = true): Promise<void> {
    const githubDue =
      (this.tick - 1) %
        Math.max(
          1,
          Math.round(
            this.ctx.config.factory.githubPollSeconds / this.ctx.config.defaults.pollSeconds,
          ),
        ) ===
      0
    const state = loadState(this.ctx.paths)
    const factory = this.ctx.config.factory
    const limits = {
      maxCiRounds: factory.maxCiRounds,
      jobTimeoutMs: factory.jobTimeoutMinutes * 60_000,
      maxReviewRounds: factory.review.maxRounds,
      stallGraceMs: factory.stallGraceMinutes * 60_000,
      deliveryTimeoutMs: factory.deliveryTimeoutMinutes * 60_000,
    }
    for (const row of this.db.activeIssues()) {
      if (this.paused && row.phase === 'queued') continue
      try {
        const facts = await observeIssue(this.ctx, row, {
          db: this.db,
          jobs: this.jobs,
          stateKeyOf: (n, t) => this.stateKeyOf(n, t),
          // A shared builder VM is a single execution slot, regardless of an older config.
          concurrency: () => 1,
          vmState: (repo) => this.vmStates.get(repo) ?? null,
          sandboxId: (repo) => state.vms[repo]?.sandboxId ?? null,
          githubDue,
        })
        const now = this.ctx.now()
        if (facts.agent === 'idle' || facts.agent === 'done') {
          const since = this.agentIdleSince.get(row.id) ?? now
          this.agentIdleSince.set(row.id, since)
          facts.idleForMs = now - since
        } else if (facts.agent !== 'unknown') {
          this.agentIdleSince.delete(row.id)
        }
        const cfg = this.ctx.config.repos[row.repo]
        // Deployment and verification runs are recorded by `decide` with the merged SHA.
        if (facts.ci) this.db.recordEvidence(row.id, 'ci', { ...facts.ci })
        const task = row.taskId ? state.tasks[row.taskId] : undefined
        const startedAt = row.roundStartedAt ?? task?.dispatchedAt
        const started = startedAt ? Date.parse(startedAt) : NaN
        const jobExpired =
          (facts.jobRunning || ['dispatching', 'resuming'].includes(row.phase)) &&
          facts.jobAgeMs > limits.jobTimeoutMs
        // Only build rounds are budgeted: in review the agent is idle and the PR may legitimately
        // wait on a human (a hold label, changes requested, auto-merge off).
        const budgetExpired =
          !facts.jobRunning &&
          row.phase === 'building' &&
          task &&
          Number.isFinite(started) &&
          this.ctx.now() - started > task.hours * 3_600_000
        if (
          (jobExpired || budgetExpired) &&
          ['building', 'resuming', 'dispatching', 'review'].includes(row.phase) &&
          facts.pr?.state !== 'MERGED' &&
          !row.mergeSha
        ) {
          await this.applier.apply(row, [
            {
              kind: 'record_evidence',
              stage: 'deadline',
              data: {
                taskId: task?.id ?? null,
                hours: task?.hours ?? null,
                startedAt,
                round: row.round,
                jobExpired,
              },
            },
            // Invalidate the run before awaiting remote stop, so late job completion cannot revive it.
            { kind: 'set_phase', phase: 'failed', jobStartedAt: null },
            { kind: 'stop_agent' },
            { kind: 'close_task' },
          ])
          const failed = this.db.issue(row.id)!
          await this.applier
            .apply(failed, [
              {
                kind: 'comment',
                key: `deadline-${row.round}`,
                body: `${jobExpired ? `The background operation exceeded its ${factory.jobTimeoutMinutes} minute limit` : `The task exceeded its ${task!.hours} hour execution budget`} and was stopped. Inspect its evidence, then move it to ${factory.linear.states.ready} to retry.`,
              },
            ])
            .catch((e: Error) =>
              this.log(`${row.identifier}: deadline comment pending: ${e.message}`),
            )
          await this.applier
            .setState(failed, 'needsInput')
            .catch((e: Error) =>
              this.log(`${row.identifier}: deadline state pending: ${e.message}`),
            )
          continue
        }
        // Budget enforcement is local; tracker-dependent work waits for fresh tracker state.
        if (!allowActions) continue
        const actions = decide(row, facts, {
          limits,
          states: factory.linear.states,
          mention: factory.linear.mention,
          tracksDeploy: Boolean(cfg?.deployWorkflow),
          tracksVerification: Boolean(cfg?.verifyWorkflow),
          deliveryMode: cfg?.deliveryMode ?? 'staging',
          identifier: row.identifier,
          blocking: factory.review.blocking,
          holdLabel: factory.holdLabel,
          autoMerge: cfg?.autoMerge ?? false,
          mergeMethod: cfg?.mergeMethod ?? 'squash',
        })
        if (actions.length) {
          this.log(`${row.identifier} [${row.phase}] → ${actions.map((a) => a.kind).join(', ')}`)
          await this.applier.apply(row, actions)
        }
      } catch (e) {
        this.log(`${row.identifier}: ${(e as Error).message}`)
        this.db.event('error', (e as Error).message.split('\n')[0] ?? '', row.id)
      }
    }
  }

  /** Comments reserved before a crash: send them now (Linear rejects a duplicate id). */
  private async retryPendingComments(): Promise<void> {
    for (const p of this.db.pendingOwnComments()) {
      const row = this.db.issue(p.issueId)
      if (!row || !p.body) continue
      await this.applier
        .comment(row, p.key, p.body)
        .catch((e: Error) => this.log(`${row.identifier}: pending comment ${p.key}: ${e.message}`))
    }
    for (const row of this.db.allIssues()) {
      if (
        row.phase !== 'failed' ||
        row.gone ||
        ['completed', 'canceled'].includes(row.linearStateType)
      )
        continue
      const deadline = this.db
        .evidence(row.id)
        .filter((e) => e.stage === 'deadline')
        .at(-1)
      if (deadline?.data.round === row.round)
        await this.applier
          .setState(row, 'needsInput')
          .catch((e: Error) => this.log(`${row.identifier}: deadline state pending: ${e.message}`))
    }
  }

  async runTick(): Promise<void> {
    this.tick++
    const stage = async (name: string, fn: () => Promise<void>): Promise<boolean> => {
      try {
        await fn()
        return true
      } catch (e) {
        const message = redact((e as Error).message)
        this.log(`${name}: ${message}`)
        this.db.event('error', `${name}: ${message.split('\n')[0] ?? ''}`)
        if (name === 'linear' && e instanceof LinearError && e.code === 'ratelimited') {
          this.linearRetryAt = this.ctx.now() + 120_000
          this.log('linear: backing off for two minutes; observations and maintenance continue')
        }
        return false
      }
    }
    await stage('vms', () => this.refreshVms())
    const synced =
      this.ctx.now() >= this.linearRetryAt && (await stage('linear', () => this.syncLinear()))
    if (synced) {
      this.linearRetryAt = 0
      this.db.setCursor('linear.syncedAt', new Date(this.ctx.now()).toISOString())
      await stage('comments', () => this.retryPendingComments())
    }
    await stage('reconcile', () => this.reconcileAll(synced))
    if (this.tick % 4 === 0)
      await stage('keeper', () =>
        keepWorkers(this.ctx, {
          db: this.db,
          jobs: this.jobs,
          log: this.log,
          idleSince: this.idleSince,
        }),
      )
    if (this.tick === 1 || this.tick % 20 === 0)
      await stage('controller keeper', () => keepSelf(this.ctx, { log: this.log }))
    this.db.setCursor('tick.at', new Date(this.ctx.now()).toISOString())
    this.db.setCursor('tick.n', String(this.tick))
  }

  async serve(opts: { maxTicks?: number } = {}): Promise<void> {
    const owner = randomUUID()
    if (!this.db.acquireController(owner)) {
      this.db.close()
      throw new OarError(
        'state_invalid',
        'another controller owns this database',
        'run only one oar factory serve process on the controller host',
      )
    }
    let stopping = false
    const stop = () => {
      stopping = true
      this.log('stopping after this tick')
    }
    process.once('SIGTERM', stop)
    process.once('SIGINT', stop)
    this.log(
      `factory serve: teams ${Object.entries(this.teams)
        .map(([k, r]) => `${k}→${r}`)
        .join(', ')}`,
    )
    try {
      for (;;) {
        await this.runTick()
        if (stopping || (opts.maxTicks && this.tick >= opts.maxTicks)) break
        await sleep(this.ctx.config.defaults.pollSeconds * 1000)
      }
    } finally {
      await this.jobs.drain()
      process.removeListener('SIGTERM', stop)
      process.removeListener('SIGINT', stop)
      this.db.releaseController(owner)
      this.db.close()
    }
  }
}
