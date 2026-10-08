import { readFileSync, writeFileSync } from 'node:fs'
import type { Ctx } from '../context.js'
import { OarError, usage } from '../errors.js'
import { LinearClient, type TokenRecord } from '../factory/linear.js'
import { linearAuth } from '../factory/loop.js'
import {
  EXAMPLE_PLAN,
  orderTickets,
  PlanFileSchema,
  renderPlan,
  renderTicket,
  SPEC_LABEL,
  type IssueRef,
  type PlanFile,
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

/** Read and validate a plan file; the error names every problem with its path. */
export function readPlanFile(path: string): PlanFile {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    throw usage(`cannot read ${path} as JSON: ${(e as Error).message}`)
  }
  const parsed = PlanFileSchema.safeParse(raw)
  if (!parsed.success)
    throw usage(
      `${path} is not a valid plan:\n${parsed.error.issues.map((i) => `  ${i.path.join('.') || '(file)'}: ${i.message}`).join('\n')}`,
      'oar ticket example prints a valid file',
    )
  try {
    orderTickets(parsed.data.tickets)
  } catch (e) {
    throw usage(`${path}: ${(e as Error).message}`)
  }
  return parsed.data
}

/** Show what `create` would make, without touching Linear. */
export function ticketDryRun(ctx: Ctx, plan: PlanFile): void {
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
      ),
    )
  }
  for (const t of order) {
    out(
      `=== ${ref(t.key).identifier} ${t.title}${plan.created.tickets[t.key] ? ' (already created)' : ''}`,
    )
    out(renderTicket(t, { deps: t.dependsOn.map(ref), plan: planRef }))
  }
  out(
    `${order.length} ticket(s)${plan.plan ? ' under one plan issue' : ''} for team ${plan.team}, created in Backlog. Nothing was sent to Linear.`,
  )
}

/**
 * Create the plan issue and its tickets in the team's Backlog, then the "blocked by" links.
 * Every created id is written back to the file at once, so a failed run resumes without duplicates.
 */
export async function ticketCreate(
  ctx: Ctx,
  path: string,
  plan: PlanFile,
  linear: LinearClient,
): Promise<void> {
  const out = ctx.io.out
  const save = () => writeFileSync(path, `${JSON.stringify(plan, null, 2)}\n`)
  const [team] = await linear.teams([plan.team])
  if (!team) throw new OarError('config', `Linear team ${plan.team} not found`)
  if (!ctx.config.factory.linear.teams[plan.team])
    out(
      `note: team ${plan.team} is not in factory.linear.teams, so the controller will not build these tickets`,
    )
  const states = await linear.states(team.id)
  const backlog =
    states.find((s) => s.type === 'backlog' && s.name === 'Backlog') ??
    states.find((s) => s.type === 'backlog')
  if (!backlog) throw new OarError('config', `team ${plan.team} has no backlog state`)

  const order = orderTickets(plan.tickets)
  let parent: { id: string; identifier: string; title: string; url: string } | null = null
  if (plan.plan) {
    if (plan.created.plan) {
      const p = await linear.issue(plan.created.plan)
      if (!p)
        throw new OarError(
          'state_invalid',
          `${plan.created.plan} (the plan issue) no longer exists`,
        )
      parent = { id: p.id, identifier: p.identifier, title: p.title, url: p.url }
    } else {
      const spec = await linear.labelId(team.id, SPEC_LABEL)
      if (!spec)
        out(
          `note: no "${SPEC_LABEL}" label in Linear and the app may not create one; create it once in Linear's label settings. The plan issue is still never built, because it has sub-issues.`,
        )
      const created = await linear.createIssue({
        teamId: team.id,
        title: plan.plan.title,
        description: renderPlan(plan.plan, []),
        stateId: backlog.id,
        ...(spec ? { labelIds: [spec] } : {}),
      })
      parent = { ...created, title: plan.plan.title }
      plan.created.plan = created.identifier
      save()
    }
  }

  const made = new Map<string, { id: string; identifier: string; title: string; url: string }>()
  for (const t of order) {
    const existing = plan.created.tickets[t.key]
    if (existing) {
      const i = await linear.issue(existing)
      if (!i) throw new OarError('state_invalid', `${existing} (ticket ${t.key}) no longer exists`)
      made.set(t.key, { id: i.id, identifier: i.identifier, title: i.title, url: i.url })
      continue
    }
    const labelIds: string[] = []
    for (const name of t.labels) {
      const id = await linear.labelId(team.id, name)
      if (id) labelIds.push(id)
      else
        out(
          `note: label "${name}" does not exist and the app may not create it; ${t.key} is created without it`,
        )
    }
    const created = await linear.createIssue({
      teamId: team.id,
      title: t.title,
      description: renderTicket(t, {
        deps: t.dependsOn.map((d) => made.get(d)!),
        plan: parent,
      }),
      stateId: backlog.id,
      ...(parent ? { parentId: parent.id } : {}),
      ...(labelIds.length ? { labelIds } : {}),
      ...(t.priority !== undefined ? { priority: t.priority } : {}),
    })
    made.set(t.key, { ...created, title: t.title })
    plan.created.tickets[t.key] = created.identifier
    save()
  }

  for (const t of order)
    for (const d of t.dependsOn) {
      const tag = `${d}>${t.key}`
      if (plan.created.relations.includes(tag)) continue
      await linear.createRelation({
        issueId: made.get(d)!.id,
        relatedIssueId: made.get(t.key)!.id,
        type: 'blocks',
      })
      plan.created.relations.push(tag)
      save()
    }

  if (parent && plan.plan && !plan.created.planListed) {
    await linear.updateIssue(parent.id, {
      description: renderPlan(
        plan.plan,
        order.map((t) => ({
          identifier: made.get(t.key)!.identifier,
          title: t.title,
          after: t.dependsOn.map((d) => made.get(d)!.identifier),
        })),
      ),
    })
    plan.created.planListed = true
    save()
  }

  if (parent) out(`${parent.identifier}  [${SPEC_LABEL}] ${parent.title}  ${parent.url}`)
  for (const t of order) {
    const m = made.get(t.key)!
    const after = t.dependsOn.map((d) => made.get(d)!.identifier)
    out(
      `${m.identifier}  ${m.title}${after.length ? `  (after ${after.join(', ')})` : ''}  ${m.url}`,
    )
  }
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
      if (dry) {
        ticketDryRun(ctx, plan)
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
