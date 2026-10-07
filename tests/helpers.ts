import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG, paths, type Config } from '../src/config.js'
import type { Ctx, Io } from '../src/context.js'
import { saveState, type State } from '../src/state.js'
import { FakeBoat } from './fakes/boat.js'
import { FakeExec } from './fakes/exec.js'

export interface TestWorld {
  ctx: Ctx
  boat: FakeBoat
  exec: FakeExec
  out: string[]
  err: string[]
  home: string
}

export function world(
  opts: { state?: Partial<State>; config?: Config; now?: () => number } = {},
): TestWorld {
  const home = mkdtempSync(join(tmpdir(), 'oar-test-'))
  const p = paths(home)
  mkdirSync(p.configDir, { recursive: true })
  writeFileSync(p.envFile, 'BOAT_API_KEY=boat_testkey_0000000000\n')
  const now = opts.now ?? (() => Date.parse('2026-10-07T20:00:00Z'))
  const boat = new FakeBoat({ now })
  const exec = new FakeExec()
  const out: string[] = []
  const err: string[] = []
  const io: Io = { out: (l) => out.push(l), err: (l) => err.push(l), isTTY: false }
  if (opts.state) saveState(p, { version: 1, vms: {}, tasks: {}, ...opts.state })
  const ctx: Ctx = { paths: p, config: opts.config ?? DEFAULT_CONFIG, exec, boat, io, now }
  return { ctx, boat, exec, out, err, home }
}
