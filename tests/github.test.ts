import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../src/config.js'
import { ghRun, prSnapshot } from '../src/github.js'
import { FakeBoat } from './fakes/boat.js'
import { FakeExec } from './fakes/exec.js'

const repo = { ...DEFAULT_CONFIG.repos.cno!, github: 'o/r' }

describe('prSnapshot', () => {
  it('reads the review decision and mergeability, with defaults for older gh output', async () => {
    const exec = new FakeExec().on('gh pr list', {
      stdout: JSON.stringify([
        {
          number: 7,
          url: 'u',
          isDraft: true,
          state: 'OPEN',
          headRefOid: 'abc',
          mergeCommit: null,
          updatedAt: 'T',
          reviewDecision: 'CHANGES_REQUESTED',
          mergeable: 'CONFLICTING',
        },
      ]),
    })
    expect(await prSnapshot(exec, null, null, repo, 'b')).toMatchObject({
      headSha: 'abc',
      reviewDecision: 'CHANGES_REQUESTED',
      mergeable: 'CONFLICTING',
    })
    expect(exec.lines()[0]).toContain('reviewDecision,mergeable')
    const old = new FakeExec().on('gh pr list', {
      stdout: JSON.stringify([{ number: 7, url: 'u', state: 'OPEN', reviewDecision: null }]),
    })
    expect(await prSnapshot(old, null, null, repo, 'b')).toMatchObject({
      reviewDecision: '',
      mergeable: 'UNKNOWN',
    })
  })
})

describe('ghRun', () => {
  it('runs here with stdin and outside any checkout', async () => {
    const exec = new FakeExec().on('gh pr comment', { stdout: 'ok' })
    const r = await ghRun(exec, null, null, ['pr', 'comment', '7', '--body-file', '-'], {
      input: 'hello',
    })
    expect(r).toMatchObject({ ok: true, via: 'local' })
    expect(exec.calls[0]!.opts).toMatchObject({ input: 'hello' })
    expect((exec.calls[0]!.opts as { cwd?: string }).cwd).toBeTruthy()
  })

  it('falls back to the VM only when gh here is missing or not logged in', async () => {
    const boat = new FakeBoat()
    boat.add('bx_1')
    const missing = new FakeExec() // no rule: exit 127
    const r = await ghRun(missing, boat, 'bx_1', ['pr', 'comment', '7', '--body-file', '-'], {
      input: 'hello',
    })
    expect(r).toMatchObject({ ok: true, via: 'vm' })
    const cmd = boat.commands[0]!.req.command
    expect(cmd).toMatch(
      /^gh 'pr' 'comment' '7' '--body-file' '\/home\/user\/oar\/gh-input-[0-9a-f]{12}\.txt'$/,
    )
    expect([...boat.files.values()]).toContain('hello')

    const loggedOut = new FakeExec().on('gh', {
      code: 4,
      stderr: 'To get started with GitHub CLI, please run:  gh auth login',
    })
    expect((await ghRun(loggedOut, boat, 'bx_1', ['pr', 'ready', '7'])).via).toBe('vm')

    const refused = new FakeExec().on('gh', {
      code: 1,
      stderr: 'Pull request is not mergeable: the merge commit cannot be cleanly created',
    })
    const before = boat.commands.length
    expect(await ghRun(refused, boat, 'bx_1', ['pr', 'merge', '7'])).toMatchObject({
      ok: false,
      via: 'local',
    })
    expect(boat.commands.length).toBe(before)
  })
})
