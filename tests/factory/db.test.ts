import { mkdtempSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FactoryDb, type IssueSync } from '../../src/factory/db.js'

const sync = (over: Partial<IssueSync> = {}): IssueSync => ({
  id: 'i1',
  identifier: 'ENG-1',
  team: 'ENG',
  repo: 'engine',
  title: 'Fix it',
  description: 'desc',
  url: 'https://linear.app/x/ENG-1',
  priority: 2,
  labels: ['bug'],
  kind: 'build',
  linearState: 'Ready',
  linearStateType: 'unstarted',
  blockedBy: [],
  gone: false,
  updatedAt: '2026-01-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
})

let db: FactoryDb
let clock: number
beforeEach(() => {
  clock = Date.parse('2026-02-03T04:05:06.000Z')
  db = new FactoryDb(':memory:', () => clock)
})
afterEach(() => db.close())

describe('issues', () => {
  it('inserts a new issue in phase queued with defaults', () => {
    const row = db.upsertIssue(sync())
    expect(row).toMatchObject({
      id: 'i1',
      identifier: 'ENG-1',
      labels: ['bug'],
      phase: 'queued',
      round: 0,
      taskId: null,
      lastSetState: null,
      prNumber: null,
      gone: false,
    })
    expect(db.issueByIdentifier('ENG-1')?.id).toBe('i1')
    expect(db.issue('nope')).toBeNull()
  })

  it('keeps controller-owned columns and refreshes synced ones on a second upsert', () => {
    db.upsertIssue(sync())
    db.updateIssue('i1', {
      phase: 'building',
      round: 2,
      taskId: 't1',
      lastSetState: 'In Progress',
      prNumber: 7,
    })
    const row = db.upsertIssue(
      sync({ title: 'New title', labels: ['a', 'b'], linearState: 'Done', gone: true }),
    )
    expect(row).toMatchObject({
      phase: 'building',
      round: 2,
      taskId: 't1',
      lastSetState: 'In Progress',
      prNumber: 7,
      title: 'New title',
      labels: ['a', 'b'],
      linearState: 'Done',
      gone: true,
    })
    expect(db.issueByTask('t1')?.id).toBe('i1')
  })

  it('updateIssue patches only the given keys and null clears', () => {
    db.upsertIssue(sync())
    db.updateIssue('i1', { taskId: 't1', prUrl: 'u', round: 3, gone: true })
    const row = db.updateIssue('i1', { round: 4, taskId: null })
    expect(row).toMatchObject({ round: 4, taskId: null, prUrl: 'u', gone: true })
    expect(db.updateIssue('i1', {})).toEqual(row)
    expect(db.updateIssue('i1', { prUrl: undefined }).prUrl).toBe('u')
  })

  it('activeIssues excludes closed and failed and orders by creation', () => {
    db.upsertIssue(sync({ id: 'a', identifier: 'ENG-3', createdAt: '2026-01-03' }))
    db.upsertIssue(sync({ id: 'b', identifier: 'ENG-2', createdAt: '2026-01-02' }))
    db.upsertIssue(sync({ id: 'c', identifier: 'ENG-4', createdAt: '2026-01-04' }))
    db.upsertIssue(sync({ id: 'd', identifier: 'ENG-5', createdAt: '2026-01-05' }))
    db.updateIssue('c', { phase: 'closed' })
    db.updateIssue('d', { phase: 'failed' })
    expect(db.activeIssues().map((i) => i.id)).toEqual(['b', 'a'])
    expect(db.allIssues()).toHaveLength(4)
  })

  it('countInPhases counts per repo', () => {
    db.upsertIssue(sync({ id: 'a' }))
    db.upsertIssue(sync({ id: 'b' }))
    db.upsertIssue(sync({ id: 'c', repo: 'cno' }))
    db.updateIssue('a', { phase: 'building' })
    db.updateIssue('b', { phase: 'resuming' })
    db.updateIssue('c', { phase: 'building' })
    expect(db.countInPhases('engine', new Set(['building', 'resuming']))).toBe(2)
    expect(db.countInPhases('engine', new Set(['building']))).toBe(1)
    expect(db.countInPhases('cno', new Set(['review']))).toBe(0)
  })

  it('setLinearState sets linear_state and last_set_state', () => {
    db.upsertIssue(sync())
    db.setLinearState('i1', 'In Progress', 'started')
    expect(db.issue('i1')).toMatchObject({
      linearState: 'In Progress',
      linearStateType: 'started',
      lastSetState: 'In Progress',
    })
  })
})

describe('human comments', () => {
  const c = (id: string, createdAt: string, body = 'hi') => ({
    id,
    issueId: 'i1',
    author: 'dan',
    body,
    createdAt,
  })

  it('addComment returns false on a duplicate', () => {
    expect(db.addComment(c('c1', '2026-01-01'))).toBe(true)
    expect(db.addComment(c('c1', '2026-01-02', 'other'))).toBe(false)
    expect(db.commentsFor('i1')).toHaveLength(1)
    expect(db.commentsFor('i1')[0]?.body).toBe('hi')
  })

  it('tracks delivery and returns comments oldest first', () => {
    db.addComment(c('c2', '2026-01-02'))
    db.addComment(c('c1', '2026-01-01'))
    db.addComment(c('c3', '2026-01-03'))
    expect(db.undelivered('i1').map((x) => x.id)).toEqual(['c1', 'c2', 'c3'])
    db.markDelivered('c2', 'steer')
    expect(db.undelivered('i1').map((x) => x.id)).toEqual(['c1', 'c3'])
    expect(db.commentsFor('i1').map((x) => x.id)).toEqual(['c1', 'c2', 'c3'])
    expect(db.commentsFor('other')).toEqual([])
  })
})

describe('own comments', () => {
  it('reserves once per (issue, key)', () => {
    expect(db.reserveOwnComment('o1', 'i1', 'pr-opened', 'body one')).toBe(true)
    expect(db.reserveOwnComment('o2', 'i1', 'pr-opened', 'body two')).toBe(false)
    expect(db.reserveOwnComment('o3', 'i2', 'pr-opened', 'body three')).toBe(true)
    expect(db.ownComment('i1', 'pr-opened')).toEqual({ id: 'o1', status: 'pending' })
    expect(db.ownComment('i1', 'missing')).toBeNull()
    expect(db.isOwnComment('o1')).toBe(true)
    expect(db.isOwnComment('o2')).toBe(false)
  })

  it('lists pending reservations with their body until sent', () => {
    db.reserveOwnComment('o1', 'i1', 'k1', 'first')
    db.reserveOwnComment('o2', 'i1', 'k2', 'second')
    expect(db.pendingOwnComments()).toEqual([
      { id: 'o1', issueId: 'i1', key: 'k1', body: 'first' },
      { id: 'o2', issueId: 'i1', key: 'k2', body: 'second' },
    ])
    db.ownCommentSent('o1')
    expect(db.ownComment('i1', 'k1')?.status).toBe('sent')
    expect(db.pendingOwnComments().map((p) => p.id)).toEqual(['o2'])
  })
})

describe('events', () => {
  it('records events with the injected clock, oldest first', () => {
    db.event('a', 'one', 'i1', 't1')
    db.event('b')
    const [first, second] = db.events()
    expect(first).toMatchObject({
      kind: 'a',
      detail: 'one',
      issueId: 'i1',
      taskId: 't1',
      ts: '2026-02-03T04:05:06.000Z',
    })
    expect(second).toMatchObject({ kind: 'b', detail: '', issueId: null, taskId: null })
  })

  it('limit keeps the newest, issueId filters, afterId skips older', () => {
    for (let n = 1; n <= 5; n++) db.event(`k${n}`, '', n % 2 ? 'i1' : 'i2')
    expect(db.events({ limit: 2 }).map((e) => e.kind)).toEqual(['k4', 'k5'])
    expect(db.events({ issueId: 'i1' }).map((e) => e.kind)).toEqual(['k1', 'k3', 'k5'])
    const all = db.events()
    const cut = all[1]!.id
    expect(db.events({ afterId: cut }).map((e) => e.kind)).toEqual(['k3', 'k4', 'k5'])
    expect(db.events({ issueId: 'i1', afterId: cut, limit: 1 }).map((e) => e.kind)).toEqual(['k5'])
  })

  it('hasEvent matches issue, kind and detail exactly', () => {
    db.event('prompted', 'r1', 'i1')
    expect(db.hasEvent('i1', 'prompted', 'r1')).toBe(true)
    expect(db.hasEvent('i1', 'prompted', 'r2')).toBe(false)
    expect(db.hasEvent('i2', 'prompted', 'r1')).toBe(false)
  })
})

describe('cursors and token store', () => {
  it('round trips and overwrites a cursor', () => {
    expect(db.cursor('k')).toBeNull()
    db.setCursor('k', 'v1')
    db.setCursor('k', 'v2')
    expect(db.cursor('k')).toBe('v2')
  })

  it('stores the token record', () => {
    const store = db.tokenStore()
    expect(store.get()).toBeNull()
    const rec = { accessToken: 'a', refreshToken: 'r', expiresAt: 123 } as unknown as Parameters<
      typeof store.set
    >[0]
    store.set(rec)
    expect(store.get()).toEqual(rec)
    db.setCursor('linear.token', 'not json')
    expect(store.get()).toBeNull()
  })
})

describe('migration', () => {
  it('adds the review columns to a database created before them, idempotently', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'oar-db-')), 'factory.sqlite')
    const old = new DatabaseSync(path)
    old.exec(`CREATE TABLE issues (
      id TEXT PRIMARY KEY, identifier TEXT NOT NULL, team TEXT NOT NULL, repo TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '',
      priority INTEGER NOT NULL DEFAULT 0, labels TEXT NOT NULL DEFAULT '[]', kind TEXT NOT NULL DEFAULT 'build',
      linear_state TEXT NOT NULL DEFAULT '', linear_state_type TEXT NOT NULL DEFAULT '', last_set_state TEXT,
      phase TEXT NOT NULL DEFAULT 'queued', round INTEGER NOT NULL DEFAULT 0, round_start_sha TEXT,
      round_started_at TEXT, task_id TEXT, pr_number INTEGER, pr_url TEXT, handled_ci_sha TEXT,
      ci_rounds INTEGER NOT NULL DEFAULT 0, review_cursor TEXT, job_started_at TEXT,
      blocked_by TEXT NOT NULL DEFAULT '[]', gone INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT '')`)
    old.exec(
      "INSERT INTO issues (id, identifier, team, repo, phase, round) VALUES ('i9', 'ENG-9', 'ENG', 'engine', 'review', 2)",
    )
    old.close()
    const a = new FactoryDb(path)
    expect(a.issue('i9')).toMatchObject({
      phase: 'review',
      round: 2,
      reviewedSha: null,
      reviewVerdict: null,
      reviewFindings: [],
      reviewRounds: 0,
      reviewRoundSha: null,
      mergeSha: null,
    })
    const findings = [
      { severity: 'P1' as const, file: 'a', line: 1, title: 't', detail: 'd', fix: null },
    ]
    a.updateIssue('i9', {
      reviewedSha: 'abc',
      reviewVerdict: 'block',
      reviewFindings: findings,
      reviewRounds: 1,
      mergeSha: null,
    })
    a.close()
    const b = new FactoryDb(path)
    expect(b.issue('i9')).toMatchObject({
      reviewedSha: 'abc',
      reviewVerdict: 'block',
      reviewFindings: findings,
      reviewRounds: 1,
    })
    b.close()
  })
})
