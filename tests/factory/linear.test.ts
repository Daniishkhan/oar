import { describe, expect, it } from 'vitest'
import {
  LinearClient,
  LinearError,
  newCommentId,
  type LinearAuth,
  type TokenRecord,
  type TokenStore,
} from '../../src/factory/linear.js'

interface Recorded {
  url: string
  headers: Record<string, string>
  body: string
  json: { query: string; variables: Record<string, unknown> }
}

const reply = (body: unknown, status = 200) => ({ body, status })
const gql = (data: unknown) => reply({ data })

function fakeFetch(script: ({ body: unknown; status: number } | Error)[]) {
  const calls: Recorded[] = []
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = String(init?.body ?? '')
    let json = { query: '', variables: {} }
    try {
      json = JSON.parse(body)
    } catch {
      // form body
    }
    calls.push({
      url: String(url),
      headers: { ...(init?.headers as Record<string, string>) },
      body,
      json,
    })
    const next = script.shift()
    if (!next) throw new Error('fake fetch: script exhausted')
    if (next instanceof Error) throw next
    return new Response(JSON.stringify(next.body), { status: next.status })
  }) as typeof fetch
  return { fn, calls }
}

function memStore(initial: TokenRecord | null = null): TokenStore & { value: TokenRecord | null } {
  const s = {
    value: initial,
    get: () => s.value,
    set: (t: TokenRecord) => {
      s.value = t
    },
  }
  return s
}

const oauth: LinearAuth = { mode: 'oauth', clientId: 'cid', clientSecret: 'sec' }
const NOW = Date.parse('2026-10-07T00:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const tokenReply = (token: string, expiresIn = 30 * 24 * 3600) =>
  reply({ access_token: token, expires_in: expiresIn, token_type: 'Bearer', scope: 'read write' })

function make(
  script: Parameters<typeof fakeFetch>[0],
  auth: LinearAuth = oauth,
  store = memStore(),
) {
  const f = fakeFetch(script)
  const client = new LinearClient({ auth, store, fetch: f.fn, now: () => NOW })
  return { client, store, ...f }
}

const issueNode = (over: Record<string, unknown> = {}) => ({
  id: 'i1',
  identifier: 'ENG-1',
  title: 'T',
  description: null,
  priority: 2,
  url: 'https://linear.app/x/issue/ENG-1',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-06T00:00:00.000Z',
  archivedAt: null,
  trashed: false,
  team: { key: 'ENG' },
  state: { id: 's1', name: 'Todo', type: 'unstarted' },
  labels: { nodes: [{ name: 'bug' }, { name: 'repo:oar' }] },
  parent: { id: 'p1' },
  inverseRelations: {
    nodes: [
      { type: 'blocks', issue: { id: 'b-open', state: { type: 'started' } } },
      { type: 'blocks', issue: { id: 'b-done', state: { type: 'completed' } } },
      { type: 'blocks', issue: { id: 'b-canceled', state: { type: 'canceled' } } },
      { type: 'related', issue: { id: 'rel', state: { type: 'started' } } },
    ],
  },
  ...over,
})

describe('auth', () => {
  it('mints an OAuth token with a form body and uses a Bearer header', async () => {
    const { client, calls, store } = make([
      tokenReply('tok1'),
      gql({ viewer: { id: 'u', name: 'oar', app: true } }),
    ])
    expect(await client.me()).toEqual({ id: 'u', name: 'oar', app: true })
    const [mint, q] = calls
    expect(mint?.url).toBe('https://api.linear.app/oauth/token')
    expect(mint?.headers['Content-Type']).toBe('application/x-www-form-urlencoded')
    const form = new URLSearchParams(mint?.body)
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'client_credentials',
      client_id: 'cid',
      client_secret: 'sec',
      scope: 'read write',
    })
    expect(q?.url).toBe('https://api.linear.app/graphql')
    expect(q?.headers.Authorization).toBe('Bearer tok1')
    expect(store.value).toEqual({
      token: 'tok1',
      expiresAt: new Date(NOW + 30 * DAY).toISOString(),
    })
  })

  it('reuses a cached token that is far from expiry', async () => {
    const store = memStore({ token: 'cached', expiresAt: new Date(NOW + 20 * DAY).toISOString() })
    const { client, calls } = make(
      [gql({ viewer: { id: 'u', name: 'n', app: false } })],
      oauth,
      store,
    )
    await client.me()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.headers.Authorization).toBe('Bearer cached')
  })

  it('re-mints when the token expires within renewBeforeMs', async () => {
    const store = memStore({ token: 'old', expiresAt: new Date(NOW + 2 * DAY).toISOString() })
    const { client, calls } = make(
      [tokenReply('new'), gql({ viewer: { id: 'u', name: 'n', app: false } })],
      oauth,
      store,
    )
    await client.me()
    expect(calls[0]?.url).toContain('/oauth/token')
    expect(calls[1]?.headers.Authorization).toBe('Bearer new')
    expect(store.value?.token).toBe('new')
  })

  it('mints once and retries once after a 401', async () => {
    const store = memStore({ token: 'stale', expiresAt: new Date(NOW + 20 * DAY).toISOString() })
    const { client, calls } = make(
      [
        reply({ errors: [{ message: 'nope' }] }, 401),
        tokenReply('fresh'),
        gql({ viewer: { id: 'u', name: 'n', app: false } }),
      ],
      oauth,
      store,
    )
    await client.me()
    expect(calls.map((c) => c.headers.Authorization ?? 'form')).toEqual([
      'Bearer stale',
      'form',
      'Bearer fresh',
    ])
  })

  it('does not retry a second 401', async () => {
    const store = memStore({ token: 'stale', expiresAt: new Date(NOW + 20 * DAY).toISOString() })
    const { client, calls } = make(
      [reply({}, 401), tokenReply('fresh'), reply({}, 401)],
      oauth,
      store,
    )
    await expect(client.me()).rejects.toMatchObject({ code: 'auth' })
    expect(calls).toHaveLength(3)
  })

  it('sends the API key without a Bearer prefix and never mints', async () => {
    const { client, calls } = make([gql({ viewer: { id: 'u', name: 'n', app: false } })], {
      mode: 'apikey',
      key: 'lin_api_abc',
    })
    await client.me()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.headers.Authorization).toBe('lin_api_abc')
  })

  it('maps a failed token mint to an auth error without leaking the secret', async () => {
    const { client } = make([reply({ error: 'invalid_client' }, 401)])
    const err = await client.me().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LinearError)
    expect((err as LinearError).code).toBe('auth')
    expect((err as LinearError).message).not.toContain('sec')
  })
})

describe('errors', () => {
  const key: LinearAuth = { mode: 'apikey', key: 'k' }
  it('maps RATELIMITED (HTTP 400) to ratelimited', async () => {
    const { client } = make(
      [reply({ errors: [{ message: 'slow down', extensions: { code: 'RATELIMITED' } }] }, 400)],
      key,
    )
    await expect(client.me()).rejects.toMatchObject({ code: 'ratelimited', status: 400 })
  })
  it('maps HTTP 429 to ratelimited', async () => {
    const { client } = make([reply({}, 429)], key)
    await expect(client.me()).rejects.toMatchObject({ code: 'ratelimited', status: 429 })
  })
  it('maps AUTHENTICATION_ERROR on 400 to auth', async () => {
    const { client } = make(
      [
        reply(
          { errors: [{ message: 'bad key', extensions: { code: 'AUTHENTICATION_ERROR' } }] },
          400,
        ),
      ],
      key,
    )
    await expect(client.me()).rejects.toMatchObject({ code: 'auth' })
  })
  it('joins graphql error messages', async () => {
    const { client } = make([reply({ errors: [{ message: 'a' }, { message: 'b' }] })], key)
    await expect(client.me()).rejects.toMatchObject({ code: 'graphql', message: 'a; b' })
  })
  it('maps a fetch throw to network', async () => {
    const { client } = make([new Error('ECONNRESET')], key)
    await expect(client.me()).rejects.toMatchObject({ code: 'network' })
  })
})

describe('issues', () => {
  const key: LinearAuth = { mode: 'apikey', key: 'k' }
  it('paginates and maps fields', async () => {
    const { client, calls } = make(
      [
        gql({
          issues: {
            nodes: [issueNode()],
            pageInfo: { hasNextPage: true, endCursor: 'c1' },
          },
        }),
        gql({
          issues: {
            nodes: [
              issueNode({
                id: 'i2',
                identifier: 'ENG-2',
                description: 'body',
                parent: null,
                labels: null,
                inverseRelations: null,
                archivedAt: '2026-10-06T01:00:00.000Z',
                trashed: null,
              }),
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        }),
      ],
      key,
    )
    const issues = await client.issuesUpdatedSince(['ENG'], '2026-10-05T00:00:00.000Z')
    expect(issues).toHaveLength(2)
    expect(issues[0]).toMatchObject({
      id: 'i1',
      identifier: 'ENG-1',
      description: '',
      teamKey: 'ENG',
      labels: ['bug', 'repo:oar'],
      parentId: 'p1',
      blockedBy: ['b-open'],
      trashed: false,
      state: { id: 's1', name: 'Todo', type: 'unstarted' },
    })
    expect(issues[1]).toMatchObject({
      description: 'body',
      parentId: null,
      labels: [],
      blockedBy: [],
      archivedAt: '2026-10-06T01:00:00.000Z',
      trashed: false,
    })
    expect(calls[0]?.json.variables).toEqual({
      filter: { team: { key: { in: ['ENG'] } }, updatedAt: { gt: '2026-10-05T00:00:00.000Z' } },
      first: 50,
      after: null,
    })
    expect(calls[1]?.json.variables.after).toBe('c1')
    expect(calls[0]?.json.query).toContain('includeArchived: true')
  })

  it('issue() uses the same fragment and returns null on "Entity not found"', async () => {
    const { client, calls } = make(
      [
        gql({ issue: issueNode() }),
        reply({ errors: [{ message: 'Entity not found: Issue' }], data: null }),
      ],
      key,
    )
    expect((await client.issue('ENG-1'))?.identifier).toBe('ENG-1')
    expect(await client.issue('ENG-404')).toBeNull()
    expect(calls[0]?.json.query).toContain('...IssueFields')
    expect(calls[0]?.json.query).toContain('fragment IssueFields on Issue')
    expect(calls[0]?.json.variables).toEqual({ id: 'ENG-1' })
  })

  it('issue() still throws other errors', async () => {
    const { client } = make([reply({ errors: [{ message: 'boom' }] })], key)
    await expect(client.issue('ENG-1')).rejects.toMatchObject({ code: 'graphql' })
  })
})

describe('comments', () => {
  const key: LinearAuth = { mode: 'apikey', key: 'k' }
  const node = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    body: `body ${id}`,
    createdAt: '2026-10-06T00:00:00.000Z',
    issue: { id: 'i1' },
    user: { id: 'u1', name: 'Dana', app: false },
    botActor: null,
    ...over,
  })

  it('chunks issue ids by 50 and maps user/bot flags', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `i${i}`)
    const { client, calls } = make(
      [
        gql({
          comments: {
            nodes: [
              node('c1'),
              node('c2', { user: { id: 'app1', name: 'oar', app: true } }),
              node('c3', { user: null, botActor: { id: 'bot1' } }),
            ],
            pageInfo: { hasNextPage: false },
          },
        }),
        gql({ comments: { nodes: [], pageInfo: { hasNextPage: false } } }),
        gql({ comments: { nodes: [node('c4')], pageInfo: { hasNextPage: false } } }),
      ],
      key,
    )
    const out = await client.comments(ids, '2026-10-05T00:00:00.000Z')
    expect(calls).toHaveLength(3)
    const sizes = calls.map((c) => {
      const f = c.json.variables.filter as { issue: { id: { in: string[] } } }
      return f.issue.id.in.length
    })
    expect(sizes).toEqual([50, 50, 20])
    expect(calls[0]?.json.variables.filter).toMatchObject({
      createdAt: { gt: '2026-10-05T00:00:00.000Z' },
    })
    expect(out.map((c) => c.id)).toEqual(['c1', 'c2', 'c3', 'c4'])
    expect(out[0]).toMatchObject({
      issueId: 'i1',
      userId: 'u1',
      userName: 'Dana',
      userIsApp: false,
      isBot: false,
    })
    expect(out[1]).toMatchObject({ userIsApp: true, isBot: false })
    expect(out[2]).toMatchObject({ userId: null, userName: null, userIsApp: false, isBot: true })
  })

  it('omits the createdAt filter without a cursor and skips empty input', async () => {
    const { client, calls } = make(
      [gql({ comments: { nodes: [], pageInfo: { hasNextPage: false } } })],
      key,
    )
    expect(await client.comments([], null)).toEqual([])
    expect(calls).toHaveLength(0)
    await client.comments(['i1'], null)
    expect(calls[0]?.json.variables.filter).toEqual({ issue: { id: { in: ['i1'] } } })
  })
})

describe('mutations', () => {
  const key: LinearAuth = { mode: 'apikey', key: 'k' }

  it('createComment sends the client-generated id', async () => {
    const { client, calls } = make(
      [gql({ commentCreate: { success: true, comment: { id: 'cid-1' } } })],
      key,
    )
    const id = newCommentId()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(await client.createComment({ id, issueId: 'ENG-1', body: 'hi' })).toEqual({
      id: 'cid-1',
    })
    expect(calls[0]?.json.variables).toEqual({ input: { id, issueId: 'ENG-1', body: 'hi' } })
  })

  it('setState passes the identifier and state id', async () => {
    const { client, calls } = make([gql({ issueUpdate: { success: true } })], key)
    await client.setState('ENG-12', 's9')
    expect(calls[0]?.json.variables).toEqual({ id: 'ENG-12', input: { stateId: 's9' } })
  })

  it('setState throws when success is false', async () => {
    const { client } = make([gql({ issueUpdate: { success: false } })], key)
    await expect(client.setState('ENG-12', 's9')).rejects.toMatchObject({ code: 'graphql' })
  })

  it('linkPr uses the GitHub PR mutation when it works', async () => {
    const { client, calls } = make([gql({ attachmentLinkGitHubPR: { success: true } })], key)
    await client.linkPr('ENG-1', 'https://github.com/o/r/pull/1', 'PR')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.json.query).toContain('attachmentLinkGitHubPR')
  })

  it('linkPr falls back to attachmentLinkURL when the GitHub mutation errors', async () => {
    const { client, calls } = make(
      [
        reply({ errors: [{ message: 'GitHub integration not installed' }] }),
        gql({ attachmentLinkURL: { success: true } }),
      ],
      key,
    )
    await client.linkPr('ENG-1', 'https://github.com/o/r/pull/1')
    expect(calls).toHaveLength(2)
    expect(calls[1]?.json.query).toContain('attachmentLinkURL')
    expect(calls[1]?.json.variables).toMatchObject({
      issueId: 'ENG-1',
      url: 'https://github.com/o/r/pull/1',
    })
  })

  it('linkPr does not fall back on rate limiting', async () => {
    const { client, calls } = make([reply({}, 429)], key)
    await expect(client.linkPr('ENG-1', 'u')).rejects.toMatchObject({ code: 'ratelimited' })
    expect(calls).toHaveLength(1)
  })

  it('createState returns the new state with its team id', async () => {
    const { client } = make(
      [
        gql({
          workflowStateCreate: {
            success: true,
            workflowState: { id: 'ws1', name: 'Needs Input', type: 'started', position: 3 },
          },
        }),
      ],
      key,
    )
    expect(
      await client.createState({
        teamId: 't1',
        name: 'Needs Input',
        type: 'started',
        color: '#f00',
      }),
    ).toEqual({ id: 'ws1', name: 'Needs Input', type: 'started', position: 3, teamId: 't1' })
  })
})

describe('lookups', () => {
  const key: LinearAuth = { mode: 'apikey', key: 'k' }
  it('teams and states map nodes', async () => {
    const { client } = make(
      [
        gql({ teams: { nodes: [{ id: 't1', key: 'ENG', name: 'Eng' }] } }),
        gql({
          team: { states: { nodes: [{ id: 's1', name: 'Todo', type: 'unstarted', position: 1 }] } },
        }),
      ],
      key,
    )
    expect(await client.teams(['ENG'])).toEqual([{ id: 't1', key: 'ENG', name: 'Eng' }])
    expect(await client.states('t1')).toEqual([
      { id: 's1', name: 'Todo', type: 'unstarted', position: 1, teamId: 't1' },
    ])
  })
})
