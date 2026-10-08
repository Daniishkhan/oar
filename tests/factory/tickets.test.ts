import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readPlanFile, ticketCreate, ticketDryRun } from '../../src/commands/ticket.js'
import type { LinearClient } from '../../src/factory/linear.js'
import { publishPlan, refreshPlan } from '../../src/factory/publication.js'
import {
  EXAMPLE_PLAN,
  orderTickets,
  PlanFileSchema,
  renderPlan,
  renderTicket,
  unwrapMarkdown,
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
  failAfterCreate: string | null = null
  failAfterRelation = false
  beforeCreate: ((input: { id?: string; title: string }) => void) | undefined
  relations = new Map<
    string,
    { id: string; issueId: string; relatedIssueId: string; type: string }
  >()
  private displayId(id?: string): string {
    if (!id) return '-'
    return `id-${[...this.issues.values()].find((i) => i.id === id)?.identifier ?? id}`
  }
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
    id?: string
    title: string
    description: string
    stateId?: string
    parentId?: string
    labelIds?: string[]
  }) {
    this.beforeCreate?.(input)
    if (this.failOnCreate === input.title) throw new Error('boom')
    if ([...this.issues.values()].some((i) => i.id === input.id)) throw new Error('duplicate UUID')
    const identifier = `CNO-${++this.n}`
    const issue = {
      id: input.id ?? `id-${identifier}`,
      identifier,
      title: input.title,
      url: `https://linear.app/x/${identifier}`,
      description: input.description,
    }
    this.issues.set(identifier, issue)
    this.calls.push(
      `create ${identifier} ${input.title} state=${input.stateId} parent=${this.displayId(input.parentId)} labels=${(input.labelIds ?? []).join(',') || '-'}`,
    )
    if (this.failAfterCreate === input.title) {
      this.failAfterCreate = null
      throw new Error('response lost after create')
    }
    return issue
  }
  async issue(identifier: string) {
    const i =
      this.issues.get(identifier) ??
      [...this.issues.values()].find((issue) => issue.id === identifier)
    return i ? { ...i, parentId: null } : null
  }
  async relation(id: string) {
    return this.relations.get(id) ?? null
  }
  async createRelation(input: {
    id?: string
    issueId: string
    relatedIssueId: string
    type: string
  }) {
    if (input.id) this.relations.set(input.id, { ...input, id: input.id })
    this.calls.push(
      `relate ${this.displayId(input.issueId)} ${input.type} ${this.displayId(input.relatedIssueId)}`,
    )
    if (this.failAfterRelation) {
      this.failAfterRelation = false
      throw new Error('relation response lost')
    }
  }
  async updateIssue(id: string, input: { description?: string }) {
    this.calls.push(`update ${this.displayId(id)}`)
    const i = [...this.issues.values()].find((x) => x.id === id)
    if (i && input.description) i.description = input.description
  }
}

describe('plan files', () => {
  it('accepts the shipped example and orders tickets by dependency', () => {
    const plan = PlanFileSchema.parse(EXAMPLE_PLAN)
    expect(orderTickets(plan.tickets).map((t) => t.key)).toEqual(['request-id', 'slow-requests'])
    const swapped = { ...EXAMPLE_PLAN, tickets: EXAMPLE_PLAN.tickets.toReversed() }
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
        decisions: ['Warn, do not error.'],
        questions: ['The threshold'],
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
      '## Decisions',
      '## Open questions',
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
    expect(text).toContain('Settled during planning')
    expect(text).toContain('Ask on this issue before acting')
  })

  it('keeps the plan and its provenance on the plan issue, not on the tickets', () => {
    const publication = {
      id: 'pub-1',
      contentHash: 'a'.repeat(64),
      sourceFile: 'tickets.json',
      document: { path: 'plan.md', content: '# Plan\n\nA long\nwrapped line.\n' },
    }
    const withParent = renderTicket(ticket(), {
      plan: { identifier: 'CNO-1', title: 'The plan' },
      publication,
    })
    expect(withParent).toContain('The full plan is on that issue')
    expect(withParent).not.toContain('wrapped line')
    expect(withParent).not.toContain('SHA-256')
    const alone = renderTicket(ticket(), { publication })
    expect(alone).toContain('## Plan\n\n# Plan\n\nA long wrapped line.')
    expect(alone).toContain('snapshot SHA-256 `' + 'a'.repeat(64) + '`')
    const plan = renderPlan({ title: 'P', summary: 'Why.' }, [], publication)
    expect(plan.indexOf('never builds it')).toBeLessThan(plan.indexOf('## Plan'))
    expect(plan).toContain('A long wrapped line.')
    expect(plan.trim().endsWith('(the published contents, not a Git commit).')).toBe(true)
  })

  it('joins hard-wrapped Markdown for Linear without touching structure', () => {
    const source = [
      '# Title',
      '',
      'A paragraph that was',
      'wrapped twice',
      'by an editor.',
      '',
      '- a list item that',
      '  continues here',
      '  * nested item',
      '    with its own continuation',
      '1. numbered',
      '2. items stay',
      '',
      '> a quote',
      'continues',
      '',
      '| a | b |',
      '| - | - |',
      '',
      '```',
      'code stays',
      'exactly',
      '```',
      '',
      'Last line  ',
      'after a hard break',
      '',
      '---',
    ].join('\n')
    expect(unwrapMarkdown(source)).toBe(
      [
        '# Title',
        '',
        'A paragraph that was wrapped twice by an editor.',
        '',
        '- a list item that continues here',
        '  * nested item with its own continuation',
        '1. numbered',
        '2. items stay',
        '',
        '> a quote continues',
        '',
        '| a | b |',
        '| - | - |',
        '',
        '```',
        'code stays',
        'exactly',
        '```',
        '',
        'Last line  ',
        'after a hard break',
        '',
        '---',
      ].join('\n'),
    )
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

  it('refreshes published descriptions with the current template and nothing else', async () => {
    const { w, path, linear } = setup()
    await ticketCreate(w.ctx, path, readPlanFile(path), linear as unknown as LinearClient)
    linear.calls = []
    for (const issue of linear.issues.values()) issue.description = 'stale'
    const result = await refreshPlan({ path, linear: linear as unknown as LinearClient })
    expect(linear.calls).toEqual(['update id-CNO-2', 'update id-CNO-3', 'update id-CNO-1'])
    expect(result.tickets.map((t) => t.identifier)).toEqual(['CNO-2', 'CNO-3'])
    expect(linear.issues.get('CNO-3')!.description).toContain('## Open questions')
    expect(linear.issues.get('CNO-3')!.description).toContain('Part of CNO-1')
    expect(linear.issues.get('CNO-1')!.description).toContain('2. CNO-3 Log slow CNO API requests')
    expect(JSON.parse(readFileSync(path, 'utf8')).created.planListed).toBe(true)
    const unpublished = join(w.home, 'fresh.json')
    writeFileSync(unpublished, JSON.stringify(EXAMPLE_PLAN))
    await expect(
      refreshPlan({ path: unpublished, linear: linear as unknown as LinearClient }),
    ).rejects.toThrow('not been published')
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
    writeFileSync(path, JSON.stringify(plan))
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

  it('persists publication and all operation IDs before the first remote mutation', async () => {
    const { w, path, linear } = setup()
    linear.beforeCreate = (input) => {
      const saved = readPlanFile(path)
      expect(saved.publication?.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(saved.publication?.contentHash).toMatch(/^[a-f0-9]{64}$/)
      expect(saved.publication?.operations.relations['request-id>slow-requests']).toBeTruthy()
      expect([
        saved.publication?.operations.plan,
        ...Object.values(saved.publication!.operations.tickets),
      ]).toContain(input.id)
    }
    await ticketCreate(w.ctx, path, readPlanFile(path), linear as unknown as LinearClient)
    const saved = readPlanFile(path)
    expect(linear.issues.get('CNO-1')!.description).toContain(saved.publication!.contentHash)
    expect(linear.issues.get('CNO-2')!.description).not.toContain(saved.publication!.contentHash)
    expect(existsSync(`${path}.publish.lock`)).toBe(false)
  })

  it('recovers a created issue after the response was lost, using its persisted UUID', async () => {
    const { w, path, linear } = setup()
    linear.failAfterCreate = 'Return an X-Request-ID header on every API response'
    await expect(
      ticketCreate(w.ctx, path, readPlanFile(path), linear as unknown as LinearClient),
    ).rejects.toThrow('response lost')
    expect(readPlanFile(path).created.tickets).toEqual({})
    const operationId = readPlanFile(path).publication!.operations.tickets['request-id']
    expect(linear.issues.get('CNO-2')!.id).toBe(operationId)
    await ticketCreate(w.ctx, path, readPlanFile(path), linear as unknown as LinearClient)
    expect(linear.issues.size).toBe(3)
    expect(linear.calls.filter((c) => c.startsWith('create'))).toHaveLength(3)
    expect(readPlanFile(path).created.tickets['request-id']).toBe('CNO-2')
  })

  it('recovers a relation after the response was lost without creating it twice', async () => {
    const { w, path, linear } = setup()
    linear.failAfterRelation = true
    await expect(
      ticketCreate(w.ctx, path, readPlanFile(path), linear as unknown as LinearClient),
    ).rejects.toThrow('relation response lost')
    expect(readPlanFile(path).created.relations).toEqual([])
    await ticketCreate(w.ctx, path, readPlanFile(path), linear as unknown as LinearClient)
    expect(linear.calls.filter((c) => c.startsWith('relate'))).toHaveLength(1)
    expect(readPlanFile(path).created.relations).toEqual(['request-id>slow-requests'])
  })

  it('rejects changed published content before calling Linear and explains revision workflow', async () => {
    const { w, path, linear } = setup()
    await ticketCreate(w.ctx, path, readPlanFile(path), linear as unknown as LinearClient)
    const saved = readPlanFile(path)
    saved.tickets[0]!.goal = 'A new goal'
    writeFileSync(path, JSON.stringify(saved))
    linear.calls = []
    await expect(
      ticketCreate(w.ctx, path, saved, linear as unknown as LinearClient),
    ).rejects.toMatchObject({
      message: expect.stringContaining('immutable'),
      hint: expect.stringContaining('plans/<slug>-v2'),
    })
    expect(linear.calls).toEqual([])
  })

  it('publishes the exact local Markdown snapshot and refuses changes on resume', async () => {
    const { w, path, linear } = setup()
    const plan = readPlanFile(path)
    plan.document = 'plan.md'
    writeFileSync(
      join(w.home, 'plan.md'),
      '# Draft design\n\nUnpushed but fully available to the worker.\n',
    )
    writeFileSync(path, JSON.stringify(plan))
    await ticketCreate(w.ctx, path, plan, linear as unknown as LinearClient)
    const parent = linear.issues.get('CNO-1')!.description
    expect(parent).toContain(
      '## Plan\n\n# Draft design\n\nUnpushed but fully available to the worker.',
    )
    expect(parent).toContain('not a Git commit')
    for (const identifier of ['CNO-2', 'CNO-3']) {
      const description = linear.issues.get(identifier)!.description
      expect(description).not.toContain('Unpushed but fully available')
      expect(description).toContain('Part of CNO-1')
    }
    writeFileSync(join(w.home, 'plan.md'), '# Different design')
    await expect(
      ticketCreate(w.ctx, path, readPlanFile(path), linear as unknown as LinearClient),
    ).rejects.toThrow('immutable')
  })

  it('locks concurrent publishers and reloads receipts inside the lock', async () => {
    const { w, path, linear } = setup()
    let unlock!: () => void
    let entered!: () => void
    const started = new Promise<void>((r) => {
      entered = r
    })
    const wait = new Promise<void>((r) => {
      unlock = r
    })
    const teams = linear.teams.bind(linear)
    linear.teams = async (keys) => {
      entered()
      await wait
      return teams(keys)
    }
    const stalePlan = readPlanFile(path)
    const first = publishPlan({ path, linear: linear as unknown as LinearClient })
    await started
    await expect(publishPlan({ path, linear: linear as unknown as LinearClient })).rejects.toThrow(
      'locked',
    )
    unlock()
    await first
    await ticketCreate(w.ctx, path, stalePlan, linear as unknown as LinearClient)
    expect(linear.issues.size).toBe(3)
    expect(existsSync(`${path}.publish.lock`)).toBe(false)
  })

  it('keeps backward-compatible receipts and adopts unchanged legacy issue definitions', async () => {
    const { w, path, linear } = setup()
    const plan = readPlanFile(path)
    const p = await linear.createIssue({
      title: plan.plan!.title,
      description: renderPlan(plan.plan!, []),
    })
    const t = plan.tickets[0]!
    const first = await linear.createIssue({
      title: t.title,
      description: renderTicket(t, { plan: { ...p, title: plan.plan!.title } }),
    })
    plan.created.plan = p.identifier
    plan.created.tickets[t.key] = first.identifier
    writeFileSync(path, JSON.stringify(plan))
    linear.calls = []
    await ticketCreate(w.ctx, path, plan, linear as unknown as LinearClient)
    expect(linear.issues.size).toBe(3)
    expect(readPlanFile(path).publication!.operations.tickets[t.key]).toBe(first.id)
    expect(w.out.join(' ')).toContain('adopted legacy')
  })

  it('preserves an editor change made during an uncertain remote write', async () => {
    const { w, path, linear } = setup()
    linear.beforeCreate = () => {
      const edited = readPlanFile(path)
      edited.tickets[0]!.goal = 'An edit while publishing'
      writeFileSync(path, JSON.stringify(edited))
    }
    await expect(
      ticketCreate(w.ctx, path, readPlanFile(path), linear as unknown as LinearClient),
    ).rejects.toThrow('no local edits were overwritten')
    expect(readPlanFile(path).tickets[0]!.goal).toBe('An edit while publishing')
    expect(readPlanFile(path).publication?.operations.plan).toBe(linear.issues.get('CNO-1')!.id)
    expect(existsSync(`${path}.publish.lock`)).toBe(false)
  })

  it('does not treat a failed recovery lookup as proof that an issue is missing', async () => {
    const { w, path, linear } = setup()
    linear.issue = async () => {
      throw new Error('lookup unavailable')
    }
    await expect(
      ticketCreate(w.ctx, path, readPlanFile(path), linear as unknown as LinearClient),
    ).rejects.toThrow('lookup unavailable')
    expect(linear.issues.size).toBe(0)
    expect(linear.calls.filter((c) => c.startsWith('create'))).toEqual([])
    expect(readPlanFile(path).publication?.operations.plan).toBeTruthy()
  })
})
