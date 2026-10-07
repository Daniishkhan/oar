import { describe, expect, it } from 'vitest'
import { deriveStatus, observeTask } from '../src/commands/task.js'
import type { PrInfo, Task } from '../src/state.js'
import { world } from './helpers.js'

const pr: PrInfo = { number: 7, url: 'https://github.com/x/y/pull/7', isDraft: true, state: 'OPEN' }

describe('deriveStatus', () => {
  it('follows the matrix', () => {
    expect(deriveStatus('working', 'blocked', null, false)).toBe('blocked')
    expect(deriveStatus('blocked', 'working', null, false)).toBe('working')
    expect(deriveStatus('working', 'idle', pr, false)).toBe('done')
    expect(deriveStatus('working', 'done', null, true)).toBe('done-no-pr')
    expect(deriveStatus('working', 'idle', null, false)).toBe('stalled')
    expect(deriveStatus('working', 'exited', null, false)).toBe('exited')
    expect(deriveStatus('done', 'exited', null, false)).toBe('done')
    expect(deriveStatus('working', 'unknown', null, false)).toBe('working')
    expect(deriveStatus('draft', 'unknown', null, false)).toBe('dispatched')
  })
})

describe('observeTask', () => {
  const task: Task = {
    id: 'fix-1234',
    slug: 'fix',
    repo: 'engine',
    branch: 'codex/fix',
    worktreePath: '/home/user/worktrees/engine/fix',
    status: 'working',
    hours: 8,
    createdAt: '2026-10-07T18:00:00Z',
    dispatchedAt: '2026-10-07T18:00:00Z',
    briefPath: '/tmp/b.md',
    runner: 'herdr',
    handle: { runner: 'herdr', workspaceId: 'w2', paneId: 'w2:p1', agentName: 'fix-1234' },
  }
  it('marks a task suspended when the VM is archived', async () => {
    const w = world({
      state: {
        vms: { engine: { sandboxId: 'bx_1', label: 'engine' } },
        tasks: { 'fix-1234': task },
      },
    })
    w.boat.add('bx_1', { state: 'archived' })
    const o = await observeTask(w.ctx, task)
    expect(o.status).toBe('suspended')
    expect(o.agent).toBe('vm-down')
  })
  it('combines agent state, PR and marker, and persists', async () => {
    const w = world({
      state: {
        vms: { engine: { sandboxId: 'bx_1', label: 'engine' } },
        tasks: { 'fix-1234': task },
      },
    })
    w.boat.add('bx_1', { state: 'running' })
    w.exec
      .on('herdr --machine engine agent get fix-1234', {
        stdout:
          '{"id":"1","result":{"agent":{"agent_status":"idle","pane_id":"w2:p1","name":"fix-1234"}}}',
      })
      .on('gh pr list', { stdout: JSON.stringify([pr]) })
    const o = await observeTask(w.ctx, task)
    expect(o.status).toBe('done')
    expect(o.pr?.number).toBe(7)
    const { loadState } = await import('../src/state.js')
    expect(loadState(w.ctx.paths).tasks['fix-1234']).toMatchObject({
      status: 'done',
      pr: { number: 7 },
    })
    expect(loadState(w.ctx.paths).tasks['fix-1234']?.finishedAt).toBeTruthy()
  })
  it('falls back to the VM gh when the Mac gh fails', async () => {
    const w = world({
      state: {
        vms: { engine: { sandboxId: 'bx_1', label: 'engine' } },
        tasks: { 'fix-1234': task },
      },
    })
    w.boat.add('bx_1', { state: 'running' })
    w.boat.commandRules.push({ re: /gh 'pr' 'list'/, result: { stdout: JSON.stringify([pr]) } })
    w.exec
      .on('herdr --machine engine agent get fix-1234', {
        stdout:
          '{"id":"1","result":{"agent":{"agent_status":"working","pane_id":"w2:p1","name":"fix-1234"}}}',
      })
      .on('gh pr list', { code: 1, stderr: 'keyring' })
    const o = await observeTask(w.ctx, task)
    expect(o.status).toBe('working')
    expect(o.pr?.number).toBe(7)
  })
})
