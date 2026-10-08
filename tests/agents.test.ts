import { describe, expect, it } from 'vitest'
import { agentArguments } from '../src/agents.js'

describe('coding agent launch contract', () => {
  const task = { name: 'task-1', taskId: 'task-1', cwd: '/home/user/worktrees/repo/task-1' }

  it('preserves Claude remote control and resume behavior', () => {
    expect(agentArguments('claude', { ...task, resume: true, model: 'chosen-model' })).toEqual([
      '--continue',
      '--name',
      'task-1',
      '--remote-control',
      'task-1',
      '--model',
      'chosen-model',
    ])
  })

  it('runs Codex with full builder VM access and no approval dialogs', () => {
    const args = agentArguments('codex', { ...task, resume: true, model: 'chosen-model' })
    expect(args.slice(0, 4)).toEqual(['resume', '--last', '--cd', task.cwd])
    expect(args).toContain('danger-full-access')
    expect(args).toContain('never')
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(args).not.toContain('--all')
    expect(args).not.toContain('--remote-control')
  })
})
