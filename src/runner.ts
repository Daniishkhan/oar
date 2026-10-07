import { runCommand } from './boat.js'
import { footer, readBrief, vmBriefPath, vmTaskDir } from './brief.js'
import type { RepoConfig } from './config.js'
import type { Ctx } from './context.js'
import { OarError } from './errors.js'
import { shq } from './exec.js'
import { Created, HerdrError, HerdrMachine, type AgentInfo } from './herdr.js'
import type { AgentStatus, Task, VmRecord } from './state.js'

export interface HerdrHandle {
  runner: 'herdr'
  workspaceId: string
  tabId?: string
  paneId: string
  agentName: string
}

export interface DispatchOptions {
  reuseBranch?: boolean
  log: (line: string) => void
}

export interface DispatchResult {
  handle: HerdrHandle
  /** Set when the prompt was sent but Herdr never saw the agent start working. */
  note?: string
}

const TRUST_DIALOG = /trust|yes, proceed|bypass permissions|dangerous|press enter|continue\?/i

const trustScript = (path: string) =>
  `node -e ${shq(
    `const fs=require("fs");const f=process.env.HOME+"/.claude.json";let j={};try{j=JSON.parse(fs.readFileSync(f,"utf8"))}catch{};j.projects=j.projects||{};const p=process.argv[1];j.projects[p]=Object.assign({},j.projects[p],{hasTrustDialogAccepted:true});fs.writeFileSync(f,JSON.stringify(j,null,2));`,
  )} ${shq(path)}`

async function uniqueAgentName(
  machine: HerdrMachine,
  wanted: string,
  paneId: string,
): Promise<string> {
  const agents = await machine.agents().catch(() => [] as AgentInfo[])
  const taken = (name: string) => agents.some((a) => a.name === name && a.pane_id !== paneId)
  if (!taken(wanted)) return wanted
  for (let i = 2; i < 10; i++) if (!taken(`${wanted}-${i}`)) return `${wanted}-${i}`
  throw new OarError('herdr', `agent name ${wanted} is taken on ${machine.label}`)
}

/** Runs interactive Claude in a Herdr pane on the VM, in its own worktree, and points it at the brief. */
export async function dispatchHerdr(
  ctx: Ctx,
  task: Task,
  repo: RepoConfig,
  vm: VmRecord,
  opts: DispatchOptions,
): Promise<DispatchResult> {
  const { log } = opts
  const id = vm.sandboxId
  const machine = new HerdrMachine(ctx.exec, repo.herdrLabel)

  // 1. pre-flight on the VM: fresh base, branch not already on origin
  const fetch = await runCommand(ctx.boat, id, `git fetch origin ${shq(repo.baseBranch)}`, {
    cwd: repo.vmPath,
    timeoutSeconds: 120,
  })
  if (fetch.exitCode !== 0)
    throw new OarError('boat', `git fetch failed on the VM: ${fetch.stderr.trim()}`)
  const remoteBranch = await runCommand(
    ctx.boat,
    id,
    `git ls-remote --heads origin ${shq(task.branch)}`,
    { cwd: repo.vmPath, timeoutSeconds: 60 },
  )
  if (remoteBranch.stdout.trim() && !task.dispatchedAt && !opts.reuseBranch) {
    throw new OarError(
      'branch_exists',
      `branch ${task.branch} already exists on origin`,
      'pick a new slug, or pass --reuse-branch to continue on it',
    )
  }

  // 2. brief + task.json on the VM
  const brief = `${readBrief(task.briefPath).trimEnd()}\n${footer(task, repo)}`
  await ctx.boat.writeFile(id, vmBriefPath(task.id), brief)
  await ctx.boat.writeFile(
    id,
    `${vmTaskDir(task.id)}/task.json`,
    `${JSON.stringify({ id: task.id, repo: task.repo, branch: task.branch, base: repo.baseBranch, gate: repo.gate, worktree: task.worktreePath }, null, 2)}\n`,
  )
  log(`brief written to ${vmBriefPath(task.id)}`)

  // 3. worktree + workspace in Herdr
  const wtArgs = [
    'worktree',
    'create',
    '--cwd',
    repo.vmPath,
    '--branch',
    task.branch,
    '--base',
    `origin/${repo.baseBranch}`,
    '--path',
    task.worktreePath,
    '--label',
    task.slug,
    '--no-focus',
  ]
  let created: Created
  try {
    created = await machine.call(wtArgs, Created, 120_000)
  } catch (e) {
    if (e instanceof HerdrError && /trust/i.test(`${e.code} ${e.message}`)) {
      created = await machine.call([...wtArgs, '--trust-repository'], Created, 120_000)
    } else throw e
  }
  const paneId = created.root_pane.pane_id
  log(
    `worktree ${task.worktreePath} in workspace ${created.workspace.workspace_id}, pane ${paneId}`,
  )

  // 4. per-worktree init (deps, .env)
  if (repo.worktreeInit.length) {
    const init = await runCommand(ctx.boat, id, repo.worktreeInit.join(' && '), {
      cwd: task.worktreePath,
      timeoutSeconds: 900,
    })
    if (init.exitCode !== 0) {
      throw new OarError(
        'boat',
        `worktree init failed (exit ${init.exitCode}): ${init.stderr.trim().split('\n').slice(-5).join(' | ')}`,
      )
    }
    log('worktree initialised')
  }

  // 5. no trust dialog for the new cwd
  await runCommand(ctx.boat, id, trustScript(task.worktreePath), { timeoutSeconds: 60 })

  // 6-7. start Claude with a unique name
  const name = await uniqueAgentName(machine, task.id, paneId)
  const startArgs = [
    'agent',
    'start',
    name,
    '--kind',
    'claude',
    '--pane',
    paneId,
    '--timeout',
    '90000',
    '--',
    '--name',
    name,
    '--remote-control',
    name,
  ]
  try {
    await machine.call(startArgs, undefined, 120_000)
  } catch (e) {
    if (!(e instanceof HerdrError) || e.code !== 'agent_not_ready') throw e
    const screen = await machine.read(name, 40, 'visible').catch(() => '')
    if (!TRUST_DIALOG.test(screen)) {
      throw new OarError(
        'blocked',
        `Claude started but is not ready in pane ${paneId}:\n${screen.trim().split('\n').slice(-12).join('\n')}`,
        `oar task attach ${task.id}`,
      )
    }
    await machine.call(['agent', 'send-keys', name, 'enter'])
    await machine.call(
      ['agent', 'wait', name, '--until', 'idle', '--timeout', '30000'],
      undefined,
      45_000,
    )
  }
  log(`claude running as agent ${name}`)

  // 8. hand over the brief
  const prompt = `Read ${vmBriefPath(task.id)} and execute it. Restate the goal and the gate in one line first.`
  let note: string | undefined
  try {
    await machine.call(
      ['agent', 'prompt', name, prompt, '--wait', '--until', 'working', '--timeout', '20000'],
      undefined,
      40_000,
    )
  } catch (e) {
    if (e instanceof HerdrError && e.code === 'agent_blocked') {
      const screen = await machine.read(name, 40, 'visible').catch(() => '')
      throw new OarError(
        'blocked',
        `agent is waiting at a dialog:\n${screen.trim().split('\n').slice(-12).join('\n')}`,
        `oar task keys ${task.id} enter   or   oar task attach ${task.id}`,
      )
    }
    if (e instanceof HerdrError && /stalled|timeout/.test(e.code)) {
      const info = await machine.agent(name)
      if (info?.agent_status !== 'working')
        note = `prompt sent but not confirmed (${e.code}); check with oar task read ${task.id}`
    } else throw e
  }

  return {
    handle: {
      runner: 'herdr',
      workspaceId: created.workspace.workspace_id,
      tabId: created.tab?.tab_id,
      paneId,
      agentName: name,
    },
    note,
  }
}

export type LiveAgent = AgentStatus | 'exited'

/** The agent's current state on the VM; `exited` when neither the name nor the pane has one. */
export async function agentState(
  ctx: Ctx,
  repo: RepoConfig,
  handle: HerdrHandle,
): Promise<{ status: LiveAgent; info: AgentInfo | null }> {
  const machine = new HerdrMachine(ctx.exec, repo.herdrLabel)
  const byName = await machine.agent(handle.agentName)
  if (byName) return { status: byName.agent_status, info: byName }
  const byPane = await machine.agent(handle.paneId)
  if (byPane) return { status: byPane.agent_status, info: byPane }
  return { status: 'exited', info: null }
}

export const agentTarget = (handle: HerdrHandle, info: AgentInfo | null) =>
  info?.name === handle.agentName ? handle.agentName : handle.paneId

export async function readAgent(
  ctx: Ctx,
  repo: RepoConfig,
  handle: HerdrHandle,
  lines: number,
): Promise<string> {
  const machine = new HerdrMachine(ctx.exec, repo.herdrLabel)
  const { info } = await agentState(ctx, repo, handle)
  return machine.read(agentTarget(handle, info), lines)
}

export async function steerAgent(
  ctx: Ctx,
  repo: RepoConfig,
  handle: HerdrHandle,
  text: string,
): Promise<void> {
  const machine = new HerdrMachine(ctx.exec, repo.herdrLabel)
  const { status, info } = await agentState(ctx, repo, handle)
  if (status === 'exited') throw new OarError('herdr', 'the agent is gone', 'oar task resume <id>')
  if (status === 'blocked') {
    const screen = await machine.read(agentTarget(handle, info), 30, 'visible').catch(() => '')
    throw new OarError(
      'blocked',
      `agent is at a dialog; answer it first:\n${screen.trim().split('\n').slice(-10).join('\n')}`,
      'oar task keys <id> enter|esc|…',
    )
  }
  await machine.call(['agent', 'prompt', agentTarget(handle, info), text])
}

export async function sendKeys(
  ctx: Ctx,
  repo: RepoConfig,
  handle: HerdrHandle,
  keys: string[],
): Promise<void> {
  const machine = new HerdrMachine(ctx.exec, repo.herdrLabel)
  const { info } = await agentState(ctx, repo, handle)
  await machine.call(['agent', 'send-keys', agentTarget(handle, info), ...keys])
}

export async function focusAgent(ctx: Ctx, repo: RepoConfig, handle: HerdrHandle): Promise<void> {
  const machine = new HerdrMachine(ctx.exec, repo.herdrLabel)
  const { info } = await agentState(ctx, repo, handle)
  await machine.call(['agent', 'focus', agentTarget(handle, info)]).catch(() => undefined)
}

/** After a VM stop/resume: re-attach to the restored pane, or recreate the pane in the worktree. */
export async function resumeHerdr(
  ctx: Ctx,
  task: Task,
  repo: RepoConfig,
  sandboxId: string,
  handle: HerdrHandle,
  log: (l: string) => void,
): Promise<HerdrHandle> {
  const machine = new HerdrMachine(ctx.exec, repo.herdrLabel)
  const byPane = await machine.agent(handle.paneId)
  if (byPane) {
    const target = byPane.name === handle.agentName ? handle.agentName : handle.paneId
    await machine.call(['agent', 'rename', handle.paneId, handle.agentName]).catch(() => undefined)
    const msg = `The VM was stopped and resumed. ${repo.services ? `Restart services with \`${repo.services}\` if needed. ` : ''}Continue executing ${vmBriefPath(task.id)}; the gate and the finish steps still apply.`
    await machine.call(['agent', 'prompt', target, msg])
    log(`resumed agent in pane ${handle.paneId}`)
    return handle
  }
  const opened = await machine.call(
    ['worktree', 'open', '--cwd', repo.vmPath, '--branch', task.branch, '--no-focus'],
    Created,
    120_000,
  )
  const paneId = opened.root_pane.pane_id
  await runCommand(ctx.boat, sandboxId, trustScript(task.worktreePath), {
    timeoutSeconds: 60,
  }).catch(() => undefined)
  const name = await uniqueAgentName(machine, handle.agentName, paneId)
  await machine.call(
    [
      'agent',
      'start',
      name,
      '--kind',
      'claude',
      '--pane',
      paneId,
      '--timeout',
      '90000',
      '--',
      '--continue',
      '--name',
      name,
      '--remote-control',
      name,
    ],
    undefined,
    120_000,
  )
  await machine.call([
    'agent',
    'prompt',
    name,
    `The VM was stopped and resumed and this is a fresh pane. Continue executing ${vmBriefPath(task.id)}; the gate and the finish steps still apply.`,
  ])
  log(`recreated agent ${name} in pane ${paneId}`)
  return {
    ...handle,
    workspaceId: opened.workspace.workspace_id,
    tabId: opened.tab?.tab_id,
    paneId,
    agentName: name,
  }
}
