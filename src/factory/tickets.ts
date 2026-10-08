import { z } from 'zod'

/** The label that marks a plan (parent) issue: the controller records it but never builds it. */
export const SPEC_LABEL = 'spec'

const text = z.string().trim().min(1)

export const TicketSchema = z.object({
  /** Local name, used by `dependsOn` inside the file. */
  key: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'use lowercase letters, digits and dashes'),
  title: text.max(120),
  /** What is true when the ticket is done, in a sentence or two. */
  goal: text,
  /** "When …, I want …, so I can …" */
  jobs: z.array(text).min(1),
  /** Observable, testable behaviour. */
  functional: z.array(text).min(1),
  /** Security, privacy, performance, compatibility, observability, cost. */
  nonFunctional: z.array(text).min(1),
  scope: z.object({ in: z.array(text).min(1), out: z.array(text).default([]) }),
  /** Pointers found while planning: files, functions, tests, docs. */
  context: z.string().trim().optional(),
  /** Choices the human makes; the agent asks before acting on each. */
  decisions: z.array(text).default([]),
  /** The one check the human runs on staging (or in the app) to accept the work. */
  stagingCheck: text,
  dependsOn: z.array(z.string()).default([]),
  /** Linear priority: 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
  priority: z.number().int().min(0).max(4).optional(),
  labels: z.array(text).default([]),
})
export type Ticket = z.infer<typeof TicketSchema>

// Defaults are factories: zod would otherwise hand every parse the same (mutated) object.
const Created = z.object({
  plan: z.string().optional(),
  tickets: z.record(z.string(), z.string()).default(() => ({})),
  relations: z.array(z.string()).default(() => []),
  planListed: z.boolean().default(false),
})

export const PlanFileSchema = z
  .object({
    /** Linear team key, e.g. CNO. */
    team: z.string().regex(/^[A-Z][A-Z0-9]*$/, 'a Linear team key such as CNO'),
    /** The parent issue holding the whole plan; required when there is more than one ticket. */
    plan: z.object({ title: text.max(120), summary: text }).optional(),
    tickets: z.array(TicketSchema).min(1),
    /** Written by `oar ticket create`: what already exists in Linear, so a re-run resumes. */
    created: Created.default(() => ({ tickets: {}, relations: [], planListed: false })),
  })
  .superRefine((p, ctx) => {
    const keys = new Set<string>()
    for (const [i, t] of p.tickets.entries()) {
      if (keys.has(t.key))
        ctx.addIssue({
          code: 'custom',
          path: ['tickets', i, 'key'],
          message: `duplicate key ${t.key}`,
        })
      keys.add(t.key)
    }
    for (const [i, t] of p.tickets.entries())
      for (const d of t.dependsOn) {
        if (d === t.key)
          ctx.addIssue({
            code: 'custom',
            path: ['tickets', i, 'dependsOn'],
            message: 'a ticket cannot depend on itself',
          })
        else if (!keys.has(d))
          ctx.addIssue({
            code: 'custom',
            path: ['tickets', i, 'dependsOn'],
            message: `no ticket with key ${d}`,
          })
      }
    if (p.tickets.length > 1 && !p.plan)
      ctx.addIssue({
        code: 'custom',
        path: ['plan'],
        message: 'several tickets need a plan (title and summary)',
      })
  })
export type PlanFile = z.infer<typeof PlanFileSchema>

/** Tickets with every dependency before its dependants; file order otherwise. Throws on a cycle. */
export function orderTickets(tickets: Ticket[]): Ticket[] {
  const out: Ticket[] = []
  const done = new Set<string>()
  let left = [...tickets]
  while (left.length) {
    const ready = left.filter((t) => t.dependsOn.every((d) => done.has(d)))
    if (!ready.length)
      throw new Error(`dependency cycle among: ${left.map((t) => t.key).join(', ')}`)
    for (const t of ready) {
      out.push(t)
      done.add(t.key)
    }
    left = left.filter((t) => !done.has(t.key))
  }
  return out
}

export interface IssueRef {
  identifier: string
  title: string
}

const bullets = (items: string[], box = false) =>
  items.map((i) => `- ${box ? '[ ] ' : ''}${i}`).join('\n')

/** One ticket's Linear description, always in the same sections and order. */
export function renderTicket(
  t: Ticket,
  o: { deps?: IssueRef[]; plan?: IssueRef | null } = {},
): string {
  const parts = [
    `## Goal\n\n${t.goal}`,
    `## Jobs to be done\n\n${bullets(t.jobs)}`,
    `## Functional criteria\n\n${bullets(t.functional, true)}`,
    `## Non-functional criteria\n\n${bullets(t.nonFunctional, true)}`,
    `## Scope\n\n**In**\n\n${bullets(t.scope.in)}${t.scope.out.length ? `\n\n**Out**\n\n${bullets(t.scope.out)}` : ''}`,
  ]
  if (t.context) parts.push(`## Context\n\n${t.context}`)
  if (t.decisions.length)
    parts.push(
      `## Decisions to ask about\n\nAsk on this issue before acting on any of these:\n\n${bullets(t.decisions)}`,
    )
  parts.push(`## Staging check\n\n${t.stagingCheck}`)
  if (o.deps?.length)
    parts.push(`## Depends on\n\n${bullets(o.deps.map((d) => `${d.identifier} ${d.title}`))}`)
  if (o.plan) parts.push(`---\n\nPart of ${o.plan.identifier}: ${o.plan.title}.`)
  return `${parts.join('\n\n')}\n`
}

/** The plan issue: the summary, then the tickets in build order once they exist. */
export function renderPlan(
  plan: { title: string; summary: string },
  tickets: Array<IssueRef & { after: string[] }>,
): string {
  const parts = [plan.summary]
  if (tickets.length)
    parts.push(
      `## Tickets\n\n${tickets
        .map(
          (t, i) =>
            `${i + 1}. ${t.identifier} ${t.title}${t.after.length ? ` (after ${t.after.join(', ')})` : ''}`,
        )
        .join('\n')}`,
    )
  parts.push(
    `---\n\nThis is a plan issue (label \`${SPEC_LABEL}\`): the factory never builds it. Move its tickets to Todo; a ticket waits until the tickets it depends on are done.`,
  )
  return `${parts.join('\n\n')}\n`
}

/** A minimal, valid plan file for the skill and `oar ticket example`. */
export const EXAMPLE_PLAN: z.input<typeof PlanFileSchema> = {
  team: 'CNO',
  plan: {
    title: 'Trace CNO requests end to end',
    summary:
      'Support questions cannot be tied to log lines today. Give every response a request id, then log slow requests with it.',
  },
  tickets: [
    {
      key: 'request-id',
      title: 'Return an X-Request-ID header on every API response',
      goal: 'Every response carries an X-Request-ID that also appears in the request log lines.',
      jobs: [
        'When a CNO client reports a failed call, I want to quote one id, so I can find its log lines.',
      ],
      functional: [
        'A safe client value (1 to 128 of letters, digits, -, _, .) is echoed unchanged.',
        'A missing or unsafe value is replaced by a new UUID4.',
        'The request log lines carry the same id.',
      ],
      nonFunctional: [
        'Unvetted client text never reaches headers or logs.',
        'No measurable latency added (one regex and one UUID per request).',
      ],
      scope: {
        in: ['nodes/core/middleware/', 'config/settings/base.py'],
        out: ['nginx configuration'],
      },
      context: 'LoggingMiddleware in nodes/core/middleware/logging.py already logs REQ/RESP lines.',
      decisions: [],
      stagingCheck:
        "curl -sI -H 'X-Request-ID: t1' https://staging.api.cno.nodes.inc/swagger.json shows X-Request-ID: t1",
      dependsOn: [],
    },
    {
      key: 'slow-requests',
      title: 'Log slow CNO API requests',
      goal: 'Requests slower than a threshold are logged as warnings with their request id.',
      jobs: [
        'When staging feels slow, I want the slow requests listed, so I can see which endpoint to fix.',
      ],
      functional: [
        'A request over the threshold logs one warning with request id, method, path and duration.',
      ],
      nonFunctional: [
        'Paths that carry capabilities are logged the way LoggingMiddleware already redacts them.',
      ],
      scope: { in: ['nodes/core/middleware/logging.py'], out: [] },
      decisions: ['The threshold: 500 ms, 1 s or 2 s.'],
      stagingCheck:
        'A deliberately slow staging request shows one warning line with its X-Request-ID.',
      dependsOn: ['request-id'],
    },
  ],
}
