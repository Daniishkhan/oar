import { writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { taskIdentity } from '../../src/factory/apply.js'
import { vmDoneMarker } from '../../src/brief.js'
import { questionPath } from '../../src/factory/brief.js'
import { FactoryDb } from '../../src/factory/db.js'
import type {
  LinearClient,
  LinearComment,
  LinearIssue,
  LinearState,
} from '../../src/factory/linear.js'
import { Factory } from '../../src/factory/loop.js'
import { ConfigSchema, DEFAULT_CONFIG } from '../../src/config.js'
import { loadState } from '../../src/state.js'
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
  blockedBy: [],
  ...over,
})

/** A worker VM whose Herdr answers like a real one: an agent appears after `agent start`. */
function worker(w: ReturnType<typeof world>) {
  const agent = { status: 'idle', name: '' }
  const pr = { json: '[]' }
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
    .on('gh api', { code: 0, stdout: '[]' })
  return { agent, pr, prompts }
}

function setup() {
  const config = ConfigSchema.parse({
    ...DEFAULT_CONFIG,
    repos: { engine: { ...DEFAULT_CONFIG.repos.engine!, worktreeInit: [] } },
    factory: {
      ...DEFAULT_CONFIG.factory,
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

  it('pauses new dispatches but keeps observing', async () => {
    const { w, linear, db, f } = setup()
    writeFileSync(`${w.ctx.paths.stateDir}/factory.paused`, 'x')
    linear.issues.push(issue())
    await tick(f)
    expect(db.issueByIdentifier('ENG-1')!.phase).toBe('queued')
  })
})
