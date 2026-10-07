import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { paths } from '../src/config.js'
import {
  aliasBlock,
  endpointFrom,
  ensureInclude,
  knownHostsLines,
  knownHostsWithout,
  pin,
  replaceHostBlock,
} from '../src/ssh.js'
import { world } from './helpers.js'

describe('endpointFrom', () => {
  it('prefers the NATed endpoint', () => {
    expect(
      endpointFrom({
        ok: true,
        type: 't',
        sshEndpoint: '203.0.113.10:22001',
        machineIp: '198.51.100.1',
      }),
    ).toEqual({ host: '203.0.113.10', port: 22001 })
  })
  it('falls back to the machine ip on port 22', () => {
    expect(
      endpointFrom({ ok: true, type: 't', sshEndpoint: null, machineIp: '2a01:db8::1' }),
    ).toEqual({ host: '2a01:db8::1', port: 22 })
  })
  it('throws when neither is set', () => {
    expect(() => endpointFrom({ ok: true, type: 't', sshEndpoint: null, machineIp: null })).toThrow(
      /neither/,
    )
  })
})

describe('known_hosts text', () => {
  it('formats one line per key, bracketed for non-22 ports', () => {
    expect(knownHostsLines({ host: 'h', port: 2201 }, 'ssh-ed25519 AAA\nssh-rsa BBB\n')).toEqual([
      '[h]:2201 ssh-ed25519 AAA',
      '[h]:2201 ssh-rsa BBB',
    ])
    expect(knownHostsLines({ host: 'h', port: 22 }, 'ssh-ed25519 AAA')).toEqual([
      'h ssh-ed25519 AAA',
    ])
  })
  it('drops only the named hosts', () => {
    const text = '[a]:1 k1\nb k2\n[c]:3 k3\n'
    expect(knownHostsWithout(text, ['[a]:1', '[c]:3'])).toBe('b k2')
  })
})

describe('alias file', () => {
  const p = paths('/Users/x')
  it('replaces an existing block and keeps the others', () => {
    const before =
      'Host other\n  HostName 1.1.1.1\n\nHost oar-engine\n  HostName old\n  Port 1\n\nHost last\n  User me\n'
    const after = replaceHostBlock(
      before,
      'oar-engine',
      aliasBlock('oar-engine', { host: 'new', port: 2 }, p),
    )
    expect(after).toContain('Host other\n  HostName 1.1.1.1')
    expect(after).toContain('Host last\n  User me')
    expect(after).not.toContain('HostName old')
    expect(after).toContain('Host oar-engine\n  HostName new\n  Port 2')
    expect(after).toContain('StrictHostKeyChecking yes')
  })
  it('is idempotent', () => {
    const block = aliasBlock('oar-cno', { host: 'h', port: 22 }, p)
    const once = replaceHostBlock('', 'oar-cno', block)
    expect(replaceHostBlock(once, 'oar-cno', block)).toBe(once)
  })
  it('adds the Include line once, at the top', () => {
    const inc = 'Include ~/.ssh/oar_config'
    const once = ensureInclude('Host foo\n  User x\n', inc)
    expect(once.startsWith(inc)).toBe(true)
    expect(ensureInclude(once, inc)).toBe(once)
  })
})

describe('pin', () => {
  it('writes known_hosts, alias and Include in a fresh HOME, replacing the previous machine', () => {
    const w = world()
    const p = w.ctx.paths
    pin(p, {
      alias: 'oar-engine',
      endpoint: { host: '1.1.1.1', port: 22001 },
      hostKey: 'ssh-ed25519 ONE',
    })
    pin(p, {
      alias: 'oar-engine',
      endpoint: { host: '2.2.2.2', port: 22002 },
      hostKey: 'ssh-ed25519 TWO',
      previous: { host: '1.1.1.1', port: 22001 },
    })
    const kh = readFileSync(p.knownHosts, 'utf8')
    expect(kh).toBe('[2.2.2.2]:22002 ssh-ed25519 TWO\n')
    expect(readFileSync(p.aliasFile, 'utf8')).toContain('HostName 2.2.2.2')
    expect(readFileSync(p.sshConfig, 'utf8').split('\n')[0]).toBe('Include ~/.ssh/oar_config')
  })
})
