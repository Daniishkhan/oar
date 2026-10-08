import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfigSchema, DEFAULT_CONFIG } from '../../src/config.js'
import { FactoryDb } from '../../src/factory/db.js'
import type { LinearClient, LinearIssue, LinearState } from '../../src/factory/linear.js'
import { Factory } from '../../src/factory/loop.js'
import { loadState } from '../../src/state.js'
import { world } from '../helpers.js'

const HEAD = 'a'.repeat(40)
const MERGE = 'b'.repeat(40)
const NOW = '2026-10-08T09:00:00.000Z'

/** Only external boundaries are fake; ticks, observation, jobs, actions and SQLite are real. */
describe('verified staging lifecycle', () => {
  it('merges, dispatches verification once, survives restart and accepts only the exact correlated run', async () => {
    const config = ConfigSchema.parse({
      ...DEFAULT_CONFIG,
      defaults: { ...DEFAULT_CONFIG.defaults, pollSeconds: 15 },
      repos: {
        engine: {
          ...DEFAULT_CONFIG.repos.engine,
          github: 'o/r',
          deliveryMode: 'staging',
          deployWorkflow: 'deploy.yml',
          verifyWorkflow: 'verify.yml',
          requiredChecks: ['test'],
        },
      },
      factory: {
        ...DEFAULT_CONFIG.factory,
        role: 'controller',
        githubPollSeconds: 15,
        linear: { ...DEFAULT_CONFIG.factory.linear, teams: { ENG: 'engine' } },
      },
    })
    let clock = Date.parse(NOW)
    const w = world({
      config,
      now: () => clock,
      state: {
        tasks: {
          task: {
            id: 'task',
            repo: 'engine',
            slug: 'feature',
            branch: 'codex/feature',
            worktreePath: '/home/user/worktrees/feature',
            status: 'done',
            hours: 10,
            createdAt: NOW,
            briefPath: '/tmp/already-built-brief.md',
            runner: 'herdr',
          },
        },
      },
    })
    const states: LinearState[] = [
      ['Ready', 'unstarted'],
      ['In Progress', 'started'],
      ['In Review', 'started'],
      ['Needs Input', 'started'],
      ['Done', 'completed'],
      ['Canceled', 'canceled'],
    ].map(([name, type], position) => ({
      id: `state-${position}`,
      name: name!,
      type: type!,
      position,
      teamId: 'team',
    }))
    const live: LinearIssue = {
      id: 'issue',
      identifier: 'ENG-1',
      title: 'Ship a feature',
      description: 'Acceptance criteria',
      url: 'https://linear.app/issue/ENG-1',
      priority: 1,
      labels: [],
      teamKey: 'ENG',
      state: { id: states[2]!.id, name: 'In Review', type: 'started' },
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      trashed: false,
      parentId: null,
      hasChildren: false,
      blockedBy: [],
    }
    const moves: string[] = []
    const comments: string[] = []
    const linear = {
      teams: async () => [{ id: 'team', key: 'ENG', name: 'Engine' }],
      states: async () => states,
      issuesUpdatedSince: async () => [live],
      issue: async () => live,
      comments: async () => [],
      createComment: async (input: { id: string; body: string }) => {
        comments.push(input.body)
        return { id: input.id }
      },
      setState: async (_id: string, stateId: string) => {
        const next = states.find((state) => state.id === stateId)!
        live.state = { id: next.id, name: next.name, type: next.type }
        live.updatedAt = new Date(clock).toISOString()
        moves.push(next.name)
      },
    } as unknown as LinearClient
    const pr = {
      number: 7,
      url: 'https://github.com/o/r/pull/7',
      state: 'OPEN',
      isDraft: false,
      headRefOid: HEAD,
      mergeCommit: null as { oid: string } | null,
      updatedAt: NOW,
      reviewDecision: '',
      mergeable: 'MERGEABLE',
    }
    const deployment = {
      id: 11,
      head_sha: MERGE,
      head_branch: 'main',
      status: 'completed',
      conclusion: 'success',
      html_url: 'https://github.com/o/r/actions/runs/11',
      run_started_at: '2026-10-08T09:00:30.000Z',
      updated_at: '2026-10-08T09:01:00.000Z',
    }
    let verificationRuns: unknown[] = []
    let requestKey = ''
    let dispatches = 0
    w.exec
      .on('gh pr list', () => ({ code: 0, stderr: '', stdout: JSON.stringify([pr]) }))
      .on('gh pr merge', () => {
        pr.state = 'MERGED'
        pr.mergeCommit = { oid: MERGE }
        return { code: 0, stderr: '', stdout: '' }
      })
      .on(/check-runs/, {
        stdout: JSON.stringify([
          {
            check_runs: [
              {
                id: 1,
                name: 'test',
                head_sha: HEAD,
                status: 'completed',
                conclusion: 'success',
                app: { id: 15368, slug: 'github-actions' },
              },
            ],
          },
        ]),
      })
      .on(/\/statuses\?/, { stdout: '[[]]' })
      .on('gh api --method POST', (call) => {
        dispatches++
        requestKey = call.args.find((arg) => arg.startsWith('inputs[oar_run_id]='))!.split('=')[1]!
        expect(call.args).toContain(`inputs[expected_sha]=${MERGE}`)
        expect(call.args).toContain('ref=main')
        return { code: 0, stdout: '', stderr: '' }
      })
      .on(/workflows\/deploy\.yml\/runs/, {
        stdout: JSON.stringify([{ workflow_runs: [deployment] }]),
      })
      .on(/workflows\/verify\.yml\/runs/, () => ({
        code: 0,
        stderr: '',
        stdout: JSON.stringify([{ workflow_runs: verificationRuns }]),
      }))
      .on('gh api', { stdout: '[]' })

    const file = join(w.home, 'factory.sqlite')
    let db = new FactoryDb(file, w.ctx.now)
    const logs: string[] = []
    const controller = () => new Factory(w.ctx, { db, linear, log: (line) => logs.push(line) })
    let factory = controller()
    const tick = async () => {
      clock += 15_000
      await factory.runTick()
      await factory.jobs.drain()
    }
    try {
      db.upsertIssue({
        id: live.id,
        identifier: live.identifier,
        team: 'ENG',
        repo: 'engine',
        title: live.title,
        description: live.description,
        url: live.url,
        priority: 1,
        labels: [],
        kind: 'build',
        linearState: 'In Review',
        linearStateType: 'started',
        blockedBy: [],
        gone: false,
        updatedAt: NOW,
        createdAt: NOW,
      })
      db.updateIssue(live.id, {
        phase: 'review',
        taskId: 'task',
        prNumber: 7,
        prUrl: pr.url,
        reviewedSha: HEAD,
        reviewVerdict: 'pass',
        round: 1,
        roundStartSha: HEAD,
        roundStartedAt: NOW,
      })
      db.recordEvidence(live.id, 'review', { sha: HEAD, verdict: 'pass', runner: 'codex' })

      await tick() // Quiet reviewed PR + CI -> controlled merge.
      expect(pr.state).toBe('MERGED')
      expect(db.issue(live.id)?.mergeSha).toBe(HEAD)
      expect(moves).not.toContain('Done')
      await tick() // Observe merged revision, stop/close task, keep Linear In Review.
      expect(db.issue(live.id)).toMatchObject({ phase: 'merged', roundStartSha: MERGE })
      expect(loadState(w.ctx.paths).tasks.task?.status).toBe('closed')
      expect(moves).not.toContain('Done')
      await tick() // Deployment receipt -> one durable verification dispatch.
      expect(db.issue(live.id)?.phase).toBe('verifying')
      expect(dispatches).toBe(1)
      expect(requestKey).toMatch(/^oar-verify-/)
      expect(db.evidence(live.id)).toContainEqual(
        expect.objectContaining({
          stage: 'verification-dispatch',
          data: expect.objectContaining({ requestKey, status: 'accepted' }),
        }),
      )

      // Restart the controller and reopen SQLite before verification becomes visible.
      db.close()
      db = new FactoryDb(file, w.ctx.now)
      factory = controller()
      const verification = {
        ...deployment,
        id: 12,
        html_url: 'https://github.com/o/r/actions/runs/12',
        run_started_at: '2026-10-08T09:01:30.000Z',
        updated_at: '2026-10-08T09:02:00.000Z',
        display_title: `Verify [oar:${requestKey}]`,
      }
      verificationRuns = [{ ...verification, display_title: 'Verify [oar:another-attempt]' }]
      await tick()
      expect(db.issue(live.id)?.phase).toBe('verifying')
      expect(moves).not.toContain('Done')
      verificationRuns = [{ ...verification, head_sha: 'c'.repeat(40) }]
      await tick()
      expect(db.issue(live.id)?.phase).toBe('verifying')
      expect(moves).not.toContain('Done')
      expect(dispatches).toBe(1)

      verificationRuns = [verification]
      await tick()
      expect(db.issue(live.id)?.phase).toBe('closed')
      expect(live.state.name).toBe('Done')
      expect(moves.filter((state) => state === 'Done')).toHaveLength(1)
      expect(db.evidence(live.id).map((item) => item.stage)).toEqual(
        expect.arrayContaining([
          'review',
          'ci',
          'merge',
          'deployment',
          'verification-dispatch',
          'verification',
          'delivery',
        ]),
      )
      expect(db.evidence(live.id)).toContainEqual(
        expect.objectContaining({
          stage: 'delivery',
          data: expect.objectContaining({
            outcome: 'verified',
            sha: MERGE,
            deploymentRunId: 11,
            verificationRunId: 12,
          }),
        }),
      )
      expect(comments.some((comment) => comment.includes(`Verified on staging: ${MERGE}`))).toBe(
        true,
      )
      await tick()
      expect(dispatches).toBe(1)
      expect(moves.filter((state) => state === 'Done')).toHaveLength(1)
      expect(logs.filter((line) => line.includes('failed:'))).toEqual([])
    } finally {
      await factory.jobs.drain()
      db.close()
    }
  })
})
