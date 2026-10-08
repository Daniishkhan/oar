import { describe, expect, it } from 'vitest'
import { ConfigSchema, DEFAULT_CONFIG } from '../../src/config.js'
import { Applier } from '../../src/factory/apply.js'
import { FactoryDb } from '../../src/factory/db.js'
import { verificationRequestKey } from '../../src/factory/github.js'
import { Jobs } from '../../src/factory/jobs.js'
import type { LinearClient, LinearIssue } from '../../src/factory/linear.js'
import { observeIssue } from '../../src/factory/observe.js'
import { world } from '../helpers.js'

function setup() {
  const config = ConfigSchema.parse({
    ...DEFAULT_CONFIG,
    repos: {
      engine: {
        ...DEFAULT_CONFIG.repos.engine,
        deliveryMode: 'staging',
        requiredChecks: [],
        deployWorkflow: 'deploy.yml',
        verifyWorkflow: 'verify.yml',
      },
    },
  })
  const w = world({ config })
  const db = new FactoryDb(':memory:', w.ctx.now)
  const row = db.upsertIssue({
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
    updatedAt: '2026-10-07T19:00:00Z',
    createdAt: '2026-10-07T19:00:00Z',
  })
  const jobs = new Jobs(w.ctx.now)
  const live = {
    id: row.id,
    labels: [] as string[],
    trashed: false,
    archivedAt: null,
    state: { type: 'started' },
  }
  const linear = {
    issue: async () => live as unknown as LinearIssue,
    setState: async () => undefined,
    createComment: async (input: { id: string }) => ({ id: input.id }),
  }
  const apply = new Applier(w.ctx, {
    db,
    jobs,
    linear: linear as unknown as LinearClient,
    stateNames: config.factory.linear.states,
    stateId: async (_team, key) => key,
    log: () => undefined,
  })
  return { ...w, db, jobs, row, live, apply }
}

const workflow = (id: number, started: string) => ({
  id,
  head_sha: 'merged-sha',
  head_branch: 'main',
  status: 'completed',
  conclusion: 'success',
  html_url: `https://github.com/run/${id}`,
  run_started_at: started,
  updated_at: '2026-10-07T19:30:00Z',
})

describe('delivery observations', () => {
  it('observes exact deploy and verify runs without a task or live builder VM', async () => {
    const w = setup()
    try {
      const row = w.db.updateIssue(w.row.id, { phase: 'verifying', roundStartSha: 'merged-sha' })
      const requestKey = verificationRequestKey(row.id, 'merged-sha', 1, 1, row.roundStartedAt)
      w.db.recordEvidence(row.id, 'verification-dispatch', { requestKey, status: 'intent' })
      w.exec
        .on(/deploy\.yml/, {
          stdout: JSON.stringify([{ workflow_runs: [workflow(1, '2026-10-07T19:00:00Z')] }]),
        })
        .on(/verify\.yml/, {
          stdout: JSON.stringify([
            {
              workflow_runs: [
                {
                  ...workflow(2, '2026-10-07T19:31:00Z'),
                  display_title: `Verify [oar:${requestKey}]`,
                },
              ],
            },
          ]),
        })
      const deps = {
        db: w.db,
        jobs: w.jobs,
        stateKeyOf: () => 'inReview' as const,
        concurrency: () => 1,
        vmState: () => 'down' as const,
        sandboxId: () => null,
        githubDue: true,
      }
      const facts = await observeIssue(w.ctx, row, deps)
      expect(facts.staging).toMatchObject({
        headSha: 'merged-sha',
        runId: 1,
        conclusion: 'success',
      })
      expect(facts.verification).toMatchObject({ headSha: 'merged-sha', runId: 2 })
      expect(facts.agent).toBeNull()
      expect(w.exec.lines()).toHaveLength(2)
      expect(w.exec.lines().every((line) => line.includes('head_sha=merged-sha&branch=main'))).toBe(
        true,
      )
      const quiet = await observeIssue(w.ctx, row, { ...deps, githubDue: false })
      expect(quiet.staging).toBeNull()
      expect(quiet.verification).toBeNull()
      expect(w.exec.lines()).toHaveLength(2)
    } finally {
      w.db.close()
    }
  })
})

describe('merge execution safety', () => {
  const merge = {
    kind: 'merge' as const,
    number: 7,
    sha: 'head',
    method: 'squash' as const,
    isDraft: true,
  }
  async function attempt(w: ReturnType<typeof setup>) {
    const row = w.db.updateIssue(w.row.id, {
      phase: 'review',
      reviewedSha: 'head',
      reviewVerdict: 'pass',
    })
    await w.apply.apply(row, [merge])
    await w.jobs.drain()
  }
  function checks(w: ReturnType<typeof setup>, conclusion: string) {
    w.exec
      .on(/check-runs/, {
        stdout: JSON.stringify([
          {
            check_runs: [
              {
                id: 1,
                name: 'test',
                head_sha: 'head',
                status: 'completed',
                conclusion,
                app: { id: 15368, slug: 'github-actions' },
              },
            ],
          },
        ]),
      })
      .on(/statuses/, { stdout: '[[]]' })
      .on(/\/files\?/, { stdout: '[[]]' })
      .on('gh pr ready', { code: 0 })
      .on('gh pr merge', { code: 0 })
  }

  it('rechecks CI immediately before merging and refuses a changed check result', async () => {
    const w = setup()
    try {
      checks(w, 'cancelled')
      await attempt(w)
      expect(w.exec.lines().some((line) => line.startsWith('gh pr merge'))).toBe(false)
      expect(w.db.issue(w.row.id)?.phase).toBe('needs_input')
      expect(w.db.evidence(w.row.id)).toContainEqual(
        expect.objectContaining({ stage: 'ci', data: expect.objectContaining({ passed: false }) }),
      )
    } finally {
      w.db.close()
    }
  })

  it('merges only using the reviewed commit and successful current checks', async () => {
    const w = setup()
    try {
      checks(w, 'success')
      await attempt(w)
      expect(w.exec.lines().find((line) => line.startsWith('gh pr merge'))).toContain(
        '--match-head-commit head',
      )
      expect(w.db.issue(w.row.id)?.mergeSha).toBe('head')
    } finally {
      w.db.close()
    }
  })

  it('refuses to merge a PR that changes protected paths', async () => {
    const w = setup()
    try {
      w.exec.on(/\/files\?/, {
        stdout: JSON.stringify([[{ filename: '.github/workflows/ci.yml' }]]),
      })
      checks(w, 'success')
      await attempt(w)
      expect(w.exec.lines().some((line) => line.startsWith('gh pr merge'))).toBe(false)
    } finally {
      w.db.close()
    }
  })

  it('honors a newly added hold label before any GitHub mutation', async () => {
    const w = setup()
    try {
      checks(w, 'success')
      w.live.labels.push('HOLD')
      await attempt(w)
      expect(w.exec.lines().some((line) => line.startsWith('gh pr'))).toBe(false)
      expect(w.db.issue(w.row.id)?.phase).toBe('needs_input')
    } finally {
      w.db.close()
    }
  })

  it('waits without reserving the merge while another delivery owns staging', async () => {
    const w = setup()
    try {
      checks(w, 'success')
      const other = w.db.upsertIssue({ ...w.row, id: 'previous', identifier: 'ENG-0' })
      for (const phase of ['merged', 'verifying', 'delivery_failed', 'review'] as const) {
        w.db.updateIssue(other.id, { phase, mergeSha: phase === 'review' ? 'previous-head' : null })
        await attempt(w)
        expect(w.db.issue(w.row.id)?.mergeSha).toBeNull()
        expect(w.exec.lines()).toEqual([])
      }
      w.db.updateIssue(other.id, { phase: 'closed' })
      await attempt(w)
      expect(w.exec.lines().some((line) => line.startsWith('gh pr merge'))).toBe(true)
    } finally {
      w.db.close()
    }
  })

  it('acknowledges delivery retry comments without launching an agent', async () => {
    const w = setup()
    try {
      const c = {
        id: 'reply',
        issueId: w.row.id,
        author: 'human',
        body: 'rerun complete',
        createdAt: '2026-10-07T20:00:00Z',
      }
      w.db.addComment(c)
      await w.apply.apply(w.row, [{ kind: 'acknowledge', comments: [c], reason: 'delivery-retry' }])
      expect(w.db.undelivered(w.row.id)).toEqual([])
      expect(w.exec.lines()).toEqual([])
    } finally {
      w.db.close()
    }
  })
})

describe('verification dispatch recovery', () => {
  it('records intent before the request and never duplicates an uncertain dispatch', async () => {
    const w = setup()
    try {
      const row = w.db.updateIssue(w.row.id, {
        phase: 'verifying',
        roundStartSha: 'merged-sha',
        roundStartedAt: '2026-10-07T20:00:00Z',
      })
      const requestKey = verificationRequestKey(row.id, 'merged-sha', 1, 1, row.roundStartedAt)
      const action = {
        kind: 'verify_staging' as const,
        sha: 'merged-sha',
        deploymentRunId: 1,
        deploymentAttempt: 1,
      }
      w.exec.on(/gh api --method POST/, () => {
        expect(w.db.evidence(row.id)).toContainEqual(
          expect.objectContaining({
            stage: 'verification-dispatch',
            data: expect.objectContaining({ requestKey, status: 'intent' }),
          }),
        )
        return { code: 1, stdout: '', stderr: 'response lost' }
      })
      await w.apply.apply(row, [action])
      await w.jobs.drain()
      await w.apply.apply(row, [action])
      await w.jobs.drain()
      expect(w.exec.lines()).toHaveLength(1)
      expect(w.exec.lines()[0]).toContain(`inputs[oar_run_id]=${requestKey}`)
      expect(w.exec.lines()[0]).toContain('inputs[expected_sha]=merged-sha')
      expect(w.boat.commands).toEqual([])
      expect(w.db.evidence(row.id).at(-1)?.data.status).toBe('unknown')
      const retried = w.db.updateIssue(row.id, { roundStartedAt: '2026-10-07T20:30:00Z' })
      await w.apply.apply(retried, [action])
      await w.jobs.drain()
      expect(w.exec.lines()).toHaveLength(2)
    } finally {
      w.db.close()
    }
  })

  it('does not dispatch an obsolete delivery revision', async () => {
    const w = setup()
    try {
      const row = w.db.updateIssue(w.row.id, { phase: 'verifying', roundStartSha: 'new-sha' })
      await w.apply.apply(row, [
        { kind: 'verify_staging', sha: 'old-sha', deploymentRunId: 1, deploymentAttempt: 1 },
      ])
      await w.jobs.drain()
      expect(w.exec.lines()).toEqual([])
      expect(w.db.evidence(row.id)).toEqual([])
    } finally {
      w.db.close()
    }
  })
})
