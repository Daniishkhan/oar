import type { LiveAgent } from '../runner.js'

export type MergeMethod = 'squash' | 'merge' | 'rebase'

/** The controller's own view of an issue; Linear's state is an input, the phase is ours. */
export const Phases = [
  'queued',
  'dispatching',
  'building',
  'needs_input',
  'review',
  'resuming',
  'merged',
  'verifying',
  'delivery_failed',
  'closed',
  'failed',
] as const
export type Phase = (typeof Phases)[number]
export const ACTIVE_PHASES: ReadonlySet<Phase> = new Set([
  'queued',
  'dispatching',
  'building',
  'needs_input',
  'review',
  'resuming',
  'merged',
  'verifying',
  'delivery_failed',
])
/** Phases during which the worker VM must stay up. */
export const HOLDING_PHASES: ReadonlySet<Phase> = new Set(['dispatching', 'building', 'resuming'])
/** Phases that occupy a repo slot (one agent per VM until forks exist). */
export const SLOT_PHASES: ReadonlySet<Phase> = new Set(['dispatching', 'building', 'resuming'])
/** Phases between a merge and a verified (or failed) staging delivery. */
export const DELIVERY_PHASES: ReadonlySet<Phase> = new Set([
  'merged',
  'verifying',
  'delivery_failed',
])

/** Logical states; their Linear names live in config.factory.linear.states. */
export const StateKeys = [
  'ready',
  'inProgress',
  'needsInput',
  'inReview',
  'done',
  'canceled',
] as const
export type StateKey = (typeof StateKeys)[number]

export interface IssueRow {
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
  lastSetState: string | null
  phase: Phase
  round: number
  roundStartSha: string | null
  roundStartedAt: string | null
  taskId: string | null
  prNumber: number | null
  prUrl: string | null
  handledCiSha: string | null
  ciRounds: number
  reviewCursor: string | null
  jobStartedAt: string | null
  /** The head SHA the automated reviewer last judged, and its verdict and findings. */
  reviewedSha: string | null
  reviewVerdict: ReviewVerdict | null
  reviewFindings: Finding[]
  /** Automated review rounds so far, and the head the last one was started for. */
  reviewRounds: number
  reviewRoundSha: string | null
  /** The head SHA a merge was attempted for (at most once per SHA). */
  mergeSha: string | null
  blockedBy: string[]
  gone: boolean
  updatedAt: string
  createdAt: string
}

export type Severity = 'P0' | 'P1' | 'P2' | 'P3'
export type ReviewVerdict = 'pass' | 'block' | 'error'

/** One item from the automated reviewer. */
export interface Finding {
  severity: Severity
  file: string
  line?: number | null
  title: string
  detail: string
  fix?: string | null
}

export interface HumanComment {
  id: string
  issueId: string
  author: string
  body: string
  createdAt: string
}

export interface PrSnapshot {
  number: number
  url: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  isDraft: boolean
  headSha: string
  mergeSha: string | null
  updatedAt: string
  /** GitHub's review decision: '' | APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED. */
  reviewDecision: string
  /** MERGEABLE | CONFLICTING | UNKNOWN. */
  mergeable: string
}

export interface ReviewComment {
  id: string
  author: string
  body: string
  createdAt: string
  kind: 'review' | 'inline' | 'conversation'
  path?: string
  line?: number
  /** Set on findings from the automated reviewer. */
  severity?: Severity
  blocking?: boolean
}

export interface WorkflowSnapshot {
  headSha: string
  status: string
  conclusion: string | null
  url: string
  runId: number
  attempt: number
  startedAt: string | null
  completedAt: string | null
  runName?: string
}

export interface Facts {
  /** null: no VM recorded for the repo. */
  vmUp: boolean | null
  /** null: no task dispatched yet. */
  agent: LiveAgent | 'vm-down' | null
  pr: PrSnapshot | null
  marker: boolean
  question: string | null
  paneTail: string
  undelivered: HumanComment[]
  review: { comments: ReviewComment[]; changesRequested: boolean; cursor: string | null }
  ci: {
    headSha: string
    failed: string[]
    pending: boolean
    passed: boolean
    missing?: string[]
    checks?: Array<{ name: string; state: string; source: 'check' | 'status'; app?: string }>
  } | null
  staging: WorkflowSnapshot | null
  verification: WorkflowSnapshot | null
  verificationRequested: boolean
  /** Where the issue's Linear state sits in our model right now. */
  linearKey: StateKey | 'other'
  /** The Linear state differs from the one the controller last set (a human or an automation moved it). */
  humanMoved: boolean
  nowIso: string
  slotFree: boolean
  /**
   * Another issue of the repo is between its merge and a verified delivery (staging mode), so a
   * second merge would move the base branch under that verification: one delivery at a time.
   */
  deliveryBusy: boolean
  jobRunning: boolean
  jobAgeMs: number
  /** Issues this one is blocked by that are not done yet. */
  blocked: boolean
  /** How long the agent has been idle without interruption, as this controller saw it (0 when not idle). */
  idleForMs: number
}

export interface Limits {
  maxCiRounds: number
  jobTimeoutMs: number
  deliveryTimeoutMs: number
  maxReviewRounds: number
  /** An idle agent without the done marker or a question is reported as stalled only after this long. */
  stallGraceMs: number
}

export type Action =
  | { kind: 'dispatch' }
  | { kind: 'resume'; message: string; deliver?: HumanComment[] }
  | { kind: 'deliver'; comment: HumanComment; mode: 'steer' | 'prompt' | 'undeliverable' }
  | {
      kind: 'review_round'
      comments: ReviewComment[]
      failed: string[]
      ciSha?: string
      cursor?: string | null
      deliver?: HumanComment[]
      /** Set when the round carries the automated reviewer's findings for this head. */
      reviewSha?: string
    }
  | { kind: 'auto_review'; sha: string }
  | { kind: 'verify_staging'; sha: string; deploymentRunId: number; deploymentAttempt: number }
  | { kind: 'merge'; number: number; sha: string; method: MergeMethod; isDraft: boolean }
  | { kind: 'reset_round_files' }
  | { kind: 'acknowledge'; comments: HumanComment[]; reason: string }
  | { kind: 'record_evidence'; stage: string; data: Record<string, unknown> }
  | { kind: 'comment'; key: string; body: string }
  | { kind: 'link_pr'; url: string }
  | { kind: 'set_state'; state: StateKey }
  | {
      kind: 'set_phase'
      phase: Phase
      round?: number
      prNumber?: number
      prUrl?: string
      roundStartSha?: string | null
      roundStartedAt?: string | null
      handledCiSha?: string
      ciRounds?: number
      reviewCursor?: string
      jobStartedAt?: string | null
      reviewedSha?: string | null
      reviewRounds?: number
      mergeSha?: string | null
    }
  | { kind: 'stop_agent' }
  | { kind: 'close_task' }
  | { kind: 'event'; name: string; detail?: string }
