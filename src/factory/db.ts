import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { TokenRecord, TokenStore } from './linear.js'
import {
  ACTIVE_PHASES,
  type Finding,
  type HumanComment,
  type IssueRow,
  type Phase,
  type ReviewVerdict,
} from './types.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  team TEXT NOT NULL,
  repo TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 0,
  labels TEXT NOT NULL DEFAULT '[]',
  kind TEXT NOT NULL DEFAULT 'build',
  linear_state TEXT NOT NULL DEFAULT '',
  linear_state_type TEXT NOT NULL DEFAULT '',
  last_set_state TEXT,
  phase TEXT NOT NULL DEFAULT 'queued',
  round INTEGER NOT NULL DEFAULT 0,
  round_start_sha TEXT,
  round_started_at TEXT,
  task_id TEXT,
  pr_number INTEGER,
  pr_url TEXT,
  handled_ci_sha TEXT,
  ci_rounds INTEGER NOT NULL DEFAULT 0,
  review_cursor TEXT,
  job_started_at TEXT,
  reviewed_sha TEXT,
  review_verdict TEXT,
  review_json TEXT NOT NULL DEFAULT '[]',
  review_rounds INTEGER NOT NULL DEFAULT 0,
  review_round_sha TEXT,
  merge_sha TEXT,
  blocked_by TEXT NOT NULL DEFAULT '[]',
  gone INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  outcome TEXT
);
CREATE INDEX IF NOT EXISTS comments_issue ON comments(issue_id, delivered_at);
CREATE TABLE IF NOT EXISTS own_comments (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  key TEXT NOT NULL,
  status TEXT NOT NULL,
  ts TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS own_comments_key ON own_comments(issue_id, key);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  issue_id TEXT,
  task_id TEXT,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS events_issue ON events(issue_id, id);
CREATE TABLE IF NOT EXISTS cursors (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

/** Columns added after the first live deploy; `migrate()` adds them to an existing database. */
const ADDED_ISSUE_COLUMNS: Array<[string, string]> = [
  ['reviewed_sha', 'TEXT'],
  ['review_verdict', 'TEXT'],
  ['review_json', "TEXT NOT NULL DEFAULT '[]'"],
  ['review_rounds', 'INTEGER NOT NULL DEFAULT 0'],
  ['review_round_sha', 'TEXT'],
  ['merge_sha', 'TEXT'],
]

type Row = Record<string, string | number | null>

const str = (v: unknown) =>
  typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v)
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0))
const nul = (v: unknown) => (v === null || v === undefined ? null : String(v))
const list = (v: unknown): string[] => {
  try {
    const parsed = JSON.parse(str(v) || '[]') as unknown
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

const findings = (v: unknown): Finding[] => {
  try {
    const parsed = JSON.parse(str(v) || '[]') as unknown
    return Array.isArray(parsed) ? (parsed as Finding[]) : []
  } catch {
    return []
  }
}

const verdict = (v: unknown): ReviewVerdict | null =>
  v === 'pass' || v === 'block' || v === 'error' ? v : null

function toIssue(r: Row): IssueRow {
  return {
    id: str(r.id),
    identifier: str(r.identifier),
    team: str(r.team),
    repo: str(r.repo),
    title: str(r.title),
    description: str(r.description),
    url: str(r.url),
    priority: num(r.priority),
    labels: list(r.labels),
    kind: str(r.kind) || 'build',
    linearState: str(r.linear_state),
    linearStateType: str(r.linear_state_type),
    lastSetState: nul(r.last_set_state),
    phase: str(r.phase) as Phase,
    round: num(r.round),
    roundStartSha: nul(r.round_start_sha),
    roundStartedAt: nul(r.round_started_at),
    taskId: nul(r.task_id),
    prNumber: r.pr_number === null || r.pr_number === undefined ? null : num(r.pr_number),
    prUrl: nul(r.pr_url),
    handledCiSha: nul(r.handled_ci_sha),
    ciRounds: num(r.ci_rounds),
    reviewCursor: nul(r.review_cursor),
    jobStartedAt: nul(r.job_started_at),
    reviewedSha: nul(r.reviewed_sha),
    reviewVerdict: verdict(r.review_verdict),
    reviewFindings: findings(r.review_json),
    reviewRounds: num(r.review_rounds),
    reviewRoundSha: nul(r.review_round_sha),
    mergeSha: nul(r.merge_sha),
    blockedBy: list(r.blocked_by),
    gone: num(r.gone) === 1,
    updatedAt: str(r.updated_at),
    createdAt: str(r.created_at),
  }
}

const toComment = (r: Row): HumanComment => ({
  id: str(r.id),
  issueId: str(r.issue_id),
  author: str(r.author),
  body: str(r.body),
  createdAt: str(r.created_at),
})

/** What syncLinear knows about an issue; everything the controller owns is left untouched on upsert. */
export interface IssueSync {
  id: string
  identifier: string
  team: string
  repo: string
  title: string
  description: string
  url: string
  priority: number
  labels: string[]
  kind: string
  linearState: string
  linearStateType: string
  blockedBy: string[]
  gone: boolean
  updatedAt: string
  createdAt: string
}

export type IssuePatch = Partial<
  Pick<
    IssueRow,
    | 'lastSetState'
    | 'phase'
    | 'round'
    | 'roundStartSha'
    | 'roundStartedAt'
    | 'taskId'
    | 'prNumber'
    | 'prUrl'
    | 'handledCiSha'
    | 'ciRounds'
    | 'reviewCursor'
    | 'jobStartedAt'
    | 'reviewedSha'
    | 'reviewVerdict'
    | 'reviewFindings'
    | 'reviewRounds'
    | 'reviewRoundSha'
    | 'mergeSha'
    | 'gone'
  >
>

const COLUMN: Record<keyof IssuePatch, string> = {
  lastSetState: 'last_set_state',
  phase: 'phase',
  round: 'round',
  roundStartSha: 'round_start_sha',
  roundStartedAt: 'round_started_at',
  taskId: 'task_id',
  prNumber: 'pr_number',
  prUrl: 'pr_url',
  handledCiSha: 'handled_ci_sha',
  ciRounds: 'ci_rounds',
  reviewCursor: 'review_cursor',
  jobStartedAt: 'job_started_at',
  reviewedSha: 'reviewed_sha',
  reviewVerdict: 'review_verdict',
  reviewFindings: 'review_json',
  reviewRounds: 'review_rounds',
  reviewRoundSha: 'review_round_sha',
  mergeSha: 'merge_sha',
  gone: 'gone',
}

export interface EventRow {
  id: number
  ts: string
  issueId: string | null
  taskId: string | null
  kind: string
  detail: string
}

/** The controller's store: issues as the factory sees them, comment delivery, idempotency keys, events. */
export class FactoryDb {
  private readonly db: DatabaseSync

  constructor(
    readonly path: string,
    private readonly now: () => number = Date.now,
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA busy_timeout = 5000;')
    this.db.exec(SCHEMA)
    this.migrate()
  }

  /** `CREATE TABLE IF NOT EXISTS` leaves an existing table alone; add the columns it lacks. */
  private migrate(): void {
    const have = new Set(
      (this.db.prepare('PRAGMA table_info(issues)').all() as Row[]).map((r) => str(r.name)),
    )
    for (const [name, ddl] of ADDED_ISSUE_COLUMNS)
      if (!have.has(name)) this.db.exec(`ALTER TABLE issues ADD COLUMN ${name} ${ddl}`)
  }

  close(): void {
    this.db.close()
  }

  private iso = () => new Date(this.now()).toISOString()

  // ---- issues -------------------------------------------------------------------------------

  upsertIssue(i: IssueSync): IssueRow {
    this.db
      .prepare(
        `INSERT INTO issues (id, identifier, team, repo, title, description, url, priority, labels, kind,
           linear_state, linear_state_type, blocked_by, gone, updated_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET identifier = excluded.identifier, team = excluded.team,
           repo = excluded.repo, title = excluded.title, description = excluded.description,
           url = excluded.url, priority = excluded.priority, labels = excluded.labels,
           kind = excluded.kind, linear_state = excluded.linear_state,
           linear_state_type = excluded.linear_state_type, blocked_by = excluded.blocked_by,
           gone = excluded.gone, updated_at = excluded.updated_at`,
      )
      .run(
        i.id,
        i.identifier,
        i.team,
        i.repo,
        i.title,
        i.description,
        i.url,
        i.priority,
        JSON.stringify(i.labels),
        i.kind,
        i.linearState,
        i.linearStateType,
        JSON.stringify(i.blockedBy),
        i.gone ? 1 : 0,
        i.updatedAt,
        i.createdAt,
      )
    return this.issue(i.id)!
  }

  issue(id: string): IssueRow | null {
    const r = this.db.prepare('SELECT * FROM issues WHERE id = ?').get(id) as Row | undefined
    return r ? toIssue(r) : null
  }

  issueByIdentifier(identifier: string): IssueRow | null {
    const r = this.db.prepare('SELECT * FROM issues WHERE identifier = ?').get(identifier) as
      Row | undefined
    return r ? toIssue(r) : null
  }

  issueByTask(taskId: string): IssueRow | null {
    const r = this.db.prepare('SELECT * FROM issues WHERE task_id = ?').get(taskId) as
      Row | undefined
    return r ? toIssue(r) : null
  }

  /** Issues the controller still has to look at, oldest first. */
  activeIssues(): IssueRow[] {
    const marks = [...ACTIVE_PHASES].map(() => '?').join(', ')
    const rows = this.db
      .prepare(`SELECT * FROM issues WHERE phase IN (${marks}) ORDER BY created_at, identifier`)
      .all(...ACTIVE_PHASES) as Row[]
    return rows.map(toIssue)
  }

  countInPhases(repo: string, phases: ReadonlySet<string>): number {
    const marks = [...phases].map(() => '?').join(', ')
    const r = this.db
      .prepare(`SELECT COUNT(*) AS n FROM issues WHERE repo = ? AND phase IN (${marks})`)
      .get(repo, ...phases) as Row
    return num(r.n)
  }

  /** All human comments on an issue, oldest first (for the brief's "discussion so far"). */
  commentsFor(issueId: string): HumanComment[] {
    const rows = this.db
      .prepare('SELECT * FROM comments WHERE issue_id = ? ORDER BY created_at, id')
      .all(issueId) as Row[]
    return rows.map(toComment)
  }

  /** Mirror a state the controller just set, so the next observe does not read it as a human move. */
  setLinearState(id: string, name: string, type: string): void {
    this.db
      .prepare(
        'UPDATE issues SET linear_state = ?, linear_state_type = ?, last_set_state = ? WHERE id = ?',
      )
      .run(name, type, name, id)
  }

  allIssues(): IssueRow[] {
    return (
      this.db.prepare('SELECT * FROM issues ORDER BY created_at, identifier').all() as Row[]
    ).map(toIssue)
  }

  updateIssue(id: string, patch: IssuePatch): IssueRow {
    const sets: string[] = []
    const vals: Array<string | number | null> = []
    for (const [k, v] of Object.entries(patch) as Array<[keyof IssuePatch, unknown]>) {
      if (v === undefined) continue
      sets.push(`${COLUMN[k]} = ?`)
      vals.push(
        typeof v === 'boolean'
          ? v
            ? 1
            : 0
          : Array.isArray(v)
            ? JSON.stringify(v)
            : (v as string | number | null),
      )
    }
    if (sets.length) {
      this.db.prepare(`UPDATE issues SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id)
    }
    return this.issue(id)!
  }

  // ---- human comments ------------------------------------------------------------------------

  /** Record a human comment once; returns true when it was new. */
  addComment(c: HumanComment): boolean {
    const r = this.db
      .prepare(
        'INSERT OR IGNORE INTO comments (id, issue_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(c.id, c.issueId, c.author, c.body, c.createdAt)
    return Number(r.changes) > 0
  }

  undelivered(issueId: string): HumanComment[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM comments WHERE issue_id = ? AND delivered_at IS NULL ORDER BY created_at, id',
      )
      .all(issueId) as Row[]
    return rows.map(toComment)
  }

  markDelivered(id: string, outcome: string): void {
    this.db
      .prepare('UPDATE comments SET delivered_at = ?, outcome = ? WHERE id = ?')
      .run(this.iso(), outcome, id)
  }

  // ---- the controller's own comments (idempotency) -------------------------------------------

  /** Reserve a key for an issue; null when a comment with this key was already sent or reserved. */
  reserveOwnComment(id: string, issueId: string, key: string, body: string): boolean {
    const r = this.db
      .prepare(
        'INSERT OR IGNORE INTO own_comments (id, issue_id, key, status, ts, body) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, issueId, key, 'pending', this.iso(), body)
    return Number(r.changes) > 0
  }

  ownCommentSent(id: string): void {
    this.db.prepare("UPDATE own_comments SET status = 'sent' WHERE id = ?").run(id)
  }

  ownComment(issueId: string, key: string): { id: string; status: string } | null {
    const r = this.db
      .prepare('SELECT id, status FROM own_comments WHERE issue_id = ? AND key = ?')
      .get(issueId, key) as Row | undefined
    return r ? { id: str(r.id), status: str(r.status) } : null
  }

  isOwnComment(id: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM own_comments WHERE id = ?').get(id))
  }

  /** Pending reservations (a crash between the reservation and the Linear call). */
  pendingOwnComments(): Array<{ id: string; issueId: string; key: string; body: string }> {
    const rows = this.db
      .prepare("SELECT id, issue_id, key, body FROM own_comments WHERE status = 'pending'")
      .all() as Row[]
    return rows.map((r) => ({
      id: str(r.id),
      issueId: str(r.issue_id),
      key: str(r.key),
      body: str(r.body),
    }))
  }

  // ---- events and cursors --------------------------------------------------------------------

  event(
    kind: string,
    detail = '',
    issueId: string | null = null,
    taskId: string | null = null,
  ): void {
    this.db
      .prepare('INSERT INTO events (ts, issue_id, task_id, kind, detail) VALUES (?, ?, ?, ?, ?)')
      .run(this.iso(), issueId, taskId, kind, detail)
  }

  events(opts: { issueId?: string; limit?: number; afterId?: number } = {}): EventRow[] {
    const where: string[] = []
    const vals: Array<string | number> = []
    if (opts.issueId) {
      where.push('issue_id = ?')
      vals.push(opts.issueId)
    }
    if (opts.afterId !== undefined) {
      where.push('id > ?')
      vals.push(opts.afterId)
    }
    const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`
    const rows = this.db.prepare(sql).all(...vals, opts.limit ?? 50) as Row[]
    return rows.toReversed().map((r) => ({
      id: num(r.id),
      ts: str(r.ts),
      issueId: nul(r.issue_id),
      taskId: nul(r.task_id),
      kind: str(r.kind),
      detail: str(r.detail),
    }))
  }

  /** Has this event already been recorded for the issue? Used for at-most-once prompts. */
  hasEvent(issueId: string, kind: string, detail: string): boolean {
    return Boolean(
      this.db
        .prepare('SELECT 1 FROM events WHERE issue_id = ? AND kind = ? AND detail = ? LIMIT 1')
        .get(issueId, kind, detail),
    )
  }

  cursor(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM cursors WHERE key = ?').get(key) as Row | undefined
    return r ? str(r.value) : null
  }

  setCursor(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO cursors (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value)
  }

  /** The Linear OAuth token lives in the cursors table. */
  tokenStore(): TokenStore {
    return {
      get: () => {
        const raw = this.cursor('linear.token')
        if (!raw) return null
        try {
          return JSON.parse(raw) as TokenRecord
        } catch {
          return null
        }
      },
      set: (t) => this.setCursor('linear.token', JSON.stringify(t)),
    }
  }
}
