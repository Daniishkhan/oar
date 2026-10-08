import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { z } from 'zod'
import type { Paths } from './config.js'
import { OarError } from './errors.js'
import { sleep } from './time.js'

export const SandboxStates = [
  'init',
  'provisioning',
  'provisioned',
  'cloning',
  'ready',
  'idle',
  'running',
  'updating',
  'archiving',
  'archived',
  'error',
  'cancelled',
] as const
export type SandboxState = (typeof SandboxStates)[number]

export const UP_STATES: ReadonlySet<SandboxState> = new Set(['ready', 'idle', 'running'])
export const CHANGING_STATES: ReadonlySet<SandboxState> = new Set([
  'init',
  'provisioning',
  'provisioned',
  'cloning',
  'updating',
  'archiving',
])

export const EndpointSchema = z.object({ host: z.string(), port: z.number().int().positive() })
export type Endpoint = z.infer<typeof EndpointSchema>

export const VmSchema = z.object({
  sandboxId: z.string().regex(/^bx_/),
  label: z.string(),
  lastEndpoint: EndpointSchema.optional(),
  lastHostKey: z.string().optional(),
  lastSeenState: z.enum(SandboxStates).optional(),
  archiveAfter: z.string().nullable().optional(),
  lastUsageDollars: z.number().optional(),
  /** How the last successful ssh probe reached the VM. */
  transport: z.enum(['tailnet', 'direct']).optional(),
  tailscaleIp: z.string().optional(),
})
export type VmRecord = z.infer<typeof VmSchema>

export const TaskStatuses = [
  'draft',
  'dispatched',
  'working',
  'blocked',
  'stalled',
  'done',
  'done-no-pr',
  'exited',
  'suspended',
  'failed',
  'closed',
] as const
export type TaskStatus = (typeof TaskStatuses)[number]
export const LIVE_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'dispatched',
  'working',
  'blocked',
  'stalled',
])

export const AgentStatuses = ['idle', 'working', 'blocked', 'done', 'unknown'] as const
export type AgentStatus = (typeof AgentStatuses)[number]

export const HerdrHandle = z.object({
  runner: z.literal('herdr'),
  agentKind: z.enum(['claude', 'codex']).optional(),
  agentModel: z.string().optional(),
  workspaceId: z.string(),
  tabId: z.string().optional(),
  paneId: z.string(),
  agentName: z.string(),
})
export const BoatPromptHandle = z.object({
  runner: z.literal('boat-prompt'),
  conversationId: z.string(),
  promptId: z.string(),
})

export const PrSchema = z.object({
  number: z.number().int(),
  url: z.string(),
  isDraft: z.boolean(),
  state: z.string(),
})
export type PrInfo = z.infer<typeof PrSchema>

export const TaskSchema = z.object({
  id: z.string(),
  /** Pinned before remote launch so configuration changes cannot relabel a running agent. */
  agentKind: z.enum(['claude', 'codex']).optional(),
  agentModel: z.string().optional(),
  repo: z.string(),
  slug: z.string(),
  branch: z.string(),
  worktreePath: z.string(),
  status: z.enum(TaskStatuses),
  hours: z.number().positive(),
  createdAt: z.string(),
  dispatchedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  briefPath: z.string(),
  runner: z.enum(['herdr', 'boat-prompt']).default('herdr'),
  handle: z.discriminatedUnion('runner', [HerdrHandle, BoatPromptHandle]).optional(),
  pr: PrSchema.optional(),
  lastAgentStatus: z.enum(AgentStatuses).optional(),
  lastNotified: z.object({ status: z.string(), at: z.string() }).optional(),
  note: z.string().optional(),
})
export type Task = z.infer<typeof TaskSchema>

export const StateSchema = z.object({
  version: z.literal(1),
  vms: z.record(z.string(), VmSchema).default({}),
  tasks: z.record(z.string(), TaskSchema).default({}),
})
export type State = z.infer<typeof StateSchema>

export const emptyState = (): State => ({ version: 1, vms: {}, tasks: {} })

export function loadState(p: Paths): State {
  if (!existsSync(p.stateFile)) return emptyState()
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(p.stateFile, 'utf8'))
  } catch (e) {
    throw new OarError(
      'state_invalid',
      `${p.stateFile} is not valid JSON: ${(e as Error).message}`,
      'fix or move the file; oar never resets it silently',
    )
  }
  const parsed = StateSchema.safeParse(raw)
  if (!parsed.success) {
    throw new OarError(
      'state_invalid',
      `${p.stateFile} does not match the schema: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      'fix or move the file; oar never resets it silently',
    )
  }
  return parsed.data
}

export function saveState(p: Paths, state: State): void {
  mkdirSync(p.stateDir, { recursive: true })
  const tmp = `${p.stateFile}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(tmp, p.stateFile)
}

/** Load, change, save under an exclusive lock file so two oar processes never clobber each other. */
export async function mutateState<T>(p: Paths, fn: (state: State) => T | Promise<T>): Promise<T> {
  mkdirSync(p.stateDir, { recursive: true })
  const deadline = Date.now() + 5_000
  let fd: number | undefined
  for (;;) {
    try {
      fd = openSync(p.lockFile, 'wx')
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() > deadline) {
        throw new OarError(
          'state_invalid',
          `could not lock ${p.lockFile}`,
          'another oar process may be stuck; delete the lock file if none is running',
        )
      }
      await sleep(100)
    }
  }
  try {
    const state = loadState(p)
    const result = await fn(state)
    saveState(p, state)
    return result
  } finally {
    closeSync(fd)
    unlinkSync(p.lockFile)
  }
}

/** A task by id, or by slug when exactly one live/draft task has it. */
export function resolveTask(state: State, ref: string): Task {
  const byId = state.tasks[ref]
  if (byId) return byId
  const matches = Object.values(state.tasks).filter((t) => t.slug === ref && t.status !== 'closed')
  if (matches.length === 1) return matches[0]!
  if (matches.length > 1) {
    throw new OarError(
      'no_task',
      `several tasks have slug '${ref}': ${matches.map((t) => t.id).join(', ')}`,
      'use the id',
    )
  }
  throw new OarError('no_task', `no task '${ref}'`, 'oar task list')
}

export function requireVm(state: State, repo: string): VmRecord {
  const vm = state.vms[repo]
  if (!vm) throw new OarError('no_vm', `no VM recorded for '${repo}'`, `run: oar vm new ${repo}`)
  return vm
}
