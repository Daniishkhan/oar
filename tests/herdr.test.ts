import { describe, expect, it } from 'vitest'
import { HerdrError, HerdrMachine, parseHerdr } from '../src/herdr.js'
import { FakeExec } from './fakes/exec.js'

describe('parseHerdr', () => {
  it('unwraps the result envelope', () => {
    expect(
      parseHerdr({ code: 0, stdout: '{"id":"req_1","result":{"agents":[]}}', stderr: '' }),
    ).toEqual({ agents: [] })
  })
  it('maps the error envelope to HerdrError with its code', () => {
    const err = () =>
      parseHerdr({
        code: 1,
        stdout: '',
        stderr: '{"id":"req_2","error":{"code":"agent_blocked","message":"waiting"}}',
      })
    expect(err).toThrow(HerdrError)
    try {
      err()
    } catch (e) {
      expect((e as HerdrError).code).toBe('agent_blocked')
    }
  })
  it('treats exit 2 as a usage error and 127 as not installed', () => {
    expect(() => parseHerdr({ code: 2, stdout: '', stderr: 'usage: herdr agent list' })).toThrow(
      /usage/,
    )
    try {
      parseHerdr({ code: 127, stdout: '', stderr: '' })
    } catch (e) {
      expect((e as HerdrError).code).toBe('not_installed')
    }
  })
})

describe('HerdrMachine', () => {
  it('prefixes every call with --machine <label> and never passes --json to list/get', async () => {
    const exec = new FakeExec().on('herdr --machine engine agent list', {
      stdout:
        '{"id":"1","result":{"agents":[{"agent_status":"working","pane_id":"w1:p1","name":"t1"}]}}',
    })
    const m = new HerdrMachine(exec, 'engine')
    const agents = await m.agents()
    expect(agents[0]).toMatchObject({ agent_status: 'working', name: 't1' })
    expect(exec.lines()[0]).toBe('herdr --machine engine agent list')
  })
  it('returns null for a missing agent and reports reachability', async () => {
    const exec = new FakeExec()
      .on('herdr --machine engine agent get', {
        code: 1,
        stderr: '{"error":{"code":"agent_not_found","message":"no"}}',
      })
      .on('herdr --machine engine agent list', { code: 1, stderr: 'ssh: connect refused' })
    const m = new HerdrMachine(exec, 'engine')
    expect(await m.agent('nope')).toBeNull()
    expect(await m.reachable()).toBe(false)
  })
})
