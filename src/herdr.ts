import { z } from 'zod'
import type { Exec, ExecResult } from './exec.js'

export class HerdrError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly raw: string = '',
  ) {
    super(message)
    this.name = 'HerdrError'
  }
}

const Envelope = z.looseObject({ id: z.string().optional(), result: z.unknown() })
const ErrorEnvelope = z.looseObject({
  error: z.looseObject({ code: z.string(), message: z.string() }),
})

export const AgentInfo = z.looseObject({
  agent_status: z.enum(['idle', 'working', 'blocked', 'done', 'unknown']),
  pane_id: z.string(),
  tab_id: z.string().optional(),
  workspace_id: z.string().optional(),
  name: z.string().optional(),
  cwd: z.string().optional(),
  interactive_ready: z.boolean().optional(),
})
export type AgentInfo = z.infer<typeof AgentInfo>
export const AgentList = z.looseObject({ agents: z.array(AgentInfo) })
export const Created = z.looseObject({
  workspace: z.looseObject({ workspace_id: z.string() }),
  tab: z.looseObject({ tab_id: z.string() }).optional(),
  root_pane: z.looseObject({ pane_id: z.string() }),
})
export type Created = z.infer<typeof Created>

/** Herdr prints `{id, result}` on stdout, `{id, error:{code,message}}` on stderr (exit 1), usage text (exit 2). */
export function parseHerdr(res: ExecResult): unknown {
  if (res.code === 0) {
    try {
      return Envelope.parse(JSON.parse(res.stdout)).result
    } catch {
      return res.stdout.trim()
    }
  }
  const raw = (res.stderr || res.stdout).trim()
  if (res.code === 2) throw new HerdrError('usage', raw.split('\n')[0] ?? 'usage error', raw)
  try {
    const err = ErrorEnvelope.parse(JSON.parse(raw)).error
    throw new HerdrError(err.code, err.message, raw)
  } catch (e) {
    if (e instanceof HerdrError) throw e
    throw new HerdrError(
      res.code === 127 ? 'not_installed' : 'failed',
      raw || `herdr exited ${res.code}`,
      raw,
    )
  }
}

/** Commands forwarded to a saved SSH machine's Herdr server (`herdr --machine <label> …`). */
export class HerdrMachine {
  constructor(
    private readonly exec: Exec,
    public readonly label: string,
  ) {}

  async call<T = unknown>(args: string[], schema?: z.ZodType<T>, timeoutMs = 60_000): Promise<T> {
    const res = await this.exec.run('herdr', ['--machine', this.label, ...args], { timeoutMs })
    const result = parseHerdr(res)
    return schema ? schema.parse(result) : (result as T)
  }

  /** The cheapest forwarded call; failure means the server on the VM is not reachable. */
  async reachable(): Promise<boolean> {
    try {
      await this.call(['agent', 'list'], undefined, 30_000)
      return true
    } catch {
      return false
    }
  }

  agents(): Promise<AgentInfo[]> {
    return this.call(['agent', 'list'], AgentList).then((r) => r.agents)
  }

  async agent(target: string): Promise<AgentInfo | null> {
    try {
      const r = await this.call(['agent', 'get', target], z.looseObject({ agent: AgentInfo }))
      return r.agent
    } catch (e) {
      if (e instanceof HerdrError && /not_found|unknown_agent|no_agent/.test(e.code)) return null
      throw e
    }
  }

  async read(target: string, lines = 60, source = 'recent-unwrapped'): Promise<string> {
    const r = await this.call<unknown>([
      'agent',
      'read',
      target,
      '--source',
      source,
      '--lines',
      String(lines),
    ])
    if (typeof r === 'string') return r
    const obj = r as { text?: string; lines?: string[]; content?: string }
    return (
      obj.text ??
      obj.content ??
      (Array.isArray(obj.lines) ? obj.lines.join('\n') : JSON.stringify(r))
    )
  }
}

export const localHerdr = {
  async installed(exec: Exec): Promise<boolean> {
    return (await exec.run('herdr', ['--version'])).code === 0
  },
  async machines(exec: Exec): Promise<Array<{ label?: string; id?: string; enabled?: boolean }>> {
    const res = await exec.run('herdr', ['machine', 'list', '--json'])
    if (res.code !== 0) return []
    try {
      const parsed = JSON.parse(res.stdout) as unknown
      const list = Array.isArray(parsed)
        ? parsed
        : ((parsed as { machines?: unknown[] }).machines ?? [])
      return list as Array<{ label?: string; id?: string; enabled?: boolean }>
    } catch {
      return []
    }
  },
  notify(exec: Exec, title: string, body: string, sound: 'done' | 'request' | 'none' = 'done') {
    return exec.run('herdr', [
      'notification',
      'show',
      title.slice(0, 80),
      '--body',
      body.slice(0, 240),
      '--sound',
      sound,
    ])
  },
  attach: (exec: Exec, alias: string) => exec.interactive('herdr', ['--remote', alias]),
  machineAdd: (exec: Exec, alias: string, label: string) =>
    exec.interactive('herdr', ['machine', 'add', alias, '--label', label]),
  machineReconnect: (exec: Exec, label: string) =>
    exec.interactive('herdr', ['machine', 'reconnect', label]),
}
