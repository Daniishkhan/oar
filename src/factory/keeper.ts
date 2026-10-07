import { ensureDeadline, sandboxState } from '../boat.js'
import { reachableAlias, vmStop } from '../commands/vm.js'
import type { Ctx } from '../context.js'
import { HerdrMachine } from '../herdr.js'
import * as ssh from '../ssh.js'
import { loadState, UP_STATES, type VmRecord } from '../state.js'
import { hoursFromNow, minutes } from '../time.js'
import type { FactoryDb } from './db.js'
import type { Jobs } from './jobs.js'
import { HOLDING_PHASES } from './types.js'

export interface KeeperDeps {
  db: FactoryDb
  jobs: Jobs
  log: (line: string) => void
  /** repo → when it was first seen idle. */
  idleSince: Map<string, number>
}

/** A question waiting for an answer keeps the agent's context alive; the VM stays up with it. */
const HOLDING = new Set<string>([...HOLDING_PHASES, 'needs_input'])

/** Why the VM must not be stopped right now, or null when nobody is using it. */
export async function busyOn(ctx: Ctx, vm: VmRecord, repo: string): Promise<string | null> {
  const agents = await new HerdrMachine(ctx.exec, vm.label).agents().catch(() => null)
  if (agents === null) return 'herdr not reachable (assumed busy)'
  const busy = agents.filter((a) => a.agent_status === 'working' || a.agent_status === 'blocked')
  if (busy.length) return `${busy.length} agent(s) ${busy.map((a) => a.agent_status).join('/')}`
  // pty sessions: a human attached with ssh or `herdr --remote` (Herdr's own forwarding has none).
  const who = await ssh
    .remote(ctx.exec, reachableAlias(vm, repo), 'who | wc -l', 20_000)
    .catch(() => null)
  if (!who || who.code !== 0) return 'ssh probe failed (assumed busy)'
  return Number(who.stdout.trim()) > 0 ? 'a terminal session is open' : null
}

/** Extend worker VMs that hold factory work; stop the ones nobody has used for a while. */
export async function keepWorkers(ctx: Ctx, deps: KeeperDeps): Promise<void> {
  const { autoKeep } = ctx.config.defaults
  const idleStopMs = minutes(ctx.config.factory.idleStopMinutes)
  const state = loadState(ctx.paths)
  for (const repo of Object.keys(ctx.config.repos)) {
    const vm = state.vms[repo]
    if (!vm) continue
    const sb = await ctx.boat.get(vm.sandboxId).catch(() => null)
    if (!sb || !UP_STATES.has(sandboxState(sb))) {
      deps.idleSince.delete(repo)
      continue
    }
    if (deps.db.countInPhases(repo, HOLDING) > 0 || deps.jobs.count(repo) > 0) {
      deps.idleSince.delete(repo)
      if (
        sb.archiveAfter &&
        sb.archiveAfter.getTime() - ctx.now() < minutes(autoKeep.leadMinutes)
      ) {
        const wanted = hoursFromNow(autoKeep.extendHours, ctx.now())
        await deps.jobs
          .withLock(repo, () =>
            ensureDeadline(ctx.boat, vm.sandboxId, wanted, { log: deps.log, now: ctx.now }),
          )
          .then(
            (after) =>
              deps.db.event('vm-extended', `${repo} until ${after?.toISOString() ?? 'never'}`),
            (e: Error) => deps.log(`keeper: could not extend ${repo}: ${e.message}`),
          )
      }
      continue
    }
    const why = await busyOn(ctx, vm, repo)
    if (why) {
      deps.idleSince.delete(repo)
      continue
    }
    const since = deps.idleSince.get(repo) ?? ctx.now()
    deps.idleSince.set(repo, since)
    if (ctx.now() - since < idleStopMs) continue
    await deps.jobs
      .withLock(repo, () => vmStop(ctx, repo))
      .then(
        () => {
          deps.db.event('vm-stopped', `${repo} idle ${Math.round(idleStopMs / 60_000)} min`)
          deps.idleSince.delete(repo)
        },
        (e: Error) => deps.log(`keeper: did not stop ${repo}: ${e.message}`),
      )
  }
}

/** The controller itself never auto-stops; if boat refuses that, push its own deadline a day out. */
export async function keepSelf(ctx: Ctx, deps: Pick<KeeperDeps, 'log'>): Promise<void> {
  const id = ctx.config.factory.controller.sandboxId
  if (!id) return
  const sb = await ctx.boat.get(id).catch(() => null)
  if (!sb || sb.archiveAfter === null || sb.archiveAfter === undefined) return
  const after = await ctx.boat
    .update(id, { ttlSeconds: null })
    .then((s) => s.archiveAfter ?? null)
    .catch(() => sb.archiveAfter ?? null)
  if (!after) {
    deps.log('controller: auto-stop disabled')
    return
  }
  await ensureDeadline(ctx.boat, id, hoursFromNow(24, ctx.now()), { log: deps.log, now: ctx.now })
    .then(() => deps.log('controller: no-auto-stop was refused; deadline pushed 24 h'))
    .catch((e: Error) => deps.log(`controller: could not extend itself: ${e.message}`))
}
