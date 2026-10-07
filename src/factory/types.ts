import type { LiveAgent } from '../runner.js'

/** The controller's own view of an issue; Linear's state is an input, the phase is ours. */
export const Phases = [
  'queued',
  'dispatching',
  'building',
  'needs_input',
  'review',
  'resuming',
  'merged',
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
])
/** Phases during which the worker VM must stay up. */
export const HOLDING_PHASES: ReadonlySet<Phase> = new Set(['dispatching', 'building', 'resuming'])
/** Phases that occupy a repo slot (one agent per VM until forks exist). */
export const SLOT_PHASES: ReadonlySet<Phase> = new Set(['dispatching', 'building', 'resuming'])

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
  blockedBy: string[]
  gone: boolean
  updatedAt: string
  createdAt: string
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
}

export interface ReviewComment {
  id: string
  author: string
  body: string
  createdAt: string
  kind: 'review' | 'inline' | 'conversation'
  path?: string
  line?: number
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
  ci: { headSha: string; failed: string[]; pending: boolean } | null
  staging: { conclusion: string | null; url: string | null } | null
  /** Where the issue's Linear state sits in our model right now. */
  linearKey: StateKey | 'other'
  /** The Linear state differs from the one the controller last set (a human or an automation moved it). */
  humanMoved: boolean
  nowIso: string
  slotFree: boolean
  jobRunning: boolean
  jobAgeMs: number
  /** Issues this one is blocked by that are not done yet. */
  blocked: boolean
}

export interface Limits {
  maxCiRounds: number
  jobTimeoutMs: number
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
    }
  | { kind: 'ci_round'; sha: string; failed: string[] }
  | { kind: 'reset_round_files' }
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
    }
  | { kind: 'stop_agent' }
  | { kind: 'close_task' }
  | { kind: 'event'; name: string; detail?: string }
