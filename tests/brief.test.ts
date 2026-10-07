import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createBrief, footer, newTaskId, validateSlug } from '../src/brief.js'
import { DEFAULT_CONFIG } from '../src/config.js'
import type { Task } from '../src/state.js'
import { world } from './helpers.js'

const AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/

describe('slugs and ids', () => {
  it('accepts a sane slug and rejects the rest', () => {
    expect(validateSlug('fix-flaky-delivery-test')).toBe('fix-flaky-delivery-test')
    expect(() => validateSlug('1abc')).toThrow()
    expect(() => validateSlug('Has-Caps')).toThrow()
    expect(() => validateSlug('a')).toThrow()
    expect(() => validateSlug('x'.repeat(28))).toThrow()
  })
  it('makes ids that are valid Herdr agent names', () => {
    for (let i = 0; i < 20; i++) {
      const id = newTaskId('x'.repeat(27))
      expect(id).toMatch(AGENT_NAME)
      expect(id.length).toBeLessThanOrEqual(32)
    }
  })
})

describe('footer', () => {
  const task: Task = {
    id: 'fix-1234',
    slug: 'fix',
    repo: 'cno',
    branch: 'codex/fix',
    worktreePath: '/home/user/worktrees/cno/fix',
    status: 'draft',
    hours: 8,
    createdAt: '',
    briefPath: '',
    runner: 'herdr',
  }
  it('names the worktree, the gate, the push, the draft PR and the done marker in order', () => {
    const f = footer(task, DEFAULT_CONFIG.repos.cno!)
    expect(f).toContain('/home/user/worktrees/cno/fix')
    expect(f).toContain('make lint && make test')
    const push = f.indexOf('git push -u origin codex/fix')
    const pr = f.indexOf('gh pr create --draft --base dev --head codex/fix')
    const done = f.indexOf('touch /home/user/oar/tasks/fix-1234/done')
    expect(push).toBeGreaterThan(0)
    expect(pr).toBeGreaterThan(push)
    expect(done).toBeGreaterThan(pr)
  })
})

describe('createBrief', () => {
  it('takes stdin verbatim and files by copy', async () => {
    const w = world()
    const path = await createBrief(
      w.ctx.paths,
      w.exec,
      { id: 'a-1', slug: 'a' },
      'engine',
      DEFAULT_CONFIG.repos.engine!,
      { stdin: '# hi' },
    )
    expect(readFileSync(path, 'utf8')).toBe('# hi\n')
  })
  it('refuses an unedited template', async () => {
    const w = world()
    w.exec.on('/bin/sh -c', { code: 0 })
    await expect(
      createBrief(
        w.ctx.paths,
        w.exec,
        { id: 'a-2', slug: 'a' },
        'engine',
        DEFAULT_CONFIG.repos.engine!,
        {},
      ),
    ).rejects.toThrow(/unedited/)
  })
})
