import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { assetsRoot } from '../assets.js'
import { runCommand, sandboxState, waitUp } from '../boat.js'
import { loadSecrets, repoConfig, sshAlias, type Config } from '../config.js'
import type { Ctx } from '../context.js'
import { OarError, usage } from '../errors.js'
import { shq } from '../exec.js'
import { FactoryDb } from '../factory/db.js'
import { LinearClient } from '../factory/linear.js'
import { dbPath, Factory, linearAuth, pauseFile } from '../factory/loop.js'
import { HOLDING_PHASES, type IssueRow } from '../factory/types.js'
import { HerdrMachine, localHerdr } from '../herdr.js'
import { focusAgent } from '../runner.js'
import * as ssh from '../ssh.js'
import { loadState, mutateState, UP_STATES } from '../state.js'
import { formatDuration, sleep } from '../time.js'
import { ensureUp, reachableAlias, setupTailscale } from './vm.js'

const FACTORY = 'factory'
type Log = (line: string) => void

const isController = (ctx: Ctx) => ctx.config.factory.role === 'controller'

function controllerAlias(ctx: Ctx): string {
  const vm = loadState(ctx.paths).vms[FACTORY]
  if (!vm) throw new OarError('no_vm', 'no factory controller yet', 'oar factory setup')
  return reachableAlias(vm, FACTORY)
}

/** Run the same `oar factory …` on the controller, stdio inherited (so `log -f` streams). */
async function forward(ctx: Ctx, args: string[]): Promise<number> {
  const alias = controllerAlias(ctx)
  return ssh.interactive(
    ctx.exec,
    alias,
    `export PATH=$HOME/.local/bin:$PATH; oar factory ${args.map(shq).join(' ')}`,
  )
}

async function remote(ctx: Ctx, command: string, timeoutMs = 120_000): Promise<string> {
  const alias = controllerAlias(ctx)
  const r = await ssh.remote(
    ctx.exec,
    alias,
    `export PATH=$HOME/.local/bin:$PATH; ${command}`,
    timeoutMs,
  )
  if (r.code !== 0)
    throw new OarError('ssh', `on the controller: ${command}\n${(r.stderr || r.stdout).trim()}`)
  return r.stdout
}

/** Text to a file on the controller over ssh stdin (secrets never go through boat's command log). */
async function putFile(ctx: Ctx, path: string, text: string, mode = '600'): Promise<void> {
  const alias = controllerAlias(ctx)
  const r = await ctx.exec.run(
    'ssh',
    [
      ...ssh.batchArgs,
      alias,
      `umask 077 && mkdir -p $(dirname ${shq(path)}) && cat > ${shq(path)} && chmod ${mode} ${shq(path)}`,
    ],
    { input: text, timeoutMs: 30_000 },
  )
  if (r.code !== 0)
    throw new OarError('ssh', `could not write ${path} on the controller: ${r.stderr.trim()}`)
}

// ---- setup (runs on the Mac) --------------------------------------------------------------------

async function ensureControllerSandbox(ctx: Ctx, log: Log): Promise<string> {
  const existing = loadState(ctx.paths).vms[FACTORY]
  if (existing) return existing.sandboxId
  const { name, type } = ctx.config.factory.controller
  log(`creating the controller sandbox (${type}, no auto-stop)`)
  let created
  try {
    created = await ctx.boat.create({ ttlSeconds: null, type }, `oar-factory-${name}`)
  } catch (e) {
    log(
      `no-auto-stop refused at creation (${(e as Error).message}); creating with a 12 h TTL, the controller extends itself`,
    )
    created = await ctx.boat.create({ ttlSeconds: 43_200, type }, `oar-factory-${name}-ttl`)
  }
  await mutateState(ctx.paths, (s) => {
    s.vms[FACTORY] = { sandboxId: created.id, label: FACTORY }
  })
  await ctx.boat.update(created.id, { name }).catch(() => undefined)
  log(`${created.id} saved; waiting for it to be ready`)
  await waitUp(ctx.boat, created.id, { timeoutMs: 300_000 })
  return created.id
}

function controllerConfig(ctx: Ctx, sandboxId: string): Config {
  const cfg: Config = JSON.parse(JSON.stringify(ctx.config)) as Config
  cfg.factory = {
    ...cfg.factory,
    role: 'controller',
    controller: { ...cfg.factory.controller, sandboxId },
  }
  cfg.tailscale = { ...cfg.tailscale, cli: 'tailscale' }
  return cfg
}

export async function factorySetup(ctx: Ctx): Promise<void> {
  const log = ctx.io.out
  if (isController(ctx)) throw usage('run oar factory setup from the Mac, not on the controller')
  const secrets = loadSecrets(ctx.paths)
  const hasLinear = Boolean(
    (secrets.LINEAR_CLIENT_ID && secrets.LINEAR_CLIENT_SECRET) || secrets.LINEAR_API_KEY,
  )
  if (hasLinear) {
    const me = await new LinearClient({
      auth: linearAuth(ctx),
      store: new FactoryDb(':memory:').tokenStore(),
      now: ctx.now,
    })
      .me()
      .catch((e: Error) => {
        log(
          `linear: cannot authenticate (${e.message}); the controller will not start until this works`,
        )
        return null
      })
    if (me)
      log(
        `linear: acting as ${me.name}${me.app ? ' (app user)' : ' (your own user; comments will not notify you)'}`,
      )
  } else {
    log(
      `linear: no credentials in ${ctx.paths.envFile}; add LINEAR_CLIENT_ID/LINEAR_CLIENT_SECRET and re-run`,
    )
  }

  // nodes-cno factory PRs target dev (staging) by decision; keep the Mac's config in step.
  for (const [name, repo] of Object.entries(ctx.config.repos)) {
    if (repo.deployWorkflow && repo.baseBranch !== 'dev' && name === 'cno') {
      repo.baseBranch = 'dev'
      writeFileSync(ctx.paths.configFile, `${JSON.stringify(ctx.config, null, 2)}\n`)
      log(`config: ${name}.baseBranch set to dev (staging deploys from it)`)
    }
  }

  const id = await ensureControllerSandbox(ctx, log)
  const up = await ensureUp(ctx, FACTORY, log, { herdr: false })
  const alias = reachableAlias(up.vm, FACTORY)

  // 1. the app bundle and its assets
  const root = assetsRoot()
  if (!existsSync(`${root}/dist/oar.mjs`))
    throw new OarError(
      'usage',
      'dist/oar.mjs is missing',
      'pnpm build (or pnpm install:local) first',
    )
  await remote(ctx, 'mkdir -p ~/oar/app')
  const scp = await ctx.exec.run(
    'scp',
    [
      ...ssh.batchArgs,
      '-q',
      '-r',
      `${root}/dist`,
      `${root}/setup`,
      `${root}/vm`,
      `${root}/templates`,
      `${alias}:/home/user/oar/app/`,
    ],
    { timeoutMs: 300_000 },
  )
  if (scp.code !== 0)
    throw new OarError('ssh', `scp to the controller failed: ${scp.stderr.trim()}`)
  log('app bundle copied')

  // 2. config, secrets, VM records
  await putFile(
    ctx,
    '/home/user/.config/oar/config.json',
    `${JSON.stringify(controllerConfig(ctx, id), null, 2)}\n`,
    '644',
  )
  const env = [
    '# oar factory controller secrets; written by oar factory setup on the Mac',
    `BOAT_API_KEY=${secrets.BOAT_API_KEY}`,
    ...(secrets.LINEAR_CLIENT_ID ? [`LINEAR_CLIENT_ID=${secrets.LINEAR_CLIENT_ID}`] : []),
    ...(secrets.LINEAR_CLIENT_SECRET
      ? [`LINEAR_CLIENT_SECRET=${secrets.LINEAR_CLIENT_SECRET}`]
      : []),
    ...(secrets.LINEAR_API_KEY ? [`LINEAR_API_KEY=${secrets.LINEAR_API_KEY}`] : []),
    ...(secrets.GH_TOKEN ? [`GH_TOKEN=${secrets.GH_TOKEN}`] : []),
    '',
  ].join('\n')
  await putFile(ctx, '/home/user/.config/oar/env', env)
  log('config and secrets written')

  // 3. the controller's own setup script (herdr, units, oar symlink)
  const code = await ssh.interactive(ctx.exec, alias, 'bash /home/user/oar/app/setup/controller.sh')
  // (controller.sh links ~/oar/setup and ~/oar/vm into the bundle, which tailscale.sh relies on)
  if (code !== 0)
    throw new OarError('ssh', `controller.sh exited ${code}`, 're-run oar factory setup')

  // 4. tailnet (so oar-factory resolves for the Mac and the workers for it)
  await setupTailscale(ctx, FACTORY, id, alias, log)
  const via = reachableAlias(loadState(ctx.paths).vms[FACTORY]!, FACTORY)

  // 5. VM records on the controller and its ssh key on every worker
  const vms = loadState(ctx.paths).vms
  const seed = Object.fromEntries(
    Object.entries(vms).map(([k, v]) => [k, { sandboxId: v.sandboxId, label: v.label }]),
  )
  await ctx.exec.run('ssh', [...ssh.batchArgs, via, '~/.local/bin/oar factory seed'], {
    input: JSON.stringify({ vms: seed }),
    timeoutMs: 60_000,
  })
  const pub = (await remote(ctx, '~/.local/bin/oar factory keygen')).trim()
  for (const repo of Object.keys(ctx.config.repos)) {
    const vm = vms[repo]
    if (!vm) continue
    await runCommand(
      ctx.boat,
      vm.sandboxId,
      `mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && (grep -qxF ${shq(pub)} ~/.ssh/authorized_keys || echo ${shq(pub)} >> ~/.ssh/authorized_keys) && wc -l < ~/.ssh/authorized_keys`,
      { timeoutSeconds: 30 },
    )
      .then((r) => log(`${repo}: controller key authorized (${r.stdout.trim()} key(s) on the VM)`))
      .catch((e: Error) => log(`${repo}: could not authorize the controller key: ${e.message}`))
  }
  // pin the workers' aliases on the controller and register its Herdr machine profiles
  for (const repo of Object.keys(ctx.config.repos)) {
    if (!vms[repo]) continue
    const label = repoConfig(ctx.config, repo).herdrLabel
    const env = 'export PATH=$HOME/.local/bin:$PATH;'
    await ssh.interactive(ctx.exec, via, `${env} oar factory pin ${shq(repo)}`)
    await ssh.interactive(
      ctx.exec,
      via,
      `${env} herdr machine list --json 2>/dev/null | grep -q ${shq(`"${label}"`)} || herdr machine add ${shq(sshAlias(repo))} --label ${shq(label)} --remote-session default`,
    )
  }

  // 6. Linear workflow states, then the unit
  if (hasLinear) {
    const created = await new Factory(ctx, { db: new FactoryDb(':memory:'), log })
      .ensureStates()
      .catch((e: Error) => {
        log(`linear: could not ensure states: ${e.message}`)
        return [] as string[]
      })
    log(created.length ? `linear: created states ${created.join(', ')}` : 'linear: states present')
  }
  await remote(
    ctx,
    'sudo systemctl enable oar-factory >/dev/null 2>&1; sudo systemctl restart oar-factory',
  )
  log('oar-factory.service restarted')
  await sleep(3_000)
  await forward(ctx, ['doctor'])
}

/** Rebuild the bundle, copy it over, restart the unit. */
export async function factoryDeploy(ctx: Ctx): Promise<void> {
  const log = ctx.io.out
  const root = assetsRoot()
  const build = await ctx.exec.run('pnpm', ['build'], { cwd: root, timeoutMs: 180_000 })
  if (build.code !== 0) throw new OarError('usage', `build failed:\n${build.stderr.trim()}`)
  const alias = controllerAlias(ctx)
  const scp = await ctx.exec.run(
    'scp',
    [
      ...ssh.batchArgs,
      '-q',
      '-r',
      `${root}/dist`,
      `${root}/setup`,
      `${root}/vm`,
      `${root}/templates`,
      `${alias}:/home/user/oar/app/`,
    ],
    { timeoutMs: 300_000 },
  )
  if (scp.code !== 0) throw new OarError('ssh', `scp failed: ${scp.stderr.trim()}`)
  await remote(
    ctx,
    'sudo install -m 644 ~/oar/app/setup/oar-factory.service /etc/systemd/system/oar-factory.service && sudo systemctl daemon-reload && sudo systemctl restart oar-factory',
  )
  log('deployed and restarted')
}

export async function factoryUp(ctx: Ctx): Promise<void> {
  const up = await ensureUp(ctx, FACTORY, ctx.io.out, { herdr: false })
  ctx.io.out(`controller ${up.vm.sandboxId} ${up.state}; ssh ${reachableAlias(up.vm, FACTORY)}`)
}

export async function factoryStop(ctx: Ctx): Promise<void> {
  const vm = loadState(ctx.paths).vms[FACTORY]
  if (!vm) throw new OarError('no_vm', 'no factory controller', 'oar factory setup')
  await ctx.boat.stop(vm.sandboxId)
  ctx.io.out(`${vm.sandboxId} stopping; oar factory up resumes it`)
}

/** Focus the issue's agent on its worker and attach Herdr there (asks the controller for the handle). */
export async function factoryAttach(ctx: Ctx, ref: string): Promise<number> {
  const raw = await remote(ctx, `~/.local/bin/oar factory handle ${shq(ref)} --json`)
  const h = JSON.parse(raw) as { repo: string; handle: Parameters<typeof focusAgent>[2] | null }
  if (!h.handle) throw new OarError('no_task', `${ref} has no agent right now`)
  await ensureUp(ctx, h.repo, ctx.io.out)
  await focusAgent(ctx, repoConfig(ctx.config, h.repo), h.handle)
  return localHerdr.attach(ctx.exec, sshAlias(h.repo))
}

// ---- on the controller ----------------------------------------------------------------------------

export async function factoryServe(ctx: Ctx): Promise<void> {
  if (!isController(ctx)) throw usage('oar factory serve runs on the controller VM')
  // Without Linear credentials there is nothing to do; wait for them instead of flapping the unit.
  for (;;) {
    try {
      linearAuth(ctx)
      break
    } catch (e) {
      ctx.io.err(`${(e as Error).message}; checking again in a minute`)
      await sleep(60_000)
    }
  }
  await new Factory(ctx).serve()
}

/** Merge VM records sent by the Mac (stdin JSON {vms}) into this host's state. */
export async function factorySeed(ctx: Ctx, json: string): Promise<void> {
  const parsed = JSON.parse(json) as { vms?: Record<string, { sandboxId: string; label: string }> }
  await mutateState(ctx.paths, (s) => {
    for (const [k, v] of Object.entries(parsed.vms ?? {}))
      s.vms[k] = { ...s.vms[k], sandboxId: v.sandboxId, label: v.label }
  })
  ctx.io.out(`seeded ${Object.keys(parsed.vms ?? {}).join(', ')}`)
}

export async function factoryKeygen(ctx: Ctx): Promise<void> {
  ctx.io.out(await ssh.ensurePublicKey(ctx.paths, ctx.exec))
}

export async function factoryPin(ctx: Ctx, repo: string): Promise<void> {
  const up = await ensureUp(ctx, repo, ctx.io.out)
  ctx.io.out(
    `${repo}: ${up.state}, herdr ${up.herdrReachable ? 'reachable' : 'not reachable yet (machine profile?)'}`,
  )
}

const phaseLabel = (r: IssueRow) => `${r.phase}${r.round ? ` r${r.round}` : ''}`

export async function factoryStatus(ctx: Ctx): Promise<void> {
  if (!isController(ctx)) {
    await forward(ctx, ['status'])
    return
  }
  const out = ctx.io.out
  const db = new FactoryDb(dbPath(ctx), ctx.now)
  try {
    const at = db.cursor('tick.at')
    const age = at ? formatDuration(ctx.now() - Date.parse(at)) : 'never'
    out(
      `controller: tick ${db.cursor('tick.n') ?? 0}, last ${age} ago${existsSync(pauseFile(ctx)) ? ', PAUSED (no new dispatches)' : ''}`,
    )
    const state = loadState(ctx.paths)
    for (const repo of Object.keys(ctx.config.repos)) {
      const vm = state.vms[repo]
      if (!vm) {
        out(`  ${repo.padEnd(8)} (no VM)`)
        continue
      }
      const sb = await ctx.boat.get(vm.sandboxId).catch(() => null)
      const st = sb ? sandboxState(sb) : 'unreachable'
      const holding = db.countInPhases(repo, new Set([...HOLDING_PHASES, 'needs_input']))
      out(`  ${repo.padEnd(8)} ${vm.sandboxId}  ${st.padEnd(10)} ${holding} issue(s) holding it`)
    }
    const rows = db.activeIssues()
    out('')
    out(rows.length ? 'Issues' : 'Issues: none active')
    for (const r of rows) {
      const pr = r.prUrl ? `  ${r.prUrl}` : ''
      out(
        `  ${r.identifier.padEnd(9)} ${r.repo.padEnd(7)} ${phaseLabel(r).padEnd(16)} ${r.linearState.padEnd(12)} ${r.title.slice(0, 50)}${pr}`,
      )
    }
  } finally {
    db.close()
  }
}

export async function factoryLog(
  ctx: Ctx,
  opts: { issue?: string; follow?: boolean; lines?: number },
): Promise<void> {
  if (!isController(ctx)) {
    await forward(ctx, [
      'log',
      ...(opts.issue ? [opts.issue] : []),
      ...(opts.follow ? ['-f'] : []),
      ...(opts.lines ? ['-n', String(opts.lines)] : []),
    ])
    return
  }
  const db = new FactoryDb(dbPath(ctx), ctx.now)
  try {
    const issueId = opts.issue ? (db.issueByIdentifier(opts.issue)?.id ?? opts.issue) : undefined
    let last = 0
    const print = (rows: ReturnType<FactoryDb['events']>) => {
      for (const e of rows) {
        const row = e.issueId ? db.issue(e.issueId) : null
        ctx.io.out(`${e.ts}  ${(row?.identifier ?? '').padEnd(9)} ${e.kind.padEnd(14)} ${e.detail}`)
        last = Math.max(last, e.id)
      }
    }
    print(db.events({ issueId, limit: opts.lines ?? 40 }))
    while (opts.follow) {
      await sleep(2_000)
      print(db.events({ issueId, afterId: last, limit: 200 }))
    }
  } finally {
    db.close()
  }
}

export async function factoryPause(ctx: Ctx, on: boolean): Promise<void> {
  if (!isController(ctx)) {
    await forward(ctx, [on ? 'pause' : 'resume'])
    return
  }
  if (on) writeFileSync(pauseFile(ctx), `${new Date(ctx.now()).toISOString()}\n`)
  else if (existsSync(pauseFile(ctx))) unlinkSync(pauseFile(ctx))
  ctx.io.out(on ? 'paused: running issues continue, nothing new is dispatched' : 'resumed')
}

export async function factoryHandle(ctx: Ctx, ref: string, json: boolean): Promise<void> {
  if (!isController(ctx)) {
    await forward(ctx, ['handle', ref, ...(json ? ['--json'] : [])])
    return
  }
  const db = new FactoryDb(dbPath(ctx), ctx.now)
  try {
    const row = db.issueByIdentifier(ref) ?? db.issue(ref)
    if (!row) throw new OarError('no_task', `no issue '${ref}' in the factory`)
    const task = row.taskId ? loadState(ctx.paths).tasks[row.taskId] : undefined
    const handle = task?.handle?.runner === 'herdr' ? task.handle : null
    if (json) ctx.io.out(JSON.stringify({ repo: row.repo, taskId: row.taskId, handle }))
    else
      ctx.io.out(
        `${row.identifier}: ${row.repo} task ${row.taskId ?? '-'} ${handle ? `pane ${handle.paneId} agent ${handle.agentName}` : '(no agent)'}`,
      )
  } finally {
    db.close()
  }
}

export async function factoryStates(ctx: Ctx): Promise<void> {
  const created = await new Factory(ctx, {
    db: new FactoryDb(':memory:'),
    log: ctx.io.out,
  }).ensureStates()
  ctx.io.out(created.length ? `created: ${created.join(', ')}` : 'all states present')
}

/** Health of the controller itself (runs there; the Mac forwards). */
export async function factoryDoctor(ctx: Ctx): Promise<boolean> {
  if (!isController(ctx)) return (await forward(ctx, ['doctor'])) === 0
  const checks: Array<[string, boolean, string]> = []
  const push = (name: string, ok: boolean, detail = '') => checks.push([name, ok, detail])
  const unit = await ctx.exec.run('systemctl', ['is-active', 'oar-factory'])
  push('oar-factory.service', unit.stdout.trim() === 'active', unit.stdout.trim())
  const db = new FactoryDb(dbPath(ctx), ctx.now)
  const at = db.cursor('tick.at')
  const ageMs = at ? ctx.now() - Date.parse(at) : Infinity
  push(
    'last tick',
    ageMs < 3 * ctx.config.defaults.pollSeconds * 1000,
    at ? `${formatDuration(ageMs)} ago` : 'never',
  )
  try {
    const me = await new LinearClient({
      auth: linearAuth(ctx),
      store: db.tokenStore(),
      now: ctx.now,
    }).me()
    push('linear auth', true, `${me.name}${me.app ? ' (app user)' : ' (personal key)'}`)
    const f = new Factory(ctx, { db, log: () => undefined })
    for (const team of Object.keys(ctx.config.factory.linear.teams)) {
      const missing: string[] = []
      for (const key of [
        'ready',
        'inProgress',
        'needsInput',
        'inReview',
        'done',
        'canceled',
      ] as const)
        await f.stateId(team, key).catch(() => missing.push(ctx.config.factory.linear.states[key]))
      push(
        `linear team ${team}`,
        missing.length === 0,
        missing.length ? `missing states: ${missing.join(', ')} (oar factory states)` : 'states ok',
      )
    }
  } catch (e) {
    push('linear auth', false, (e as Error).message)
  }
  const gh = await ctx.exec.run('gh', ['auth', 'status', '-h', 'github.com'], { timeoutMs: 20_000 })
  push(
    'gh here',
    gh.code === 0,
    gh.code === 0
      ? 'logged in'
      : 'not logged in: PR polling falls back to the worker VMs (set GH_TOKEN in ~/.config/oar/env)',
  )
  const self = ctx.config.factory.controller.sandboxId
  if (self) {
    const sb = await ctx.boat.get(self).catch(() => null)
    push(
      'no auto-stop',
      Boolean(sb && (sb.archiveAfter === null || sb.archiveAfter === undefined)),
      sb
        ? sb.archiveAfter
          ? `stops ${sb.archiveAfter.toISOString()} (keeper extends it)`
          : 'never stops'
        : 'cannot read own sandbox',
    )
  }
  const state = loadState(ctx.paths)
  const machines = await localHerdr.machines(ctx.exec)
  for (const repo of Object.keys(ctx.config.repos)) {
    const vm = state.vms[repo]
    if (!vm) {
      push(`${repo}: VM`, false, 'not seeded; oar factory setup')
      continue
    }
    const sb = await ctx.boat.get(vm.sandboxId).catch(() => null)
    const st = sb ? sandboxState(sb) : 'unreachable'
    push(`${repo}: VM ${vm.sandboxId}`, Boolean(sb), st)
    push(
      `${repo}: herdr machine '${vm.label}'`,
      machines.some((m) => m.label === vm.label),
      `herdr machine add ${sshAlias(repo)} --label ${vm.label} --remote-session default`,
    )
    if (sb && UP_STATES.has(st as never)) {
      const reach = await new HerdrMachine(ctx.exec, vm.label).reachable()
      push(
        `${repo}: herdr --machine`,
        reach,
        reach ? 'reachable' : 'not reachable from the controller',
      )
    }
  }
  db.close()
  for (const [name, ok, detail] of checks)
    ctx.io.out(`${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`)
  return checks.every((c) => c[1])
}

// ---- CLI ------------------------------------------------------------------------------------------

export async function factoryCmd(ctx: Ctx, args: string[]): Promise<number> {
  const [sub, ...rest] = args
  switch (sub) {
    case 'setup':
      await factorySetup(ctx)
      return 0
    case 'deploy':
      await factoryDeploy(ctx)
      return 0
    case 'serve':
      await factoryServe(ctx)
      return 0
    case 'status':
      await factoryStatus(ctx)
      return 0
    case 'log': {
      const follow = rest.includes('-f') || rest.includes('--follow')
      const nIdx = rest.findIndex((a) => a === '-n' || a === '--lines')
      const lines = nIdx >= 0 ? Number(rest[nIdx + 1]) : undefined
      const issue = rest.find((a, i) => !a.startsWith('-') && (nIdx < 0 || i !== nIdx + 1))
      await factoryLog(ctx, { issue, follow, lines })
      return 0
    }
    case 'pause':
      await factoryPause(ctx, true)
      return 0
    case 'resume':
      await factoryPause(ctx, false)
      return 0
    case 'handle':
      if (!rest[0]) throw usage('handle needs an issue identifier')
      await factoryHandle(ctx, rest[0], rest.includes('--json'))
      return 0
    case 'attach':
      if (!rest[0]) throw usage('attach needs an issue identifier')
      return factoryAttach(ctx, rest[0])
    case 'up':
      await factoryUp(ctx)
      return 0
    case 'stop':
      await factoryStop(ctx)
      return 0
    case 'doctor':
      return (await factoryDoctor(ctx)) ? 0 : 1
    case 'states':
      await factoryStates(ctx)
      return 0
    case 'seed':
      await factorySeed(ctx, readFileSync(0, 'utf8'))
      return 0
    case 'keygen':
      await factoryKeygen(ctx)
      return 0
    case 'pin':
      if (!rest[0]) throw usage('pin needs a repo')
      await factoryPin(ctx, rest[0])
      return 0
    default:
      throw usage(
        `oar factory ${sub ?? ''}: unknown subcommand`,
        'setup|deploy|status|log|pause|resume|attach|handle|up|stop|doctor|states',
      )
  }
}
