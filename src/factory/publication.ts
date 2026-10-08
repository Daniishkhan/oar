import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { OarError, usage } from '../errors.js'
import type { LinearClient } from './linear.js'
import {
  orderTickets,
  PlanFileSchema,
  renderPlan,
  renderTicket,
  SPEC_LABEL,
  type IssueRef,
  type PlanFile,
  type PublicationContext,
} from './tickets.js'

export type PublicationLinear = Pick<
  LinearClient,
  | 'teams'
  | 'states'
  | 'issue'
  | 'relation'
  | 'createIssue'
  | 'createRelation'
  | 'updateIssue'
  | 'labelId'
>
type PublishedIssue = IssueRef & { id: string; url: string }

export interface PublicationResult {
  publicationId: string
  contentHash: string
  parent: PublishedIssue | null
  tickets: Array<PublishedIssue & { key: string; after: string[] }>
}

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

/** Hash semantic input, not receipts or JSON formatting. Markdown is part of the input. */
export function publicationSource(
  path: string,
  plan: PlanFile,
): {
  contentHash: string
  sourceFile: string
  document?: { path: string; content: string }
} {
  let document: { path: string; content: string } | undefined
  if (plan.document) {
    if (isAbsolute(plan.document)) throw usage('plan document must be relative to the JSON file')
    try {
      document = {
        path: plan.document,
        content: readFileSync(resolve(dirname(path), plan.document), 'utf8'),
      }
    } catch (e) {
      throw usage(`cannot read plan document ${plan.document}: ${(e as Error).message}`)
    }
    if (!document.content.trim()) throw usage(`plan document ${plan.document} is empty`)
  }
  const contentHash = createHash('sha256')
    .update(JSON.stringify({ team: plan.team, plan: plan.plan, tickets: plan.tickets, document }))
    .digest('hex')
  if (plan.publication && plan.publication.contentHash !== contentHash)
    throw new OarError(
      'state_invalid',
      'Published plan contents changed. An existing publication is immutable.',
      'Restore the original files to resume. For changed scope, copy plan.md and tickets.json to a new plans/<slug>-v2 directory, remove created and publication from the copy, then check and publish the new revision. Retire superseded Linear tickets explicitly.',
    )
  return { contentHash, sourceFile: basename(path), ...(document ? { document } : {}) }
}

/** Same-directory rename prevents torn JSON; fsync also covers a machine crash. */
function savePlan(path: string, plan: PlanFile): void {
  const temporary = `${path}.${randomUUID()}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(temporary, 'wx', statSync(path).mode & 0o777)
    writeFileSync(fd, `${JSON.stringify(plan, null, 2)}\n`)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, path)
    const directory = openSync(dirname(path), 'r')
    try {
      fsyncSync(directory)
    } finally {
      closeSync(directory)
    }
  } finally {
    if (fd !== undefined) closeSync(fd)
    try {
      unlinkSync(temporary)
    } catch {
      // The rename normally removed it. Cleanup must not mask a failed durable write.
    }
  }
}

/** Fail closed for stale locks: never steal a lease from a potentially live publisher. */
function lockPlan(path: string): () => void {
  const lock = `${path}.publish.lock`
  let fd: number
  try {
    fd = openSync(lock, 'wx', 0o600)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    throw new OarError(
      'blocked',
      `Plan publication is locked: ${lock}`,
      'Wait for the publisher to finish. After a crash, inspect the lock host and PID and remove this lock only after confirming that publisher is no longer running.',
    )
  }
  try {
    writeFileSync(
      fd,
      JSON.stringify({ host: hostname(), pid: process.pid, startedAt: new Date().toISOString() }),
    )
    fsyncSync(fd)
  } catch (e) {
    closeSync(fd)
    unlinkSync(lock)
    throw e
  }
  closeSync(fd)
  return () => unlinkSync(lock)
}

/**
 * Application service shared by CLI and future MCP. No stdout, credentials, commits, or pushes.
 * Linear's public SDK schema supports UUID v4 `id` on issue and relation create inputs:
 * https://github.com/linear/linear (published @linear/sdk 97.1.0).
 */
export async function publishPlan(options: {
  path: string
  linear: PublicationLinear
  now?: () => number
  notice?: (message: string) => void
}): Promise<PublicationResult> {
  const path = realpathSync(options.path)
  const release = lockPlan(path)
  try {
    // Read inside the lock. A caller may have loaded stale receipts before another run finished.
    let expectedFile = readFileSync(path, 'utf8')
    const plan = readPlanFile(path)
    const source = publicationSource(path, plan)
    const linear = options.linear
    const notice = options.notice ?? (() => {})
    const order = orderTickets(plan.tickets)
    const save = () => {
      // Editors do not take our publisher lock; preserve their work if the file changes mid-run.
      if (readFileSync(path, 'utf8') !== expectedFile)
        throw new OarError(
          'state_invalid',
          'Plan file changed during publication; no local edits were overwritten',
          'Restore the published definitions and rerun to reconcile the saved operation IDs.',
        )
      savePlan(path, plan)
      expectedFile = readFileSync(path, 'utf8')
    }

    if (!plan.publication) {
      const operations: NonNullable<PlanFile['publication']>['operations'] = {
        ...(plan.plan ? { plan: randomUUID() } : {}),
        tickets: Object.fromEntries(order.map((t) => [t.key, randomUUID()])),
        relations: Object.fromEntries(
          order.flatMap((t) => t.dependsOn.map((d) => [`${d}>${t.key}`, randomUUID()])),
        ),
      }
      // Older files have only receipts. Adopt them only when the remote definitions still match.
      const existing = new Map<string, PublishedIssue>()
      let oldParent: PublishedIssue | null = null
      if (plan.created.plan) {
        oldParent = await linear.issue(plan.created.plan)
        if (!oldParent)
          throw new OarError(
            'state_invalid',
            `${plan.created.plan} (the plan issue) no longer exists`,
          )
        operations.plan = oldParent.id
      }
      for (const t of order) {
        const ref = plan.created.tickets[t.key]
        if (!ref) continue
        const issue = await linear.issue(ref)
        if (!issue) throw new OarError('state_invalid', `${ref} (ticket ${t.key}) no longer exists`)
        const deps = t.dependsOn.map((d) => existing.get(d))
        if (
          deps.some((d) => !d) ||
          issue.title !== t.title ||
          issue.description.trim() !==
            renderTicket(t, { deps: deps as IssueRef[], plan: oldParent }).trim()
        )
          throw new OarError(
            'state_invalid',
            `${ref} differs from this legacy plan; restore its published definition or publish a new plan revision`,
          )
        existing.set(t.key, issue)
        operations.tickets[t.key] = issue.id
      }
      if (oldParent && plan.plan) {
        const issue = await linear.issue(oldParent.id)
        const listed = plan.created.planListed
          ? order.map((t) => ({
              identifier: plan.created.tickets[t.key] ?? '',
              title: t.title,
              after: t.dependsOn.map((d) => plan.created.tickets[d] ?? ''),
            }))
          : []
        if (
          oldParent.title !== plan.plan.title ||
          issue?.description.trim() !== renderPlan(plan.plan, listed).trim()
        )
          throw new OarError(
            'state_invalid',
            `${oldParent.identifier} differs from this legacy plan; restore its published definition or publish a new plan revision`,
          )
      }
      plan.publication = {
        version: 1,
        id: randomUUID(),
        contentHash: source.contentHash,
        startedAt: new Date((options.now ?? Date.now)()).toISOString(),
        operations,
      }
      save() // Intent and all operation IDs MUST reach disk before any remote mutation.
      if (existing.size || oldParent)
        notice(
          'note: adopted legacy issue receipts; existing issue descriptions are preserved, and future changes require a new plan revision',
        )
    }

    const publication = plan.publication
    const context: PublicationContext = { id: publication.id, ...source }
    const [team] = await linear.teams([plan.team])
    if (!team) throw new OarError('config', `Linear team ${plan.team} not found`)
    const states = await linear.states(team.id)
    const backlog =
      states.find((s) => s.type === 'backlog' && s.name === 'Backlog') ??
      states.find((s) => s.type === 'backlog')
    if (!backlog) throw new OarError('config', `team ${plan.team} has no backlog state`)

    const getExisting = async (
      operationId: string | undefined,
      receipt: string | undefined,
    ): Promise<PublishedIssue | null> => {
      if (!operationId)
        throw new OarError(
          'state_invalid',
          'Publication is missing an operation ID; restore the original file',
        )
      const issue = await linear.issue(receipt ?? operationId)
      if (receipt && !issue)
        throw new OarError(
          'state_invalid',
          `${receipt} no longer exists; refusing to recreate a published issue`,
        )
      if (issue && issue.id !== operationId)
        throw new OarError(
          'state_invalid',
          `Publication receipt ${receipt} has an unexpected Linear ID`,
        )
      return issue
    }

    let parent: PublishedIssue | null = null
    if (plan.plan) {
      parent = await getExisting(publication.operations.plan, plan.created.plan)
      if (!parent) {
        const spec = await linear.labelId(team.id, SPEC_LABEL, false)
        if (!spec)
          notice(
            `note: no "${SPEC_LABEL}" label in Linear; create it once in Linear's label settings. The plan issue is still never built, because it has sub-issues.`,
          )
        parent = {
          ...(await linear.createIssue({
            id: publication.operations.plan!,
            teamId: team.id,
            title: plan.plan.title,
            description: renderPlan(plan.plan, [], context),
            stateId: backlog.id,
            ...(spec ? { labelIds: [spec] } : {}),
          })),
          title: plan.plan.title,
        }
      }
      plan.created.plan = parent.identifier
      save()
    }

    const made = new Map<string, PublishedIssue>()
    for (const t of order) {
      let issue = await getExisting(
        publication.operations.tickets[t.key],
        plan.created.tickets[t.key],
      )
      if (!issue) {
        const labelIds: string[] = []
        for (const name of t.labels) {
          const id = await linear.labelId(team.id, name, false)
          if (id) labelIds.push(id)
          else notice(`note: label "${name}" does not exist; ${t.key} is created without it`)
        }
        issue = {
          ...(await linear.createIssue({
            id: publication.operations.tickets[t.key]!,
            teamId: team.id,
            title: t.title,
            description: renderTicket(t, {
              deps: t.dependsOn.map((d) => made.get(d)!),
              plan: parent,
              publication: { ...context, taskKey: t.key },
            }),
            stateId: backlog.id,
            ...(parent ? { parentId: parent.id } : {}),
            ...(labelIds.length ? { labelIds } : {}),
            ...(t.priority !== undefined ? { priority: t.priority } : {}),
          })),
          title: t.title,
        }
      }
      made.set(t.key, issue)
      plan.created.tickets[t.key] = issue.identifier
      save()
    }

    for (const t of order)
      for (const d of t.dependsOn) {
        const tag = `${d}>${t.key}`
        if (plan.created.relations.includes(tag)) continue
        const id = publication.operations.relations[tag]
        if (!id)
          throw new OarError('state_invalid', `Publication is missing the operation ID for ${tag}`)
        const input = {
          id,
          issueId: made.get(d)!.id,
          relatedIssueId: made.get(t.key)!.id,
          type: 'blocks' as const,
        }
        const relation = await linear.relation(id)
        if (
          relation &&
          (relation.issueId !== input.issueId ||
            relation.relatedIssueId !== input.relatedIssueId ||
            relation.type !== input.type)
        )
          throw new OarError(
            'state_invalid',
            `Publication relation ${tag} has unexpected endpoints`,
          )
        if (!relation) await linear.createRelation(input)
        plan.created.relations.push(tag)
        save()
      }

    const tickets = order.map((t) => ({
      ...made.get(t.key)!,
      key: t.key,
      after: t.dependsOn.map((d) => made.get(d)!.identifier),
    }))
    if (parent && plan.plan && !plan.created.planListed) {
      // Setting this deterministic body again after a lost response is safe.
      await linear.updateIssue(parent.id, { description: renderPlan(plan.plan, tickets, context) })
      plan.created.planListed = true
      save()
    }
    return { publicationId: publication.id, contentHash: publication.contentHash, parent, tickets }
  } finally {
    release()
  }
}
