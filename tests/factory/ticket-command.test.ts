import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ticketCmd } from '../../src/commands/ticket.js'
import { LinearClient } from '../../src/factory/linear.js'
import { EXAMPLE_PLAN } from '../../src/factory/tickets.js'
import { world } from '../helpers.js'

describe('ticket command preview', () => {
  it('checks and previews the inline Markdown source without modifying files or requiring auth', async () => {
    const w = world()
    const path = join(w.home, 'tickets.json')
    const original = JSON.stringify({ ...EXAMPLE_PLAN, document: 'plan.md' })
    writeFileSync(path, original)
    writeFileSync(join(w.home, 'plan.md'), '# Repo plan\n\nThe exact local design.')
    expect(await ticketCmd(w.ctx, ['check', path])).toBe(0)
    expect(w.out.join('\n')).toContain('The exact local design.')
    expect(w.out.join('\n')).toMatch(/Snapshot SHA-256: `[0-9a-f]{64}`/)
    expect(readFileSync(path, 'utf8')).toBe(original)
    expect(existsSync(`${path}.publish.lock`)).toBe(false)
  })

  it('refuses a plan document that is not a Markdown file inside the plan directory', async () => {
    const w = world()
    const dir = join(w.home, 'plans')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'tickets.json')
    writeFileSync(join(w.home, 'env.md'), 'SECRET=1')
    for (const document of ['../env.md', 'notes.txt']) {
      writeFileSync(path, JSON.stringify({ ...EXAMPLE_PLAN, document }))
      await expect(ticketCmd(w.ctx, ['check', path])).rejects.toThrow('inside the plan directory')
    }
    symlinkSync(join(w.home, 'env.md'), join(dir, 'link.md'))
    writeFileSync(path, JSON.stringify({ ...EXAMPLE_PLAN, document: 'link.md' }))
    await expect(ticketCmd(w.ctx, ['check', path])).rejects.toThrow('outside the plan directory')
    expect(w.out.join('\n')).not.toContain('SECRET=1')
  })

  it('rejects missing source documents during dry run', async () => {
    const w = world()
    const path = join(w.home, 'tickets.json')
    writeFileSync(path, JSON.stringify({ ...EXAMPLE_PLAN, document: 'missing.md' }))
    await expect(ticketCmd(w.ctx, ['create', path, '--dry-run'])).rejects.toThrow(
      'cannot read plan document missing.md',
    )
  })
})

describe('Linear publication transport', () => {
  const setup = (responses: unknown[]) => {
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = []
    const client = new LinearClient({
      auth: { mode: 'apikey', key: 'test-key' },
      store: { get: () => null, set: () => {} },
      fetch: (async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)))
        return new Response(JSON.stringify(responses.shift()), { status: 200 })
      }) as typeof fetch,
    })
    return { client, requests }
  }

  it('passes persisted UUIDs to both create mutations and queries a relation by UUID', async () => {
    const issueId = '04772f88-2423-4fef-876e-73a9238e9a79'
    const relationId = 'e1f7ade2-6974-4652-a2c4-080cb7a8ec16'
    const { client, requests } = setup([
      {
        data: {
          issueCreate: {
            success: true,
            issue: { id: issueId, identifier: 'ENG-1', url: 'https://linear.app/ENG-1' },
          },
        },
      },
      { data: { issueRelationCreate: { success: true } } },
      {
        data: {
          issueRelation: {
            id: relationId,
            type: 'blocks',
            issue: { id: issueId },
            relatedIssue: { id: 'second' },
          },
        },
      },
    ])
    await client.createIssue({ id: issueId, teamId: 'team', title: 'Task', description: 'Body' })
    await client.createRelation({
      id: relationId,
      issueId,
      relatedIssueId: 'second',
      type: 'blocks',
    })
    expect(await client.relation(relationId)).toEqual({
      id: relationId,
      type: 'blocks',
      issueId,
      relatedIssueId: 'second',
    })
    expect(requests[0]!.variables.input).toMatchObject({ id: issueId })
    expect(requests[1]!.variables.input).toMatchObject({ id: relationId })
    expect(requests[2]!.variables).toEqual({ id: relationId })
  })

  it('distinguishes not-found relations from uncertain network failures', async () => {
    const { client } = setup([{ errors: [{ message: 'Entity not found' }] }])
    expect(await client.relation('missing')).toBeNull()
    const network = new LinearClient({
      auth: { mode: 'apikey', key: 'test-key' },
      store: { get: () => null, set: () => {} },
      fetch: (async () => {
        throw new Error('disconnected')
      }) as typeof fetch,
    })
    await expect(network.relation('uncertain')).rejects.toMatchObject({ code: 'network' })
  })

  it('looks up labels without creating them during publication', async () => {
    const { client, requests } = setup([{ data: { issueLabels: { nodes: [] } } }])
    expect(await client.labelId('team', 'spec', false)).toBeNull()
    expect(requests).toHaveLength(1)
    expect(requests[0]!.query).toContain('query Labels')
  })
})
