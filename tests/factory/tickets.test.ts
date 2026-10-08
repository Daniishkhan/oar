import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readPlanFile, ticketCreate, ticketDryRun } from '../../src/commands/ticket.js'
import type { LinearClient } from '../../src/factory/linear.js'
import {
  EXAMPLE_PLAN,
  orderTickets,
  PlanFileSchema,
  renderPlan,
  renderTicket,
  TicketSchema,
  type Ticket,
} from '../../src/factory/tickets.js'
import { world } from '../helpers.js'

const ticket = (over: Partial<Ticket> = {}): Ticket =>
  TicketSchemaParse({
    key: 'a',
    title: 'Do A',
    goal: 'A is done.',
    jobs: ['When x, I want y, so I can z.'],
    functional: ['f1'],
    nonFunctional: ['n1'],
    scope: { in: ['src/a.ts'] },
    stagingCheck: 'curl it',
    ...over,
  })
function TicketSchemaParse(t: unknown): Ticket {
  return TicketSchema.parse(t)
}

/** Linear as `oar ticket create` uses it; records every write. */
class FakeLinear {
  calls: string[] = []
  issues = new Map<
    string,
    { id: string; identifier: string; title: string; url: string; description: string }
  >()
  private n = 0
  failOnCreate: string | null = null
  async teams(keys: string[]) {
    return keys.includes('CNO') ? [{ id: 'team-cno', key: 'CNO', name: 'CNO' }] : []
  }
  async states() {
    return [
      { id: 'st-todo', name: 'Todo', type: 'unstarted', position: 1, teamId: 'team-cno' },
      { id: 'st-backlog', name: 'Backlog', type: 'backlog', position: 0, teamId: 'team-cno' },
    ]
  }
  labels = new Set(['spec'])
  async labelId(_team: string, name: string) {
    this.calls.push(`label ${name}`)
    return this.labels.has(name) ? `label-${name}` : null
  }
  async createIssue(input: {
    title: string
    description: string
    stateId?: string
    parentId?: string
    labelIds?: string[]
  }) {
    if (this.failOnCreate === input.title) throw new Error('boom')
    const identifier = `CNO-${++this.n}`
    const issue = {
      id: `id-${identifier}`,
      identifier,
      title: input.title,
      url: `https://linear.app/x/${identifier}`,
      description: input.description,
    }
    this.issues.set(identifier, issue)
    this.calls.push(
      `create ${identifier} ${input.title} state=${input.stateId} parent=${input.parentId ?? '-'} labels=${(input.labelIds ?? []).join(',') || '-'}`,
    )
    return issue
  }
  async issue(identifier: string) {
    const i = this.issues.get(identifier)
    return i ? { ...i, parentId: null } : null
  }
  async createRelation(input: { issueId: string; relatedIssueId: string; type: string }) {
    this.calls.push(`relate ${input.issueId} ${input.type} ${input.relatedIssueId}`)
  }
  async updateIssue(id: string, input: { description?: string }) {
    this.calls.push(`update ${id}`)
    const i = [...this.issues.values()].find((x) => x.id === id)
    if (i && input.description) i.description = input.description
  }
}

describe('plan files', () => {
  it('accepts the shipped example and orders tickets by dependency', () => {
    const plan = PlanFileSchema.parse(EXAMPLE_PLAN)
    expect(orderTickets(plan.tickets).map((t) => t.key)).toEqual(['request-id', 'slow-requests'])
    const swapped = { ...EXAMPLE_PLAN, tickets: [...EXAMPLE_PLAN.tickets].reverse() }
    expect(orderTickets(PlanFileSchema.parse(swapped).tickets).map((t) => t.key)).toEqual([
      'request-id',
      'slow-requests',
    ])
  })

  it('names every missing section first, then the cross-ticket problems', () => {
    const missing = PlanFileSchema.safeParse({
      team: 'CNO',
      tickets: [
        {
          key: 'a',
          title: 'A',
          goal: 'g',
          jobs: [],
          functional: ['f'],
          scope: { in: ['x'] },
          stagingCheck: 's',
        },
      ],
    })
    const fieldMsgs = missing.error!.issues.map((i) => i.path.join('.')).join('\n')
    expect(fieldMsgs).toContain('tickets.0.jobs')
    expect(fieldMsgs).toContain('tickets.0.nonFunctional')
    const t = {
      title: 'T',
      goal: 'g',
      jobs: ['j'],
      functional: ['f'],
      nonFunctional: ['n'],
      scope: { in: ['x'] },
      stagingCheck: 's',
    }
    const cross = PlanFileSchema.safeParse({
      team: 'CNO',
      tickets: [
        { ...t, key: 'a', dependsOn: ['zz'] },
        { ...t, key: 'a' },
      ],
    })
    const msgs = cross.error!.issues.map((i) => i.message).join('\n')
    expect(msgs).toContain('no ticket with key zz')
    expect(msgs).toContain('duplicate key a')
    expect(msgs).toContain('several tickets need a plan')
  })

  it('refuses a dependency cycle', () => {
    expect(() =>
      orderTickets([
        ticket({ key: 'a', dependsOn: ['b'] }),
        ticket({ key: 'b', dependsOn: ['a'] }),
      ]),
    ).toThrow(/cycle among: a, b/)
  })
})

describe('rendering', () => {
  it('writes the sections in a fixed order with checklists for the criteria', () => {
    const text = renderTicket(
      ticket({
        context: 'See LoggingMiddleware.',
        decisions: ['The threshold'],
        scope: { in: ['src/a.ts'], out: ['nginx'] },
      }),
      {
        deps: [{ identifier: 'CNO-2', title: 'Do B' }],
        plan: { identifier: 'CNO-1', title: 'The plan' },
      },
    )
    const order = [
      '## Goal',
      '## Jobs to be done',
      '## Functional criteria',
      '## Non-functional criteria',
      '## Scope',
      '## Context',
      '## Decisions to ask about',
      '## Staging check',
      '## Depends on',
      'Part of CNO-1',
    ]
    const at = order.map((h) => text.indexOf(h))
    expect(at.every((i) => i >= 0)).toBe(true)
    expect([...at].sort((x, y) => x - y)).toEqual(at)
    expect(text).toContain('- [ ] f1')
    expect(text).toContain('- [ ] n1')
    expect(text).toContain('**Out**\n\n- nginx')
    expect(text).toContain('- CNO-2 Do B')
  })

  it('leaves out empty optional sections', () => {
    const text = renderTicket(ticket())
    expect(text).not.toContain('## Context')
    expect(text).not.toContain('## Decisions')
    expect(text).not.toContain('## Depends on')
    expect(text).not.toContain('**Out**')
  })

  it('lists the tickets on the plan and says it is never built', () => {
    const text = renderPlan({ title: 'P', summary: 'Why.' }, [
      { identifier: 'CNO-2', title: 'A', after: [] },
      { identifier: 'CNO-3', title: 'B', after: ['CNO-2'] },
    ])
    expect(text).toContain('1. CNO-2 A\n2. CNO-3 B (after CNO-2)')
    expect(text).toContain('never builds it')
  })
})

describe('oar ticket create', () => {
  const setup = () => {
    const w = world()
    const path = join(w.home, 'plan.json')
    writeFileSync(path, JSON.stringify(EXAMPLE_PLAN))
    return { w, path, linear: new FakeLinear() }
  }

  it('creates the plan, its tickets in dependency order, the links, and records every id', async () => {
    const { w, path, linear } = setup()
    await ticketCreate(w.ctx, path, readPlanFile(path), linear as unknown as LinearClient)
    expect(linear.calls).toEqual([
      'label spec',
      'create CNO-1 Trace CNO requests end to end state=st-backlog parent=- labels=label-spec',
      'create CNO-2 Return an X-Request-ID header on every API response state=st-backlog parent=id-CNO-1 labels=-',
      'create CNO-3 Log slow CNO API requests state=st-backlog parent=id-CNO-1 labels=-',
      'relate id-CNO-2 blocks id-CNO-3',
      'update id-CNO-1',
    ])
    expect(linear.issues.get('CNO-3')!.description).toContain(
      '## Depends on\n\n- CNO-2 Return an X-Request-ID',
    )
    expect(linear.issues.get('CNO-1')!.description).toContain(
      '2. CNO-3 Log slow CNO API requests (after CNO-2)',
    )
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    expect(saved.created).toEqual({
      plan: 'CNO-1',
      tickets: { 'request-id': 'CNO-2', 'slow-requests': 'CNO-3' },
      relations: ['request-id>slow-requests'],
      planListed: true,
    })
    expect(w.out.join('\n')).toContain('CNO-3  Log slow CNO API requests  (after CNO-2)')
  })

  it('resumes after a failure without creating anything twice', async () => {
    const { w, path, linear } = setup()
    linear.failOnCreate = 'Log slow CNO API requests'
    await expect(
      ticketCreate(w.ctx, path, readPlanFile(path), linear as unknown as LinearClient),
    ).rejects.toThrow('boom')
    expect(JSON.parse(readFileSync(path, 'utf8')).created.tickets).toEqual({
      'request-id': 'CNO-2',
    })
    linear.failOnCreate = null
    linear.calls = []
    await ticketCreate(w.ctx, path, readPlanFile(path), linear as unknown as LinearClient)
    expect(linear.calls.filter((c) => c.startsWith('create')).map((c) => c.split(' ')[1])).toEqual([
      'CNO-3',
    ])
    expect(linear.calls).toContain('relate id-CNO-2 blocks id-CNO-3')
  })

  it('goes on without labels the app may not create, and says so', async () => {
    const { w, path, linear } = setup()
    linear.labels.clear()
    const plan = readPlanFile(path)
    plan.tickets[1]!.labels = ['perf']
    await ticketCreate(w.ctx, path, plan, linear as unknown as LinearClient)
    expect(linear.calls[1]).toContain('labels=-')
    const notes = w.out.join('\n')
    expect(notes).toContain('no "spec" label in Linear')
    expect(notes).toContain('label "perf" does not exist')
    expect(linear.calls.filter((c) => c.startsWith('create'))).toHaveLength(3)
  })

  it('warns when the team is not one the controller builds', async () => {
    const { w, path, linear } = setup()
    w.ctx.config.factory.linear.teams = { ENG: 'engine' }
    await ticketCreate(w.ctx, path, readPlanFile(path), linear as unknown as LinearClient)
    expect(w.out[0]).toContain('not in factory.linear.teams')
  })

  it('shows the rendered tickets on a dry run without any call', () => {
    const { w, path } = setup()
    ticketDryRun(w.ctx, readPlanFile(path))
    const text = w.out.join('\n')
    expect(text).toContain('=== <plan> [spec] Trace CNO requests end to end')
    expect(text).toContain('=== <slow-requests> Log slow CNO API requests')
    expect(text).toContain('- <request-id> Return an X-Request-ID header')
    expect(text).toContain('Nothing was sent to Linear.')
  })

  it('rejects a broken file with every problem named', () => {
    const { w, path } = setup()
    writeFileSync(path, JSON.stringify({ team: 'cno', tickets: [] }))
    expect(() => readPlanFile(path)).toThrow(/team: a Linear team key[\s\S]*tickets/)
    void w
  })
})
