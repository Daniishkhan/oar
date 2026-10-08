import type { Ctx } from '../context.js'
import { usage } from '../errors.js'
import { LinearClient, type TokenRecord } from '../factory/linear.js'
import { linearAuth } from '../factory/loop.js'
import { publicationSource, publishPlan, readPlanFile } from '../factory/publication.js'
export { readPlanFile } from '../factory/publication.js'
import {
  EXAMPLE_PLAN,
  orderTickets,
  renderPlan,
  renderTicket,
  SPEC_LABEL,
  type IssueRef,
  type PlanFile,
  type PublicationContext,
} from '../factory/tickets.js'

/** The Linear client as the "oar" app, with the token kept in memory for this run. */
export function ticketLinear(ctx: Ctx): LinearClient {
  let token: TokenRecord | null = null
  return new LinearClient({
    auth: linearAuth(ctx),
    store: { get: () => token, set: (t) => (token = t) },
    now: ctx.now,
  })
}

/** Show what `create` would make, without touching Linear. */
export function ticketDryRun(ctx: Ctx, plan: PlanFile, publication?: PublicationContext): void {
  const out = ctx.io.out
  const order = orderTickets(plan.tickets)
  const ref = (key: string): IssueRef => {
    const t = plan.tickets.find((x) => x.key === key)!
    return { identifier: plan.created.tickets[key] ?? `<${key}>`, title: t.title }
  }
  const planRef = plan.plan
    ? { identifier: plan.created.plan ?? '<plan>', title: plan.plan.title }
    : null
  if (plan.plan) {
    out(`=== ${planRef!.identifier} [${SPEC_LABEL}] ${plan.plan.title}`)
    out(
      renderPlan(
        plan.plan,
        order.map((t) => ({ ...ref(t.key), after: t.dependsOn.map((d) => ref(d).identifier) })),
        publication,
      ),
    )
  }
  for (const t of order) {
    out(
      `=== ${ref(t.key).identifier} ${t.title}${plan.created.tickets[t.key] ? ' (already created)' : ''}`,
    )
    out(
      renderTicket(t, {
        deps: t.dependsOn.map(ref),
        plan: planRef,
        ...(publication ? { publication: { ...publication, taskKey: t.key } } : {}),
      }),
    )
  }
  out(
    `${order.length} ticket(s)${plan.plan ? ' under one plan issue' : ''} for team ${plan.team}, created in Backlog. Nothing was sent to Linear.`,
  )
}

/** CLI presentation around the reusable, crash-recoverable publisher. */
export async function ticketCreate(
  ctx: Ctx,
  path: string,
  _plan: PlanFile,
  linear: LinearClient,
): Promise<void> {
  const out = ctx.io.out
  const plan = readPlanFile(path)
  if (!ctx.config.factory.linear.teams[plan.team])
    out(
      `note: team ${plan.team} is not in factory.linear.teams, so the controller will not build these tickets`,
    )
  const result = await publishPlan({ path, linear, now: ctx.now, notice: out })
  if (result.parent) {
    const p = result.parent
    out(`${p.identifier}  [${SPEC_LABEL}] ${p.title}  ${p.url}`)
  }
  for (const t of result.tickets)
    out(
      `${t.identifier}  ${t.title}${t.after.length ? `  (after ${t.after.join(', ')})` : ''}  ${t.url}`,
    )
  out(`Publication ${result.publicationId} · snapshot ${result.contentHash}`)
  out(
    `In Backlog. Move tickets to ${ctx.config.factory.linear.states.ready} to build them; never the plan issue.`,
  )
}

export async function ticketCmd(ctx: Ctx, args: string[]): Promise<number> {
  const [sub, ...rest] = args
  switch (sub) {
    case 'example':
      ctx.io.out(JSON.stringify(EXAMPLE_PLAN, null, 2))
      return 0
    case 'check':
    case 'create': {
      const dry = rest.includes('--dry-run') || sub === 'check'
      const path = rest.find((a) => !a.startsWith('--'))
      if (!path)
        throw usage(`oar ticket ${sub} <plan.json>${sub === 'create' ? ' [--dry-run]' : ''}`)
      const plan = readPlanFile(path)
      const source = publicationSource(path, plan)
      if (dry) {
        ticketDryRun(ctx, plan, { id: plan.publication?.id ?? '<new publication>', ...source })
        return 0
      }
      await ticketCreate(ctx, path, plan, ticketLinear(ctx))
      return 0
    }
    default:
      throw usage(
        `oar ticket ${sub ?? ''}: unknown subcommand`,
        'oar ticket example | check <file> | create <file> [--dry-run]',
      )
  }
}
