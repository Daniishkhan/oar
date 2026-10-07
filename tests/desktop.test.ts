import { describe, expect, it } from 'vitest'
import { parseMcpList, parseProbe, shotCommand, VM_SHOT_PATH } from '../src/desktop.js'

describe('desktop helpers', () => {
  it('builds the shot command with an optional window', () => {
    expect(shotCommand()).toBe(`~/.local/bin/shot '${VM_SHOT_PATH}'`)
    expect(shotCommand("Google Chrome's tab")).toBe(
      `~/.local/bin/shot '${VM_SHOT_PATH}' 'Google Chrome'\\''s tab'`,
    )
  })
  it('parses the probe output', () => {
    const p = parseProbe(
      'x11=ok\nchrome=active\ncdp=Chrome/142.0.0.0\nprofile=ok\nsysctl=0\npw=chromium-1200 \nlinger=user \n',
    )
    expect(p).toMatchObject({
      x11: 'ok',
      chrome: 'active',
      cdp: 'Chrome/142.0.0.0',
      sysctl: '0',
      pw: 'chromium-1200',
      linger: 'user',
    })
  })
  it('parses claude mcp list', () => {
    const text = [
      'Checking MCP server health...',
      '',
      'browser: /home/user/.local/bin/mcp-server-playwright --cdp-endpoint http://127.0.0.1:9222 - ✓ Connected',
      'computer: cua-driver mcp - ✓ Connected',
      'paper: http://127.0.0.1:29979/mcp (HTTP) - ✗ Failed to connect',
    ].join('\n')
    expect(parseMcpList(text)).toEqual({
      browser: 'connected',
      computer: 'connected',
      paper: 'failed',
    })
  })
})
