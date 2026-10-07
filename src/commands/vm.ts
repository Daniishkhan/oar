import { readAsset } from '../assets.js'
import { ensureDeadline, runCommand, sandboxState, waitForState, waitUp } from '../boat.js'
import { repoConfig, sshAlias, type RepoConfig } from '../config.js'
import type { Ctx } from '../context.js'
import { OarError } from '../errors.js'
import { HerdrMachine, localHerdr } from '../herdr.js'
import * as ssh from '../ssh.js'
import {
  CHANGING_STATES,
  LIVE_STATUSES,
  UP_STATES,
  loadState,
  mutateState,
  requireVm,
  type VmRecord,
} from '../state.js'
import { hoursFromNow, startOfTodayIso, stopsIn } from '../time.js'

export interface UpResult {
  vm: VmRecord
  state: string
  archiveAfter: Date | null
  herdrReachable: boolean
}

type Log = (line: string) => void

async function refreshSsh(ctx: Ctx, repo: string, vm: VmRecord, log: Log): Promise<VmRecord> {
  const pub = await ssh.ensurePublicKey(ctx.paths, ctx.exec)
  const res = await ctx.boat.sshKey(vm.sandboxId, pub)
  const endpoint = ssh.endpointFrom(res)
  if (!res.hostKey) throw new OarError('ssh', 'boat returned no host key to pin')
  ssh.pin(ctx.paths, {
    alias: sshAlias(repo),
    endpoint,
    hostKey: res.hostKey,
    previous: vm.lastEndpoint,
  })
  log(`ssh alias ${sshAlias(repo)} → ${endpoint.host}:${endpoint.port} (host key pinned)`)
  await ssh.probe(ctx.exec, sshAlias(repo))
  return mutateState(ctx.paths, (s) => {
    const rec = requireVm(s, repo)
    rec.lastEndpoint = endpoint
    rec.lastHostKey = res.hostKey
    return rec
  })
}

async function ensureHerdrServer(
  ctx: Ctx,
  repo: string,
  cfg: RepoConfig,
  log: Log,
  interactiveFallback: boolean,
): Promise<boolean> {
  const machine = new HerdrMachine(ctx.exec, cfg.herdrLabel)
  if (await machine.reachable()) return true
  log('herdr server on the VM not reachable; restarting it')
  await ssh.remote(
    ctx.exec,
    sshAlias(repo),
    'sudo systemctl restart herdr-server 2>/dev/null || (nohup ~/.local/bin/herdr server >/dev/null 2>&1 &)',
  )
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 3_000))
    if (await machine.reachable()) return true
  }
  const known = await localHerdr.machines(ctx.exec)
  if (!known.some((m) => m.label === cfg.herdrLabel)) {
    log(
      `no Herdr machine profile '${cfg.herdrLabel}'; run: herdr machine add ${sshAlias(repo)} --label ${cfg.herdrLabel}`,
    )
    return false
  }
  if (interactiveFallback && ctx.io.isTTY) {
    log(`running: herdr machine reconnect ${cfg.herdrLabel}`)
    await localHerdr.machineReconnect(ctx.exec, cfg.herdrLabel)
    return machine.reachable()
  }
  return false
}

/** Resume if needed, refresh SSH, make sure Herdr answers. Used by `vm up` and by every task command. */
export async function ensureUp(
  ctx: Ctx,
  repo: string,
  log: Log,
  opts: { interactive?: boolean } = {},
): Promise<UpResult> {
  const cfg = repoConfig(ctx.config, repo)
  let vm = requireVm(loadState(ctx.paths), repo)
  let sb = await ctx.boat.get(vm.sandboxId)
  let st = sandboxState(sb)
  if (CHANGING_STATES.has(st)) {
    log(`${vm.sandboxId} is ${st}; waiting`)
    sb = await waitForState(ctx.boat, vm.sandboxId, new Set([...UP_STATES, 'archived']), {
      timeoutMs: 240_000,
    })
    st = sandboxState(sb)
  }
  if (st === 'archived') {
    log(`resuming ${vm.sandboxId} (ttl ${ctx.config.defaults.ttlSeconds}s)`)
    await ctx.boat.resume(vm.sandboxId, { ttlSeconds: ctx.config.defaults.ttlSeconds })
    sb = await waitUp(ctx.boat, vm.sandboxId, { timeoutMs: 300_000 })
    st = sandboxState(sb)
  } else if (!UP_STATES.has(st)) {
    throw new OarError(
      'boat',
      `${vm.sandboxId} is ${st}${sb.error ? `: ${sb.error}` : ''}`,
      'look at it in the boat dashboard',
    )
  }
  vm = await refreshSsh(ctx, repo, vm, log)
  const herdrReachable = await ensureHerdrServer(ctx, repo, cfg, log, opts.interactive ?? false)
  await mutateState(ctx.paths, (s) => {
    const rec = requireVm(s, repo)
    rec.lastSeenState = st
    rec.archiveAfter = sb.archiveAfter?.toISOString() ?? null
  })
  return { vm, state: st, archiveAfter: sb.archiveAfter ?? null, herdrReachable }
}

async function resumeSuspendedTasks(ctx: Ctx, repo: string, log: Log): Promise<void> {
  const state = loadState(ctx.paths)
  const suspended = Object.values(state.tasks).filter(
    (t) => t.repo === repo && t.status === 'suspended',
  )
  if (!suspended.length) return
  const { taskResume } = await import('./task.js')
  for (const t of suspended) {
    log(`resuming suspended task ${t.id}`)
    await taskResume(ctx, t.id, log).catch((e: Error) =>
      log(`  could not resume ${t.id}: ${e.message}`),
    )
  }
}

export async function vmUp(ctx: Ctx, repo: string, opts: { attach?: boolean } = {}): Promise<void> {
  const cfg = repoConfig(ctx.config, repo)
  const log = ctx.io.out
  const up = await ensureUp(ctx, repo, log, { interactive: true })
  await resumeSuspendedTasks(ctx, repo, log)
  if (cfg.services) {
    const r = await runCommand(ctx.boat, up.vm.sandboxId, cfg.services, {
      cwd: cfg.vmPath,
      timeoutSeconds: 300,
    }).catch(() => null)
    log(
      r && r.exitCode === 0
        ? `services: ${cfg.services} ✓`
        : `services: ${cfg.services} failed; start them by hand`,
    )
  }
  const dollars = await ctx.boat
    .usage(up.vm.sandboxId, startOfTodayIso())
    .then((u) => u.dollars)
    .catch(() => null)
  log(
    `${repo}: ${up.vm.sandboxId} ${up.state}, ${stopsIn(up.archiveAfter, ctx.now())}${dollars !== null ? `, $${dollars.toFixed(2)} today` : ''}`,
  )
  if (!up.herdrReachable)
    log('Herdr is not reachable on the VM; `herdr --remote` will still try to start it')
  if (opts.attach ?? ctx.io.isTTY) await localHerdr.attach(ctx.exec, sshAlias(repo))
}

export async function vmSetup(ctx: Ctx, repo: string): Promise<void> {
  const cfg = repoConfig(ctx.config, repo)
  const log = ctx.io.out
  const up = await ensureUp(ctx, repo, log)
  const id = up.vm.sandboxId
  const probe = await runCommand(ctx.boat, id, `test -d ${cfg.vmPath}`, { timeoutSeconds: 30 })
  if (probe.exitCode !== 0) {
    throw new OarError(
      'boat',
      `${cfg.vmPath} is missing on the VM`,
      `attach ${cfg.github} to boat environment '${cfg.envName}' (dashboard → Environment → GitHub repositories), then recreate or resume`,
    )
  }
  const files: Array<[string, string]> = [
    ['setup/common.sh', readAsset('setup', 'common.sh')],
    [`setup/${cfg.setupScript}`, readAsset('setup', cfg.setupScript)],
    ['setup/herdr-server.service', readAsset('setup', 'herdr-server.service')],
    ['vm/claude-settings.json', readAsset('vm', 'claude-settings.json')],
    ['vm/CLAUDE.md', readAsset('vm', 'CLAUDE.md')],
  ]
  for (const [rel, content] of files) await ctx.boat.writeFile(id, `/home/user/oar/${rel}`, content)
  log(
    `copied ${files.length} files to /home/user/oar; running setup/${cfg.setupScript} (several minutes)`,
  )
  const code = await ssh.interactive(
    ctx.exec,
    sshAlias(repo),
    `bash /home/user/oar/setup/${cfg.setupScript}`,
  )
  if (code !== 0)
    throw new OarError('ssh', `setup script exited ${code}`, `re-run with: oar vm setup ${repo}`)
  log('setup finished')
}

export async function vmNew(
  ctx: Ctx,
  repo: string,
  opts: { noLogin?: boolean; type?: 'small' | 'default' | 'large' } = {},
): Promise<void> {
  const cfg = repoConfig(ctx.config, repo)
  const log = ctx.io.out
  const existing = loadState(ctx.paths).vms[repo]
  if (existing)
    throw new OarError(
      'usage',
      `${repo} already has VM ${existing.sandboxId}`,
      `use oar vm up ${repo}, or remove it from ${ctx.paths.stateFile}`,
    )
  const envs = await ctx.boat.environments()
  if (!envs.some((e) => e.name === cfg.envName)) {
    throw new OarError(
      'config',
      `boat environment '${cfg.envName}' does not exist`,
      `boat env new ${cfg.envName} && boat env add-repo ${cfg.envName} ${cfg.github}`,
    )
  }
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  log(`creating ${repo} sandbox from environment '${cfg.envName}'`)
  const created = await ctx.boat.create(
    {
      environment: cfg.envName,
      ttlSeconds: ctx.config.defaults.ttlSeconds,
      type: opts.type ?? ctx.config.defaults.type,
    },
    `oar-${repo}-${day}`,
  )
  await mutateState(ctx.paths, (s) => {
    s.vms[repo] = { sandboxId: created.id, label: cfg.herdrLabel }
  })
  log(`${created.id} saved; waiting for it to be ready`)
  const sb = await waitUp(ctx.boat, created.id, { timeoutMs: 300_000 })
  if (sb.setupStatus === 'failed')
    log(`boat setup reported a failure: ${sb.setupError ?? 'unknown'}`)
  await vmSetup(ctx, repo)
  if (!opts.noLogin) {
    log('logging Claude Code in on the VM (browser flow; paste the code back here)')
    await ssh.interactive(ctx.exec, sshAlias(repo), 'claude auth login')
  }
  if (ctx.io.isTTY) {
    log(
      `registering the VM in Herdr: herdr machine add ${sshAlias(repo)} --label ${cfg.herdrLabel}`,
    )
    await localHerdr.machineAdd(ctx.exec, sshAlias(repo), cfg.herdrLabel)
  }
  const { doctor } = await import('./doctor.js')
  await doctor(ctx, { repo })
}

export async function vmStop(
  ctx: Ctx,
  repo: string,
  opts: { forceTasks?: boolean } = {},
): Promise<void> {
  const state = loadState(ctx.paths)
  const vm = requireVm(state, repo)
  const working = Object.values(state.tasks).filter(
    (t) => t.repo === repo && LIVE_STATUSES.has(t.status),
  )
  if (working.length && !opts.forceTasks) {
    throw new OarError(
      'usage',
      `${working.length} live task(s) on ${repo}: ${working.map((t) => t.id).join(', ')}`,
      'pass --force-tasks to stop anyway (they become suspended)',
    )
  }
  await ctx.boat.stop(vm.sandboxId)
  await mutateState(ctx.paths, (s) => {
    for (const t of Object.values(s.tasks))
      if (t.repo === repo && LIVE_STATUSES.has(t.status)) t.status = 'suspended'
    const rec = requireVm(s, repo)
    rec.lastSeenState = 'archiving'
  })
  ctx.io.out(
    `${vm.sandboxId} stopping (snapshot, then free)${working.length ? `; ${working.length} task(s) suspended` : ''}`,
  )
}

export async function vmKeep(ctx: Ctx, repo: string, hours?: number): Promise<void> {
  const vm = requireVm(loadState(ctx.paths), repo)
  const h = hours ?? ctx.config.defaults.keepHours
  const after = await ensureDeadline(ctx.boat, vm.sandboxId, hoursFromNow(h, ctx.now()), {
    log: ctx.io.out,
    now: ctx.now,
  })
  await mutateState(ctx.paths, (s) => {
    requireVm(s, repo).archiveAfter = after?.toISOString() ?? null
  })
  ctx.io.out(`${vm.sandboxId}: ${stopsIn(after, ctx.now())}`)
}

export async function vmSsh(ctx: Ctx, repo: string, command?: string): Promise<number> {
  await ensureUp(ctx, repo, ctx.io.out)
  return ssh.interactive(ctx.exec, sshAlias(repo), command)
}

export async function vmTunnel(ctx: Ctx, repo: string, ports: number[]): Promise<number> {
  const cfg = repoConfig(ctx.config, repo)
  const list = ports.length ? ports : cfg.ports
  if (!list.length) throw new OarError('usage', 'no ports given and none configured for this repo')
  await ensureUp(ctx, repo, ctx.io.out)
  ctx.io.out(`localhost:${list.join(', ')} → ${sshAlias(repo)} (ctrl+c closes the tunnel)`)
  return ssh.tunnel(ctx.exec, sshAlias(repo), list)
}

export async function vmPreview(
  ctx: Ctx,
  repo: string,
  port: number,
  isPublic = false,
): Promise<void> {
  const up = await ensureUp(ctx, repo, ctx.io.out)
  const r = await ctx.boat.hostPort(up.vm.sandboxId, port, { title: `${repo}:${port}`, isPublic })
  ctx.io.out(r.url ?? JSON.stringify(r))
  if (!isPublic) ctx.io.out('token-protected; the service must bind 0.0.0.0')
}

export async function vmSnapshot(ctx: Ctx, repo: string, name: string): Promise<void> {
  const vm = requireVm(loadState(ctx.paths), repo)
  await ctx.boat.saveNamedSnapshot(vm.sandboxId, name)
  ctx.io.out(`named snapshot '${name}' requested for ${vm.sandboxId} (boat new --from ${name})`)
}

export async function vmList(ctx: Ctx): Promise<void> {
  const state = loadState(ctx.paths)
  const names = Object.keys(ctx.config.repos)
  if (!names.some((n) => state.vms[n])) {
    ctx.io.out('no VMs yet: oar vm new engine')
    return
  }
  for (const name of names) {
    const vm = state.vms[name]
    if (!vm) {
      ctx.io.out(`${name.padEnd(7)} (no VM)`)
      continue
    }
    const sb = await ctx.boat.get(vm.sandboxId).catch(() => null)
    const st = sb ? sandboxState(sb) : 'unknown'
    const when = sb ? stopsIn(sb.archiveAfter, ctx.now()) : ''
    ctx.io.out(`${name.padEnd(7)} ${vm.sandboxId}  ${st.padEnd(12)} ${when}  ssh ${sshAlias(name)}`)
    await mutateState(ctx.paths, (s) => {
      const rec = requireVm(s, name)
      if (sb) {
        rec.lastSeenState = st as VmRecord['lastSeenState']
        rec.archiveAfter = sb.archiveAfter?.toISOString() ?? null
      }
    })
  }
}
