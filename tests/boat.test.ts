import { describe, expect, it } from 'vitest'
import { ensureDeadline, relHome, runCommand, waitForState } from '../src/boat.js'
import { UP_STATES } from '../src/state.js'
import { FakeBoat } from './fakes/boat.js'

const T0 = Date.parse('2026-10-07T20:00:00Z')
const H = 3_600_000

describe('relHome', () => {
  it('strips the home prefix', () => {
    expect(relHome('/home/user/nodes-engine')).toBe('nodes-engine')
    expect(relHome('/home/user')).toBe('.')
    expect(relHome('/tmp/x')).toBe('/tmp/x')
  })
})

describe('ensureDeadline', () => {
  it('is a no-op when the deadline is already covered or auto-stop is off', async () => {
    const boat = new FakeBoat({ now: () => T0 })
    boat.add('bx_a', { archiveAfter: new Date(T0 + 10 * H) })
    boat.add('bx_b', { archiveAfter: null })
    expect((await ensureDeadline(boat, 'bx_a', new Date(T0 + 4 * H)))?.getTime()).toBe(T0 + 10 * H)
    expect(await ensureDeadline(boat, 'bx_b', new Date(T0 + 4 * H))).toBeNull()
    expect(boat.updates).toHaveLength(0)
  })
  it('corrects once when boat anchors the ttl on the last resume', async () => {
    const boat = new FakeBoat({ now: () => T0 })
    boat.add('bx_a', { archiveAfter: new Date(T0 + 1 * H) })
    boat.anchors.set('bx_a', T0 - 2 * H) // resumed two hours ago
    const log: string[] = []
    const after = await ensureDeadline(boat, 'bx_a', new Date(T0 + 4 * H), {
      log: (l) => log.push(l),
      now: () => T0,
    })
    expect(boat.updates.map((u) => u.req.ttlSeconds)).toEqual([4 * 3600, 6 * 3600])
    expect(after?.getTime()).toBe(T0 + 4 * H)
    expect(log[0]).toMatch(/corrected/)
  })
  it('needs one pass when boat anchors on now', async () => {
    const boat = new FakeBoat({ now: () => T0 })
    boat.add('bx_a', { archiveAfter: new Date(T0 + 1 * H) })
    boat.anchors.set('bx_a', T0)
    await ensureDeadline(boat, 'bx_a', new Date(T0 + 4 * H), { now: () => T0 })
    expect(boat.updates).toHaveLength(1)
  })
})

describe('waitForState', () => {
  it('polls through transitions and stops on a wanted state', async () => {
    const boat = new FakeBoat()
    boat.add('bx_a', { state: 'ready' })
    boat.transitions('bx_a', ['archiving', 'archived'])
    const s = await waitForState(boat, 'bx_a', new Set(['archived']), { intervalMs: 1 })
    expect(s.state).toBe('archived')
  })
  it('throws on error states', async () => {
    const boat = new FakeBoat()
    boat.add('bx_a', { state: 'error', error: 'boom' })
    await expect(waitForState(boat, 'bx_a', UP_STATES, { intervalMs: 1 })).rejects.toThrow(
      /error: boom/,
    )
  })
})

describe('runCommand', () => {
  it('runs synchronously under the 600 s cap with a relative cwd', async () => {
    const boat = new FakeBoat()
    boat.add('bx_a')
    boat.commandRules.push({ re: /^echo/, result: { stdout: 'hi\n' } })
    const r = await runCommand(boat, 'bx_a', 'echo hi', {
      cwd: '/home/user/repo',
      timeoutSeconds: 30,
    })
    expect(r.stdout).toBe('hi\n')
    expect(boat.commands[0]?.req).toMatchObject({ cwd: 'repo', timeoutSeconds: 30 })
  })
  it('detaches and polls when the timeout exceeds the cap', async () => {
    const boat = new FakeBoat()
    boat.add('bx_a')
    boat.commandRules.push({ re: /pnpm install/, result: { exitCode: 0, stdout: 'done' } })
    const r = await runCommand(boat, 'bx_a', 'pnpm install', { timeoutSeconds: 900 })
    expect(boat.commands[0]?.req.detached).toBe(true)
    expect(r).toMatchObject({ exitCode: 0, stdout: 'done', timedOut: false })
  }, 20_000)
})
