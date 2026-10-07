import {
  BoatApi,
  Configuration,
  ResponseError,
  type CommandRequest,
  type CommandStatusResponse,
  type CreateSandboxRequest,
  type HostPortResponse,
  type ResumeRequest,
  type Sandbox,
  type SandboxUsageResponse,
  type SshKeyResponse,
  type UpdateSandboxRequest,
} from '@boatdev/sdk'
import { OarError } from './errors.js'
import { type SandboxState, UP_STATES } from './state.js'
import { sleep } from './time.js'

export const HOME = '/home/user'

/** boat's `cwd` is relative to /home/user. */
export function relHome(path: string): string {
  if (path === HOME) return '.'
  return path.startsWith(`${HOME}/`) ? path.slice(HOME.length + 1) : path
}

export interface DesktopInfo {
  url: string | null
  provisioning: boolean
  mode?: string
  message?: string
}

export interface CommandResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/** The slice of boat's API that oar uses. Tests implement it with a scripted fake. */
export interface BoatClient {
  get(id: string): Promise<Sandbox>
  create(req: CreateSandboxRequest, idempotencyKey?: string): Promise<Sandbox>
  resume(id: string, req?: ResumeRequest): Promise<void>
  stop(id: string, force?: boolean): Promise<void>
  update(id: string, req: UpdateSandboxRequest): Promise<Sandbox>
  sshKey(id: string, publicKey: string): Promise<SshKeyResponse>
  hostPort(
    id: string,
    port: number,
    opts?: { title?: string; isPublic?: boolean },
  ): Promise<HostPortResponse>
  command(id: string, req: CommandRequest): Promise<CommandResult | { processId: number }>
  commandStatus(id: string, processId: number): Promise<CommandStatusResponse>
  /** null when the file does not exist. */
  readFile(id: string, path: string): Promise<string | null>
  /** Raw bytes (PNG etc.); null when the file does not exist. */
  readFileBytes(id: string, path: string): Promise<Buffer | null>
  /** A fresh desktop-stream URL (Moonlight, or noVNC with `vnc`); valid about 10 minutes. */
  desktop(
    id: string,
    opts?: { vnc?: boolean; theme?: 'light' | 'dark'; publicAccess?: boolean },
  ): Promise<DesktopInfo>
  writeFile(id: string, path: string, content: string): Promise<void>
  usage(id: string, since?: string, until?: string): Promise<SandboxUsageResponse>
  saveNamedSnapshot(id: string, name: string): Promise<void>
  environments(): Promise<Array<{ id: string; name: string }>>
}

async function mapError(e: unknown): Promise<never> {
  if (e instanceof ResponseError) {
    let detail = ''
    try {
      const body = (await e.response.json()) as {
        error?: { message?: string; code?: string }
        message?: string
      }
      detail = body.error?.message ?? body.message ?? ''
      if (body.error?.code) detail = `${body.error.code}: ${detail}`
    } catch {
      /* body not JSON */
    }
    throw new OarError('boat', `boat API ${e.response.status}${detail ? ` ${detail}` : ''}`)
  }
  if (e instanceof OarError) throw e
  throw new OarError('boat', `boat API: ${(e as Error).message}`)
}

export function realBoat(apiKey: string): BoatClient {
  const api = new BoatApi(
    new Configuration({ basePath: 'https://boat.dev/api/v1', accessToken: apiKey }),
  )
  const guard = <T>(p: Promise<T>): Promise<T> => p.catch(mapError)
  return {
    get: (id) => guard(api.get({ sandboxId: id })).then((r) => r.sandbox),
    create: (req, idempotencyKey) =>
      guard(
        api.create({ createSandboxRequest: req, ...(idempotencyKey ? { idempotencyKey } : {}) }),
      ).then((r) => r.sandbox),
    resume: (id, req) =>
      guard(api.resume({ sandboxId: id, resumeRequest: req ?? {} })).then(() => undefined),
    stop: (id, force) =>
      guard(api.stop({ sandboxId: id, stopRequest: force ? { force: true } : {} })).then(
        () => undefined,
      ),
    update: (id, req) =>
      guard(api.update({ sandboxId: id, updateSandboxRequest: req })).then((r) => r.sandbox),
    sshKey: (id, key) => guard(api.sshKey({ sandboxId: id, sshKeyRequest: { key } })),
    hostPort: (id, port, opts = {}) =>
      guard(
        api.hostPort({
          sandboxId: id,
          hostPortRequest: { port, title: opts.title, _public: opts.isPublic ?? false },
        }),
      ),
    command: async (id, req) => {
      const r = await guard(api.command({ sandboxId: id, commandRequest: req }))
      if ('processId' in r) return { processId: r.processId }
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut }
    },
    commandStatus: (id, processId) => guard(api.commandStatus({ sandboxId: id, processId })),
    readFile: async (id, path) => {
      try {
        const r = await api.readFile({ sandboxId: id, path })
        return r.encoding === 'base64'
          ? Buffer.from(r.content, 'base64').toString('utf8')
          : r.content
      } catch (e) {
        if (e instanceof ResponseError && e.response.status === 404) return null
        return mapError(e)
      }
    },
    readFileBytes: async (id, path) => {
      try {
        const r = await api.readFile({ sandboxId: id, path, encoding: 'base64' })
        return Buffer.from(r.content, r.encoding === 'base64' ? 'base64' : 'utf8')
      } catch (e) {
        if (e instanceof ResponseError && e.response.status === 404) return null
        return mapError(e)
      }
    },
    desktop: (id, opts = {}) =>
      guard(
        api.desktop({
          sandboxId: id,
          vnc: (opts.vnc ? '1' : undefined) as never,
          theme: opts.theme as never,
          desktopRequest: { publicAccess: opts.publicAccess ?? false },
        }),
      ).then((r) => ({
        url: r.desktopUrl ?? null,
        provisioning: Boolean(r.provisioning),
        mode: r.mode,
        message: r.message,
      })),
    writeFile: (id, path, content) =>
      guard(
        api.writeFile({ sandboxId: id, fileWriteRequest: { path, content, encoding: 'utf8' } }),
      ).then(() => undefined),
    usage: (id, since, until) => guard(api.usage({ sandboxId: id, since, until })),
    saveNamedSnapshot: (id, name) =>
      guard(api.saveNamedSnapshot({ namedSnapshotSaveRequest: { sandboxId: id, name } })).then(
        () => undefined,
      ),
    environments: () =>
      guard(api.environments()).then((r) =>
        r.environments.map((e) => ({ id: e.id, name: e.name })),
      ),
  }
}

export const sandboxState = (s: Sandbox): SandboxState => s.state as SandboxState

export interface WaitOptions {
  timeoutMs?: number
  intervalMs?: number
  onTick?: (s: Sandbox) => void
}

/** Poll until the sandbox is in one of `states`. `error`/`cancelled` throw unless they are wanted. */
export async function waitForState(
  boat: BoatClient,
  id: string,
  states: ReadonlySet<SandboxState>,
  opts: WaitOptions = {},
): Promise<Sandbox> {
  const timeoutMs = opts.timeoutMs ?? 180_000
  const intervalMs = opts.intervalMs ?? 3_000
  const deadline = Date.now() + timeoutMs
  let last: Sandbox | undefined
  for (;;) {
    last = await boat.get(id)
    const st = sandboxState(last)
    opts.onTick?.(last)
    if (states.has(st)) return last
    if (st === 'error' || st === 'cancelled') {
      throw new OarError(
        'boat',
        `sandbox ${id} is ${st}${last.error ? `: ${last.error}` : ''}`,
        'open the boat dashboard',
      )
    }
    if (Date.now() > deadline) {
      throw new OarError('boat', `sandbox ${id} still ${st} after ${Math.round(timeoutMs / 1000)}s`)
    }
    await sleep(intervalMs)
  }
}

export const waitUp = (boat: BoatClient, id: string, opts?: WaitOptions) =>
  waitForState(boat, id, UP_STATES, opts)

const MAX_TTL = 2_592_000
const clampTtl = (seconds: number) => Math.min(MAX_TTL, Math.max(60, Math.round(seconds)))

/**
 * Make sure the sandbox does not auto-stop before `deadline`. boat's PATCH ttlSeconds anchors the
 * deadline somewhere we cannot read (creation or last resume), so set, read back, and correct once.
 * Returns the resulting archiveAfter (null = auto-stop disabled). Never shortens an existing deadline.
 */
export async function ensureDeadline(
  boat: BoatClient,
  id: string,
  deadline: Date,
  opts: { log?: (line: string) => void; now?: () => number } = {},
): Promise<Date | null> {
  const log = opts.log
  const current = await boat.get(id)
  if (current.archiveAfter === null || current.archiveAfter === undefined) return null
  if (current.archiveAfter.getTime() >= deadline.getTime()) return current.archiveAfter
  const now = (opts.now ?? Date.now)()
  const ttl1 = clampTtl((deadline.getTime() - now) / 1000)
  let s = await boat.update(id, { ttlSeconds: ttl1 })
  const after1 = s.archiveAfter?.getTime()
  if (after1 === undefined || after1 === null) return null
  if (Math.abs(after1 - deadline.getTime()) > 60_000 && after1 < deadline.getTime()) {
    const anchor = after1 - ttl1 * 1000
    const ttl2 = clampTtl((deadline.getTime() - anchor) / 1000)
    s = await boat.update(id, { ttlSeconds: ttl2 })
    log?.(
      `ttl: first pass landed ${new Date(after1).toISOString()}, corrected with ttl=${ttl2}s → ${s.archiveAfter?.toISOString() ?? 'null'}`,
    )
  }
  return s.archiveAfter ?? null
}

export interface RunOptions {
  cwd?: string
  timeoutSeconds?: number
  onPoll?: (status: CommandStatusResponse) => void
}

/** Run a shell command on the sandbox; detached + polled when it may exceed boat's 600 s sync cap. */
export async function runCommand(
  boat: BoatClient,
  id: string,
  command: string,
  opts: RunOptions = {},
): Promise<CommandResult> {
  const timeoutSeconds = opts.timeoutSeconds ?? 120
  const cwd = opts.cwd ? relHome(opts.cwd) : undefined
  if (timeoutSeconds <= 600) {
    const r = await boat.command(id, { command, cwd, timeoutSeconds })
    if ('processId' in r)
      throw new OarError('boat', 'boat started the command detached although sync was requested')
    return r
  }
  const started = await boat.command(id, { command, cwd, detached: true })
  if (!('processId' in started)) return started
  const deadline = Date.now() + timeoutSeconds * 1000
  for (;;) {
    await sleep(3_000)
    const st = await boat.commandStatus(id, started.processId)
    opts.onPoll?.(st)
    if (!st.running) {
      return {
        exitCode: st.exitCode,
        stdout: st.stdout,
        stderr: st.stderr,
        timedOut: st.status === 'lost',
      }
    }
    if (Date.now() > deadline)
      return { exitCode: null, stdout: st.stdout, stderr: st.stderr, timedOut: true }
  }
}

/** VNC desktops provision on first use; poll until a URL comes back. */
export async function waitDesktop(
  boat: BoatClient,
  id: string,
  opts: { vnc?: boolean; theme?: 'light' | 'dark'; publicAccess?: boolean },
  timeoutMs = 90_000,
): Promise<DesktopInfo> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const d = await boat.desktop(id, opts)
    if (d.url && !d.provisioning) return d
    if (Date.now() > deadline)
      throw new OarError('boat', `desktop still provisioning: ${d.message ?? ''}`)
    await sleep(2_000)
  }
}

export async function usageToday(boat: BoatClient, id: string, sinceIso: string): Promise<number> {
  const u = await boat.usage(id, sinceIso)
  return u.dollars
}
