import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const script = join(process.cwd(), 'skills/oar/hooks/save-plan.py')

function run(event: unknown, plansDir: string): string {
  return execFileSync('python3', ['-I', script], {
    input: JSON.stringify(event),
    env: { ...process.env, OAR_PLANS_DIR: plansDir },
  }).toString()
}

const exitPlanMode = (response: Record<string, unknown>, input: Record<string, unknown> = {}) => ({
  session_id: 's1',
  hook_event_name: 'PostToolUse',
  tool_name: 'ExitPlanMode',
  tool_input: input,
  tool_response: response,
})

describe('save-plan hook', () => {
  it('copies an approved plan into the factory plans directory and points at /oar-tickets', () => {
    const home = mkdtempSync(join(tmpdir(), 'oar-hook-'))
    const source = join(home, 'tidy-fox.md')
    writeFileSync(source, '# Plan\n\nDo the thing')
    const plans = join(home, 'plans')
    const out = run(exitPlanMode({ plan: '# Plan\n\nDo the thing', filePath: source }), plans)
    const dirs = readdirSync(plans)
    expect(dirs).toHaveLength(1)
    expect(dirs[0]).toMatch(/^\d{4}-\d{2}-\d{2}-tidy-fox$/)
    const saved = join(plans, dirs[0]!, 'plan.md')
    expect(readFileSync(saved, 'utf8')).toBe('# Plan\n\nDo the thing\n')
    const json = JSON.parse(out) as { hookSpecificOutput: { additionalContext: string } }
    expect(json.hookSpecificOutput.additionalContext).toContain(`/oar-tickets ${saved}`)
    // Approving the same plan again updates it in place rather than making a second directory.
    run(exitPlanMode({ plan: '# Plan v2', filePath: source }), plans)
    expect(readdirSync(plans)).toHaveLength(1)
    expect(readFileSync(saved, 'utf8')).toBe('# Plan v2\n')
  })

  it('keeps an unapproved plan as a draft, which the approval then replaces', () => {
    const home = mkdtempSync(join(tmpdir(), 'oar-hook-'))
    const source = join(home, 'bold-eagle.md')
    writeFileSync(source, '# Draft')
    const plans = join(home, 'plans')
    const out = run(exitPlanMode({}, { planFilePath: source }), plans)
    const dir = join(plans, readdirSync(plans)[0]!)
    expect(readdirSync(dir)).toEqual(['plan.draft.md'])
    expect(out).toContain('plan draft')
    run(exitPlanMode({ plan: '# Final', filePath: source }), plans)
    expect(readdirSync(dir)).toEqual(['plan.md'])
  })

  it('ignores other tools, empty plans and malformed input', () => {
    const home = mkdtempSync(join(tmpdir(), 'oar-hook-'))
    const plans = join(home, 'plans')
    expect(run({ tool_name: 'Edit', tool_response: { plan: 'x' } }, plans)).toBe('')
    expect(run(exitPlanMode({ plan: '   ' }), plans)).toBe('')
    expect(
      execFileSync('python3', ['-I', script], {
        input: 'not json',
        env: { ...process.env, OAR_PLANS_DIR: plans },
      }).toString(),
    ).toBe('')
    expect(() => readdirSync(plans)).toThrow()
  })
})
