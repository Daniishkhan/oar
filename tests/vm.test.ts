import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ensureUp, vmDesktop, vmKeep, vmShot, vmStop } from '../src/commands/vm.js'
import { loadState } from '../src/state.js'
import { world } from './helpers.js'

const T0 = Date.parse('2026-10-07T20:00:00Z')

function herdrOk(w: ReturnType<typeof world>) {
  w.exec.on('herdr --machine engine agent list', { stdout: '{"id":"1","result":{"agents":[]}}' })
  w.exec.on('ssh -o BatchMode=yes', { code: 0 })
  w.exec.on('ssh-keygen', () => {
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    writeFileSync(w.ctx.paths.pubFile, 'ssh-ed25519 AAAAPUB oar\n')
    return { code: 0, stdout: '', stderr: '' }
  })
}

describe('ensureUp', () => {
  it('resumes an archived VM, pins the new host key and reaches Herdr', async () => {
    const w = world({
      state: {
        vms: {
          engine: {
            sandboxId: 'bx_1',
            label: 'engine',
            lastEndpoint: { host: '203.0.113.10', port: 22000 },
          },
        },
      },
    })
    w.boat.add('bx_1', { state: 'archived' })
    herdrOk(w)
    const log: string[] = []
    const r = await ensureUp(w.ctx, 'engine', (l) => log.push(l))
    expect(r.state).toBe('ready')
    expect(r.herdrReachable).toBe(true)
    expect(readFileSync(w.ctx.paths.knownHosts, 'utf8')).toBe(
      '[203.0.113.11]:22001 ssh-ed25519 AAAAFAKE1\n',
    )
    expect(readFileSync(w.ctx.paths.aliasFile, 'utf8')).toContain('HostName 203.0.113.11')
    expect(loadState(w.ctx.paths).vms.engine?.lastEndpoint).toEqual({
      host: '203.0.113.11',
      port: 22001,
    })
    expect(log.some((l) => /resuming bx_1/.test(l))).toBe(true)
  })
  it('restarts the Herdr server over ssh when --machine fails', async () => {
    const w = world({ state: { vms: { engine: { sandboxId: 'bx_1', label: 'engine' } } } })
    w.boat.add('bx_1', { state: 'ready' })
    let listCalls = 0
    w.exec
      .on('herdr --machine engine agent list', () =>
        ++listCalls < 2
          ? { code: 1, stdout: '', stderr: 'ssh: refused' }
          : { code: 0, stdout: '{"id":"1","result":{"agents":[]}}', stderr: '' },
      )
      .on('ssh -o BatchMode=yes', { code: 0 })
      .on('ssh-keygen', () => {
        const { writeFileSync } = require('node:fs') as typeof import('node:fs')
        writeFileSync(w.ctx.paths.pubFile, 'ssh-ed25519 AAAAPUB oar\n')
        return { code: 0, stdout: '', stderr: '' }
      })
    const r = await ensureUp(w.ctx, 'engine', () => undefined)
    expect(r.herdrReachable).toBe(true)
    expect(w.exec.lines().some((l) => /systemctl restart herdr-server/.test(l))).toBe(true)
  }, 20_000)
})

describe('vm keep / stop', () => {
  it('keep extends the deadline and records it', async () => {
    const w = world({
      state: { vms: { engine: { sandboxId: 'bx_1', label: 'engine' } } },
      now: () => T0,
    })
    w.boat.add('bx_1', { state: 'ready', archiveAfter: new Date(T0 + 3_600_000) })
    w.boat.anchors.set('bx_1', T0)
    await vmKeep(w.ctx, 'engine', 5)
    expect(loadState(w.ctx.paths).vms.engine?.archiveAfter).toBe(
      new Date(T0 + 5 * 3_600_000).toISOString(),
    )
    expect(w.out.at(-1)).toMatch(/stops in 5h 0m/)
  })
  it('stop refuses with live tasks unless forced, then suspends them', async () => {
    const w = world({
      state: {
        vms: { engine: { sandboxId: 'bx_1', label: 'engine' } },
        tasks: {
          't-1': {
            id: 't-1',
            repo: 'engine',
            slug: 't',
            branch: 'codex/t',
            worktreePath: '/home/user/worktrees/engine/t',
            status: 'working',
            hours: 1,
            createdAt: '',
            briefPath: '',
            runner: 'herdr',
          },
        },
      },
    })
    w.boat.add('bx_1', { state: 'ready' })
    await expect(vmStop(w.ctx, 'engine')).rejects.toThrow(/live task/)
    await vmStop(w.ctx, 'engine', { forceTasks: true })
    expect(loadState(w.ctx.paths).tasks['t-1']?.status).toBe('suspended')
    expect((await w.boat.get('bx_1')).state).toBe('archived')
  })
})

describe('vm desktop / shot', () => {
  it('desktop prints a stream URL and refuses --public without --vnc', async () => {
    const w = world({ state: { vms: { engine: { sandboxId: 'bx_1', label: 'engine' } } } })
    w.boat.add('bx_1', { state: 'ready', desktopAvailable: true })
    herdrOk(w)
    await expect(vmDesktop(w.ctx, 'engine', { isPublic: true })).rejects.toMatchObject({
      code: 'usage',
    })
    const url = await vmDesktop(w.ctx, 'engine', { vnc: true, open: false })
    expect(url).toContain('bx_1-desktop')
    expect(w.boat.desktops[0]?.opts).toMatchObject({ vnc: true })
  })
  it('shot runs the helper on the VM and saves the PNG locally', async () => {
    const w = world({ state: { vms: { engine: { sandboxId: 'bx_1', label: 'engine' } } } })
    w.boat.add('bx_1', { state: 'ready' })
    herdrOk(w)
    w.boat.commandRules.push({ re: /local\/bin\/shot/, result: { stdout: '/tmp/oar/shot.png\n' } })
    w.boat.bytes.set('bx_1:/tmp/oar/shot.png', Buffer.from('PNGDATA'))
    const out = await vmShot(w.ctx, 'engine', { window: 'Chrome', open: false })
    expect(out).toMatch(/shots\/engine-\d{8}T\d{6}\.png$/)
    const { readFileSync } = await import('node:fs')
    expect(readFileSync(out, 'utf8')).toBe('PNGDATA')
    expect(w.boat.commands.at(-1)?.req.command).toContain("'Chrome'")
  })
})
