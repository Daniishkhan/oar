import { BoatApi, type CommandRequest, type CreateSandboxRequest } from '@boatdev/sdk'
import { describe, expect, it, vi } from 'vitest'
import { realBoat } from '../../src/boat.js'
import { DEFAULT_CONFIG } from '../../src/config.js'
import {
  isolatedReviewCheckout,
  reviewPreflight,
  runIsolatedReview,
  type IsolatedReviewOptions,
  type ReviewSandboxEvidence,
} from '../../src/factory/review-sandbox.js'
import { reviewFiles } from '../../src/factory/review.js'
import type { IssueRow } from '../../src/factory/types.js'
import { FakeBoat } from '../fakes/boat.js'

const sha = 'abcde12345'.repeat(4)
const taskId = 'eng-1-review'
const files = reviewFiles(taskId)
const good = JSON.stringify({ summary: 'Reviewed the change.', findings: [] })

class ReviewBoat extends FakeBoat {
  creates: Array<{ req: CreateSandboxRequest; key?: string }> = []
  stopped: string[] = []
  answer = good
  exit = 0
  lifecycle: string[] = []

  override async create(req: CreateSandboxRequest, key?: string) {
    this.creates.push({ req, key })
    const s = await super.create(req)
    this.sandboxes.get(s.id)!.state = 'ready'
    return { ...s, state: 'ready' as const }
  }

  override async command(id: string, req: CommandRequest) {
    if (req.command.includes('codex exec')) {
      this.files.set(`${id}:${files.out}`, this.answer)
      this.files.set(`${id}:${files.log}`, 'review log')
      this.files.set(`${id}:${files.diff}`, 'the exact diff')
      this.files.set(`${id}:${files.commits}`, sha)
      this.files.set(`${id}:${files.dir}/review-exit.txt`, String(this.exit))
      if (this.exit)
        return { exitCode: this.exit, stdout: '', stderr: '', timedOut: this.exit === 124 }
    }
    return super.command(id, req)
  }

  override async stop(id: string) {
    this.lifecycle.push('stop')
    this.stopped.push(id)
    await super.stop(id)
  }
}

function setup() {
  const boat = new ReviewBoat()
  const evidence: ReviewSandboxEvidence[] = []
  const opts: IsolatedReviewOptions = {
    cfg: DEFAULT_CONFIG.repos.engine!,
    row: {
      identifier: 'ENG-1',
      title: 'A change',
      description: '',
      prUrl: 'https://github.com/o/r/pull/1',
    } as IssueRow,
    taskId,
    headSha: sha,
    branch: 'codex/eng-1-review',
    runner: 'codex',
    blocking: ['P0', 'P1'],
    timeoutSeconds: 60,
    environment: 'review-only',
    attempt: { idempotencyKey: `review-${sha}-1` },
    onSandbox: async () => {
      boat.lifecycle.push('persist-id')
    },
    onEvidence: async (e) => {
      boat.lifecycle.push('persist-evidence')
      evidence.push(e)
    },
    onStopped: async () => {
      boat.lifecycle.push('persist-stop')
    },
  }
  return { boat, opts, evidence }
}

describe('isolated reviews', () => {
  it('uses a separate disposable environment and durable callbacks before cleanup', async () => {
    const { boat, opts, evidence } = setup()
    boat.add('builder', { environment: opts.cfg.envName })
    const result = await runIsolatedReview(boat, opts)
    expect(result.out.findings).toEqual([])
    expect(boat.creates).toEqual([
      {
        req: { environment: 'review-only', type: 'small', snapshots: false, ttlSeconds: 960 },
        key: `review-${sha}-1`,
      },
    ])
    expect(boat.commands.every((c) => c.id !== 'builder')).toBe(true)
    expect(boat.lifecycle).toEqual(['persist-id', 'persist-evidence', 'stop', 'persist-stop'])
    expect(evidence[0]).toMatchObject({
      headSha: sha,
      output: good,
      log: 'review log',
      diff: 'the exact diff',
      commits: sha,
      exitCode: 0,
    })
    expect(boat.commands.find((c) => c.req.command.includes('clone'))?.req.command).toContain(
      `test "$(git -C '${files.dir}/checkout' rev-parse HEAD)" = '${sha}'`,
    )
  })

  it.each([undefined, DEFAULT_CONFIG.repos.engine!.envName])(
    'rejects missing or builder environment %s before creation',
    async (environment) => {
      const { boat, opts } = setup()
      await expect(runIsolatedReview(boat, { ...opts, environment })).rejects.toThrow(
        /reviewEnvName distinct/,
      )
      expect(boat.creates).toHaveLength(0)
    },
  )

  it('rejects unknown environments and credential forwarding before creating a sandbox', async () => {
    const unknown = setup()
    await expect(
      runIsolatedReview(unknown.boat, { ...unknown.opts, environment: 'missing' }),
    ).rejects.toThrow(/existing Boat environment/)
    expect(unknown.boat.creates).toHaveLength(0)
    for (const flag of ['passGithub', 'passSandboxCredentials'] as const) {
      const { boat, opts } = setup()
      boat.environmentList.find((environment) => environment.name === 'review-only')![flag] = true
      await expect(runIsolatedReview(boat, opts)).rejects.toThrow(/explicitly disable/)
      expect(boat.creates).toHaveLength(0)
      expect(boat.commands).toHaveLength(0)
    }
  })

  it('stops a recovered sandbox when its environment policy can no longer be trusted', async () => {
    const { boat, opts } = setup()
    boat.add('prior', { environment: 'review-only', archiveAfter: new Date(Date.now() + 900_000) })
    boat.environmentList.find((environment) => environment.name === 'review-only')!.passGithub =
      true
    await expect(
      runIsolatedReview(boat, { ...opts, attempt: { ...opts.attempt, sandboxId: 'prior' } }),
    ).rejects.toThrow(/explicitly disable/)
    expect(boat.creates).toHaveLength(0)
    expect(boat.commands).toHaveLength(0)
    expect(boat.stopped).toEqual(['prior'])
  })

  it('stops a sandbox whose pinned environment differs from the inspected policy', async () => {
    const { boat, opts } = setup()
    const create = boat.create.bind(boat)
    vi.spyOn(boat, 'create').mockImplementation(async (request, key) => {
      const sandbox = await create(request, key)
      boat.sandboxes.get(sandbox.id)!.environmentVersion = 2
      return { ...sandbox, environmentVersion: 2 }
    })
    await expect(runIsolatedReview(boat, opts)).rejects.toThrow(/environment\/version differs/)
    expect(boat.stopped).toHaveLength(1)
    expect(boat.commands).toHaveLength(0)
  })

  it('keeps raw environment secrets outside the BoatClient metadata boundary', async () => {
    const { boat } = setup()
    const env = boat.environmentList.find((environment) => environment.name === 'review-only')!
    const api = vi.spyOn(BoatApi.prototype, 'environments').mockResolvedValue({
      environments: [
        {
          ...env,
          versions: [],
          envContents: 'private-env-sentinel',
          secretFiles: [{ contents: 'private-file-sentinel' }],
        },
      ],
    } as never)
    try {
      const result = await realBoat('unused-test-key').environments()
      expect(result).toEqual([env])
      expect(JSON.stringify(result)).not.toContain('sentinel')
      expect(result[0]).not.toHaveProperty('envContents')
      expect(result[0]).not.toHaveProperty('secretFiles')
    } finally {
      api.mockRestore()
    }
  })

  it.each([
    ['{}', 0],
    [good, 124],
    ['not json', 0],
  ] as const)(
    'persists failure evidence and stops on malformed output or timeout',
    async (answer, exit) => {
      const { boat, opts, evidence } = setup()
      boat.answer = answer
      boat.exit = exit
      await expect(runIsolatedReview(boat, opts)).rejects.toThrow()
      expect(boat.stopped).toHaveLength(1)
      expect(evidence[0]?.output).toBe(answer)
      expect(evidence[0]?.error).toBeTruthy()
    },
  )

  it('stops even when recording the sandbox or evidence fails', async () => {
    for (const callback of ['onSandbox', 'onEvidence'] as const) {
      const { boat, opts } = setup()
      opts[callback] = async () => {
        throw new Error('database unavailable')
      }
      await expect(runIsolatedReview(boat, opts)).rejects.toThrow('database unavailable')
      expect(boat.stopped).toHaveLength(1)
    }
  })

  it('fails closed when stop fails and leaves the configured TTL as a backstop', async () => {
    const { boat, opts, evidence } = setup()
    vi.spyOn(boat, 'stop').mockRejectedValue(new Error('stop unavailable'))
    const stopped = vi.fn(opts.onStopped)
    opts.onStopped = stopped
    await expect(runIsolatedReview(boat, opts)).rejects.toThrow('stop unavailable')
    expect(evidence[0]?.exitCode).toBe(0)
    expect(stopped).not.toHaveBeenCalled()
    expect(boat.creates[0]?.req.ttlSeconds).toBe(960)
  })

  it('recovers completed output after a controller restart without rerunning the reviewer', async () => {
    const { boat, opts } = setup()
    boat.add('prior', { archiveAfter: new Date(Date.now() + 900_000), environment: 'review-only' })
    boat.files.set(`prior:${files.dir}/review-head.txt`, sha)
    boat.files.set(`prior:${files.dir}/review-exit.txt`, '0')
    boat.files.set(`prior:${files.out}`, good)
    boat.files.set(`prior:${files.diff}`, 'diff')
    boat.files.set(`prior:${files.commits}`, sha)
    const result = await runIsolatedReview(boat, {
      ...opts,
      attempt: { ...opts.attempt, sandboxId: 'prior' },
    })
    expect(result.out.findings).toEqual([])
    expect(boat.creates).toHaveLength(0)
    expect(boat.commands).toHaveLength(0)
    expect(boat.stopped).toEqual(['prior'])
  })

  it('stops an interrupted attempt instead of running another agent over it', async () => {
    const { boat, opts, evidence } = setup()
    boat.add('prior', { archiveAfter: new Date(Date.now() + 900_000), environment: 'review-only' })
    boat.files.set(`prior:${files.dir}/review-head.txt`, sha)
    await expect(
      runIsolatedReview(boat, { ...opts, attempt: { ...opts.attempt, sandboxId: 'prior' } }),
    ).rejects.toThrow(/interrupted/)
    expect(boat.commands).toHaveLength(0)
    expect(boat.stopped).toEqual(['prior'])
    expect(evidence[0]?.error).toMatch(/interrupted/)
  })

  it('fails before executing commands when authentication or the deadline is absent', async () => {
    const { boat, opts } = setup()
    boat.commandRules.push({ re: /command -v codex/, result: { exitCode: 1 } })
    await expect(runIsolatedReview(boat, opts)).rejects.toThrow(/model authentication/)
    expect(boat.commands).toHaveLength(1)
    expect(boat.stopped).toHaveLength(1)
    const other = setup()
    other.boat.add('no-ttl', { archiveAfter: null })
    await expect(
      runIsolatedReview(other.boat, {
        ...other.opts,
        attempt: { idempotencyKey: 'r', sandboxId: 'no-ttl' },
      }),
    ).rejects.toThrow(/hard auto-stop/)
    expect(other.boat.stopped).toEqual(['no-ttl'])
  })

  it('does not execute project setup scripts or copy builder authentication', () => {
    const cfg = DEFAULT_CONFIG.repos.engine!
    const command = isolatedReviewCheckout({
      cfg,
      cwd: '/review',
      taskId,
      headSha: sha,
      branch: 'codex/a',
    })
    expect(command).toContain('-c core.hooksPath=/dev/null clone --no-checkout')
    expect(command).toContain('diff --no-ext-diff --no-textconv')
    expect(command).not.toContain(cfg.setupScript)
    expect(command).not.toContain('cp ')
    expect(reviewPreflight('codex')).toContain('codex login status >/dev/null')
    expect(reviewPreflight('claude')).toContain('ANTHROPIC_API_KEY')
  })
})
