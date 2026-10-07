import { cleanTail, describe, expect, it } from 'vitest'
import {
  factoryFooter,
  issueBrief,
  questionFrom,
  questionPath,
  reviewBrief,
  roundToken,
  cleanTail,
} from '../../src/factory/brief.js'
import type { Task } from '../../src/state.js'
import type { HumanComment, IssueRow, ReviewComment } from '../../src/factory/types.js'

const issue = (over: Partial<IssueRow> = {}): IssueRow => ({
  id: 'i1',
  identifier: 'ENG-12',
  team: 'ENG',
  repo: 'engine',
  title: 'Add retries',
  description: 'Retry the upload.\nTwice.',
  url: 'https://linear.app/x/issue/ENG-12',
  priority: 2,
  labels: ['bug', 'infra'],
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
  blockedBy: [],
  gone: false,
  updatedAt: '',
  createdAt: '',
  ...over,
})

const task: Task = {
  id: 'eng-12',
  repo: 'engine',
  slug: 'eng-12',
  branch: 'oar/eng-12',
  worktreePath: '/home/user/wt/eng-12',
  status: 'working',
  hours: 2,
  createdAt: '2026-01-01T00:00:00.000Z',
  briefPath: '/x/brief.md',
  runner: 'herdr',
}

describe('issueBrief', () => {
  it('includes identifier, title, url, repo, priority label, labels and description', () => {
    const md = issueBrief(issue(), [], 'engine')
    expect(md).toContain('# ENG-12: Add retries')
    expect(md).toContain('Linear: https://linear.app/x/issue/ENG-12')
    expect(md).toContain('Repo: engine')
    expect(md).toContain('Priority: high')
    expect(md).toContain('Labels: bug, infra')
    expect(md).toContain('Retry the upload.\nTwice.')
    expect(md).not.toContain('Discussion so far')
  })

  it('omits labels when there are none and falls back on empty description', () => {
    const md = issueBrief(issue({ labels: [], description: '  ', priority: 9 }), [], 'engine')
    expect(md).toContain('Priority: none')
    expect(md).not.toContain('Labels:')
    expect(md).toContain('(no description; the title is the whole request)')
  })

  it('quotes comments under the discussion heading', () => {
    const comments: HumanComment[] = [
      {
        id: 'c1',
        issueId: 'i1',
        author: 'dan',
        body: 'use backoff\nplease',
        createdAt: '2026-03-04T05:06:07.000Z',
      },
      { id: 'c2', issueId: 'i1', author: '', body: 'ok', createdAt: '2026-03-04T06:00:00.000Z' },
    ]
    const md = issueBrief(issue(), comments, 'engine')
    expect(md).toContain('## Discussion so far')
    expect(md).toContain('**dan** (2026-03-04 05:06):')
    expect(md).toContain('> use backoff\n> please')
    expect(md).toContain('**someone** (2026-03-04 06:00):')
  })
})

describe('factoryFooter', () => {
  const f = factoryFooter(task, issue())

  it('names the PR title and body rules after the issue', () => {
    expect(f.prTitle?.startsWith('ENG-12')).toBe(true)
    expect(f.prBody).toContain('Fixes ENG-12')
  })

  it('points blocked agents at question.md', () => {
    expect(f.blockedRule).toContain('question.md')
    expect(f.blockedRule).toContain(questionPath('eng-12'))
  })

  it('tells the agent where review rounds arrive', () => {
    expect(f.extra?.some((l) => l.includes('review-<n>.md'))).toBe(true)
    expect(f.extra?.join('\n')).toContain('/home/user/oar/tasks/eng-12/review-<n>.md')
  })
})

describe('reviewBrief', () => {
  const comments: ReviewComment[] = [
    {
      id: 'inline-1',
      author: 'rev',
      body: 'rename this\nnow',
      createdAt: '2026-01-01',
      kind: 'inline',
      path: 'src/a.ts',
      line: 12,
    },
    {
      id: 'inline-2',
      author: 'rev',
      body: 'file-level',
      createdAt: '2026-01-02',
      kind: 'inline',
      path: 'src/b.ts',
    },
    {
      id: 'conv-3',
      author: 'rev',
      body: 'overall ok',
      createdAt: '2026-01-03',
      kind: 'conversation',
    },
  ]

  it('lists failed checks and comments with path:line', () => {
    const md = reviewBrief(issue(), 2, comments, ['lint', 'test'], 'https://github.com/o/r/pull/7')
    expect(md).toContain('# ENG-12 review round 2')
    expect(md).toContain('PR: https://github.com/o/r/pull/7')
    expect(md).toContain('## CI is red')
    expect(md).toContain('Failed checks: lint, test.')
    expect(md).toContain('- **rev** on `src/a.ts:12` (inline):')
    expect(md).toContain('  > rename this\n  > now')
    expect(md).toContain('on `src/b.ts` (inline)')
    expect(md).toContain('- **rev** (conversation):')
  })

  it('skips empty sections and handles a missing PR url', () => {
    const md = reviewBrief(issue(), 1, [], [], null)
    expect(md).toContain('PR: (see the branch)')
    expect(md).not.toContain('CI is red')
    expect(md).not.toContain('Review comments')
    expect(md).toContain('## What to do')
  })
})

describe('questionFrom', () => {
  it('prefers the trimmed question file', () => {
    expect(questionFrom('  Which db?\n', 'pane text')).toBe('Which db?')
  })

  it('falls back to a fenced pane tail of the last 25 lines', () => {
    const pane = Array.from({ length: 40 }, (_, n) => `line ${n + 1}`).join('\n')
    for (const file of [null, '   ']) {
      const q = questionFrom(file, pane)
      expect(q).toContain('without writing question.md')
      expect(q).toContain('```\nline 16\n')
      expect(q).toContain('line 40\n```')
      expect(q).not.toContain('line 15\n')
    }
  })

  it('says so when there is nothing at all', () => {
    expect(questionFrom(null, '  \n')).toBe('The agent stopped without saying why.')
  })
})

describe('roundToken', () => {
  it('formats the round marker', () => {
    expect(roundToken(3)).toBe('[oar r3]')
  })
})

describe('cleanTail', () => {
  it('drops Claude TUI chrome and collapses blank runs', () => {
    const screen = [
      '- Checks: pnpm verify passed.',
      '',
      '',
      '✻ Brewed for 2m 25s · done 7:51 PM',
      '',
      '──────────────── eng-1-add-one-readme-senten-ed58 ─',
      '❯ [oar r3] Read /home/user/oar/tasks/x/review-3.md and address it.',
      '◤ graft · 5527 nodes / 15188 edges · ✓ synced',
      '▸ ctx 7%',
      '⏵⏵ bypass permissions on (shift+tab to cycle) · PR #151 · ← for agents',
    ].join('\n')
    expect(cleanTail(screen)).toBe('- Checks: pnpm verify passed.')
  })
  it('keeps only the last lines', () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n')
    expect(cleanTail(text, 3)).toBe('line 47\nline 48\nline 49')
  })
})
