import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readAsset } from '../assets.js'
import { CHROME_PROFILE, shotCommand, VM_SHOT_PATH } from '../desktop.js'
import { commandExists } from '../exec.js'
import {
  ensureDeadline,
  runCommand,
  sandboxState,
  waitDesktop,
  waitForState,
  waitUp,
} from '../boat.js'
import { loadSecrets, repoConfig, sshAlias, tailnetHost } from '../config.js'
import type { Ctx } from '../context.js'
import { shq } from '../exec.js'
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
  // Two hosts (the Mac and the factory controller) share each worker. boat's sshKey "adds" a key;
  // in case it ever replaces the file, every host re-appends its own key, idempotently.
  await runCommand(
    ctx.boat,
    vm.sandboxId,
    `mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && (grep -qxF ${shq(pub)} ~/.ssh/authorized_keys || echo ${shq(pub)} >> ~/.ssh/authorized_keys)`,
    { timeoutSeconds: 30 },
  ).catch(() => undefined)
  const tsHost = tailnetHost(ctx.config, repo)
  const alias = sshAlias(repo)
  ssh.pin(ctx.paths, {
    alias,
    endpoint,
    hostKey: res.hostKey,
    previous: vm.lastEndpoint,
    tailnet: tsHost ? { host: tsHost } : undefined,
  })
  const direct = ssh.directAlias(alias)
  const reached = await ssh.probeAny(ctx.exec, tsHost ? [alias, direct] : [alias])
  const transport = tsHost && reached === alias ? 'tailnet' : 'direct'
  if (tsHost && transport === 'direct') {
    // Not on the tailnet yet: keep `oar-<repo>` usable (Herdr's machine profile targets it).
    ssh.pin(ctx.paths, { alias, endpoint, hostKey: res.hostKey, previous: vm.lastEndpoint })
  }
  log(
    transport === 'tailnet'
      ? `ssh ${alias} → ${tsHost} (tailnet; ${direct} → ${endpoint.host}:${endpoint.port} pinned as fallback)`
      : `ssh ${reached} → ${endpoint.host}:${endpoint.port} (host key pinned)${tsHost ? `; tailnet name ${tsHost} not reachable yet` : ''}`,
  )
  return mutateState(ctx.paths, (s) => {
    const rec = requireVm(s, repo)
    rec.lastEndpoint = endpoint
    rec.lastHostKey = res.hostKey
    rec.transport = transport
    return rec
  })
}

/** The alias that answered on the last `vm up`; commands that must work even when the tailnet is down use it. */
export function reachableAlias(vm: VmRecord, repo: string): string {
  return vm.transport === 'direct' ? ssh.directAlias(sshAlias(repo)) : sshAlias(repo)
}

async function ensureHerdrServer(
  ctx: Ctx,
  repo: string,
  label: string,
  via: string,
  log: Log,
  interactiveFallback: boolean,
): Promise<boolean> {
  const machine = new HerdrMachine(ctx.exec, label)
  if (await machine.reachable()) return true
  // Another host (the Mac or the controller) may be driving agents on this VM right now: only
  // restart the server when systemd says it is down, never just because this client cannot reach it.
  const active = await ssh
    .remote(ctx.exec, via, 'systemctl is-active herdr-server 2>/dev/null', 30_000)
    .catch(() => null)
  if (active?.stdout.trim() === 'active') {
    log('herdr-server is active on the VM but this client cannot reach it (stale machine profile?)')
  } else {
    log(`herdr server on the VM is ${active?.stdout.trim() || 'not running'}; restarting the unit`)
    await ssh.remote(ctx.exec, via, 'sudo systemctl restart herdr-server')
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 3_000))
      if (await machine.reachable()) return true
    }
  }
  const known = await localHerdr.machines(ctx.exec)
  if (!known.some((m) => m.label === label)) {
    log(
      `no Herdr machine profile '${label}'; run: herdr machine add ${sshAlias(repo)} --label ${label} --remote-session default`,
    )
    return false
  }
  if (interactiveFallback && ctx.io.isTTY) {
    log(`running: herdr machine reconnect ${label}`)
    await localHerdr.machineReconnect(ctx.exec, label)
    return machine.reachable()
  }
  return false
}

/**
 * Resume if needed, refresh SSH, make sure Herdr answers. Used by `vm up` and by every task command.
 * `repo` is any key in state.vms (a repo, or `factory` for the controller, which has no Herdr label to check).
 */
export async function ensureUp(
  ctx: Ctx,
  repo: string,
  log: Log,
  opts: { interactive?: boolean; herdr?: boolean } = {},
): Promise<UpResult> {
  let vm = requireVm(loadState(ctx.paths), repo)
  const label = vm.label
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
  // boat scrubs ~/.claude/.credentials.json and ~/.codex/auth.json on resume; put our copies back.
  const creds = await ssh
    .remote(
      ctx.exec,
      reachableAlias(vm, repo),
      '~/.local/bin/oar-creds restore 2>/dev/null',
      30_000,
    )
    .catch(() => null)
  if (creds?.stdout.trim()) log(`logins: ${creds.stdout.trim().split('\n').join(', ')}`)
  const herdrReachable =
    opts.herdr === false
      ? false
      : await ensureHerdrServer(
          ctx,
          repo,
          label,
          reachableAlias(vm, repo),
          log,
          opts.interactive ?? false,
        )
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
    ['vm/codex-config.toml', readAsset('vm', 'codex-config.toml')],
    ['setup/tailscale.sh', readAsset('setup', 'tailscale.sh')],
    ['setup/desktop.sh', readAsset('setup', 'desktop.sh')],
    ['setup/agent-chrome.service', readAsset('setup', 'agent-chrome.service')],
    ['setup/oar-linger.service', readAsset('setup', 'oar-linger.service')],
    ['vm/shot', readAsset('vm', 'shot')],
    ['vm/pr-shot', readAsset('vm', 'pr-shot')],
    ['vm/oar-creds', readAsset('vm', 'oar-creds')],
    ['setup/oar-creds-restore.service', readAsset('setup', 'oar-creds-restore.service')],
  ]
  for (const [rel, content] of files) await ctx.boat.writeFile(id, `/home/user/oar/${rel}`, content)
  log(
    `copied ${files.length} files to /home/user/oar; running setup/${cfg.setupScript} (several minutes)`,
  )
  const via = reachableAlias(up.vm, repo)
  const code = await ssh.interactive(ctx.exec, via, `bash /home/user/oar/setup/${cfg.setupScript}`)
  if (code !== 0)
    throw new OarError('ssh', `setup script exited ${code}`, `re-run with: oar vm setup ${repo}`)
  log('setup finished')
  await setupTailscale(ctx, repo, id, via, log)
  const { name, email } = ctx.config.gitIdentity
  await runCommand(
    ctx.boat,
    id,
    `git config --global user.name ${shq(name)} && git config --global user.email ${shq(email)}`,
    { timeoutSeconds: 30 },
  )
  log(`git identity on the VM: ${name} <${email}>`)
}

/** Joins the VM to the tailnet (first time needs TS_AUTHKEY), then re-pins so `oar-<repo>` uses the tailnet name. */
export async function setupTailscale(
  ctx: Ctx,
  repo: string,
  id: string,
  via: string,
  log: Log,
): Promise<void> {
  const tsHost = tailnetHost(ctx.config, repo)
  if (!tsHost) return
  const key = loadSecrets(ctx.paths).TS_AUTHKEY
  if (key) {
    // Over ssh stdin, so the key never transits boat's API or a command log; the script deletes it.
    const put = await ctx.exec.run(
      'ssh',
      [...ssh.batchArgs, via, 'umask 077 && mkdir -p ~/oar && cat > ~/oar/ts-authkey'],
      { input: `${key}\n`, timeoutMs: 30_000 },
    )
    if (put.code !== 0)
      throw new OarError('ssh', `could not place the auth key on the VM: ${put.stderr.trim()}`)
  }
  log(
    `tailscale: joining as ${tsHost}${key ? '' : ' (no TS_AUTHKEY; only works if already joined)'}`,
  )
  const code = await ssh.interactive(
    ctx.exec,
    via,
    `OAR_TS_HOSTNAME=${sshAlias(repo)} OAR_TS_OPTIONAL=${key ? 0 : 1} bash /home/user/oar/setup/tailscale.sh`,
  )
  if (code !== 0) {
    log(
      `tailscale: join failed (exit ${code}); the VM stays reachable through boat's endpoint. A used-up or expired TS_AUTHKEY is the usual cause: generate a reusable key and re-run oar vm setup ${repo}`,
    )
    return
  }
  const ip = await runCommand(ctx.boat, id, 'tailscale ip -4', { timeoutSeconds: 30 }).catch(
    () => null,
  )
  await mutateState(ctx.paths, (s) => {
    requireVm(s, repo).tailscaleIp = ip?.stdout.trim() || undefined
  })
  const vm = requireVm(loadState(ctx.paths), repo)
  await refreshSsh(ctx, repo, vm, log)
}

/** Interactive `claude auth login` (and `codex login` with --codex) on the VM, then save the login so a resume keeps it. */
export async function vmLogin(
  ctx: Ctx,
  repo: string,
  opts: { codex?: boolean } = {},
): Promise<void> {
  const up = await ensureUp(ctx, repo, ctx.io.out)
  const via = reachableAlias(up.vm, repo)
  const cmd = opts.codex ? 'codex login' : 'claude auth login'
  ctx.io.out(`${cmd} on ${repo} (browser flow; paste the code back here)`)
  const code = await ssh.interactive(ctx.exec, via, `export PATH=$HOME/.local/bin:$PATH; ${cmd}`)
  if (code !== 0) throw new OarError('ssh', `${cmd} exited ${code}`)
  const saved = await ssh.remote(ctx.exec, via, '~/.local/bin/oar-creds save', 30_000)
  ctx.io.out(saved.stdout.trim() || 'nothing to save')
}

/** A desktop-stream URL for the VM: Moonlight by default (clipboard, 60 fps), noVNC with `vnc` (phones, bad networks). */
export async function vmDesktop(
  ctx: Ctx,
  repo: string,
  opts: { vnc?: boolean; isPublic?: boolean; open?: boolean } = {},
): Promise<string> {
  if (opts.isPublic && !opts.vnc) throw new OarError('usage', '--public only works with --vnc')
  const up = await ensureUp(ctx, repo, ctx.io.out)
  const sb = await ctx.boat.get(up.vm.sandboxId)
  if (sb.desktopAvailable === false)
    throw new OarError(
      'boat',
      `the desktop is not available on ${up.vm.sandboxId}`,
      'check the sandbox in the boat dashboard',
    )
  const d = await waitDesktop(ctx.boat, up.vm.sandboxId, {
    vnc: opts.vnc,
    publicAccess: opts.isPublic,
  })
  ctx.io.out(d.url!)
  ctx.io.out(
    opts.vnc
      ? `noVNC over HTTPS${opts.isPublic ? ', no token: anyone with the link can control the desktop' : ''}; link valid about 10 minutes`
      : 'Moonlight stream with clipboard; link valid about 10 minutes (use --vnc on a phone or a bad network)',
  )
  if (opts.open ?? ctx.io.isTTY) await ctx.exec.run('open', [d.url!]).catch(() => undefined)
  return d.url!
}

/** Chrome-only stream of the agent's profile. CLI-only in boat, so this prints the recipe and runs it when `boat` exists here. */
export async function vmBrowser(ctx: Ctx, repo: string): Promise<void> {
  const up = await ensureUp(ctx, repo, ctx.io.out)
  const id = up.vm.sandboxId
  const recipe = `boat browser ${id} --profile ${CHROME_PROFILE}`
  ctx.io.out(
    `agent Chrome is already visible in \`oar vm desktop ${repo}\`. For boat's Chrome-only stream:`,
  )
  ctx.io.out(
    `  oar vm ssh ${repo} -- sudo systemctl stop agent-chrome   # boat launches its own Chrome on the profile`,
  )
  ctx.io.out(`  ${recipe}`)
  ctx.io.out(`  oar vm ssh ${repo} -- sudo systemctl start agent-chrome  # afterwards`)
  if (!(await commandExists(ctx.exec, 'boat'))) return
  await runCommand(ctx.boat, id, 'sudo systemctl stop agent-chrome', { timeoutSeconds: 30 })
  try {
    await ctx.exec.interactive('boat', ['browser', id, '--profile', CHROME_PROFILE])
  } finally {
    await runCommand(ctx.boat, id, 'sudo systemctl start agent-chrome', {
      timeoutSeconds: 30,
    }).catch(() => undefined)
  }
}

/** Screenshot of the VM desktop (or one window), pulled to the Mac. */
export async function vmShot(
  ctx: Ctx,
  repo: string,
  opts: { out?: string; window?: string; open?: boolean } = {},
): Promise<string> {
  const up = await ensureUp(ctx, repo, ctx.io.out)
  const id = up.vm.sandboxId
  const r = await runCommand(ctx.boat, id, shotCommand(opts.window), { timeoutSeconds: 60 })
  if (r.exitCode !== 0)
    throw new OarError(
      'boat',
      `shot failed on the VM: ${(r.stderr || r.stdout).trim().split('\n').pop()}`,
      `oar vm setup ${repo} installs it`,
    )
  const bytes = await ctx.boat.readFileBytes(id, VM_SHOT_PATH)
  if (!bytes) throw new OarError('boat', `${VM_SHOT_PATH} was not written on the VM`)
  const stamp = new Date(ctx.now()).toISOString().replace(/[-:]/g, '').replace(/\..*/, '')
  const out = opts.out ?? join(ctx.paths.shotsDir, `${repo}-${stamp}.png`)
  mkdirSync(join(out, '..'), { recursive: true })
  writeFileSync(out, bytes)
  ctx.io.out(out)
  if (opts.open ?? ctx.io.isTTY) await ctx.exec.run('open', [out]).catch(() => undefined)
  return out
}

/** Private preview over the tailnet: https://oar-<repo>.<suffix> → 127.0.0.1:<port> on the VM. */
export async function vmServe(
  ctx: Ctx,
  repo: string,
  port: number,
  opts: { off?: boolean } = {},
): Promise<void> {
  const tsHost = tailnetHost(ctx.config, repo)
  if (!tsHost)
    throw new OarError(
      'config',
      'tailscale is not configured',
      'set tailscale.enabled and tailscale.suffix in ~/.config/oar/config.json',
    )
  const up = await ensureUp(ctx, repo, ctx.io.out)
  const cmd = opts.off ? 'sudo tailscale serve reset' : `sudo tailscale serve --bg ${port}`
  const r = await runCommand(ctx.boat, up.vm.sandboxId, cmd, { timeoutSeconds: 60 })
  if (r.exitCode !== 0)
    throw new OarError(
      'boat',
      `tailscale serve failed: ${(r.stderr || r.stdout).trim()}`,
      'HTTPS certificates must be enabled in the Tailscale admin console (DNS tab)',
    )
  ctx.io.out(
    opts.off
      ? `serve reset on ${repo}`
      : `https://${tsHost}  →  127.0.0.1:${port} on ${repo} (tailnet only; the service may bind localhost)`,
  )
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
  // Agents started by another host (the factory controller, or the Mac) are invisible in this
  // state file; ask the VM's Herdr before pulling the plug.
  if (!opts.forceTasks && vm.label) {
    const sb = await ctx.boat.get(vm.sandboxId).catch(() => null)
    if (sb && UP_STATES.has(sandboxState(sb))) {
      const agents = await new HerdrMachine(ctx.exec, vm.label).agents().catch(() => [])
      const busy = agents.filter(
        (a) => a.agent_status === 'working' || a.agent_status === 'blocked',
      )
      if (busy.length)
        throw new OarError(
          'usage',
          `${busy.length} agent(s) still ${busy.map((a) => `${a.name ?? a.pane_id}:${a.agent_status}`).join(', ')} on ${repo}`,
          'they may belong to the factory controller; pass --force-tasks to stop anyway',
        )
    }
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
