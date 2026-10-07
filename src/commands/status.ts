import { sandboxState } from '../boat.js'
import { sshAlias } from '../config.js'
import type { Ctx } from '../context.js'
import { loadState, LIVE_STATUSES } from '../state.js'
import { startOfTodayIso, stopsIn } from '../time.js'
import { observeTask } from './task.js'

/** One screen: every VM with its deadline and spend, every non-closed task with its live state. */
export async function status(ctx: Ctx, opts: { all?: boolean } = {}): Promise<void> {
  const state = loadState(ctx.paths)
  const out = ctx.io.out
  out('VMs')
  for (const name of Object.keys(ctx.config.repos)) {
    const vm = state.vms[name]
    if (!vm) {
      out(`  ${name.padEnd(7)} (none)`)
      continue
    }
    const sb = await ctx.boat.get(vm.sandboxId).catch(() => null)
    if (!sb) {
      out(`  ${name.padEnd(7)} ${vm.sandboxId}  unreachable`)
      continue
    }
    const st = sandboxState(sb)
    const spend = await ctx.boat
      .usage(vm.sandboxId, startOfTodayIso())
      .then((u) => `$${u.dollars.toFixed(2)} today`)
      .catch(() => '')
    const deadline = stopsIn(sb.archiveAfter, ctx.now())
    const warn =
      sb.archiveAfter && sb.archiveAfter.getTime() - ctx.now() < 3_600_000 && st !== 'archived'
        ? '  ← under 1h'
        : ''
    out(
      `  ${name.padEnd(7)} ${vm.sandboxId}  ${st.padEnd(11)} ${deadline.padEnd(22)} ${spend.padEnd(14)} ssh ${sshAlias(name)}${warn}`,
    )
  }
  const tasks = Object.values(state.tasks).filter((t) => opts.all || t.status !== 'closed')
  out('')
  out(tasks.length ? 'Tasks' : 'Tasks: none')
  for (const t of tasks.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (LIVE_STATUSES.has(t.status) || t.status === 'suspended') {
      const o = await observeTask(ctx, t).catch(() => null)
      const live = o
        ? `${o.status.padEnd(11)} agent:${String(o.agent).padEnd(8)}`
        : `${t.status.padEnd(11)} (unobservable)`
      const pr = o?.pr ? o.pr.url : (t.pr?.url ?? '')
      out(`  ${t.id.padEnd(32)} ${t.repo.padEnd(7)} ${live} ${pr}`)
    } else {
      out(`  ${t.id.padEnd(32)} ${t.repo.padEnd(7)} ${t.status.padEnd(11)} ${t.pr?.url ?? ''}`)
    }
  }
}
