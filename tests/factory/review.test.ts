import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../../src/config.js'
import { OAR_MARKER } from '../../src/factory/github.js'
import {
  findingsComment,
  findingsLine,
  findingsSummary,
  findingsToComments,
  parseReviewOutput,
  REVIEW_SCHEMA,
  reviewCheckout,
  reviewCommand,
  reviewFiles,
  reviewPrompt,
  reviewWorktree,
  verdictOf,
} from '../../src/factory/review.js'
import type { Finding, IssueRow } from '../../src/factory/types.js'

const cfg = DEFAULT_CONFIG.repos.cno!
const p1: Finding = {
  severity: 'P1',
  file: 'a.py',
  line: 3,
  title: 'Off | by one',
  detail: 'loses\nrows',
  fix: 'use <=',
}
const p2: Finding = { severity: 'P2', file: '', line: null, title: 'Naming', detail: '', fix: null }

describe('review helpers', () => {
  it('runs codex read-only on the detached checkout with the schema and a hard timeout', () => {
    const files = reviewFiles('cno-1-x-ab12')
    const cmd = reviewCommand('codex', {
      cwd: reviewWorktree(cfg, 'cno-1-x-ab12'),
      files,
      timeoutSeconds: 900,
    })
    expect(cmd).toBe(
      `export PATH="$HOME/.local/bin:$PATH"; cd '/home/user/worktrees/cno/review-cno-1-x-ab12' && rm -f '/home/user/oar/tasks/cno-1-x-ab12/review-out.json' && timeout 900s codex exec -C '/home/user/worktrees/cno/review-cno-1-x-ab12' -s read-only --ignore-user-config --ignore-rules --skip-git-repo-check --ephemeral --color never -c model_reasoning_effort=high --output-schema '/home/user/oar/tasks/cno-1-x-ab12/review-schema.json' -o '/home/user/oar/tasks/cno-1-x-ab12/review-out.json' - < '/home/user/oar/tasks/cno-1-x-ab12/review-prompt.md' > '/home/user/oar/tasks/cno-1-x-ab12/review-log.txt' 2>&1`,
    )
    expect(cmd).not.toContain('bypass')
    const claude = reviewCommand('claude', { cwd: '/w', files, timeoutSeconds: 60, model: 'opus' })
    expect(claude).toContain(
      "claude -p --restricted --strict-mcp-config --add-dir '/home/user/oar/tasks/cno-1-x-ab12' --output-format json --json-schema \"$(cat ",
    )
    expect(claude).toContain("--model 'opus'")
  })

  it('checks out the head with git hooks off and writes the diff for the reviewer', () => {
    const files = reviewFiles('t1')
    const cmd = reviewCheckout(cfg, {
      wt: '/w/review-t1',
      sha: 'abc',
      branch: 'codex/cno-1-x',
      files,
    })
    expect(cmd).toBe(
      "git -c core.hooksPath=/dev/null worktree remove --force '/w/review-t1' 2>/dev/null; git worktree prune; " +
        "git fetch -q origin 'dev' 'codex/cno-1-x' && " +
        "git -c core.hooksPath=/dev/null worktree add -f --detach '/w/review-t1' 'abc' && " +
        "git -C '/w/review-t1' log --oneline 'origin/dev..HEAD' > '/home/user/oar/tasks/t1/review-commits.txt' && " +
        "git -C '/w/review-t1' diff 'origin/dev...HEAD' > '/home/user/oar/tasks/t1/review-diff.patch'",
    )
  })

  it('parses codex output, the claude envelope and fenced JSON; rejects anything else', () => {
    const body = { summary: 's', findings: [p1] }
    expect(parseReviewOutput('codex', JSON.stringify(body)).findings[0]?.severity).toBe('P1')
    expect(
      parseReviewOutput('claude', JSON.stringify({ structured_output: body, result: '' })).summary,
    ).toBe('s')
    expect(
      parseReviewOutput(
        'claude',
        JSON.stringify({ result: '```json\n{"summary":"f","findings":[]}\n```' }),
      ).summary,
    ).toBe('f')
    expect(() => parseReviewOutput('codex', 'not json')).toThrow()
    expect(() =>
      parseReviewOutput('codex', '{"findings":[{"severity":"P9","title":"x"}]}'),
    ).toThrow()
    expect(() => parseReviewOutput('claude', '{"is_error":true,"result":"overloaded"}')).toThrow(
      /overloaded/,
    )
  })

  it('blocks only on the configured severities', () => {
    expect(verdictOf([p1, p2], ['P0', 'P1'])).toBe('block')
    expect(verdictOf([p2], ['P0', 'P1'])).toBe('pass')
    expect(verdictOf([p2], ['P2'])).toBe('block')
    expect(verdictOf([], ['P0'])).toBe('pass')
    expect(findingsLine([p1, p2], ['P0', 'P1'])).toBe('1 blocking (P1 ×1), 1 advisory (P2 ×1)')
    expect(findingsLine([], ['P0', 'P1'])).toBe('no findings')
  })

  it('turns findings into review-round items', () => {
    const c = findingsToComments('abc', [p2, p1], ['P0', 'P1'], 'T')
    expect(c.map((x) => [x.severity, x.blocking])).toEqual([
      ['P1', true],
      ['P2', false],
    ])
    expect(c[1]).toMatchObject({ path: undefined, line: undefined, body: '[P2] Naming' })
  })

  it('marks the PR comment as ours and keeps the table intact', () => {
    const out = { summary: 'Looks fine.', findings: [p1, p2] }
    const body = findingsComment(out, {
      sha: 'abcdef123',
      runner: 'codex',
      blocking: ['P0', 'P1'],
      next: 'Round next.',
    })
    expect(body.startsWith(OAR_MARKER)).toBe(true)
    expect(body).toContain('`abcdef1`')
    expect(body).toContain('| P1 (blocking) | `a.py:3` | Off \\| by one — loses rows | use <= |')
    expect(body).toContain('Looks fine.')
    const linear = findingsSummary(out, {
      sha: 'abcdef123',
      runner: 'codex',
      blocking: ['P0', 'P1'],
      prUrl: 'https://github.com/o/r/pull/7',
      next: 'Round next.',
    })
    expect(linear).toContain('- [P1] Off | by one (`a.py:3`)')
    expect(linear).not.toContain('Naming')
    expect(linear.endsWith('Round next.')).toBe(true)
  })

  it('fills every placeholder of the prompt, leaving the issue text as written', () => {
    const row = {
      identifier: 'CNO-1',
      title: 'Add a header',
      description: 'Keep <base> literal.',
    } as IssueRow
    const text = reviewPrompt(
      row,
      cfg,
      { url: 'https://github.com/o/r/pull/7', headSha: 'abc' },
      ['P0', 'P1'],
      reviewFiles('t1'),
    )
    expect(text).toContain('/home/user/oar/tasks/t1/review-diff.patch')
    expect(text).toContain('/home/user/oar/tasks/t1/review-commits.txt')
    expect(text).toContain('Issue CNO-1: Add a header')
    expect(text).toContain('`origin/dev`')
    expect(text).toContain('Keep <base> literal.')
    expect(text).toContain('Only P0 and P1 findings block the merge.')
    expect(text).not.toMatch(
      /<(pr-url|identifier|title|head-sha|gate|blocking|description|diff-path|commits-path)>/,
    )
  })

  it('ships a strict schema', () => {
    expect(REVIEW_SCHEMA.additionalProperties).toBe(false)
    expect(REVIEW_SCHEMA.properties.findings.items.required).toEqual([
      'severity',
      'file',
      'line',
      'title',
      'detail',
      'fix',
    ])
  })
})
