import { join } from 'node:path'
import { ensureDeadline, runCommand, sandboxState } from '../boat.js'
import { createBrief, newTaskId, validateSlug, vmDoneMarker, type FooterOptions } from '../brief.js'
import { repoConfig, sshAlias } from '../config.js'
import type { Ctx } from '../context.js'
import { OarError } from '../errors.js'
import { shq } from '../exec.js'
import { prForBranch } from '../github.js'
import { localHerdr } from '../herdr.js'
import {
  agentState,
  dispatchHerdr,
  focusAgent,
  readAgent,
  resumeHerdr,
  sendKeys,
  steerAgent,
  type HerdrHandle,
  type LiveAgent,
} from '../runner.js'
import {
  loadState,
  mutateState,
  requireVm,
  resolveTask,
  UP_STATES,
  type PrInfo,
  type Task,
  type TaskStatus,
} from '../state.js'
import { formatDuration, hoursFromNow, nowIso } from '../time.js'
import { ensureUp } from './vm.js'

const herdrHandle = (task: Task): HerdrHandle => {
  if (task.handle?.runner !== 'herdr')
    throw new OarError(
      'no_task',
      `task ${task.id} has not been dispatched`,
      `oar task dispatch ${task.id}`,
    )
  return task.handle
}

export interface NewTaskOptions {
  repo: string
  slug: string
  hours?: number
  briefFile?: string
  briefStdin?: string
}

export async function taskNew(ctx: Ctx, o: NewTaskOptions): Promise<Task> {
  const cfg = repoConfig(ctx.config, o.repo)
  const slug = validateSlug(o.slug)
  const id = newTaskId(slug)
  const briefPath = await createBrief(ctx.paths, ctx.exec, { id, slug }, o.repo, cfg, {
    file: o.briefFile,
    stdin: o.briefStdin,
  })
  const task: Task = {
    id,
    repo: o.repo,
    slug,
    branch: `${cfg.branchPrefix}${slug}`,
    worktreePath: `${cfg.worktreeRoot}/${slug}`,
    status: 'draft',
    hours: o.hours ?? ctx.config.defaults.keepHours,
    createdAt: nowIso(),
    briefPath,
    runner: 'herdr',
  }
  await mutateState(ctx.paths, (s) => {
    s.tasks[id] = task
  })
  ctx.io.out(`${id}  ${task.branch}  brief: ${briefPath}`)
  return task
}

export interface DispatchTaskOptions {
  reuseBranch?: boolean
  log: (line: string) => void
  /** Keep the VM alive this long from now (default: the task's hours). */
  hours?: number
  /** Extra footer rules for the brief (the factory's PR naming and question convention). */
  footer?: FooterOptions
}

/** Bring the VM up, run the agent, record the handle; the state file reflects failure too. */
export async function dispatchTask(
  ctx: Ctx,
  task: Task,
  opts: DispatchTaskOptions,
): Promise<{ handle: HerdrHandle; note?: string }> {
  const { log } = opts
  const cfg = repoConfig(ctx.config, task.repo)
  const up = await ensureUp(ctx, task.repo, log)
  if (!up.herdrReachable)
    throw new OarError(
      'herdr',
      `Herdr on ${task.repo} is not reachable`,
      `oar vm up ${task.repo} first (it repairs the server), then dispatch again`,
    )
  let result
  try {
    result = await dispatchHerdr(ctx, task, cfg, up.vm, {
      reuseBranch: opts.reuseBranch,
      log,
      footer: opts.footer,
    })
  } catch (e) {
    await mutateState(ctx.paths, (s) => {
      const t = s.tasks[task.id]
      if (t) {
        t.status = e instanceof OarError && e.code === 'blocked' ? 'blocked' : 'failed'
        t.note = (e as Error).message.split('\n')[0]
      }
    })
    throw e
  }
  const deadline = hoursFromNow(opts.hours ?? task.hours, ctx.now())
  const after = await ensureDeadline(ctx.boat, up.vm.sandboxId, deadline, {
    log,
    now: ctx.now,
  }).catch(() => null)
  await mutateState(ctx.paths, (s) => {
    const t = s.tasks[task.id]!
    t.status = result.note ? 'dispatched' : 'working'
    t.dispatchedAt = nowIso()
    t.handle = result.handle
    t.note = result.note
    t.lastAgentStatus = result.note ? undefined : 'working'
    requireVm(s, task.repo).archiveAfter = after?.toISOString() ?? null
  })
  return result
}

export async function taskDispatch(
  ctx: Ctx,
  ref: string,
  opts: { reuseBranch?: boolean } = {},
): Promise<void> {
  const log = ctx.io.out
  const task = resolveTask(loadState(ctx.paths), ref)
  if (['working', 'done', 'done-no-pr', 'suspended'].includes(task.status)) {
    throw new OarError(
      'usage',
      `task ${task.id} is ${task.status}`,
      task.status === 'suspended' ? `oar task resume ${task.id}` : `oar task status ${task.id}`,
    )
  }
  if (ctx.config.factory.role === 'client' && loadState(ctx.paths).vms.factory)
    log(
      `note: a factory controller is configured; it dispatches Linear issues to ${task.repo} on its own. Both will share the VM's one screen.`,
    )
  const result = await dispatchTask(ctx, task, { reuseBranch: opts.reuseBranch, log })
  log('')
  log(`${task.id} dispatched on ${task.repo}: branch ${task.branch}, worktree ${task.worktreePath}`)
  if (result.note) log(`note: ${result.note}`)
  log(
    `status: oar task status ${task.id}     attach: oar task attach ${task.id}     watch: oar watch`,
  )
}

/** Pure: the task status that follows from what we can observe. */
export function deriveStatus(
  prev: TaskStatus,
  agent: LiveAgent,
  pr: PrInfo | null,
  marker: boolean,
): TaskStatus {
  if (agent === 'blocked') return 'blocked'
  if (agent === 'working') return 'working'
  if (agent === 'unknown') return prev === 'draft' ? 'dispatched' : prev
  // idle | done | exited
  if (pr) return 'done'
  if (marker) return 'done-no-pr'
  if (agent === 'exited') return prev === 'done' || prev === 'done-no-pr' ? prev : 'exited'
  return prev === 'done' || prev === 'done-no-pr' ? prev : 'stalled'
}

export interface Observation {
  task: Task
  vmState: string
  agent: LiveAgent | 'vm-down'
  pr: PrInfo | null
  marker: boolean
  status: TaskStatus
}

/** Observe one task without side effects on the VM; persists what it learned. */
export async function observeTask(ctx: Ctx, task: Task): Promise<Observation> {
  const cfg = repoConfig(ctx.config, task.repo)
  const vm = requireVm(loadState(ctx.paths), task.repo)
  const sb = await ctx.boat.get(vm.sandboxId)
  const vmState = sandboxState(sb)
  if (!UP_STATES.has(vmState)) {
    const status: TaskStatus = ['working', 'dispatched', 'blocked', 'stalled'].includes(task.status)
      ? 'suspended'
      : task.status
    await mutateState(ctx.paths, (s) => {
      const t = s.tasks[task.id]
      if (t) t.status = status
      const rec = requireVm(s, task.repo)
      rec.lastSeenState = vmState
      rec.archiveAfter = sb.archiveAfter?.toISOString() ?? null
    })
    return {
      task: { ...task, status },
      vmState,
      agent: 'vm-down',
      pr: task.pr ?? null,
      marker: false,
      status,
    }
  }
  const handle = herdrHandle(task)
  const { status: agent } = await agentState(ctx, cfg, handle).catch(() => ({
    status: 'unknown' as LiveAgent,
    info: null,
  }))
  const pr = await prForBranch(ctx.exec, ctx.boat, vm.sandboxId, cfg, task.branch)
  const marker =
    (await ctx.boat.readFile(vm.sandboxId, vmDoneMarker(task.id)).catch(() => null)) !== null
  const status = deriveStatus(task.status, agent, pr, marker)
  const updated = await mutateState(ctx.paths, (s) => {
    const t = s.tasks[task.id]!
    t.status = status
    if (pr) t.pr = pr
    t.lastAgentStatus = agent === 'exited' ? t.lastAgentStatus : agent
    if (agent === 'working' && t.note?.startsWith('prompt sent but not confirmed'))
      t.note = undefined
    if ((status === 'done' || status === 'done-no-pr') && !t.finishedAt) t.finishedAt = nowIso()
    const rec = requireVm(s, task.repo)
    rec.lastSeenState = vmState
    rec.archiveAfter = sb.archiveAfter?.toISOString() ?? null
    return t
  })
  return { task: updated, vmState, agent, pr, marker, status }
}

export function formatObservation(o: Observation, now: number): string {
  const t = o.task
  const age = t.dispatchedAt ? formatDuration(now - Date.parse(t.dispatchedAt)) : '-'
  const lines = [
    `${t.id}  ${t.repo}  ${t.branch}`,
    `  status: ${o.status}   agent: ${o.agent}   vm: ${o.vmState}   running: ${age}`,
    `  pr: ${o.pr ? `${o.pr.url} (${o.pr.isDraft ? 'draft, ' : ''}${o.pr.state.toLowerCase()})` : 'none'}   done-marker: ${o.marker ? 'yes' : 'no'}`,
  ]
  if (t.note) lines.push(`  note: ${t.note}`)
  return lines.join('\n')
}

export async function taskStatus(
  ctx: Ctx,
  ref: string,
  opts: { read?: number } = {},
): Promise<Observation> {
  const task = resolveTask(loadState(ctx.paths), ref)
  if (task.status === 'draft') {
    ctx.io.out(`${task.id}  draft  brief: ${task.briefPath}`)
    return { task, vmState: '-', agent: 'exited', pr: null, marker: false, status: 'draft' }
  }
  const o = await observeTask(ctx, task)
  ctx.io.out(formatObservation(o, ctx.now()))
  if (opts.read && o.agent !== 'vm-down' && o.agent !== 'exited') {
    ctx.io.out('')
    ctx.io.out(
      await readAgent(ctx, repoConfig(ctx.config, task.repo), herdrHandle(task), opts.read),
    )
  }
  return o
}

export async function taskRead(ctx: Ctx, ref: string, lines: number): Promise<void> {
  const task = resolveTask(loadState(ctx.paths), ref)
  ctx.io.out(await readAgent(ctx, repoConfig(ctx.config, task.repo), herdrHandle(task), lines))
}

export async function taskSteer(ctx: Ctx, ref: string, text: string): Promise<void> {
  const task = resolveTask(loadState(ctx.paths), ref)
  await steerAgent(ctx, repoConfig(ctx.config, task.repo), herdrHandle(task), text)
  ctx.io.out(`sent to ${task.id}`)
}

export async function taskKeys(ctx: Ctx, ref: string, keys: string[]): Promise<void> {
  const task = resolveTask(loadState(ctx.paths), ref)
  await sendKeys(ctx, repoConfig(ctx.config, task.repo), herdrHandle(task), keys)
  await mutateState(ctx.paths, (s) => {
    const t = s.tasks[task.id]
    if (t && t.status === 'blocked') t.status = 'working'
  })
  ctx.io.out(`keys sent to ${task.id}: ${keys.join(' ')}`)
}

export async function taskAttach(ctx: Ctx, ref: string): Promise<number> {
  const task = resolveTask(loadState(ctx.paths), ref)
  const cfg = repoConfig(ctx.config, task.repo)
  await ensureUp(ctx, task.repo, ctx.io.out)
  await focusAgent(ctx, cfg, herdrHandle(task))
  return localHerdr.attach(ctx.exec, sshAlias(task.repo))
}

/** Push and open the draft PR from the VM when Claude stopped short of it. */
export async function taskDone(ctx: Ctx, ref: string): Promise<void> {
  const task = resolveTask(loadState(ctx.paths), ref)
  const cfg = repoConfig(ctx.config, task.repo)
  const up = await ensureUp(ctx, task.repo, ctx.io.out)
  const id = up.vm.sandboxId
  const wt = task.worktreePath
  const ahead = await runCommand(
    ctx.boat,
    id,
    `git rev-list --count origin/${shq(cfg.baseBranch)}..HEAD`,
    { cwd: wt, timeoutSeconds: 60 },
  )
  const n = Number(ahead.stdout.trim())
  if (!Number.isInteger(n) || n === 0) {
    const log = await runCommand(
      ctx.boat,
      id,
      'git status --short | head -30; git log --oneline -5',
      { cwd: wt, timeoutSeconds: 60 },
    )
    throw new OarError(
      'usage',
      `no commits ahead of origin/${cfg.baseBranch} in ${wt}`,
      `on the VM:\n${log.stdout.trim()}`,
    )
  }
  const push = await runCommand(ctx.boat, id, `git push -u origin ${shq(task.branch)}`, {
    cwd: wt,
    timeoutSeconds: 120,
  })
  if (push.exitCode !== 0)
    throw new OarError(
      'boat',
      `push failed: ${push.stderr.trim().split('\n').slice(-3).join(' | ')}`,
    )
  const existing = await prForBranch(ctx.exec, ctx.boat, id, cfg, task.branch)
  if (!existing) {
    const pr = await runCommand(
      ctx.boat,
      id,
      `gh pr create --draft --fill --base ${shq(cfg.baseBranch)} --head ${shq(task.branch)}`,
      { cwd: wt, timeoutSeconds: 120 },
    )
    if (pr.exitCode !== 0)
      throw new OarError(
        'boat',
        `gh pr create failed: ${pr.stderr.trim().split('\n').slice(-3).join(' | ')}`,
      )
    ctx.io.out(pr.stdout.trim())
  }
  await ctx.boat.writeFile(id, vmDoneMarker(task.id), `${nowIso()}\n`)
  const o = await observeTask(ctx, { ...task, status: 'working' })
  ctx.io.out(formatObservation(o, ctx.now()))
}

export async function taskResume(ctx: Ctx, ref: string, log = ctx.io.out): Promise<void> {
  const task = resolveTask(loadState(ctx.paths), ref)
  const cfg = repoConfig(ctx.config, task.repo)
  const up = await ensureUp(ctx, task.repo, log)
  if (!up.herdrReachable) throw new OarError('herdr', `Herdr on ${task.repo} is not reachable`)
  const handle = await resumeHerdr(ctx, task, cfg, up.vm.sandboxId, herdrHandle(task), log)
  await mutateState(ctx.paths, (s) => {
    const t = s.tasks[task.id]!
    t.handle = handle
    t.status = 'working'
    t.note = undefined
  })
  const after = await ensureDeadline(
    ctx.boat,
    up.vm.sandboxId,
    hoursFromNow(Math.max(2, task.hours / 2), ctx.now()),
    { log, now: ctx.now },
  ).catch(() => null)
  await mutateState(ctx.paths, (s) => {
    requireVm(s, task.repo).archiveAfter = after?.toISOString() ?? null
  })
  log(`${task.id} resumed`)
}

export async function taskClose(ctx: Ctx, ref: string): Promise<void> {
  const task = resolveTask(loadState(ctx.paths), ref)
  await mutateState(ctx.paths, (s) => {
    const t = s.tasks[task.id]
    if (t) t.status = 'closed'
  })
  ctx.io.out(`${task.id} closed`)
}

export async function taskList(ctx: Ctx, all = false): Promise<void> {
  const state = loadState(ctx.paths)
  const tasks = Object.values(state.tasks)
    .filter((t) => all || t.status !== 'closed')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  if (!tasks.length) {
    ctx.io.out('no tasks: oar task new <slug> --repo engine|cno')
    return
  }
  for (const t of tasks) {
    const pr = t.pr ? `PR #${t.pr.number}` : ''
    ctx.io.out(
      `${t.id.padEnd(32)} ${t.repo.padEnd(7)} ${t.status.padEnd(11)} ${t.branch.padEnd(32)} ${pr}`,
    )
  }
}

export const taskBriefPath = (ctx: Ctx, id: string) => join(ctx.paths.tasksDir, id, 'brief.md')
