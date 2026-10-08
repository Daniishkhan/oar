import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, type RepoConfig } from '../../src/config.js'
import {
  checkRuns,
  GhFeed,
  OAR_MARKER,
  prFiles,
  protectedChanges,
  reviewFeed,
  workflowRun,
} from '../../src/factory/github.js'
import { FakeExec } from '../fakes/exec.js'

const repo: RepoConfig = { ...DEFAULT_CONFIG.repos.engine!, github: 'o/r', requiredChecks: [] }
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
  const check = (name: string, conclusion: string | null = 'success', id = 1) => ({
    id,
    name,
    head_sha: 'abc',
    status: 'completed',
    conclusion,
    app: { id: 15368, slug: 'github-actions' },
  })
  const runs = (check_runs: unknown[], statuses: unknown[] = []) =>
    new FakeExec()
      .on(/gh api --paginate --slurp repos\/o\/r\/commits\/abc\/check-runs/, json([{ check_runs }]))
      .on(/gh api --paginate --slurp repos\/o\/r\/commits\/abc\/statuses/, json([statuses]))

  it('fails closed for every non-successful terminal conclusion', async () => {
    const r = await checkRuns(
      feed(
        runs([
          check('lint', 'failure'),
          check('slow', 'timed_out'),
          check('stop', 'cancelled'),
          check('test'),
          check('skip', 'skipped'),
          check('neutral', 'neutral'),
          check('unknown', null),
        ]),
      ),
      'abc',
    )
    expect(r).toMatchObject({
      headSha: 'abc',
      failed: ['lint', 'slow', 'stop', 'skip', 'neutral', 'unknown'],
      pending: false,
      passed: false,
    })
  })

  it('reports pending while any run is incomplete', async () => {
    const r = await checkRuns(
      feed(runs([check('a'), { ...check('b'), status: 'in_progress' }])),
      'abc',
    )
    expect(r).toMatchObject({ failed: [], pending: true, passed: false })
  })

  it('passes only when the configured required set exists and succeeds', async () => {
    const gh = new GhFeed(runs([check('test')]), null, null, {
      ...repo,
      requiredChecks: ['test', 'lint'],
    })
    expect(await checkRuns(gh, 'abc')).toMatchObject({
      missing: ['lint'],
      pending: true,
      passed: false,
    })
    expect(await checkRuns(feed(runs([check('test')])), 'abc')).toMatchObject({ passed: true })
  })

  it('paginates checks and commit statuses and uses the newest rerun/context', async () => {
    const exec = new FakeExec()
      .on(
        /check-runs/,
        json([
          { check_runs: [check('test', 'failure', 1)] },
          { check_runs: [check('test', 'success', 2)] },
        ]),
      )
      .on(
        /statuses/,
        json([
          [{ id: 4, context: 'legacy', state: 'success' }],
          [{ id: 3, context: 'legacy', state: 'failure' }],
        ]),
      )
    expect(await checkRuns(feed(exec), 'abc')).toMatchObject({
      passed: true,
      checks: [
        { name: 'test', state: 'success', source: 'check' },
        { name: 'legacy', state: 'success', source: 'status' },
      ],
    })
    expect(exec.lines().every((line) => line.includes('--paginate --slurp'))).toBe(true)
  })

  it('keeps a failing run from another check suite even when a newer run shares its name', async () => {
    const gh = feed(
      runs([
        { ...check('test', 'failure', 1), check_suite: { id: 10 } },
        { ...check('test', 'success', 2), check_suite: { id: 11 } },
      ]),
    )
    expect(await checkRuns(gh, 'abc')).toMatchObject({ passed: false, failed: ['test'] })
    const rerun = feed(
      runs([
        { ...check('test', 'failure', 1), check_suite: { id: 10 } },
        { ...check('test', 'success', 2), check_suite: { id: 10 } },
      ]),
    )
    expect(await checkRuns(rerun, 'abc')).toMatchObject({ passed: true, failed: [] })
  })
  it('does not let another GitHub app mask a failed check with the same name', async () => {
    const gh = feed(
      runs([
        { ...check('test', 'failure', 1), app: { id: 1 } },
        { ...check('test', 'success', 2), app: { id: 2 } },
      ]),
    )
    expect(await checkRuns(gh, 'abc')).toMatchObject({ passed: false, failed: ['test'] })
  })

  it('legacy statuses can fail a check but never satisfy one', async () => {
    expect(
      await checkRuns(
        feed(runs([check('test')], [{ id: 1, context: 'legacy', state: 'error' }])),
        'abc',
      ),
    ).toMatchObject({ passed: false, failed: ['legacy'] })
    // A builder holding the repo token can post a commit status under any name.
    const gh = new GhFeed(runs([], [{ id: 1, context: 'legacy', state: 'success' }]), null, null, {
      ...repo,
      requiredChecks: ['legacy'],
    })
    expect(await checkRuns(gh, 'abc')).toMatchObject({
      passed: false,
      pending: true,
      missing: ['legacy'],
    })
    const spoofed = new GhFeed(
      runs([check('checks')], [{ id: 1, context: 'checks', state: 'success' }]),
      null,
      null,
      { ...repo, requiredChecks: ['checks'] },
    )
    expect(await checkRuns(spoofed, 'abc')).toMatchObject({ passed: true, missing: [] })
  })
  it('only a check run from a trusted GitHub App satisfies a check; any app can fail it', async () => {
    const other = { ...check('test', 'success', 1), app: { id: 9, slug: 'other-ci' } }
    const gh = new GhFeed(runs([other]), null, null, { ...repo, requiredChecks: ['test'] })
    expect(await checkRuns(gh, 'abc')).toMatchObject({
      passed: false,
      pending: true,
      missing: ['test'],
    })
    expect(await checkRuns(feed(runs([other])), 'abc')).toMatchObject({ passed: false })
    const failing = { ...check('test', 'failure', 2), app: { id: 9, slug: 'other-ci' } }
    expect(await checkRuns(feed(runs([check('test'), failing])), 'abc')).toMatchObject({
      passed: false,
      failed: ['test'],
    })
    const allowed = new GhFeed(runs([other]), null, null, { ...repo, checkApps: ['other-ci'] })
    expect(await checkRuns(allowed, 'abc')).toMatchObject({ passed: true })
  })

  it('does not pass with no runs, missing pages, bad output or the wrong revision', async () => {
    expect(await checkRuns(feed(runs([])), 'abc')).toMatchObject({ passed: false, pending: false })
    expect(await checkRuns(feed(new FakeExec()), 'abc')).toBeNull()
    expect(await checkRuns(feed(runs([{ ...check('test'), head_sha: 'old' }])), 'abc')).toBeNull()
    const missingStatuses = new FakeExec().on(/check-runs/, json([{ check_runs: [check('test')] }]))
    expect(await checkRuns(feed(missingStatuses), 'abc')).toBeNull()
    const bad = new FakeExec().on(/gh api/, json({ nope: 1 }))
    expect(await checkRuns(feed(bad), 'abc')).toBeNull()
  })
})

describe('workflowRun', () => {
  const run = {
    id: 1,
    run_attempt: 1,
    head_sha: 'abc',
    head_branch: 'release/1',
    status: 'completed',
    conclusion: 'success',
    html_url: 'https://gh/run/1',
    run_started_at: '2026-10-08T09:00:00Z',
    updated_at: '2026-10-08T09:10:00Z',
  }
  it('paginates and selects the newest exact revision and branch', async () => {
    const exec = new FakeExec().on(
      /gh api --paginate --slurp repos\/o\/r\/actions\/workflows\/deploy\.yml\/runs\?head_sha=abc&branch=release%2F1&per_page=100/,
      json([
        {
          workflow_runs: [
            { ...run, id: 9, head_sha: 'old' },
            { ...run, id: 8, head_branch: 'wrong' },
          ],
        },
        { workflow_runs: [run] },
      ]),
    )
    expect(await workflowRun(feed(exec), 'deploy.yml', 'abc', 'release/1')).toEqual({
      headSha: 'abc',
      status: 'completed',
      conclusion: 'success',
      url: 'https://gh/run/1',
      runId: 1,
      attempt: 1,
      startedAt: '2026-10-08T09:00:00Z',
      completedAt: '2026-10-08T09:10:00Z',
      runName: '',
    })
  })

  it('returns a pending snapshot, and null with no exact run or on failure', async () => {
    const running = new FakeExec().on(
      /gh api/,
      json({ workflow_runs: [{ ...run, status: 'in_progress', conclusion: null }] }),
    )
    expect(await workflowRun(feed(running), 'd.yml', 'abc', 'release/1')).toMatchObject({
      status: 'in_progress',
      conclusion: null,
      completedAt: null,
    })
    const none = new FakeExec().on(/gh api/, json({ workflow_runs: [] }))
    expect(await workflowRun(feed(none), 'd.yml', 'abc', 'main')).toBeNull()
    const wrong = new FakeExec().on(/gh api/, json({ workflow_runs: [run] }))
    expect(await workflowRun(feed(wrong), 'd.yml', 'wrong', 'main')).toBeNull()
    expect(await workflowRun(feed(new FakeExec()), 'd.yml', 'abc', 'main')).toBeNull()
  })
})

describe('reviewFeed and the controller own comments', () => {
  it('drops comments carrying the oar marker and never uses them as the cursor', async () => {
    const mine = `${OAR_MARKER}\n**Automated review** …`
    const exec = rules({
      reviews: [
        {
          id: 1,
          state: 'COMMENTED',
          body: mine,
          submitted_at: '2026-01-05T00:00:00Z',
          user: human,
        },
      ],
      inline: [{ id: 2, body: mine, created_at: '2026-01-05T00:00:00Z', user: human, path: 'a' }],
      conv: [
        { id: 3, body: mine, created_at: '2026-01-05T00:00:00Z', user: human },
        { id: 4, body: 'real feedback', created_at: '2026-01-02T00:00:00Z', user: human },
      ],
    })
    const r = await reviewFeed(feed(exec), 7, null)
    expect(r.comments.map((c) => c.id)).toEqual(['conv-4'])
    expect(r.cursor).toBe('2026-01-02T00:00:00Z')
  })
})

describe('prFiles and protectedChanges', () => {
  it('lists every touched path across pages, with the old name of a rename', async () => {
    const exec = new FakeExec().on(
      /gh api --paginate --slurp repos\/o\/r\/pulls\/7\/files/,
      json([
        [
          { filename: 'src/a.ts' },
          { filename: 'docs/b.md', previous_filename: '.github/CODEOWNERS' },
        ],
        [{ filename: 'src/a.ts' }],
      ]),
    )
    expect(await prFiles(feed(exec), 7)).toEqual(['src/a.ts', 'docs/b.md', '.github/CODEOWNERS'])
    expect(await prFiles(feed(new FakeExec()), 7)).toBeNull()
  })
  it('matches directories by prefix and files exactly', () => {
    const files = [
      '.github/workflows/ci.yml',
      'AGENTS.md',
      'src/AGENTS.md',
      'docs/.github/x',
      '.claude/settings.json',
      'README.md',
    ]
    expect(protectedChanges(files, ['.github/', 'AGENTS.md', '.claude/'])).toEqual([
      '.github/workflows/ci.yml',
      'AGENTS.md',
      '.claude/settings.json',
    ])
  })
})
