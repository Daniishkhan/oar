import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { sandboxState } from '../boat.js'
import { loadSecrets } from '../config.js'
import type { Ctx } from '../context.js'
import { OarError } from '../errors.js'
import { loadState, UP_STATES } from '../state.js'
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
  private vmStates = new Map<string, boolean | null>()
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
    const kind = i.labels.map((l) => l.toLowerCase()).find((l) => KINDS.has(l)) ?? 'build'
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
    const reopenable = row.phase === 'closed' || row.phase === 'failed' || row.phase === 'merged'
    if (
      reopenable &&
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
    const next = new Map<string, boolean | null>()
    for (const repo of Object.keys(this.ctx.config.repos)) {
      const vm = state.vms[repo]
      if (!vm) {
        next.set(repo, null)
        continue
      }
      const sb = await this.ctx.boat.get(vm.sandboxId).catch(() => null)
      next.set(repo, sb ? UP_STATES.has(sandboxState(sb)) : false)
    }
    this.vmStates = next
  }

  get paused(): boolean {
    return existsSync(pauseFile(this.ctx))
  }

  async reconcileAll(): Promise<void> {
    const githubDue =
      this.tick %
        Math.max(
          1,
          Math.round(
            this.ctx.config.factory.githubPollSeconds / this.ctx.config.defaults.pollSeconds,
          ),
        ) ===
      1
    const state = loadState(this.ctx.paths)
    const limits = {
      maxCiRounds: this.ctx.config.factory.maxCiRounds,
      jobTimeoutMs: this.ctx.config.factory.jobTimeoutMinutes * 60_000,
    }
    for (const row of this.db.activeIssues()) {
      if (this.paused && row.phase === 'queued') continue
      try {
        const facts = await observeIssue(this.ctx, row, {
          db: this.db,
          jobs: this.jobs,
          stateKeyOf: (n, t) => this.stateKeyOf(n, t),
          concurrency: (repo) => this.ctx.config.factory.concurrency[repo] ?? 1,
          vmUp: (repo) => this.vmStates.get(repo) ?? null,
          sandboxId: (repo) => state.vms[repo]?.sandboxId ?? null,
          githubDue,
        })
        const cfg = this.ctx.config.repos[row.repo]
        const actions = decide(row, facts, {
          limits,
          mention: this.ctx.config.factory.linear.mention,
          tracksDeploy: Boolean(cfg?.deployWorkflow),
          identifier: row.identifier,
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
  }

  async runTick(): Promise<void> {
    this.tick++
    try {
      if (this.tick === 1) await this.retryPendingComments()
      await this.refreshVms()
      await this.syncLinear()
      await this.reconcileAll()
      if (this.tick % 4 === 0)
        await keepWorkers(this.ctx, {
          db: this.db,
          jobs: this.jobs,
          log: this.log,
          idleSince: this.idleSince,
        })
      if (this.tick === 1 || this.tick % 20 === 0) await keepSelf(this.ctx, { log: this.log })
      this.db.setCursor('tick.at', new Date(this.ctx.now()).toISOString())
      this.db.setCursor('tick.n', String(this.tick))
    } catch (e) {
      if (e instanceof LinearError && e.code === 'ratelimited') {
        this.log('linear: rate limited; pausing two minutes')
        await sleep(120_000)
        return
      }
      this.log(`tick ${this.tick}: ${(e as Error).message}`)
      this.db.event('error', (e as Error).message.split('\n')[0] ?? '')
    }
  }

  async serve(opts: { maxTicks?: number } = {}): Promise<void> {
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
    for (;;) {
      await this.runTick()
      if (stopping || (opts.maxTicks && this.tick >= opts.maxTicks)) break
      await sleep(this.ctx.config.defaults.pollSeconds * 1000)
    }
    await this.jobs.drain()
    this.db.close()
  }
}
