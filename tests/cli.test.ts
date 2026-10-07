import { describe, expect, it } from 'vitest'
import { main } from '../src/cli.js'
import { world } from './helpers.js'

describe('cli', () => {
  it('prints help', async () => {
    const w = world()
    expect(await main([], w.ctx)).toBe(0)
    expect(w.out.join('\n')).toContain('oar vm new')
  })
  it('rejects unknown commands with a usage error', async () => {
    const w = world()
    await expect(main(['nope'], w.ctx)).rejects.toMatchObject({ code: 'usage', exitCode: 2 })
    await expect(main(['vm', 'fly'], w.ctx)).rejects.toMatchObject({ code: 'usage' })
  })
  it('creates a task from stdin-less brief file and lists it', async () => {
    const w = world()
    const { writeFileSync } = await import('node:fs')
    const brief = `${w.home}/b.md`
    writeFileSync(brief, '# do a thing\n')
    expect(
      await main(
        ['task', 'new', 'do-thing', '--repo', 'cno', '--brief', brief, '--hours', '2'],
        w.ctx,
      ),
    ).toBe(0)
    expect(w.out[0]).toMatch(/^do-thing-[a-z0-9]{4}\s+codex\/do-thing/)
    expect(await main(['task', 'list'], w.ctx)).toBe(0)
    expect(w.out.at(-1)).toContain('draft')
  })
  it('vm up without a VM explains what to do', async () => {
    const w = world()
    await expect(main(['vm', 'up', 'engine'], w.ctx)).rejects.toMatchObject({ code: 'no_vm' })
  })
})
