import type {
  CommandRequest,
  CommandStatusResponse,
  CreateSandboxRequest,
  HostPortResponse,
  ResumeRequest,
  Sandbox,
  SandboxUsageResponse,
  SshKeyResponse,
  UpdateSandboxRequest,
} from '@boatdev/sdk'
import type { BoatClient, CommandResult, DesktopInfo } from '../../src/boat.js'

export interface FakeBoatOptions {
  now?: () => number
  /** archiveAfter = anchor + ttl; boat anchors on the last resume, which is what makes ensureDeadline two-step. */
  anchorOffsetMs?: number
}

const base = (id: string, over: Partial<Sandbox> = {}): Sandbox =>
  ({
    id,
    name: id,
    state: 'ready',
    desktopAvailable: false,
    snapshotAvailable: true,
    archiveAfter: null,
    ip: null,
    sshEndpoint: null,
    ...over,
  }) as Sandbox

export class FakeBoat implements BoatClient {
  sandboxes = new Map<string, Sandbox>()
  files = new Map<string, string>()
  commands: Array<{ id: string; req: CommandRequest }> = []
  updates: Array<{ id: string; req: UpdateSandboxRequest }> = []
  snapshots: Array<{ id: string; name: string }> = []
  desktops: Array<{ id: string; opts: unknown }> = []
  bytes = new Map<string, Buffer>()
  anchors = new Map<string, number>()
  /** Commands answered by regex on the command text; first match wins. */
  commandRules: Array<{ re: RegExp; result: Partial<CommandResult> }> = []
  pendingGets = new Map<string, Sandbox['state'][]>()
  private machineCounter = 0
  private processes = new Map<number, { polls: number; result: CommandResult }>()
  private nextProcess = 100
  private readonly now: () => number

  constructor(private readonly opts: FakeBoatOptions = {}) {
    this.now = opts.now ?? (() => Date.now())
  }

  add(id: string, over: Partial<Sandbox> = {}): Sandbox {
    const s = base(id, over)
    this.sandboxes.set(id, s)
    return s
  }

  private require(id: string): Sandbox {
    const s = this.sandboxes.get(id)
    if (!s) throw new Error(`fake boat: no sandbox ${id}`)
    return s
  }

  /** Queue states returned by successive get() calls before the stored one (simulates transitions). */
  transitions(id: string, states: Sandbox['state'][]) {
    this.pendingGets.set(id, states)
  }

  async get(id: string): Promise<Sandbox> {
    const s = this.require(id)
    const q = this.pendingGets.get(id)
    if (q?.length) return { ...s, state: q.shift()! }
    return { ...s }
  }

  async create(req: CreateSandboxRequest): Promise<Sandbox> {
    const id = `bx_new${this.sandboxes.size + 1}`
    const ttl = req.ttlSeconds ?? 3600
    this.anchors.set(id, this.now())
    return this.add(id, {
      state: 'provisioning',
      environment: req.environment,
      archiveAfter: new Date(this.now() + ttl * 1000),
    })
  }

  async resume(id: string, req: ResumeRequest = {}): Promise<void> {
    const s = this.require(id)
    const ttl = req.ttlSeconds ?? 3600
    const anchor = this.now() + (this.opts.anchorOffsetMs ?? 0)
    this.anchors.set(id, anchor)
    this.machineCounter++
    Object.assign(s, { state: 'ready', archiveAfter: new Date(anchor + ttl * 1000) })
  }

  async stop(id: string): Promise<void> {
    Object.assign(this.require(id), { state: 'archived', archiveAfter: null })
  }

  async update(id: string, req: UpdateSandboxRequest): Promise<Sandbox> {
    const s = this.require(id)
    this.updates.push({ id, req })
    if (req.ttlSeconds !== undefined) {
      const anchor = this.anchors.get(id) ?? this.now()
      s.archiveAfter = req.ttlSeconds === null ? null : new Date(anchor + req.ttlSeconds * 1000)
    }
    return { ...s }
  }

  async sshKey(id: string): Promise<SshKeyResponse> {
    this.require(id)
    const n = this.machineCounter
    return {
      ok: true,
      type: 'ssh_key.configured',
      success: true,
      machineIp: null,
      sshUser: 'user',
      sshEndpoint: `203.0.113.${10 + n}:2200${n}`,
      hostKey: `ssh-ed25519 AAAAFAKE${n}`,
    }
  }

  async hostPort(id: string, port: number): Promise<HostPortResponse> {
    this.require(id)
    return {
      ok: true,
      type: 'host.port',
      url: `https://${id}-${port}.on.boat.dev?_token=t`,
      isProtected: true,
      port,
    }
  }

  async command(id: string, req: CommandRequest): Promise<CommandResult | { processId: number }> {
    this.require(id)
    this.commands.push({ id, req })
    const rule = this.commandRules.find((r) => r.re.test(req.command))
    const result: CommandResult = {
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      ...rule?.result,
    }
    if (req.detached) {
      const processId = this.nextProcess++
      this.processes.set(processId, { polls: 0, result })
      return { processId }
    }
    return result
  }

  async commandStatus(_id: string, processId: number): Promise<CommandStatusResponse> {
    const p = this.processes.get(processId)
    if (!p) throw new Error('fake boat: unknown process')
    p.polls++
    const done = p.polls >= 2
    return {
      ok: true,
      type: 'command.status',
      success: true,
      processId,
      status: done ? 'exited' : 'running',
      running: !done,
      exitCode: done ? p.result.exitCode : null,
      stdout: p.result.stdout,
      stderr: p.result.stderr,
    }
  }

  async readFile(id: string, path: string): Promise<string | null> {
    return this.files.get(`${id}:${path}`) ?? null
  }

  async readFileBytes(id: string, path: string): Promise<Buffer | null> {
    return this.bytes.get(`${id}:${path}`) ?? null
  }

  async desktop(id: string, opts: unknown = {}): Promise<DesktopInfo> {
    this.require(id)
    this.desktops.push({ id, opts })
    return { url: `https://${id}-desktop.on.boat.dev/#t`, provisioning: false, mode: 'moonlight' }
  }

  async writeFile(id: string, path: string, content: string): Promise<void> {
    this.files.set(`${id}:${path}`, content)
  }

  async usage(id: string): Promise<SandboxUsageResponse> {
    this.require(id)
    return {
      ok: true,
      type: 'usage',
      sandboxId: id,
      sandboxType: 'default',
      billingMultiplier: 1,
      since: new Date(0),
      until: new Date(this.now()),
      seconds: 3600,
      dollars: 0.04,
      secondsPerDollar: 100_000,
      running: true,
    }
  }

  async saveNamedSnapshot(id: string, name: string): Promise<void> {
    this.snapshots.push({ id, name })
  }

  async environments() {
    return [
      { id: 'env-engine', name: 'engine' },
      { id: 'env-cno', name: 'cno' },
    ]
  }
}
