import { writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadState, mutateState, resolveTask, saveState, type Task } from '../src/state.js'
import { world } from './helpers.js'

const task = (id: string, slug: string, status: Task['status'] = 'draft'): Task => ({
  id,
  slug,
  repo: 'engine',
  branch: `codex/${slug}`,
  worktreePath: `/home/user/worktrees/engine/${slug}`,
  status,
  hours: 8,
  createdAt: '2026-10-07T00:00:00Z',
  briefPath: '/tmp/brief.md',
  runner: 'herdr',
})

describe('state file', () => {
  it('starts empty, saves atomically and reloads', async () => {
    const w = world()
    expect(loadState(w.ctx.paths)).toEqual({ version: 1, vms: {}, tasks: {} })
    await mutateState(w.ctx.paths, (s) => {
      s.vms.engine = { sandboxId: 'bx_1', label: 'engine' }
    })
    expect(loadState(w.ctx.paths).vms.engine?.sandboxId).toBe('bx_1')
  })
  it('refuses an invalid file instead of resetting it', () => {
    const w = world()
    saveState(w.ctx.paths, { version: 1, vms: {}, tasks: {} })
    writeFileSync(w.ctx.paths.stateFile, '{"version":1,"vms":{"engine":{"sandboxId":"nope"}}}')
    expect(() => loadState(w.ctx.paths)).toThrow(/schema/)
  })
  it('serialises concurrent mutations through the lock', async () => {
    const w = world()
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        mutateState(w.ctx.paths, (s) => {
          s.tasks[`t${i}`] = task(`t${i}`, `slug-${i}`)
        }),
      ),
    )
    expect(Object.keys(loadState(w.ctx.paths).tasks)).toHaveLength(5)
  })
})

describe('resolveTask', () => {
  it('finds by id, then by unique slug, and refuses ambiguity', () => {
    const s = {
      version: 1 as const,
      vms: {},
      tasks: {
        'a-1111': task('a-1111', 'a'),
        'b-1111': task('b-1111', 'b'),
        'b-2222': task('b-2222', 'b', 'closed'),
      },
    }
    expect(resolveTask(s, 'a-1111').id).toBe('a-1111')
    expect(resolveTask(s, 'b').id).toBe('b-1111')
    expect(() => resolveTask(s, 'zzz')).toThrow(/no task/)
    s.tasks['b-2222']!.status = 'working'
    expect(() => resolveTask(s, 'b')).toThrow(/several/)
  })
})
