import { randomUUID } from 'node:crypto'
import { z } from 'zod'

export type LinearAuth =
  { mode: 'oauth'; clientId: string; clientSecret: string } | { mode: 'apikey'; key: string }

export interface TokenRecord {
  token: string
  /** ISO timestamp. */
  expiresAt: string
}
export interface TokenStore {
  get(): TokenRecord | null
  set(t: TokenRecord): void
}

export interface LinearIssue {
  id: string
  identifier: string
  title: string
  description: string
  priority: number
  url: string
  createdAt: string
  updatedAt: string
  archivedAt: string | null
  trashed: boolean
  teamKey: string
  state: { id: string; name: string; type: string }
  labels: string[]
  parentId: string | null
  /** The issue has sub-issues: it is a plan, never built itself. */
  hasChildren: boolean
  /** Ids of blockers whose state type is not completed/canceled. */
  blockedBy: string[]
}

export interface LinearComment {
  id: string
  issueId: string
  body: string
  createdAt: string
  userId: string | null
  userName: string | null
  userIsApp: boolean
  isBot: boolean
}

export interface LinearState {
  id: string
  name: string
  type: string
  position: number
  teamId: string
}
export interface LinearTeam {
  id: string
  key: string
  name: string
}

export class LinearError extends Error {
  constructor(
    public readonly code: 'auth' | 'ratelimited' | 'graphql' | 'network' | 'notfound',
    message: string,
    public readonly status?: number,
  ) {
    super(message)
    this.name = 'LinearError'
  }
}

export interface LinearClientOptions {
  auth: LinearAuth
  store: TokenStore
  fetch?: typeof fetch
  now?: () => number
  /** Re-mint the OAuth token this many ms before it expires (default 5 days). */
  renewBeforeMs?: number
}

const GRAPHQL_URL = 'https://api.linear.app/graphql'
const TOKEN_URL = 'https://api.linear.app/oauth/token'
const DEFAULT_RENEW_BEFORE_MS = 5 * 24 * 60 * 60 * 1000
const PAGE_SIZE = 50
const DONE_STATE_TYPES = new Set(['completed', 'canceled'])

export const newCommentId = () => randomUUID()

const ISSUE_FIELDS = `
fragment IssueFields on Issue {
  id
  identifier
  title
  description
  priority
  url
  createdAt
  updatedAt
  archivedAt
  trashed
  team { key }
  state { id name type }
  labels { nodes { name } }
  parent { id }
  children(first: 1) { nodes { id } }
  inverseRelations { nodes { type issue { id state { type } } } }
}`

const pageInfo = z.looseObject({ hasNextPage: z.boolean(), endCursor: z.string().nullish() })
const page = <T extends z.ZodType>(node: T) =>
  z.looseObject({ nodes: z.array(node), pageInfo: pageInfo.optional() })

const issueNode = z.looseObject({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  description: z.string().nullish(),
  priority: z.number(),
  url: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullish(),
  trashed: z.boolean().nullish(),
  team: z.looseObject({ key: z.string() }),
  state: z.looseObject({ id: z.string(), name: z.string(), type: z.string() }),
  labels: z.looseObject({ nodes: z.array(z.looseObject({ name: z.string() })) }).nullish(),
  parent: z.looseObject({ id: z.string() }).nullish(),
  children: z.looseObject({ nodes: z.array(z.looseObject({ id: z.string() })) }).nullish(),
  inverseRelations: z
    .looseObject({
      nodes: z.array(
        z.looseObject({
          type: z.string(),
          issue: z.looseObject({
            id: z.string(),
            state: z.looseObject({ type: z.string() }).nullish(),
          }),
        }),
      ),
    })
    .nullish(),
})
type IssueNode = z.infer<typeof issueNode>

const commentNode = z.looseObject({
  id: z.string(),
  body: z.string(),
  createdAt: z.string(),
  issue: z.looseObject({ id: z.string() }),
  user: z
    .looseObject({ id: z.string(), name: z.string().nullish(), app: z.boolean().nullish() })
    .nullish(),
  botActor: z.looseObject({ id: z.string() }).nullish(),
})

const tokenResponse = z.looseObject({ access_token: z.string(), expires_in: z.number() })

const toIssue = (n: IssueNode): LinearIssue => ({
  id: n.id,
  identifier: n.identifier,
  title: n.title,
  description: n.description ?? '',
  priority: n.priority,
  url: n.url,
  createdAt: n.createdAt,
  updatedAt: n.updatedAt,
  archivedAt: n.archivedAt ?? null,
  trashed: n.trashed ?? false,
  teamKey: n.team.key,
  state: { id: n.state.id, name: n.state.name, type: n.state.type },
  labels: (n.labels?.nodes ?? []).map((l) => l.name),
  parentId: n.parent?.id ?? null,
  hasChildren: (n.children?.nodes.length ?? 0) > 0,
  blockedBy: (n.inverseRelations?.nodes ?? [])
    .filter((r) => r.type === 'blocks' && !DONE_STATE_TYPES.has(r.issue.state?.type ?? ''))
    .map((r) => r.issue.id),
})

interface GraphqlResponse {
  data?: unknown
  errors?: { message?: string; extensions?: { code?: string } }[]
}

export class LinearClient {
  private readonly auth: LinearAuth
  private readonly store: TokenStore
  private readonly fetchFn: typeof fetch
  private readonly now: () => number
  private readonly renewBeforeMs: number
  private readonly mintFailures = new WeakSet<Error>()

  constructor(opts: LinearClientOptions) {
    this.auth = opts.auth
    this.store = opts.store
    this.fetchFn = opts.fetch ?? globalThis.fetch
    this.now = opts.now ?? Date.now
    this.renewBeforeMs = opts.renewBeforeMs ?? DEFAULT_RENEW_BEFORE_MS
  }

  async me(): Promise<{ id: string; name: string; app: boolean }> {
    // VERIFY: `app` on User (viewer) is taken from the task brief, not checked against the schema.
    const data = await this.query(
      'query { viewer { id name app } }',
      {},
      z.looseObject({
        viewer: z.looseObject({ id: z.string(), name: z.string(), app: z.boolean().nullish() }),
      }),
    )
    return { id: data.viewer.id, name: data.viewer.name, app: data.viewer.app ?? false }
  }

  async teams(keys: string[]): Promise<LinearTeam[]> {
    const data = await this.query(
      `query Teams($keys: [String!]) {
        teams(filter: { key: { in: $keys } }, first: 100) { nodes { id key name } }
      }`,
      { keys },
      z.looseObject({
        teams: z.looseObject({
          nodes: z.array(z.looseObject({ id: z.string(), key: z.string(), name: z.string() })),
        }),
      }),
    )
    return data.teams.nodes.map((t) => ({ id: t.id, key: t.key, name: t.name }))
  }

  async states(teamId: string): Promise<LinearState[]> {
    const data = await this.query(
      `query States($teamId: String!) {
        team(id: $teamId) { states(first: 100) { nodes { id name type position } } }
      }`,
      { teamId },
      z.looseObject({
        team: z.looseObject({
          states: z.looseObject({ nodes: z.array(stateNode) }),
        }),
      }),
    )
    return data.team.states.nodes.map((s) => ({ ...pickState(s), teamId }))
  }

  async createState(input: {
    teamId: string
    name: string
    type: string
    color: string
    description?: string
  }): Promise<LinearState> {
    const data = await this.query(
      `mutation CreateState($input: WorkflowStateCreateInput!) {
        workflowStateCreate(input: $input) {
          success
          workflowState { id name type position team { id } }
        }
      }`,
      { input },
      z.looseObject({
        workflowStateCreate: z.looseObject({
          success: z.boolean(),
          workflowState: stateNode.nullish(),
        }),
      }),
    )
    const out = data.workflowStateCreate
    if (!out.success || !out.workflowState) {
      throw new LinearError('graphql', `workflowStateCreate failed for "${input.name}"`)
    }
    return { ...pickState(out.workflowState), teamId: input.teamId }
  }

  async issuesUpdatedSince(teamKeys: string[], sinceIso: string): Promise<LinearIssue[]> {
    const filter = { team: { key: { in: teamKeys } }, updatedAt: { gt: sinceIso } }
    const nodes = await this.paginate(
      `query Issues($filter: IssueFilter, $first: Int, $after: String) {
        issues(filter: $filter, first: $first, after: $after, includeArchived: true) {
          nodes { ...IssueFields }
          pageInfo { hasNextPage endCursor }
        }
      }
      ${ISSUE_FIELDS}`,
      { filter },
      z.looseObject({ issues: page(issueNode) }),
      (d) => d.issues,
    )
    return nodes.map(toIssue)
  }

  async issue(idOrIdentifier: string): Promise<LinearIssue | null> {
    try {
      const data = await this.query(
        `query Issue($id: String!) {
          issue(id: $id) { ...IssueFields }
        }
        ${ISSUE_FIELDS}`,
        { id: idOrIdentifier },
        z.looseObject({ issue: issueNode.nullable() }),
      )
      return data.issue ? toIssue(data.issue) : null
    } catch (e) {
      if (e instanceof LinearError && e.code === 'notfound') return null
      throw e
    }
  }

  async comments(issueIds: string[], sinceIso: string | null): Promise<LinearComment[]> {
    const out: LinearComment[] = []
    for (let i = 0; i < issueIds.length; i += PAGE_SIZE) {
      const chunk = issueIds.slice(i, i + PAGE_SIZE)
      const filter: Record<string, unknown> = { issue: { id: { in: chunk } } }
      if (sinceIso !== null) filter.createdAt = { gt: sinceIso }
      const nodes = await this.paginate(
        `query Comments($filter: CommentFilter, $first: Int, $after: String) {
          comments(filter: $filter, first: $first, after: $after) {
            nodes {
              id body createdAt
              issue { id }
              user { id name app }
              botActor { id }
            }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { filter },
        z.looseObject({ comments: page(commentNode) }),
        (d) => d.comments,
      )
      for (const c of nodes) {
        out.push({
          id: c.id,
          issueId: c.issue.id,
          body: c.body,
          createdAt: c.createdAt,
          userId: c.user?.id ?? null,
          userName: c.user?.name ?? null,
          userIsApp: c.user?.app ?? false,
          isBot: c.botActor != null,
        })
      }
    }
    return out
  }

  async setState(issueId: string, stateId: string): Promise<void> {
    await this.updateIssue(issueId, { stateId })
  }

  /** `issueUpdate` with any IssueUpdateInput fields (state, description, …); `id` may be "ENG-12". */
  async updateIssue(issueId: string, input: Record<string, unknown>): Promise<void> {
    const data = await this.query(
      `mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success }
      }`,
      { id: issueId, input },
      z.looseObject({ issueUpdate: z.looseObject({ success: z.boolean() }) }),
    )
    if (!data.issueUpdate.success)
      throw new LinearError('graphql', `issueUpdate failed for ${issueId}`)
  }

  async createIssue(input: {
    /** Client-supplied UUID v4, persisted before the request for recoverable publication. */
    id?: string
    teamId: string
    title: string
    description: string
    stateId?: string
    parentId?: string
    labelIds?: string[]
    priority?: number
  }): Promise<{ id: string; identifier: string; url: string }> {
    const data = await this.query(
      `mutation CreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) { success issue { id identifier url } }
      }`,
      { input },
      z.looseObject({
        issueCreate: z.looseObject({
          success: z.boolean(),
          issue: z
            .looseObject({ id: z.string(), identifier: z.string(), url: z.string() })
            .nullish(),
        }),
      }),
    )
    const out = data.issueCreate
    if (!out.success || !out.issue)
      throw new LinearError('graphql', `issueCreate failed for "${input.title}"`)
    return { id: out.issue.id, identifier: out.issue.identifier, url: out.issue.url }
  }

  /** `issueId` blocks `relatedIssueId` (type `blocks`), or the two are related. */
  async createRelation(input: {
    id?: string
    issueId: string
    relatedIssueId: string
    type: 'blocks' | 'related'
  }): Promise<void> {
    const data = await this.query(
      `mutation CreateRelation($input: IssueRelationCreateInput!) {
        issueRelationCreate(input: $input) { success }
      }`,
      { input },
      z.looseObject({ issueRelationCreate: z.looseObject({ success: z.boolean() }) }),
    )
    if (!data.issueRelationCreate.success)
      throw new LinearError('graphql', `issueRelationCreate failed for ${input.relatedIssueId}`)
  }

  /** Lookup by the client-supplied ID after an uncertain relation-create outcome. */
  async relation(id: string): Promise<{
    id: string
    type: string
    issueId: string
    relatedIssueId: string
  } | null> {
    try {
      const data = await this.query(
        `query Relation($id: String!) {
          issueRelation(id: $id) { id type issue { id } relatedIssue { id } }
        }`,
        { id },
        z.looseObject({
          issueRelation: z
            .looseObject({
              id: z.string(),
              type: z.string(),
              issue: z.looseObject({ id: z.string() }),
              relatedIssue: z.looseObject({ id: z.string() }),
            })
            .nullable(),
        }),
      )
      const r = data.issueRelation
      return r
        ? { id: r.id, type: r.type, issueId: r.issue.id, relatedIssueId: r.relatedIssue.id }
        : null
    } catch (e) {
      if (e instanceof LinearError && e.code === 'notfound') return null
      throw e
    }
  }

  /**
   * The id of a label usable on the team (a workspace label or the team's own), created on the
   * team when missing. Null when it is missing and this identity may not create labels (the
   * OAuth app may not).
   */
  async labelId(teamId: string, name: string, create = true): Promise<string | null> {
    const data = await this.query(
      `query Labels($name: String!) {
        issueLabels(filter: { name: { eqIgnoreCase: $name } }, first: 50) {
          nodes { id name team { id } }
        }
      }`,
      { name },
      z.looseObject({
        issueLabels: z.looseObject({
          nodes: z.array(
            z.looseObject({
              id: z.string(),
              name: z.string(),
              team: z.looseObject({ id: z.string() }).nullish(),
            }),
          ),
        }),
      }),
    )
    const usable = data.issueLabels.nodes.filter((l) => !l.team || l.team.id === teamId)
    const found = usable.find((l) => l.team?.id === teamId) ?? usable[0]
    if (found) return found.id
    if (!create) return null
    let created
    try {
      created = await this.query(
        `mutation CreateLabel($input: IssueLabelCreateInput!) {
        issueLabelCreate(input: $input) { success issueLabel { id } }
      }`,
        { input: { name, teamId } },
        z.looseObject({
          issueLabelCreate: z.looseObject({
            success: z.boolean(),
            issueLabel: z.looseObject({ id: z.string() }).nullish(),
          }),
        }),
      )
    } catch (e) {
      if (e instanceof LinearError && /not allowed/i.test(e.message)) return null
      throw e
    }
    if (!created.issueLabelCreate.success || !created.issueLabelCreate.issueLabel)
      throw new LinearError('graphql', `issueLabelCreate failed for "${name}"`)
    return created.issueLabelCreate.issueLabel.id
  }

  async createComment(input: {
    id: string
    issueId: string
    body: string
  }): Promise<{ id: string }> {
    const data = await this.query(
      `mutation CreateComment($input: CommentCreateInput!) {
        commentCreate(input: $input) { success comment { id } }
      }`,
      { input },
      z.looseObject({
        commentCreate: z.looseObject({
          success: z.boolean(),
          comment: z.looseObject({ id: z.string() }).nullish(),
        }),
      }),
    )
    const out = data.commentCreate
    if (!out.success || !out.comment) {
      throw new LinearError('graphql', `commentCreate failed for ${input.issueId}`)
    }
    return { id: out.comment.id }
  }

  async linkPr(issueId: string, url: string, title?: string): Promise<void> {
    const result = z.looseObject({ success: z.boolean() })
    const variables = { issueId, url, title: title ?? null }
    try {
      // VERIFY: attachmentLinkGitHubPR argument types (String!/String) are from the brief.
      const data = await this.query(
        `mutation LinkPr($issueId: String!, $url: String!, $title: String) {
          attachmentLinkGitHubPR(issueId: $issueId, url: $url, title: $title) { success }
        }`,
        variables,
        z.looseObject({ attachmentLinkGitHubPR: result }),
      )
      if (data.attachmentLinkGitHubPR.success) return
    } catch (e) {
      // Only a rejected mutation falls back; transport, auth and rate-limit errors propagate.
      if (!(e instanceof LinearError) || (e.code !== 'graphql' && e.code !== 'notfound')) throw e
    }
    const data = await this.query(
      `mutation LinkUrl($issueId: String!, $url: String!, $title: String) {
        attachmentLinkURL(issueId: $issueId, url: $url, title: $title) { success }
      }`,
      variables,
      z.looseObject({ attachmentLinkURL: result }),
    )
    if (!data.attachmentLinkURL.success) {
      throw new LinearError('graphql', `attachmentLinkURL failed for ${issueId}`)
    }
  }

  /** Raw escape hatch used by later recipes. */
  async query<T>(
    query: string,
    variables: Record<string, unknown> = {},
    schema?: z.ZodType<T>,
  ): Promise<T> {
    let data: unknown
    try {
      data = await this.send(query, variables)
    } catch (e) {
      if (!(e instanceof LinearError) || e.code !== 'auth' || this.auth.mode !== 'oauth') throw e
      if (this.mintFailures.has(e)) throw e // minting itself failed; do not mint again
      // The token may have been revoked or rotated: mint once and retry once.
      await this.mint(this.auth)
      data = await this.send(query, variables)
    }
    if (!schema) return data as T
    const parsed = schema.safeParse(data)
    if (!parsed.success) {
      throw new LinearError('graphql', `unexpected response shape: ${parsed.error.message}`)
    }
    return parsed.data
  }

  private async paginate<D, N>(
    query: string,
    variables: Record<string, unknown>,
    schema: z.ZodType<D>,
    pick: (d: D) => {
      nodes: N[]
      pageInfo?: { hasNextPage: boolean; endCursor?: string | null } | undefined
    },
  ): Promise<N[]> {
    const all: N[] = []
    let after: string | null = null
    for (;;) {
      const data: D = await this.query(query, { ...variables, first: PAGE_SIZE, after }, schema)
      const p = pick(data)
      all.push(...p.nodes)
      const next = p.pageInfo?.endCursor
      if (!p.pageInfo?.hasNextPage || !next) return all
      after = next
    }
  }

  private async authHeader(): Promise<string> {
    if (this.auth.mode === 'apikey') return this.auth.key // no Bearer prefix for API keys
    const stored = this.store.get()
    if (stored && Date.parse(stored.expiresAt) - this.renewBeforeMs > this.now()) {
      return `Bearer ${stored.token}`
    }
    return `Bearer ${await this.mint(this.auth)}`
  }

  private async mint(auth: { clientId: string; clientSecret: string }): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: auth.clientId,
      client_secret: auth.clientSecret,
      scope: 'read write',
    })
    const res = await this.fetchRaw(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    if (res.status === 429) throw new LinearError('ratelimited', 'token endpoint rate limited', 429)
    let json: unknown = null
    try {
      json = await res.json()
    } catch {
      // handled below via status / schema
    }
    const parsed = tokenResponse.safeParse(json)
    if (!res.ok || !parsed.success) {
      const err = new LinearError(
        'auth',
        `OAuth token request failed (HTTP ${res.status})`,
        res.status,
      )
      this.mintFailures.add(err)
      throw err
    }
    const expiresAt = new Date(this.now() + parsed.data.expires_in * 1000).toISOString()
    this.store.set({ token: parsed.data.access_token, expiresAt })
    return parsed.data.access_token
  }

  private async fetchRaw(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchFn(url, init)
    } catch (e) {
      throw new LinearError('network', `request to ${new URL(url).pathname} failed: ${errMsg(e)}`)
    }
  }

  private async send(query: string, variables: Record<string, unknown>): Promise<unknown> {
    const res = await this.fetchRaw(GRAPHQL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: await this.authHeader() },
      body: JSON.stringify({ query, variables }),
    })
    let json: GraphqlResponse | null = null
    try {
      json = (await res.json()) as GraphqlResponse
    } catch {
      // non-JSON body; classified by status below
    }
    const errors = json?.errors ?? []
    const codes = errors.map((e) => e.extensions?.code)
    const message = errors.map((e) => e.message ?? 'unknown error').join('; ')
    if (res.status === 429 || codes.includes('RATELIMITED')) {
      throw new LinearError('ratelimited', message || 'rate limited', res.status)
    }
    if (res.status === 401 || codes.includes('AUTHENTICATION_ERROR')) {
      throw new LinearError('auth', message || 'authentication failed', res.status)
    }
    if (errors.length > 0) {
      // VERIFY: the exact "Entity not found" wording is taken from the brief.
      const code = errors.some((e) => /entity not found/i.test(e.message ?? ''))
        ? 'notfound'
        : 'graphql'
      throw new LinearError(code, message, res.status)
    }
    if (!res.ok || !json || json.data === undefined) {
      throw new LinearError('graphql', `unexpected response (HTTP ${res.status})`, res.status)
    }
    return json.data
  }
}

const stateNode = z.looseObject({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  position: z.number(),
})
const pickState = (s: z.infer<typeof stateNode>) => ({
  id: s.id,
  name: s.name,
  type: s.type,
  position: s.position,
})

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))
