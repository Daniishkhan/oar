import { existsSync, statSync } from 'node:fs'
import { runCommand, sandboxState } from '../boat.js'
import { loadSecrets, repoConfig, sshAlias } from '../config.js'
import type { Ctx } from '../context.js'
import { commandExists } from '../exec.js'
import { macGhOk } from '../github.js'
import { HerdrMachine, localHerdr } from '../herdr.js'
import { loadState, UP_STATES } from '../state.js'

interface Check {
  name: string
  ok: boolean
  detail: string
}

export async function doctor(
  ctx: Ctx,
  opts: { repo?: string; quiet?: boolean } = {},
): Promise<boolean> {
  const checks: Check[] = []
  const push = (name: string, ok: boolean, detail = '') => checks.push({ name, ok, detail })

  // Mac side
  try {
    loadSecrets(ctx.paths)
    const mode = statSync(ctx.paths.envFile).mode & 0o777
    push(
      'boat api key',
      true,
      mode === 0o600
        ? ctx.paths.envFile
        : `${ctx.paths.envFile} has mode ${mode.toString(8)}; chmod 600 it`,
    )
  } catch (e) {
    push('boat api key', false, (e as Error).message)
  }
  push(
    'ssh key',
    existsSync(ctx.paths.pubFile),
    existsSync(ctx.paths.pubFile) ? ctx.paths.pubFile : 'created on first vm up',
  )
  push('herdr on Mac', await localHerdr.installed(ctx.exec), '')
  push(
    'gh on Mac',
    await macGhOk(ctx.exec),
    'gh auth refresh -h github.com -s repo,workflow (VM gh is used as fallback)',
  )
  push('osascript', await commandExists(ctx.exec, 'osascript'), 'notifications')

  // boat side
  let envs: Array<{ name: string }> = []
  try {
    envs = await ctx.boat.environments()
    push('boat api', true, `${envs.length} environment(s): ${envs.map((e) => e.name).join(', ')}`)
  } catch (e) {
    push('boat api', false, (e as Error).message)
  }

  const repos = opts.repo ? [opts.repo] : Object.keys(ctx.config.repos)
  const state = loadState(ctx.paths)
  const machines = await localHerdr.machines(ctx.exec)
  for (const name of repos) {
    const cfg = repoConfig(ctx.config, name)
    push(
      `${name}: boat env '${cfg.envName}'`,
      envs.some((e) => e.name === cfg.envName),
      'oar vm new creates sandboxes from it',
    )
    const vm = state.vms[name]
    if (!vm) {
      push(`${name}: VM`, false, `oar vm new ${name}`)
      continue
    }
    const sb = await ctx.boat.get(vm.sandboxId).catch(() => null)
    const st = sb ? sandboxState(sb) : 'unreachable'
    push(`${name}: VM ${vm.sandboxId}`, Boolean(sb), st)
    const profiles = machines.filter((m) => m.label === cfg.herdrLabel)
    push(
      `${name}: herdr machine '${cfg.herdrLabel}'`,
      profiles.length === 1,
      profiles.length > 1
        ? `${profiles.length} profiles share this label, so herdr --machine refuses it: herdr machine remove ${profiles
            .slice(1)
            .map((m) => m.id)
            .join(' ')}`
        : `herdr machine add ${sshAlias(name)} --label ${cfg.herdrLabel}`,
    )
    if (sb && UP_STATES.has(st as never)) {
      const reach = await new HerdrMachine(ctx.exec, cfg.herdrLabel).reachable()
      push(`${name}: herdr server`, reach, reach ? 'reachable' : `oar vm up ${name} repairs it`)
      const login = await runCommand(
        ctx.boat,
        vm.sandboxId,
        'test -s ~/.claude/.credentials.json && claude auth status 2>/dev/null | head -c 300',
        { timeoutSeconds: 60 },
      ).catch(() => null)
      const ok = Boolean(
        login && login.exitCode === 0 && /loggedIn"?\s*:\s*true|claude\.ai/.test(login.stdout),
      )
      push(
        `${name}: claude login on VM`,
        ok,
        ok ? 'claude.ai' : `oar vm ssh ${name} -- claude auth login`,
      )
      const codex = await runCommand(ctx.boat, vm.sandboxId, 'codex login status 2>&1 | head -1', {
        timeoutSeconds: 60,
      }).catch(() => null)
      const codexOk = Boolean(codex && /logged in/i.test(codex.stdout))
      push(
        `${name}: codex login on VM`,
        codexOk,
        codexOk
          ? codex!.stdout.trim()
          : `scp ~/.codex/auth.json ${sshAlias(name)}:~/.codex/auth.json`,
      )
      const repoDir = await runCommand(
        ctx.boat,
        vm.sandboxId,
        `test -d ${cfg.vmPath}/.git && echo ok`,
        { timeoutSeconds: 30 },
      ).catch(() => null)
      push(
        `${name}: clone at ${cfg.vmPath}`,
        Boolean(repoDir && repoDir.stdout.includes('ok')),
        'attach the repo to the boat environment',
      )
    }
  }

  const allOk = checks.every((c) => c.ok)
  if (!opts.quiet || !allOk) {
    for (const c of checks)
      ctx.io.out(`${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? `  ${c.detail}` : ''}`)
  }
  if (opts.quiet && allOk) ctx.io.out('ok')
  return allOk
}
