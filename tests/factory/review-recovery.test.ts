import { describe, expect, it, vi } from 'vitest'
import { ConfigSchema, DEFAULT_CONFIG } from '../../src/config.js'
import { Applier } from '../../src/factory/apply.js'
import { FactoryDb } from '../../src/factory/db.js'
import { Jobs } from '../../src/factory/jobs.js'
import type { LinearClient } from '../../src/factory/linear.js'
import { reviewFiles } from '../../src/factory/review.js'
import { mutateState } from '../../src/state.js'
import { world } from '../helpers.js'

const sha = 'a'.repeat(40)
const taskId = 'eng-1-review'
const sandboxId = 'bx_review'
const files = reviewFiles(taskId)
const output = JSON.stringify({ summary: 'Reviewed.', findings: [] })

function setup() {
  const config = ConfigSchema.parse({
    ...DEFAULT_CONFIG,
    factory: {
      ...DEFAULT_CONFIG.factory,
      review: { ...DEFAULT_CONFIG.factory.review, timeoutMinutes: 1 },
    },
    repos: { engine: { ...DEFAULT_CONFIG.repos.engine, reviewEnvName: 'review-only' } },
  })
  const w = world({
    config,
    now: Date.now,
    state: {
      tasks: {
        [taskId]: {
          id: taskId,
          repo: 'engine',
          slug: taskId,
          branch: `codex/${taskId}`,
          worktreePath: `/home/user/worktrees/${taskId}`,
          status: 'done',
          hours: 1,
          createdAt: new Date().toISOString(),
          briefPath: '/tmp/brief',
          runner: 'herdr',
        },
      },
    },
  })
  const db = new FactoryDb(':memory:', w.ctx.now)
  const issue = db.upsertIssue({
    id: 'issue',
    identifier: 'ENG-1',
    team: 'ENG',
    repo: 'engine',
    title: 'Task',
    description: '',
    url: 'https://linear.app/issue',
    priority: 1,
    labels: [],
    kind: 'build',
    linearState: 'In Review',
    linearStateType: 'started',
    blockedBy: [],
    gone: false,
    updatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  })
  const row = db.updateIssue(issue.id, { phase: 'review', taskId })
  const jobs = new Jobs(w.ctx.now)
  const linear = {
    setState: async () => undefined,
    createComment: async ({ id }: { id: string }) => ({ id }),
  }
  const apply = new Applier(w.ctx, {
    db,
    jobs,
    linear: linear as unknown as LinearClient,
    stateNames: config.factory.linear.states,
    stateId: async (_team, key) => key,
    log: () => undefined,
  })
  const attempt = async () => {
    await apply.apply(db.issue(row.id)!, [{ kind: 'auto_review', sha }])
    await jobs.drain()
  }
  const retry = async () => {
    db.updateIssue(row.id, { phase: 'review', reviewedSha: null, reviewVerdict: null })
    await attempt()
  }
  return { ...w, db, jobs, row, attempt, retry }
}

function completed(
  w: ReturnType<typeof setup>,
  state: 'ready' | 'archived',
  model: string | null = null,
) {
  const identity = { sha, runner: 'codex', model, idempotencyKey: 'persisted-review-key' }
  w.boat.add(sandboxId, {
    state,
    environment: 'review-only',
    archiveAfter: state === 'ready' ? new Date(Date.now() + 900_000) : null,
  })
  w.db.recordEvidence(w.row.id, 'review-attempt', { ...identity, sandboxId, status: 'running' })
  w.db.recordEvidence(w.row.id, 'review-artifacts', {
    ...identity,
    sandboxId,
    headSha: sha,
    output,
    log: '',
    diff: 'diff',
    commits: sha,
    exitCode: 0,
  })
}

function answerReview(w: ReturnType<typeof setup>) {
  const command = w.boat.command.bind(w.boat)
  vi.spyOn(w.boat, 'command').mockImplementation(async (id, req) => {
    if (req.command.includes('codex exec')) {
      for (const [path, content] of [
        [files.out, output],
        [files.log, ''],
        [files.diff, 'diff'],
        [files.commits, sha],
        [`${files.dir}/review-exit.txt`, '0'],
      ])
        w.boat.files.set(`${id}:${path}`, content!)
    }
    return command(id, req)
  })
}

describe('durable review recovery', () => {
  it('checks reviewer independence against the actual pinned builder after configuration changes', async () => {
    const w = setup()
    try {
      await mutateState(w.ctx.paths, (state) => {
        state.tasks[taskId]!.agentKind = 'claude'
      })
      w.ctx.config.repos.engine!.buildRunner = 'codex'
      w.ctx.config.factory.review.runner = 'claude'
      const create = vi.spyOn(w.boat, 'create')
      await w.attempt()
      expect(w.db.issue(w.row.id)?.reviewVerdict).toBe('error')
      expect(create).not.toHaveBeenCalled()
      expect(w.db.events().some((e) => e.detail.includes('different runner'))).toBe(true)
    } finally {
      w.db.close()
    }
  })
  it('reuses the original creation key after a successful create response is lost', async () => {
    const w = setup()
    try {
      const create = vi.spyOn(w.ctx.boat, 'create').mockImplementation(async (req) => {
        const existing = w.boat.sandboxes.get(sandboxId)
        if (existing) return { ...existing }
        w.boat.add(sandboxId, {
          environment: req.environment,
          archiveAfter: new Date(Date.now() + (req.ttlSeconds ?? 960) * 1000),
        })
        throw new Error('create response lost')
      })
      answerReview(w)
      await w.attempt()
      expect(w.db.issue(w.row.id)?.reviewVerdict).toBe('error')
      await w.retry()
      expect(w.db.issue(w.row.id)?.reviewVerdict).toBe('pass')
      expect(create).toHaveBeenCalledTimes(2)
      expect(create.mock.calls[0]?.[1]).toBeTruthy()
      expect(create.mock.calls[1]?.[1]).toBe(create.mock.calls[0]?.[1])
      expect(w.boat.sandboxes.size).toBe(1)
      expect(w.boat.sandboxes.get(sandboxId)?.state).toBe('archived')
    } finally {
      w.db.close()
    }
  })

  it.each(['ready', 'archived'] as const)(
    'recovers persisted artifacts when cleanup status is missing and the sandbox is %s',
    async (state) => {
      const w = setup()
      try {
        completed(w, state)
        const create = vi.spyOn(w.boat, 'create')
        const stop = vi.spyOn(w.boat, 'stop')
        await w.attempt()
        expect(w.db.issue(w.row.id)?.reviewVerdict).toBe('pass')
        expect(create).not.toHaveBeenCalled()
        expect(w.boat.commands).toEqual([])
        expect(stop).toHaveBeenCalledTimes(state === 'ready' ? 1 : 0)
        expect(w.db.evidence(w.row.id).filter((e) => e.stage === 'review-artifacts')).toHaveLength(
          1,
        )
        expect(
          w.db
            .evidence(w.row.id)
            .filter((e) => e.stage === 'review-attempt')
            .at(-1)?.data.status,
        ).toBe('stopped')
      } finally {
        w.db.close()
      }
    },
  )

  it('does not accept persisted output until failed cleanup succeeds', async () => {
    const w = setup()
    try {
      completed(w, 'ready')
      const stop = vi.spyOn(w.boat, 'stop').mockRejectedValueOnce(new Error('stop unavailable'))
      await w.attempt()
      expect(w.db.issue(w.row.id)?.reviewVerdict).toBe('error')
      expect(w.db.issue(w.row.id)?.phase).toBe('needs_input')
      await w.retry()
      expect(stop).toHaveBeenCalledTimes(2)
      expect(w.db.issue(w.row.id)?.reviewVerdict).toBe('pass')
      expect(w.boat.commands).toEqual([])
    } finally {
      w.db.close()
    }
  })

  it('starts a new attempt after the configured reviewer model changes', async () => {
    const w = setup()
    try {
      completed(w, 'ready', 'previous-model')
      const create = vi.spyOn(w.ctx.boat, 'create').mockImplementation(async (req) =>
        w.boat.add('bx_new_review', {
          environment: req.environment,
          archiveAfter: new Date(Date.now() + (req.ttlSeconds ?? 960) * 1000),
        }),
      )
      answerReview(w)
      await w.attempt()
      expect(w.db.issue(w.row.id)?.reviewVerdict).toBe('pass')
      expect(create).toHaveBeenCalledTimes(1)
      expect(create.mock.calls[0]?.[1]).not.toBe('persisted-review-key')
      expect(w.boat.commands.some((c) => c.req.command.includes('codex exec'))).toBe(true)
      expect(w.boat.sandboxes.get(sandboxId)?.state).toBe('archived')
      expect(w.boat.sandboxes.get('bx_new_review')?.state).toBe('archived')
    } finally {
      w.db.close()
    }
  })
})
