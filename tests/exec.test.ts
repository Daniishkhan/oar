import { describe, expect, it } from 'vitest'
import { realExec } from '../src/exec.js'

describe('realExec', () => {
  it('survives a child that closes stdin before the input is written', async () => {
    const r = await realExec.run('true', [], { input: 'x'.repeat(4_000_000) })
    expect(r.code).toBe(0)
  })
  it('captures output and a non-zero exit', async () => {
    const r = await realExec.run('/bin/sh', ['-c', 'echo out; echo err >&2; exit 3'])
    expect(r).toMatchObject({ code: 3, stdout: 'out\n', stderr: 'err\n' })
  })
})
