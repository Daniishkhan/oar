import { writeFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { taskIdentity } from '../../src/factory/apply.js'
import { vmDoneMarker } from '../../src/brief.js'
import { questionPath, reviewPath } from '../../src/factory/brief.js'
import { FactoryDb } from '../../src/factory/db.js'
import type {
  LinearClient,
  LinearComment,
  LinearIssue,
  LinearState,
} from '../../src/factory/linear.js'
import { Factory } from '../../src/factory/loop.js'
import { LinearError } from '../../src/factory/linear.js'
import { ConfigSchema, DEFAULT_CONFIG } from '../../src/config.js'
import { loadState, mutateState } from '../../src/state.js'
import { world } from '../helpers.js'

const T0 = '2026-10-07T19:00:00.000Z'

/** Enough of Linear to drive the controller: issues, states, comments, state changes. */
class FakeLinear {
  issues: LinearIssue[] = []
  commentList: LinearComment[] = []
  created: Array<{ id: string; issueId: string; body: string }> = []
  moves: Array<{ issueId: string; state: string }> = []
  links: string[] = []
  stateList: LinearState[] = [
    ['Ready', 'unstarted'],
    ['In Progress', 'started'],
    ['Needs Input', 'started'],
    ['In Review', 'started'],
    ['Done', 'completed'],
    ['Canceled', 'canceled'],
  ].map(([name, type], i) => ({
    id: `st-${name}`,
    name: name!,
    type: type!,
    position: i,
    teamId: 'team-ENG',
  }))

  async me() {
    return { id: 'app-1', name: 'oar', app: true }
  }
  async teams() {
    return [{ id: 'team-ENG', key: 'ENG', name: 'Engine' }]
  }
  async states() {
    return this.stateList
  }
  async createState(input: { name: string; type: string }) {
    const s = {
      id: `st-${input.name}`,
      name: input.name,
      type: input.type,
      position: 9,
      teamId: 'team-ENG',
    }
    this.stateList.push(s)
    return s
  }
  async issuesUpdatedSince() {
    return this.issues
  }
  async issue(id: string) {
    return this.issues.find((i) => i.id === id || i.identifier === id) ?? null
  }
  async comments(ids: string[], since: string | null) {
    return this.commentList.filter(
      (c) => ids.includes(c.issueId) && (!since || c.createdAt > since),
    )
  }
  async setState(issueId: string, stateId: string) {
    const st = this.stateList.find((s) => s.id === stateId)!
    this.moves.push({ issueId, state: st.name })
    const i = this.issues.find((x) => x.id === issueId)
    if (i) i.state = { id: st.id, name: st.name, type: st.type }
  }
  async createComment(input: { id: string; issueId: string; body: string }) {
    this.created.push(input)
    return { id: input.id }
  }
  async linkPr(_issueId: string, url: string) {
    this.links.push(url)
  }
  lastComment() {
    return this.created.at(-1)?.body ?? ''
  }
}

const issue = (over: Partial<LinearIssue> = {}): LinearIssue => ({
  id: 'iss-1',
  identifier: 'ENG-1',
  title: 'Add one README sentence',
  description: 'Say hello in the README.',
  priority: 2,
  url: 'https://linear.app/x/issue/ENG-1',
  createdAt: T0,
  updatedAt: T0,
  archivedAt: null,
  trashed: false,
  teamKey: 'ENG',
  state: { id: 'st-Ready', name: 'Ready', type: 'unstarted' },
  labels: [],
  parentId: null,
  hasChildren: false,
  blockedBy: [],
  ...over,
})

/** A worker VM whose Herdr answers like a real one: an agent appears after `agent start`. */
function worker(w: ReturnType<typeof world>) {
  const agent = { status: 'idle', name: '' }
  const pr = { json: '[]' }
  const checks = { json: '{"check_runs":[]}' }
  const merge = { code: 0, stderr: '' }
  const prompts: string[] = []
  const info = () =>
    `{"id":"1","result":{"agent":{"agent_status":"${agent.status}","pane_id":"w1:p1","name":"${agent.name}","workspace_id":"w1"}}}`
  w.exec
    .on('ssh-keygen', () => {
      writeFileSync(w.ctx.paths.pubFile, 'ssh-ed25519 AAAAPUB oar\n')
      return { code: 0, stdout: '', stderr: '' }
    })
    .on('ssh -o BatchMode=yes', { code: 0 })
    .on('herdr --machine engine agent list', () => ({
      code: 0,
      stderr: '',
      stdout: `{"id":"1","result":{"agents":[${agent.name ? info().match(/"agent":(\{.*\})\}\}$/)![1] : ''}]}}`,
    }))
    .on('herdr --machine engine worktree create', {
      stdout:
        '{"id":"1","result":{"workspace":{"workspace_id":"w1"},"root_pane":{"pane_id":"w1:p1"}}}',
    })
    .on(/^herdr --machine engine agent start (\S+)/, (call) => {
      agent.name = call.args[4]!
      return { code: 0, stdout: '{"id":"1","result":{}}', stderr: '' }
    })
    .on(/^herdr --machine engine agent get /, () => ({ code: 0, stderr: '', stdout: info() }))
    .on(/^herdr --machine engine agent read /, { stdout: '{"id":"1","result":{"text":"screen"}}' })
    .on(/^herdr --machine engine agent prompt /, (call) => {
      prompts.push(call.args[5]!)
      agent.status = 'working'
      return { code: 0, stdout: '{"id":"1","result":{}}', stderr: '' }
    })
    .on(/^herdr --machine engine agent send-keys /, { stdout: '{"id":"1","result":{}}' })
    .on(/^herdr --machine engine pane close /, { stdout: '{"id":"1","result":{}}' })
    .on('gh pr list', () => ({ code: 0, stderr: '', stdout: pr.json }))
    .on('gh pr comment', { code: 0, stdout: 'https://github.com/o/r/pull/7#issuecomment-1' })
    .on('gh pr ready', { code: 0 })
    .on('gh pr merge', () => ({ code: merge.code, stdout: '', stderr: merge.stderr }))
    .on(/^gh api (?:--paginate --slurp )?repos\/\S+\/commits\/\S+\/check-runs/, () => ({
      code: 0,
      stderr: '',
      stdout: JSON.stringify([
        {
          check_runs: (
            JSON.parse(checks.json) as { check_runs: Array<Record<string, unknown>> }
          ).check_runs.map((check, index) => ({ id: index + 1, head_sha: 'abc', ...check })),
        },
      ]),
    }))
    .on('gh api', { code: 0, stdout: '[]' })
  return { agent, pr, checks, merge, prompts }
}

function setup() {
  const config = ConfigSchema.parse({
    ...DEFAULT_CONFIG,
    repos: {
      engine: {
        ...DEFAULT_CONFIG.repos.engine!,
        worktreeInit: [],
        deliveryMode: 'merge',
        requiredChecks: [],
      },
    },
    factory: {
      ...DEFAULT_CONFIG.factory,
      // ≤ 10 minutes keeps runCommand synchronous (the detached path polls every 3 s)
      review: { ...DEFAULT_CONFIG.factory.review, timeoutMinutes: 5, isolation: 'worktree' },
      role: 'controller',
      linear: { ...DEFAULT_CONFIG.factory.linear, teams: { ENG: 'engine' }, mention: '@danish' },
    },
  })
  const w = world({ state: { vms: { engine: { sandboxId: 'bx_1', label: 'engine' } } }, config })
  w.boat.add('bx_1', { state: 'running', archiveAfter: new Date(Date.parse(T0) + 10 * 3_600_000) })
  const linear = new FakeLinear()
  const db = new FactoryDb(':memory:', w.ctx.now)
  const log: string[] = []
  const f = new Factory(w.ctx, {
    db,
    linear: linear as unknown as LinearClient,
    log: (l) => log.push(l),
  })
  const vm = worker(w)
  return { w, linear, db, f, log, ...vm }
}

const tick = async (f: Factory) => {
  await f.runTick()
  await f.jobs.drain()
}

describe('Factory end to end (fakes)', () => {
  it('enforces budgets during a tracker outage, retries notification, and grants an explicit PR retry a new budget', async () => {
    const { w, linear, db, f, pr } = setup()
    let now = w.ctx.now()
    w.ctx.now = () => now
    linear.issues.push(issue())
    await tick(f)
    const row = db.issueByIdentifier('ENG-1')!
    await mutateState(w.ctx.paths, (state) => {
      state.tasks[row.taskId!]!.hours = 1
    })
    db.updateIssue(row.id, { prNumber: 7, prUrl: 'https://github.com/o/r/pull/7' })
    now += 3_600_001
    const sync = vi.spyOn(linear, 'issuesUpdatedSince').mockRejectedValue(new Error('tracker down'))
    const comments = vi.spyOn(linear, 'createComment').mockRejectedValue(new Error('tracker down'))
    const states = vi.spyOn(linear, 'setState').mockRejectedValue(new Error('tracker down'))
    await tick(f)
    expect(db.issue(row.id)?.phase).toBe('failed')
    expect(loadState(w.ctx.paths).tasks[row.taskId!]?.status).toBe('closed')
    expect(db.pendingOwnComments()).toHaveLength(1)
    expect(w.exec.lines().some((line) => line.includes('pane close'))).toBe(true)
    sync.mockRestore()
    comments.mockRestore()
    states.mockRestore()
    await tick(f)
    expect(db.issue(row.id)?.linearState).toBe('Needs Input')
    expect(db.pendingOwnComments()).toEqual([])
    expect(linear.lastComment()).toContain('execution budget')
    now += 1000
    linear.issues[0]!.state = { id: 'st-Ready', name: 'Ready', type: 'unstarted' }
    linear.issues[0]!.updatedAt = new Date(now).toISOString()
    pr.json = JSON.stringify([
      {
        number: 7,
        url: 'https://github.com/o/r/pull/7',
        state: 'OPEN',
        isDraft: true,
        headRefOid: 'abc',
        mergeCommit: null,
      },
    ])
    await tick(f)
    expect(db.issue(row.id)?.phase).toBe('building')
    expect(db.issue(row.id)?.roundStartedAt).toBe(new Date(now).toISOString())
    now += 60_000
    await tick(f)
    expect(db.issue(row.id)?.phase).toBe('building')
  })

  it('waits for an active resume until the job limit, then rejects its late completion', async () => {
    const { w, linear, db, f } = setup()
    let now = w.ctx.now()
    w.ctx.now = () => now
    linear.issues.push(issue())
    await tick(f)
    const row = db.issueByIdentifier('ENG-1')!
    await mutateState(w.ctx.paths, (state) => {
      state.tasks[row.taskId!]!.hours = 0.01
    })
    now += 60_000
    db.updateIssue(row.id, { phase: 'resuming', jobStartedAt: new Date(now).toISOString() })
    let release!: () => void
    let entered!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const exec = w.exec.run.bind(w.exec)
    vi.spyOn(w.exec, 'run').mockImplementation(async (cmd, args, opts) => {
      if (cmd === 'herdr' && args.includes('prompt')) {
        entered()
        await pending
      }
      return exec(cmd, args, opts)
    })
    await f.reconcileAll()
    await started
    await f.runTick()
    expect(db.issue(row.id)?.phase).toBe('resuming')
    now += (w.ctx.config.factory.jobTimeoutMinutes + 1) * 60_000
    await f.runTick()
    expect(db.issue(row.id)?.phase).toBe('failed')
    release()
    await f.jobs.drain()
    expect(db.issue(row.id)?.phase).toBe('failed')
    expect(loadState(w.ctx.paths).tasks[row.taskId!]?.status).toBe('closed')
    expect(
      db.evidence(row.id).some((e) => e.stage === 'deadline' && e.data.jobExpired === true),
    ).toBe(true)
  })

  it('pins provider and model before launch and preserves them after an uncertain launch response', async () => {
    const { w, linear, db, f } = setup()
    w.ctx.config.repos.engine!.buildModel = 'original-model'
    linear.issues.push(issue())
    const exec = w.exec.run.bind(w.exec)
    let loseResponse = true
    vi.spyOn(w.exec, 'run').mockImplementation(async (cmd, args, opts) => {
      const result = await exec(cmd, args, opts)
      if (cmd === 'herdr' && args.includes('start') && loseResponse) {
        loseResponse = false
        const task = Object.values(loadState(w.ctx.paths).tasks)[0]!
        expect(task).toMatchObject({ agentKind: 'claude', agentModel: 'original-model' })
        throw new Error('launch response lost')
      }
      return result
    })
    await tick(f)
    expect(db.issueByIdentifier('ENG-1')?.phase).toBe('failed')
    w.ctx.config.repos.engine!.buildRunner = 'codex'
    w.ctx.config.repos.engine!.buildModel = 'new-model'
    linear.issues[0]!.state = { id: 'st-Ready', name: 'Ready', type: 'unstarted' }
    await tick(f)
    const row = db.issueByIdentifier('ENG-1')!
    expect(row.phase).toBe('building')
    expect(loadState(w.ctx.paths).tasks[row.taskId!]?.handle).toMatchObject({
      agentKind: 'claude',
      agentModel: 'original-model',
    })
    expect(
      db
        .evidence(row.id)
        .filter((e) => e.stage === 'input')
        .at(-1)?.data,
    ).toMatchObject({ runner: 'claude', model: 'original-model' })
    expect(w.exec.lines().filter((line) => line.includes('agent start'))).toHaveLength(1)
  })

  it('keeps observation and maintenance ticking through a Linear outage without dispatching stale work', async () => {
    const { w, linear, db, f, agent, log } = setup()
    linear.issues.push(issue())
    linear.issuesUpdatedSince = async () => {
      throw new LinearError('ratelimited', 'retry later', 429)
    }
    f.tick = 3
    w.boat.add('bx_1', { state: 'running', archiveAfter: new Date(w.ctx.now() + 60_000) })
    await tick(f)
    expect(db.cursor('tick.n')).toBe('4')
    expect(db.cursor('tick.at')).toBe(new Date(w.ctx.now()).toISOString())
    expect(agent.name).toBe('')
    expect(log.some((l) => l.includes('maintenance continue'))).toBe(true)
    expect(db.events().some((e) => e.detail.includes('linear:'))).toBe(true)
    await tick(f)
    expect(db.cursor('tick.n')).toBe('5')
  })

  it('polls GitHub when its configured cadence equals the main tick interval', async () => {
    const { w, linear, db, f, pr } = setup()
    w.ctx.config.factory.githubPollSeconds = w.ctx.config.defaults.pollSeconds
    linear.issues.push(issue())
    await tick(f)
    const row = db.issueByIdentifier('ENG-1')!
    db.updateIssue(row.id, { phase: 'review' })
    pr.json = JSON.stringify([
      {
        number: 7,
        url: 'https://github.com/o/r/pull/7',
        state: 'OPEN',
        isDraft: true,
        headRefOid: 'abc',
        mergeCommit: null,
        updatedAt: T0,
      },
    ])
    await tick(f)
    expect(w.exec.calls.some((c) => c.args.some((arg) => arg.includes('/reviews')))).toBe(true)
  })
  it('takes a Ready issue to a draft PR, a review and a merge', async () => {
    const { w, linear, db, f, log, agent, pr, prompts } = setup()
    linear.issues.push(issue())
    await tick(f)
    const row = db.issueByIdentifier('ENG-1')!
    expect(row.phase, log.join('\n')).toBe('building')
    expect(row.round).toBe(1)
    const task = loadState(w.ctx.paths).tasks[row.taskId!]!
    expect(task.branch).toBe(`codex/${taskIdentity(row).slug}`)
    expect(task.status).toBe('working')
    expect(prompts[0]).toContain('brief.md')
    expect(linear.moves.at(-1)?.state).toBe('In Progress')
    expect(linear.lastComment()).toContain('Started on `engine`')
    expect(w.boat.files.get(`bx_1:/home/user/oar/tasks/${task.id}/brief.md`)).toContain(
      'Fixes ENG-1',
    )
    expect(db.issue(row.id)!.lastSetState).toBe('In Progress')

    // the agent finishes: done marker + draft PR
    agent.status = 'idle'
    w.boat.files.set(`bx_1:${vmDoneMarker(task.id)}`, 'x')
    pr.json = JSON.stringify([
      {
        number: 7,
        url: 'https://github.com/o/r/pull/7',
        isDraft: true,
        state: 'OPEN',
        headRefOid: 'abc',
        mergeCommit: null,
        updatedAt: T0,
      },
    ])
    await tick(f)
    expect(db.issue(row.id)!.phase).toBe('review')
    expect(db.issue(row.id)!.prNumber).toBe(7)
    expect(linear.links).toEqual(['https://github.com/o/r/pull/7'])
    expect(linear.moves.at(-1)?.state).toBe('In Review')
    expect(linear.lastComment()).toContain('Draft PR: https://github.com/o/r/pull/7')

    // nothing new: no actions, no duplicate comments
    const before = linear.created.length
    await tick(f)
    expect(linear.created.length).toBe(before)

    // merged
    pr.json = JSON.stringify([
      {
        number: 7,
        url: 'https://github.com/o/r/pull/7',
        isDraft: false,
        state: 'MERGED',
        headRefOid: 'abc',
        mergeCommit: { oid: 'm1' },
        updatedAt: T0,
      },
    ])
    await tick(f)
    expect(db.issue(row.id)!.phase).toBe('closed')
    expect(linear.moves.at(-1)?.state).toBe('Done')
    expect(linear.lastComment()).toContain('Merged')
    expect(loadState(w.ctx.paths).tasks[task.id]!.status).toBe('closed')
    expect(w.exec.lines().some((l) => l.includes('pane close w1:p1'))).toBe(true)
  })

  it('relays a question and sends the answer back as the next round', async () => {
    const { w, linear, db, f, agent, prompts } = setup()
    linear.issues.push(issue())
    await tick(f)
    const row = db.issueByIdentifier('ENG-1')!
    const task = loadState(w.ctx.paths).tasks[row.taskId!]!
    agent.status = 'idle'
    w.boat.files.set(`bx_1:${questionPath(task.id)}`, 'Sort by name or by date?')
    await tick(f)
    expect(db.issue(row.id)!.phase).toBe('needs_input')
    expect(linear.moves.at(-1)?.state).toBe('Needs Input')
    expect(linear.lastComment()).toContain('@danish Sort by name or by date?')
    // a second tick must not post the question again
    const n = linear.created.length
    await tick(f)
    expect(linear.created.length).toBe(n)

    // the human answers in Linear; our own comments are ignored
    linear.commentList.push({
      id: 'own',
      issueId: row.id,
      body: 'ignored',
      createdAt: '2026-10-07T19:30:00.000Z',
      userId: 'app-1',
      userName: 'oar',
      userIsApp: true,
      isBot: false,
    })
    linear.commentList.push({
      id: 'ans',
      issueId: row.id,
      body: 'By date.',
      createdAt: '2026-10-07T19:31:00.000Z',
      userId: 'u1',
      userName: 'danish',
      userIsApp: false,
      isBot: false,
    })
    await tick(f)
    const after = db.issue(row.id)!
    expect(after.phase).toBe('building')
    expect(after.round).toBe(2)
    expect(prompts.at(-1)).toContain('[oar r2]')
    expect(prompts.at(-1)).toContain('By date.')
    expect(linear.moves.at(-1)?.state).toBe('In Progress')
    expect(db.undelivered(row.id)).toEqual([])
    expect(
      w.boat.commands.some(
        (c) => c.req.command.includes('rm -f') && c.req.command.includes('question.md'),
      ),
    ).toBe(true)
  })

  it('stops the agent when the issue is canceled and re-queues when moved back to Ready', async () => {
    const { linear, db, f, agent } = setup()
    linear.issues.push(issue())
    await tick(f)
    const row = db.issueByIdentifier('ENG-1')!
    linear.issues[0]!.state = { id: 'st-Canceled', name: 'Canceled', type: 'canceled' }
    agent.status = 'working'
    await tick(f)
    expect(db.issue(row.id)!.phase).toBe('closed')
    expect(linear.lastComment()).toContain('Canceled')
    linear.issues[0]!.state = { id: 'st-Ready', name: 'Ready', type: 'unstarted' }
    await tick(f)
    expect(db.issue(row.id)!.phase).toBe('building')
    expect(db.issue(row.id)!.round).toBe(2)
  })

  it('records a plan issue (label spec) but never builds it', async () => {
    const { linear, db, f, prompts } = setup()
    linear.issues.push(issue({ labels: ['spec'] }))
    await tick(f)
    expect(db.issueByIdentifier('ENG-1')!.phase).toBe('closed')
    expect(prompts).toEqual([])
    expect(db.events({ limit: 10 }).map((e) => e.kind)).toContain('not-built')
    // moving it again does not re-queue it
    linear.issues[0]!.updatedAt = '2026-10-07T19:05:00.000Z'
    await tick(f)
    expect(db.issueByIdentifier('ENG-1')!.phase).toBe('closed')
  })

  it('treats an issue with sub-issues as a plan even without the label', async () => {
    const { linear, db, f, prompts } = setup()
    linear.issues.push(issue({ hasChildren: true }))
    await tick(f)
    expect(db.issueByIdentifier('ENG-1')!.phase).toBe('closed')
    expect(prompts).toEqual([])
  })

  it("puts the parent plan into a ticket's brief", async () => {
    const { w, linear, db, f } = setup()
    linear.issues.push(
      issue({
        id: 'plan-1',
        identifier: 'ENG-9',
        title: 'Trace requests',
        description: 'The whole plan.',
        labels: ['spec'],
        state: { id: 'st-Backlog', name: 'Backlog', type: 'backlog' },
      }),
      issue({ parentId: 'plan-1' }),
    )
    await tick(f)
    const row = db.issueByIdentifier('ENG-1')!
    expect(row.phase).toBe('building')
    const brief = w.boat.files.get(`bx_1:/home/user/oar/tasks/${row.taskId}/brief.md`)
    expect(brief).toContain('## The plan this ticket belongs to: ENG-9 Trace requests')
    expect(brief).toContain('The whole plan.')
  })

  it('pauses new dispatches but keeps observing', async () => {
    const { w, linear, db, f } = setup()
    writeFileSync(`${w.ctx.paths.stateDir}/factory.paused`, 'x')
    linear.issues.push(issue())
    await tick(f)
    expect(db.issueByIdentifier('ENG-1')!.phase).toBe('queued')
  })
})

describe('Factory automated review and merge (fakes)', () => {
  const prJson = (state: 'OPEN' | 'MERGED', head = 'abc') =>
    JSON.stringify([
      {
        number: 7,
        url: 'https://github.com/o/r/pull/7',
        isDraft: state === 'OPEN',
        state,
        headRefOid: head,
        mergeCommit: state === 'MERGED' ? { oid: 'm1' } : null,
        updatedAt: T0,
        reviewDecision: '',
        mergeable: 'MERGEABLE',
      },
    ])
  const GREEN = JSON.stringify({
    check_runs: [{ name: 'checks', status: 'completed', conclusion: 'success' }],
  })
  const P1 = {
    severity: 'P1',
    file: 'README.md',
    line: 3,
    title: 'Wrong command',
    detail: 'the sentence names a command that does not exist',
    fix: 'say oar factory status',
  }

  /** Ready → building → a draft PR in review with green checks and a reviewer answer waiting. */
  async function inReview(findings: unknown[]) {
    const s = setup()
    s.linear.issues.push(issue())
    await tick(s.f) // 1: dispatch
    const row = s.db.issueByIdentifier('ENG-1')!
    const task = loadState(s.w.ctx.paths).tasks[row.taskId!]!
    s.agent.status = 'idle'
    s.w.boat.files.set(`bx_1:${vmDoneMarker(task.id)}`, 'x')
    s.pr.json = prJson('OPEN')
    await tick(s.f) // 2: review
    expect(s.db.issue(row.id)!.phase).toBe('review')
    s.checks.json = GREEN
    s.w.boat.files.set(
      `bx_1:/home/user/oar/tasks/${task.id}/review-out.json`,
      JSON.stringify({ summary: 'Small README change.', findings }),
    )
    return { ...s, row, task }
  }

  it('reviews a green PR, merges it, and closes the issue', async () => {
    const { w, f, db, linear, row, pr } = await inReview([])
    await tick(f) // 3: green → automated review
    const reviewed = db.issue(row.id)!
    expect(reviewed).toMatchObject({ reviewedSha: 'abc', reviewVerdict: 'pass', phase: 'review' })
    const run = w.boat.commands.find((c) => c.req.command.includes('codex exec'))
    expect(run?.req.command).toContain('-s read-only')
    expect(
      w.boat.commands.some((c) =>
        c.req.command.includes('-c core.hooksPath=/dev/null worktree add -f --detach'),
      ),
    ).toBe(true)
    expect(w.exec.lines().some((l) => l.startsWith('gh pr comment 7 --repo'))).toBe(true)
    expect(w.exec.calls.find((c) => c.args[1] === 'comment')!.opts).toMatchObject({
      input: expect.stringContaining('<!-- oar -->'),
    })
    expect(linear.lastComment()).toContain('no findings')
    expect(linear.lastComment()).toContain('merges next')

    await tick(f) // 4: no GitHub reads this tick
    await tick(f) // 5: merge
    expect(w.exec.lines().some((l) => l.startsWith('gh pr ready 7'))).toBe(true)
    const mergeLine = w.exec.lines().find((l) => l.startsWith('gh pr merge 7'))
    expect(mergeLine).toContain('--squash --delete-branch --match-head-commit abc')
    expect(db.issue(row.id)!.mergeSha).toBe('abc')
    await tick(f) // 6: nothing new; no second merge
    expect(w.exec.lines().filter((l) => l.startsWith('gh pr merge')).length).toBe(1)

    pr.json = prJson('MERGED')
    await tick(f)
    expect(db.issue(row.id)!.phase).toBe('closed')
    expect(linear.moves.at(-1)?.state).toBe('Done')
    expect(db.events({ issueId: row.id, limit: 100 }).map((e) => e.kind)).toEqual(
      expect.arrayContaining(['review-start', 'review', 'merge-start', 'merged-by-oar', 'merged']),
    )
  })

  it('sends blocking findings back to the agent and asks a human when the round pushes nothing', async () => {
    const { w, f, db, linear, row, task, agent, prompts } = await inReview([P1])
    await tick(f) // 3: review → block
    expect(db.issue(row.id)).toMatchObject({ reviewVerdict: 'block', reviewedSha: 'abc' })
    expect(linear.lastComment()).toContain('[P1] Wrong command')
    await tick(f) // 4: no GitHub reads
    await tick(f) // 5: review round 2
    const after = db.issue(row.id)!
    expect(after).toMatchObject({
      phase: 'building',
      round: 2,
      reviewRounds: 1,
      reviewRoundSha: 'abc',
    })
    expect(w.boat.files.get(`bx_1:${reviewPath(task.id, 2)}`)).toContain('[P1, **blocking**]')
    expect(prompts.at(-1)).toContain('[oar r2]')
    expect(w.exec.lines().some((l) => l.startsWith('gh pr merge'))).toBe(false)

    // the agent stops without pushing (the stale done marker stays in the fake VM)
    agent.status = 'idle'
    await tick(f) // 6: noop round → review
    await tick(f) // 7: blocking findings stand → Needs Input
    expect(db.issue(row.id)!.phase).toBe('needs_input')
    expect(db.ownComment(row.id, 'review-noop-abc')?.status).toBe('sent')
    expect(linear.moves.at(-1)?.state).toBe('Needs Input')
    const n = linear.moves.length
    await tick(f)
    await tick(f)
    expect(linear.moves.length).toBe(n)
  })

  it('parks the issue when GitHub refuses the merge, without retrying elsewhere', async () => {
    const { w, f, db, linear, row, merge } = await inReview([])
    merge.code = 1
    merge.stderr = 'Pull request #7 is not mergeable: the base branch policy prohibits the merge'
    await tick(f) // 3: review
    await tick(f) // 4
    await tick(f) // 5: merge refused
    const r = db.issue(row.id)!
    expect(r.phase).toBe('needs_input')
    expect(r.mergeSha).toBe('abc')
    expect(linear.lastComment()).toContain('Could not merge')
    expect(linear.lastComment()).toContain('policy prohibits')
    expect(w.boat.commands.some((c) => c.req.command.startsWith('gh '))).toBe(false)
  })

  it('records a failed reviewer once and asks a human', async () => {
    const { w, f, db, linear, row, task } = await inReview([])
    w.boat.files.delete(`bx_1:/home/user/oar/tasks/${task.id}/review-out.json`)
    w.boat.commandRules.push({ re: /codex exec/, result: { exitCode: 1 } })
    w.boat.files.set(`bx_1:/home/user/oar/tasks/${task.id}/review-log.txt`, 'error: not logged in')
    await tick(f)
    const r = db.issue(row.id)!
    expect(r).toMatchObject({ phase: 'needs_input', reviewVerdict: 'error', reviewedSha: 'abc' })
    expect(linear.lastComment()).toContain('automated review')
    expect(linear.lastComment()).toContain('not logged in')
    expect(w.exec.lines().some((l) => l.startsWith('gh pr merge'))).toBe(false)
  })
})
