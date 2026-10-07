import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, type RepoConfig } from '../../src/config.js'
import { checkRuns, GhFeed, reviewFeed, workflowRun } from '../../src/factory/github.js'
import { FakeExec } from '../fakes/exec.js'

const repo: RepoConfig = { ...DEFAULT_CONFIG.repos.engine!, github: 'o/r' }
const feed = (exec: FakeExec) => new GhFeed(exec, null, null, repo)
const json = (v: unknown) => ({ stdout: JSON.stringify(v) })

const human = { login: 'dan', type: 'User' }
const REVIEWS = /gh api --paginate --slurp repos\/o\/r\/pulls\/7\/reviews/
const INLINE = /gh api --paginate --slurp repos\/o\/r\/pulls\/7\/comments/
const CONV = /gh api --paginate --slurp repos\/o\/r\/issues\/7\/comments/

function rules(opts: { reviews?: unknown[]; inline?: unknown[]; conv?: unknown[] }) {
  return new FakeExec()
    .on(REVIEWS, json([opts.reviews ?? []]))
    .on(INLINE, json([opts.inline ?? []]))
    .on(CONV, json([opts.conv ?? []]))
}

describe('reviewFeed', () => {
  it('turns review summaries into review comments and flags CHANGES_REQUESTED', async () => {
    const exec = rules({
      reviews: [
        {
          id: 1,
          state: 'CHANGES_REQUESTED',
          body: 'please fix',
          submitted_at: '2026-01-02T00:00:00Z',
          user: human,
        },
        { id: 2, state: 'APPROVED', body: '', submitted_at: '2026-01-03T00:00:00Z', user: human },
      ],
    })
    const r = await reviewFeed(feed(exec), 7, null)
    expect(r.changesRequested).toBe(true)
    expect(r.comments).toEqual([
      {
        id: 'review-1',
        author: 'dan',
        body: 'please fix',
        createdAt: '2026-01-02T00:00:00Z',
        kind: 'review',
      },
    ])
  })

  it('ignores CHANGES_REQUESTED at or before since', async () => {
    const exec = rules({
      reviews: [
        {
          id: 1,
          state: 'CHANGES_REQUESTED',
          body: 'old',
          submitted_at: '2026-01-02T00:00:00Z',
          user: human,
        },
      ],
    })
    const r = await reviewFeed(feed(exec), 7, '2026-01-02T00:00:00Z')
    expect(r.changesRequested).toBe(false)
    expect(r.comments).toEqual([])
    expect(r.cursor).toBe('2026-01-02T00:00:00Z')
  })

  it('carries path and line on inline comments, falling back to original_line', async () => {
    const exec = rules({
      inline: [
        {
          id: 10,
          body: 'a',
          created_at: '2026-01-02T00:00:00Z',
          user: human,
          path: 'x.ts',
          line: 5,
        },
        {
          id: 11,
          body: 'b',
          created_at: '2026-01-03T00:00:00Z',
          user: human,
          path: 'y.ts',
          line: null,
          original_line: 9,
        },
      ],
    })
    const r = await reviewFeed(feed(exec), 7, null)
    expect(r.comments).toMatchObject([
      { id: 'inline-10', kind: 'inline', path: 'x.ts', line: 5 },
      { id: 'inline-11', kind: 'inline', path: 'y.ts', line: 9 },
    ])
  })

  it('maps conversation comments', async () => {
    const exec = rules({
      conv: [{ id: 20, body: 'hello', created_at: '2026-01-02T00:00:00Z', user: human }],
    })
    const r = await reviewFeed(feed(exec), 7, null)
    expect(r.comments).toEqual([
      {
        id: 'conv-20',
        author: 'dan',
        body: 'hello',
        createdAt: '2026-01-02T00:00:00Z',
        kind: 'conversation',
      },
    ])
  })

  it('drops bots and empty bodies', async () => {
    const bot = { login: 'ci', type: 'Bot' }
    const bracket = { login: 'renovate[bot]', type: 'User' }
    const exec = rules({
      reviews: [
        { id: 1, state: 'COMMENTED', body: 'bot', submitted_at: '2026-01-02T00:00:00Z', user: bot },
        {
          id: 2,
          state: 'CHANGES_REQUESTED',
          body: 'bot',
          submitted_at: '2026-01-02T00:00:00Z',
          user: bracket,
        },
        {
          id: 3,
          state: 'COMMENTED',
          body: null,
          submitted_at: '2026-01-02T00:00:00Z',
          user: human,
        },
      ],
      inline: [
        { id: 4, body: 'bot', created_at: '2026-01-02T00:00:00Z', user: bot, path: 'a' },
        { id: 5, body: '', created_at: '2026-01-02T00:00:00Z', user: human, path: 'a' },
      ],
      conv: [
        { id: 6, body: 'bot', created_at: '2026-01-02T00:00:00Z', user: bracket },
        { id: 7, body: null, created_at: '2026-01-02T00:00:00Z', user: human },
      ],
    })
    const r = await reviewFeed(feed(exec), 7, null)
    expect(r.comments).toEqual([])
    expect(r.changesRequested).toBe(false)
    expect(r.cursor).toBeNull()
  })

  it('sorts by createdAt across kinds and uses the newest as cursor', async () => {
    const exec = rules({
      reviews: [
        { id: 1, state: 'COMMENTED', body: 'r', submitted_at: '2026-01-03T00:00:00Z', user: human },
      ],
      inline: [{ id: 2, body: 'i', created_at: '2026-01-01T00:00:00Z', user: human, path: 'a' }],
      conv: [{ id: 3, body: 'c', created_at: '2026-01-02T00:00:00Z', user: human }],
    })
    const r = await reviewFeed(feed(exec), 7, null)
    expect(r.comments.map((c) => c.id)).toEqual(['inline-2', 'conv-3', 'review-1'])
    expect(r.cursor).toBe('2026-01-03T00:00:00Z')
  })

  it('filters out items at or before since and passes since to the comment endpoints', async () => {
    const exec = rules({
      reviews: [
        {
          id: 1,
          state: 'COMMENTED',
          body: 'old',
          submitted_at: '2026-01-01T00:00:00Z',
          user: human,
        },
        {
          id: 2,
          state: 'COMMENTED',
          body: 'new',
          submitted_at: '2026-01-05T00:00:00Z',
          user: human,
        },
      ],
      inline: [
        { id: 3, body: 'old', created_at: '2026-01-01T00:00:00Z', user: human, path: 'a' },
        { id: 4, body: 'new', created_at: '2026-01-04T00:00:00Z', user: human, path: 'a' },
      ],
      conv: [
        { id: 5, body: 'old', created_at: '2026-01-02T00:00:00Z', user: human },
        { id: 6, body: 'new', created_at: '2026-01-03T00:00:00Z', user: human },
      ],
    })
    const r = await reviewFeed(feed(exec), 7, '2026-01-02T00:00:00Z')
    expect(r.comments.map((c) => c.id)).toEqual(['conv-6', 'inline-4', 'review-2'])
    expect(exec.lines().some((l) => l.includes('comments?since=2026-01-02T00%3A00%3A00Z'))).toBe(
      true,
    )
  })

  it('throws when gh fails, so the caller keeps its cursor', async () => {
    await expect(reviewFeed(feed(new FakeExec()), 7, 'c0')).rejects.toThrow('gh api failed')
  })
})

describe('checkRuns', () => {
  const runs = (check_runs: unknown[]) =>
    new FakeExec().on(/gh api repos\/o\/r\/commits\/abc\/check-runs/, json({ check_runs }))

  it('classifies failed checks', async () => {
    const r = await checkRuns(
      feed(
        runs([
          { name: 'lint', status: 'completed', conclusion: 'failure' },
          { name: 'slow', status: 'completed', conclusion: 'timed_out' },
          { name: 'stop', status: 'completed', conclusion: 'cancelled' },
          { name: 'test', status: 'completed', conclusion: 'success' },
          { name: 'skip', status: 'completed', conclusion: 'skipped' },
        ]),
      ),
      'abc',
    )
    expect(r).toEqual({
      headSha: 'abc',
      failed: ['lint', 'slow'],
      pending: false,
      passed: false,
    })
  })

  it('reports pending while any run is incomplete', async () => {
    const r = await checkRuns(
      feed(
        runs([
          { name: 'a', status: 'completed', conclusion: 'success' },
          { name: 'b', status: 'in_progress' },
        ]),
      ),
      'abc',
    )
    expect(r).toMatchObject({ failed: [], pending: true, passed: false })
  })

  it('passes when all runs succeed', async () => {
    const r = await checkRuns(
      feed(runs([{ name: 'a', status: 'completed', conclusion: 'success' }])),
      'abc',
    )
    expect(r).toMatchObject({ failed: [], pending: false, passed: true })
  })

  it('does not pass with no runs, and returns null on bad output', async () => {
    expect(await checkRuns(feed(runs([])), 'abc')).toMatchObject({ passed: false, pending: false })
    expect(await checkRuns(feed(new FakeExec()), 'abc')).toBeNull()
    const bad = new FakeExec().on(/gh api/, json({ nope: 1 }))
    expect(await checkRuns(feed(bad), 'abc')).toBeNull()
  })
})

describe('workflowRun', () => {
  it('returns the first run summary and encodes the branch', async () => {
    const exec = new FakeExec().on(
      /gh api repos\/o\/r\/actions\/workflows\/deploy\.yml\/runs\?head_sha=abc&branch=release%2F1&per_page=5/,
      json({
        workflow_runs: [
          { status: 'completed', conclusion: 'success', html_url: 'https://gh/run/1' },
          { status: 'queued', html_url: 'https://gh/run/0' },
        ],
      }),
    )
    expect(await workflowRun(feed(exec), 'deploy.yml', 'abc', 'release/1')).toEqual({
      status: 'completed',
      conclusion: 'success',
      url: 'https://gh/run/1',
    })
  })

  it('returns null conclusion while running, and null with no runs or on failure', async () => {
    const running = new FakeExec().on(
      /gh api/,
      json({ workflow_runs: [{ status: 'in_progress', html_url: 'u' }] }),
    )
    expect(await workflowRun(feed(running), 'd.yml', 'abc', 'main')).toEqual({
      status: 'in_progress',
      conclusion: null,
      url: 'u',
    })
    const none = new FakeExec().on(/gh api/, json({ workflow_runs: [] }))
    expect(await workflowRun(feed(none), 'd.yml', 'abc', 'main')).toBeNull()
    expect(await workflowRun(feed(new FakeExec()), 'd.yml', 'abc', 'main')).toBeNull()
  })
})
