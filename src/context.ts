import { realBoat, type BoatClient } from './boat.js'
import { loadConfig, loadSecrets, paths, type Config, type Paths } from './config.js'
import { realExec, redact, type Exec } from './exec.js'

export interface Io {
  out(line: string): void
  err(line: string): void
  isTTY: boolean
}

export interface Ctx {
  paths: Paths
  config: Config
  exec: Exec
  /** Lazy: commands that never touch boat (task new, doctor) work without a key. */
  readonly boat: BoatClient
  io: Io
  now(): number
}

export function buildCtx(overrides: Partial<Ctx> = {}): Ctx {
  const p = overrides.paths ?? paths()
  const config = overrides.config ?? loadConfig(p)
  let boat: BoatClient | undefined = overrides.boat
  const io: Io = overrides.io ?? {
    out: (line) => process.stdout.write(`${redact(line)}\n`),
    err: (line) => process.stderr.write(`${redact(line)}\n`),
    isTTY: Boolean(process.stdout.isTTY),
  }
  return {
    paths: p,
    config,
    exec: overrides.exec ?? realExec,
    io,
    now: overrides.now ?? (() => Date.now()),
    get boat() {
      if (!boat) boat = realBoat(loadSecrets(p).BOAT_API_KEY)
      return boat
    },
  }
}
