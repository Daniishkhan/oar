import { ensureDeadline, sandboxState } from '../boat.js'
import type { Ctx } from '../context.js'
import { notify } from '../notify.js'
import {
  loadState,
  mutateState,
  requireVm,
  LIVE_STATUSES,
  UP_STATES,
  type Task,
  type TaskStatus,
} from '../state.js'
import { formatDuration, hoursFromNow, minutes, nowIso, sleep, startOfTodayIso } from '../time.js'
import { observeTask } from './task.js'

const NOTIFY_ON: ReadonlySet<TaskStatus> = new Set([
  'blocked',
  'done',
  'done-no-pr',
  'stalled',
  'exited',
  'suspended',
])

const titleFor = (t: Task, status: TaskStatus) =>
  ({
    blocked: `${t.id} needs you`,
    done: `${t.id} done`,
    'done-no-pr': `${t.id} finished without a PR`,
    stalled: `${t.id} stopped working`,
    exited: `${t.id} agent exited`,
    suspended: `${t.id} suspended (VM stopped)`,
  })[status as 'blocked'] ?? `${t.id} ${status}`

export interface WatchOptions {
  untilIdle?: boolean
  /** Test hook: stop after N ticks. */
  maxTicks?: number
}

/** The notification loop. Runs in a Herdr pane on the Mac; `ctrl+c` stops it. */
export async function watch(ctx: Ctx, opts: WatchOptions = {}): Promise<void> {
  const { pollSeconds, autoKeep } = ctx.config.defaults
  let tick = 0
  let failures = 0
  for (;;) {
    tick++
    const state = loadState(ctx.paths)
    const live = Object.values(state.tasks).filter((t) => LIVE_STATUSES.has(t.status))
    if (!live.length && opts.untilIdle) {
      ctx.io.out('no live tasks; exiting')
      return
    }
    try {
      const repos = new Set(live.map((t) => t.repo))
      for (const repo of repos) {
        const vm = requireVm(state, repo)
        const sb = await ctx.boat.get(vm.sandboxId)
        const st = sandboxState(sb)
        const mine = live.filter((t) => t.repo === repo)
        if (!UP_STATES.has(st)) {
          await mutateState(ctx.paths, (s) => {
            for (const t of mine) s.tasks[t.id]!.status = 'suspended'
            requireVm(s, repo).lastSeenState = st
          })
          for (const t of mine)
            await announce(
              ctx,
              t,
              'suspended',
              `VM ${repo} is ${st}. oar vm up ${repo} resumes it and the task.`,
            )
          continue
        }
        for (const t of mine) {
          const o = await observeTask(ctx, t)
          if (o.status !== t.status && NOTIFY_ON.has(o.status)) {
            const body =
              o.status === 'done' && o.pr
                ? o.pr.url
                : o.status === 'blocked'
                  ? `oar task read ${t.id} --lines 40`
                  : `oar task status ${t.id}`
            await announce(ctx, o.task, o.status, body)
          }
        }
        if (autoKeep.enabled && sb.archiveAfter) {
          const left = sb.archiveAfter.getTime() - ctx.now()
          const working = mine.filter((t) =>
            ['working', 'dispatched', 'blocked'].includes(
              loadState(ctx.paths).tasks[t.id]?.status ?? '',
            ),
          )
          if (left < minutes(autoKeep.leadMinutes) && working.length) {
            const budget = Math.max(
              ...working.map(
                (t) => Date.parse(t.dispatchedAt ?? t.createdAt) + t.hours * 3_600_000,
              ),
            )
            const wanted = Math.min(hoursFromNow(autoKeep.extendHours, ctx.now()).getTime(), budget)
            if (wanted > sb.archiveAfter.getTime() + 60_000) {
              const after = await ensureDeadline(ctx.boat, vm.sandboxId, new Date(wanted), {
                log: ctx.io.out,
                now: ctx.now,
              })
              ctx.io.out(
                `${nowIso()} auto-keep ${repo}: now stops in ${formatDuration((after?.getTime() ?? wanted) - ctx.now())}`,
              )
            } else {
              const key = `budget:${repo}`
              const already = working.some(
                (t) => loadState(ctx.paths).tasks[t.id]?.lastNotified?.status === key,
              )
              if (!already) {
                await notify(ctx.exec, {
                  title: `${repo} VM stops in ${formatDuration(left)}`,
                  body: `task budget used; oar vm keep ${repo} N to extend`,
                  sound: 'request',
                })
                await mutateState(ctx.paths, (s) => {
                  for (const t of working)
                    s.tasks[t.id]!.lastNotified = { status: key, at: nowIso() }
                })
              }
            }
          }
        }
        if (tick % 10 === 1) {
          const u = await ctx.boat.usage(vm.sandboxId, startOfTodayIso()).catch(() => null)
          if (u)
            ctx.io.out(
              `${nowIso()} ${repo}: $${u.dollars.toFixed(2)} today, ${live.filter((t) => t.repo === repo).length} live task(s)`,
            )
        }
      }
      failures = 0
    } catch (e) {
      failures++
      if (failures === 1 || failures % 10 === 0)
        ctx.io.err(
          `${nowIso()} watch: ${(e as Error).message}${failures > 1 ? ` (x${failures})` : ''}`,
        )
    }
    if (opts.maxTicks && tick >= opts.maxTicks) return
    const base = failures >= 3 ? 120 : pollSeconds
    await sleep((base + Math.round(Math.random() * 10 - 5)) * 1000)
  }
}

async function announce(ctx: Ctx, t: Task, status: TaskStatus, body: string): Promise<void> {
  const current = loadState(ctx.paths).tasks[t.id]
  if (current?.lastNotified?.status === status) return
  await notify(ctx.exec, {
    title: titleFor(t, status),
    body,
    sound: status === 'blocked' || status === 'suspended' ? 'request' : 'done',
  })
  ctx.io.out(`${nowIso()} ${titleFor(t, status)}: ${body}`)
  await mutateState(ctx.paths, (s) => {
    const rec = s.tasks[t.id]
    if (rec) rec.lastNotified = { status, at: nowIso() }
  })
}
