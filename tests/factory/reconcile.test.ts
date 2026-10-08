import { describe, expect, it } from 'vitest'
import { decide, type DecideContext } from '../../src/factory/reconcile.js'
import type {
  Action,
  Facts,
  Finding,
  HumanComment,
  IssueRow,
  PrSnapshot,
} from '../../src/factory/types.js'

const NOW = '2026-10-08T09:00:00.000Z'

const row = (over: Partial<IssueRow> = {}): IssueRow => ({
  id: 'iss-1',
  identifier: 'ENG-12',
  team: 'ENG',
  repo: 'engine',
  title: 'Fix the thing',
  description: 'Please fix it',
  url: 'https://linear.app/x/issue/ENG-12',
  priority: 2,
  labels: [],
  kind: 'build',
  linearState: 'Ready',
  linearStateType: 'unstarted',
  lastSetState: null,
  phase: 'queued',
  round: 0,
  roundStartSha: null,
  roundStartedAt: null,
  taskId: null,
  prNumber: null,
  prUrl: null,
  handledCiSha: null,
  ciRounds: 0,
  reviewCursor: null,
  jobStartedAt: null,
  reviewedSha: null,
  reviewVerdict: null,
  reviewFindings: [],
  reviewRounds: 0,
  reviewRoundSha: null,
  mergeSha: null,
  blockedBy: [],
  gone: false,
  updatedAt: NOW,
  createdAt: NOW,
  ...over,
})

const facts = (over: Partial<Facts> = {}): Facts => ({
  vmUp: true,
  agent: null,
  pr: null,
  marker: false,
  question: null,
  paneTail: '',
  undelivered: [],
  review: { comments: [], changesRequested: false, cursor: null },
  ci: null,
  staging: null,
  linearKey: 'ready',
  humanMoved: true,
  nowIso: NOW,
  slotFree: true,
  jobRunning: false,
  jobAgeMs: 0,
  blocked: false,
  idleForMs: 0,
  ...over,
})

const pr = (over: Partial<PrSnapshot> = {}): PrSnapshot => ({
  number: 7,
  url: 'https://github.com/o/r/pull/7',
  state: 'OPEN',
  isDraft: true,
  headSha: 'abc123',
  mergeSha: null,
  updatedAt: NOW,
  reviewDecision: '',
  mergeable: 'MERGEABLE',
  ...over,
})

const comment = (over: Partial<HumanComment> = {}): HumanComment => ({
  id: 'c-1',
  issueId: 'iss-1',
  author: 'danish',
  body: 'Use option B',
  createdAt: NOW,
  ...over,
})

const ctx: DecideContext = {
  limits: {
    maxCiRounds: 3,
    jobTimeoutMs: 30 * 60_000,
    maxReviewRounds: 3,
    stallGraceMs: 20 * 60_000,
  },
  states: {
    ready: 'Ready',
    inProgress: 'In Progress',
    needsInput: 'Needs Input',
    inReview: 'In Review',
    done: 'Done',
    canceled: 'Canceled',
  },
  mention: '@danish',
  tracksDeploy: false,
  identifier: 'ENG-12',
  blocking: ['P0', 'P1'],
  holdLabel: 'hold',
  autoMerge: true,
  mergeMethod: 'squash',
}

const kinds = (actions: Action[]) => actions.map((a) => a.kind)
const find = <K extends Action['kind']>(actions: Action[], kind: K) =>
  actions.find((a): a is Extract<Action, { kind: K }> => a.kind === kind)

describe('decide: queued', () => {
  it('dispatches a Ready issue when the slot is free', () => {
    const a = decide(row(), facts(), ctx)
    expect(kinds(a)).toEqual(['set_phase', 'event', 'dispatch'])
    expect(find(a, 'set_phase')).toMatchObject({ phase: 'dispatching', jobStartedAt: NOW })
  })
  it('waits when not Ready, blocked, busy or without a slot', () => {
    expect(decide(row(), facts({ linearKey: 'other' }), ctx)).toEqual([])
    expect(decide(row(), facts({ blocked: true }), ctx)).toEqual([])
    expect(decide(row(), facts({ slotFree: false }), ctx)).toEqual([])
    expect(decide(row(), facts({ jobRunning: true }), ctx)).toEqual([])
  })
  it('closes a canceled or done issue before it started', () => {
    expect(kinds(decide(row(), facts({ linearKey: 'canceled' }), ctx))).toEqual([
      'set_phase',
      'event',
    ])
    expect(find(decide(row({ gone: true }), facts(), ctx), 'set_phase')?.phase).toBe('closed')
  })
  it('fails loudly when the repo has no VM', () => {
    const a = decide(row(), facts({ vmUp: null }), ctx)
    expect(find(a, 'comment')?.key).toBe('no-vm')
    expect(find(a, 'comment')?.body).toContain('@danish')
    expect(a.at(-1)).toMatchObject({ kind: 'set_phase', phase: 'failed' })
  })
})

describe('decide: dispatching / resuming', () => {
  it('does nothing while the job runs', () => {
    expect(decide(row({ phase: 'dispatching' }), facts({ jobRunning: true }), ctx)).toEqual([])
  })
  it('re-runs the job after a restart', () => {
    expect(kinds(decide(row({ phase: 'dispatching' }), facts(), ctx))).toEqual(['dispatch'])
    const a = decide(row({ phase: 'resuming', round: 2 }), facts(), ctx)
    expect(find(a, 'resume')?.message).toContain('[oar r2]')
  })
  it('gives up after the timeout', () => {
    const a = decide(row({ phase: 'dispatching' }), facts({ jobAgeMs: 31 * 60_000 }), ctx)
    expect(find(a, 'set_state')?.state).toBe('needsInput')
    expect(a.at(-1)).toMatchObject({ kind: 'set_phase', phase: 'failed', jobStartedAt: null })
  })
})

describe('decide: building', () => {
  const b = (over: Partial<IssueRow> = {}) =>
    row({
      phase: 'building',
      round: 1,
      taskId: 't1',
      linearState: 'In Progress',
      lastSetState: 'In Progress',
      ...over,
    })
  it('steers comments into a working agent and otherwise waits', () => {
    expect(decide(b(), facts({ agent: 'working', linearKey: 'inProgress' }), ctx)).toEqual([])
    const a = decide(
      b(),
      facts({ agent: 'working', linearKey: 'inProgress', undelivered: [comment()] }),
      ctx,
    )
    expect(a).toEqual([{ kind: 'deliver', comment: comment(), mode: 'steer' }])
  })
  it('moves to review when the marker is set and a PR with new commits exists', () => {
    const a = decide(
      b(),
      facts({ agent: 'idle', linearKey: 'inProgress', marker: true, pr: pr() }),
      ctx,
    )
    expect(kinds(a)).toEqual(['link_pr', 'comment', 'set_state', 'set_phase', 'event'])
    expect(find(a, 'set_state')?.state).toBe('inReview')
    expect(find(a, 'set_phase')).toMatchObject({
      phase: 'review',
      prNumber: 7,
      roundStartSha: 'abc123',
      reviewCursor: NOW,
    })
    expect(find(a, 'comment')?.key).toBe('pr-1')
  })
  it('does not link the PR again on a later round', () => {
    const a = decide(
      b({ round: 2, prNumber: 7, roundStartSha: 'old' }),
      facts({ agent: 'done', linearKey: 'inProgress', marker: true, pr: pr({ headSha: 'new' }) }),
      ctx,
    )
    expect(kinds(a)).not.toContain('link_pr')
    expect(find(a, 'comment')?.body).toContain('Round 2 pushed')
  })
  it('returns a later round with no commits to review instead of asking', () => {
    const a = decide(
      b({ round: 2, prNumber: 7, roundStartSha: 'abc123' }),
      facts({
        agent: 'idle',
        linearKey: 'inProgress',
        marker: true,
        pr: pr(),
        paneTail: 'nothing to change',
      }),
      ctx,
    )
    expect(kinds(a)).toEqual(['comment', 'set_state', 'set_phase', 'event'])
    expect(find(a, 'comment')?.key).toBe('noop-2')
    expect(find(a, 'set_phase')?.phase).toBe('review')
  })
  it('asks for input when done was touched but nothing was pushed', () => {
    const a = decide(
      b({ roundStartSha: 'abc123' }),
      facts({ agent: 'idle', linearKey: 'inProgress', marker: true, pr: pr() }),
      ctx,
    )
    expect(find(a, 'comment')?.key).toBe('nopush-1')
    expect(find(a, 'set_phase')?.phase).toBe('needs_input')
  })
  it('relays a question, or reports a stall', () => {
    const q = decide(
      b(),
      facts({ agent: 'idle', linearKey: 'inProgress', question: 'A or B?' }),
      ctx,
    )
    expect(find(q, 'comment')).toMatchObject({ key: 'question-1' })
    expect(find(q, 'comment')?.body).toContain('A or B?')
    expect(find(q, 'set_state')?.state).toBe('needsInput')
    // idle without the marker: a background gate may still run, so wait out the grace period
    expect(
      decide(b(), facts({ agent: 'idle', linearKey: 'inProgress', idleForMs: 19 * 60_000 }), ctx),
    ).toEqual([])
    const s = decide(
      b(),
      facts({
        agent: 'idle',
        linearKey: 'inProgress',
        paneTail: 'last lines',
        idleForMs: 20 * 60_000,
      }),
      ctx,
    )
    expect(find(s, 'comment')?.key).toBe('stalled-1')
    expect(find(s, 'comment')?.body).toContain('last lines')
  })
  it('prompts an idle agent with a fresh comment before concluding anything', () => {
    const a = decide(
      b(),
      facts({ agent: 'idle', linearKey: 'inProgress', undelivered: [comment()] }),
      ctx,
    )
    expect(a).toEqual([{ kind: 'deliver', comment: comment(), mode: 'prompt' }])
  })
  it('reports a dialog it cannot answer', () => {
    const a = decide(
      b(),
      facts({ agent: 'blocked', linearKey: 'inProgress', paneTail: 'Allow?' }),
      ctx,
    )
    expect(find(a, 'comment')?.key).toBe('dialog-1')
    expect(find(a, 'comment')?.body).toContain('oar factory attach ENG-12')
  })
  it('resumes an exited agent or a stopped VM, carrying undelivered comments', () => {
    const a = decide(
      b(),
      facts({ agent: 'exited', linearKey: 'inProgress', undelivered: [comment()] }),
      ctx,
    )
    expect(kinds(a)).toEqual(['set_phase', 'resume'])
    expect(find(a, 'resume')?.deliver).toHaveLength(1)
    expect(
      find(decide(b(), facts({ agent: 'vm-down', linearKey: 'inProgress' }), ctx), 'set_phase')
        ?.phase,
    ).toBe('resuming')
  })
  it('handles a merge or a closed PR that happened under it', () => {
    const m = decide(
      b(),
      facts({
        agent: 'idle',
        linearKey: 'inProgress',
        pr: pr({ state: 'MERGED', mergeSha: 'm1' }),
      }),
      ctx,
    )
    expect(kinds(m)).toEqual([
      'comment',
      'set_state',
      'stop_agent',
      'close_task',
      'set_phase',
      'event',
    ])
    expect(find(m, 'set_phase')).toMatchObject({ phase: 'closed', roundStartSha: 'm1' })
    const c = decide(
      b(),
      facts({ agent: 'idle', linearKey: 'inProgress', pr: pr({ state: 'CLOSED' }) }),
      ctx,
    )
    expect(find(c, 'comment')?.key).toBe('pr-closed-7')
  })
  it('stops the agent when the issue is canceled', () => {
    const a = decide(b(), facts({ agent: 'working', linearKey: 'canceled' }), ctx)
    expect(kinds(a)).toEqual(['stop_agent', 'close_task', 'comment', 'set_phase', 'event'])
  })
})

describe('decide: needs_input', () => {
  const n = (over: Partial<IssueRow> = {}) =>
    row({
      phase: 'needs_input',
      round: 1,
      taskId: 't1',
      linearState: 'Needs Input',
      lastSetState: 'Needs Input',
      ...over,
    })
  it('starts the next round from an answer', () => {
    const a = decide(
      n(),
      facts({ agent: 'idle', linearKey: 'needsInput', undelivered: [comment()], pr: pr() }),
      ctx,
    )
    expect(kinds(a)).toEqual(['reset_round_files', 'set_phase', 'event', 'deliver', 'set_state'])
    expect(find(a, 'set_phase')).toMatchObject({
      phase: 'building',
      round: 2,
      roundStartSha: 'abc123',
    })
    const d = find(a, 'deliver')!
    expect(d.mode).toBe('prompt')
    expect(d.comment.body).toContain('[oar r2]')
    expect(d.comment.body).toContain('Use option B')
    expect(find(a, 'set_state')?.state).toBe('inProgress')
  })
  it('leaves the answer waiting while the agent sits at a dialog', () => {
    const a = decide(
      n(),
      facts({ agent: 'blocked', linearKey: 'needsInput', undelivered: [comment()] }),
      ctx,
    )
    expect(a).toEqual([{ kind: 'deliver', comment: comment(), mode: 'undeliverable' }])
  })
  it('resumes a gone agent with the answer as its message', () => {
    const a = decide(
      n(),
      facts({ agent: 'exited', linearKey: 'needsInput', undelivered: [comment()] }),
      ctx,
    )
    expect(find(a, 'set_phase')).toMatchObject({ phase: 'resuming', round: 2 })
    expect(find(a, 'resume')?.message).toContain('Use option B')
  })
  it('follows an agent someone restarted by hand, and a round it finished on its own', () => {
    const a = decide(n(), facts({ agent: 'working', linearKey: 'needsInput' }), ctx)
    expect(kinds(a)).toEqual(['set_state', 'set_phase'])
    expect(decide(n(), facts({ agent: 'idle', linearKey: 'needsInput' }), ctx)).toEqual([])
    const done = decide(
      n({ prNumber: 7, roundStartSha: 'old' }),
      facts({ agent: 'idle', linearKey: 'needsInput', marker: true, pr: pr({ headSha: 'new' }) }),
      ctx,
    )
    expect(find(done, 'set_state')?.state).toBe('inReview')
    expect(find(done, 'set_phase')?.phase).toBe('review')
  })
})

describe('decide: review', () => {
  const r = (over: Partial<IssueRow> = {}) =>
    row({
      phase: 'review',
      round: 1,
      taskId: 't1',
      prNumber: 7,
      prUrl: pr().url,
      roundStartSha: 'abc123',
      linearState: 'In Review',
      lastSetState: 'In Review',
      ...over,
    })
  const rc = {
    id: 'inline-1',
    author: 'danish',
    body: 'rename this',
    createdAt: NOW,
    kind: 'inline' as const,
  }
  it('closes out a merge', () => {
    const a = decide(
      r(),
      facts({ agent: 'idle', linearKey: 'inReview', pr: pr({ state: 'MERGED', mergeSha: 'm1' }) }),
      { ...ctx, tracksDeploy: true },
    )
    expect(find(a, 'set_state')?.state).toBe('done')
    expect(find(a, 'set_phase')).toMatchObject({ phase: 'merged', roundStartSha: 'm1' })
    expect(find(a, 'comment')?.body).toContain('deploy')
  })
  it('starts a review round from review comments and Linear comments', () => {
    const a = decide(
      r(),
      facts({
        agent: 'idle',
        linearKey: 'inReview',
        pr: pr(),
        review: { comments: [rc], changesRequested: true, cursor: '2026-10-08T09:30:00Z' },
        undelivered: [comment()],
      }),
      ctx,
    )
    expect(kinds(a)).toEqual(['review_round'])
    const rr = find(a, 'review_round')!
    expect(rr.comments).toHaveLength(2)
    expect(rr.cursor).toBe('2026-10-08T09:30:00Z')
    expect(rr.deliver).toHaveLength(1)
    expect(rr.ciSha).toBeUndefined()
  })
  it('starts a CI round once per SHA and stops at the limit', () => {
    const red = { headSha: 'abc123', failed: ['Verify'], pending: false, passed: false }
    const a = decide(r(), facts({ agent: 'idle', linearKey: 'inReview', pr: pr(), ci: red }), ctx)
    expect(find(a, 'review_round')).toMatchObject({ ciSha: 'abc123', failed: ['Verify'] })
    expect(
      decide(
        r({ handledCiSha: 'abc123' }),
        facts({ agent: 'idle', linearKey: 'inReview', pr: pr(), ci: red }),
        ctx,
      ),
    ).toEqual([])
    const limit = decide(
      r({ ciRounds: 3 }),
      facts({ agent: 'idle', linearKey: 'inReview', pr: pr(), ci: red }),
      ctx,
    )
    expect(find(limit, 'comment')?.key).toBe('ci-limit-abc123')
    expect(limit.at(-1)).toMatchObject({
      kind: 'set_phase',
      phase: 'needs_input',
      handledCiSha: 'abc123',
    })
  })
  it('waits while the agent works, the slot is taken, or nothing happened', () => {
    const feedback = { comments: [rc], changesRequested: false, cursor: NOW }
    expect(
      decide(
        r(),
        facts({ agent: 'working', linearKey: 'inReview', pr: pr(), review: feedback }),
        ctx,
      ),
    ).toEqual([])
    expect(
      decide(
        r(),
        facts({
          agent: 'idle',
          linearKey: 'inReview',
          pr: pr(),
          review: feedback,
          slotFree: false,
        }),
        ctx,
      ),
    ).toEqual([])
    expect(decide(r(), facts({ agent: 'idle', linearKey: 'inReview', pr: pr() }), ctx)).toEqual([])
  })
  it('asks for input when the PR is closed unmerged', () => {
    const a = decide(
      r(),
      facts({ agent: 'idle', linearKey: 'inReview', pr: pr({ state: 'CLOSED' }) }),
      ctx,
    )
    expect(find(a, 'comment')?.key).toBe('pr-closed-7')
  })
})

describe('decide: merged', () => {
  const m = (over: Partial<IssueRow> = {}) =>
    row({ phase: 'merged', roundStartSha: 'm1', roundStartedAt: NOW, ...over })
  it('posts the deploy result, or gives up after three hours', () => {
    const t = { ...ctx, tracksDeploy: true }
    const ok = decide(
      m(),
      facts({ linearKey: 'done', staging: { conclusion: 'success', url: 'https://gh/run/1' } }),
      t,
    )
    expect(find(ok, 'comment')?.body).toContain('success')
    expect(ok.at(-2)).toMatchObject({ kind: 'set_phase', phase: 'closed' })
    expect(decide(m(), facts({ linearKey: 'done' }), t)).toEqual([])
    const late = decide(m(), facts({ linearKey: 'done', nowIso: '2026-10-08T13:00:00.000Z' }), t)
    expect(find(late, 'comment')?.key).toBe('deploy-none-m1')
    expect(decide(m(), facts({ linearKey: 'done' }), ctx)).toEqual([
      { kind: 'set_phase', phase: 'closed' },
    ])
  })
})

describe('decide: automated review and merge', () => {
  const r = (over: Partial<IssueRow> = {}) =>
    row({
      phase: 'review',
      round: 1,
      taskId: 't1',
      prNumber: 7,
      prUrl: pr().url,
      roundStartSha: 'abc123',
      linearState: 'In Review',
      lastSetState: 'In Review',
      ...over,
    })
  const green = { headSha: 'abc123', failed: [], pending: false, passed: true }
  const quiet = (over: Partial<Facts> = {}) =>
    facts({ agent: 'idle', linearKey: 'inReview', pr: pr(), ci: green, ...over })
  const p1: Finding = {
    severity: 'P1',
    file: 'a.py',
    line: 3,
    title: 'Off by one',
    detail: 'loses the last row',
    fix: 'use <=',
  }
  const p3: Finding = {
    severity: 'P3',
    file: 'b.py',
    line: null,
    title: 'Name',
    detail: '',
    fix: null,
  }
  const reviewed = (over: Partial<IssueRow> = {}) =>
    r({ reviewedSha: 'abc123', reviewVerdict: 'pass', ...over })

  it('reviews a green head once', () => {
    const a = decide(r(), quiet(), ctx)
    expect(a).toEqual([{ kind: 'auto_review', sha: 'abc123' }])
  })
  it('waits for green CI on this head and for running jobs', () => {
    expect(decide(r(), quiet({ ci: null }), ctx)).toEqual([])
    expect(decide(r(), quiet({ ci: { ...green, pending: true, passed: false } }), ctx)).toEqual([])
    expect(decide(r(), quiet({ ci: { ...green, headSha: 'old' } }), ctx)).toEqual([])
    expect(
      decide(r(), quiet({ ci: { ...green, passed: false, failed: ['Verify'] } }), ctx),
    ).toMatchObject([{ kind: 'review_round', ciSha: 'abc123' }])
    expect(decide(r(), quiet({ jobRunning: true }), ctx)).toEqual([])
  })
  it('puts human feedback before the automated review', () => {
    const a = decide(
      r(),
      quiet({
        review: {
          comments: [
            { id: 'conv-1', author: 'dan', body: 'x', createdAt: NOW, kind: 'conversation' },
          ],
          changesRequested: false,
          cursor: NOW,
        },
      }),
      ctx,
    )
    expect(kinds(a)).toEqual(['review_round'])
    expect(find(a, 'review_round')!.reviewSha).toBeUndefined()
  })
  it('sends blocking findings back to the agent as a round, blocking first', () => {
    const a = decide(reviewed({ reviewVerdict: 'block', reviewFindings: [p3, p1] }), quiet(), ctx)
    const rr = find(a, 'review_round')!
    expect(rr).toMatchObject({ reviewSha: 'abc123', failed: [], deliver: [] })
    expect(rr.comments[0]).toMatchObject({
      severity: 'P1',
      blocking: true,
      path: 'a.py',
      line: 3,
      kind: 'review',
      body: '[P1] Off by one — loses the last row — fix: use <=',
    })
    expect(rr.comments[1]).toMatchObject({ severity: 'P3', blocking: false })
    expect(
      decide(
        reviewed({ reviewVerdict: 'block', reviewFindings: [p1] }),
        quiet({ slotFree: false }),
        ctx,
      ),
    ).toEqual([])
  })
  it('asks a human when a round changed nothing, the round limit is hit, or the review failed', () => {
    const noop = decide(
      reviewed({ reviewVerdict: 'block', reviewFindings: [p1], reviewRoundSha: 'abc123' }),
      quiet(),
      ctx,
    )
    expect(find(noop, 'comment')?.key).toBe('review-noop-abc123')
    expect(find(noop, 'set_phase')?.phase).toBe('needs_input')
    const limit = decide(
      reviewed({ reviewVerdict: 'block', reviewFindings: [p1], reviewRounds: 3 }),
      quiet(),
      ctx,
    )
    expect(find(limit, 'comment')?.key).toBe('review-limit-abc123')
    const err = decide(reviewed({ reviewVerdict: 'error' }), quiet(), ctx)
    expect(find(err, 'comment')?.key).toBe('review-error-abc123')
    expect(find(err, 'set_state')?.state).toBe('needsInput')
  })
  it('merges a clean review of a green head', () => {
    expect(decide(reviewed({ reviewFindings: [p3] }), quiet(), ctx)).toEqual([
      { kind: 'merge', number: 7, sha: 'abc123', method: 'squash', isDraft: true },
    ])
  })
  it('does not merge when held, turned off, or a human requested changes', () => {
    expect(decide(reviewed({ labels: ['Hold'] }), quiet(), ctx)).toEqual([])
    expect(decide(reviewed(), quiet(), { ...ctx, autoMerge: false })).toEqual([])
    expect(
      decide(reviewed(), quiet({ pr: pr({ reviewDecision: 'CHANGES_REQUESTED' }) }), ctx),
    ).toEqual([])
  })
  it('asks for help when the branch conflicts', () => {
    const a = decide(reviewed(), quiet({ pr: pr({ mergeable: 'CONFLICTING' }) }), ctx)
    expect(find(a, 'comment')?.key).toBe('conflict-abc123')
  })
  it('attempts a merge at most once per head and flags one that never finished', () => {
    expect(
      decide(reviewed({ mergeSha: 'abc123', jobStartedAt: NOW }), quiet({ jobAgeMs: 60_000 }), ctx),
    ).toEqual([])
    expect(decide(reviewed({ mergeSha: 'abc123' }), quiet(), ctx)).toEqual([])
    const stuck = decide(
      reviewed({ mergeSha: 'abc123', jobStartedAt: NOW }),
      quiet({ jobAgeMs: 31 * 60_000 }),
      ctx,
    )
    expect(find(stuck, 'comment')?.key).toBe('merge-stuck-abc123')
    expect(stuck.at(-1)).toMatchObject({
      kind: 'set_phase',
      phase: 'needs_input',
      jobStartedAt: null,
    })
    // a new head after the failed attempt is judged again
    expect(decide(reviewed({ mergeSha: 'old' }), quiet(), ctx).map((a) => a.kind)).toEqual([
      'merge',
    ])
  })
  it('lets a human answer retry a failed merge or review and resets the round budget', () => {
    const a = decide(
      r({
        phase: 'needs_input',
        mergeSha: 'abc123',
        reviewedSha: 'abc123',
        reviewVerdict: 'error',
        reviewRounds: 3,
        linearState: 'Needs Input',
        lastSetState: 'Needs Input',
      }),
      facts({ agent: 'idle', linearKey: 'needsInput', pr: pr(), undelivered: [comment()] }),
      ctx,
    )
    expect(find(a, 'set_phase')).toMatchObject({
      phase: 'building',
      mergeSha: null,
      reviewRounds: 0,
      reviewedSha: null,
    })
  })
  it('keeps an issue in Needs Input when only an old done marker is there', () => {
    const a = decide(
      r({
        phase: 'needs_input',
        round: 2,
        linearState: 'Needs Input',
        lastSetState: 'Needs Input',
      }),
      facts({ agent: 'idle', linearKey: 'needsInput', marker: true, pr: pr() }),
      ctx,
    )
    expect(a).toEqual([])
  })
  it('names the configured trigger state in its messages', () => {
    const a = decide(row(), facts({ vmUp: null }), {
      ...ctx,
      states: { ...ctx.states, ready: 'Todo' },
    })
    expect(find(a, 'comment')?.body).toContain('move this back to Todo')
  })
})
