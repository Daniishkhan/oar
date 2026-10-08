import { roundToken } from './brief.js'
import { findingsToComments } from './review.js'
import type {
  Action,
  Facts,
  HumanComment,
  IssueRow,
  Limits,
  MergeMethod,
  ReviewComment,
  Severity,
  StateKey,
} from './types.js'

export interface DecideContext {
  limits: Limits
  /** Linear state names (messages name the trigger state as configured). */
  states: Record<StateKey, string>
  /** Prepended to comments that need the human (a Linear profile URL becomes a mention). */
  mention?: string
  /** The repo has a deploy workflow whose result is worth waiting for after a merge. */
  tracksDeploy: boolean
  tracksVerification: boolean
  deliveryMode: 'staging' | 'merge'
  identifier: string
  /** Severities from the automated reviewer that block the merge. */
  blocking: readonly Severity[]
  /** A Linear label that stops auto-merge. */
  holdLabel: string
  autoMerge: boolean
  mergeMethod: MergeMethod
}

const fence = (text: string, max = 1500) => {
  const t = text.trim()
  const body = t.length > max ? `…${t.slice(-max)}` : t
  return body ? `\n\n\`\`\`\n${body}\n\`\`\`` : ''
}

const attachHint = (identifier: string) => `\`oar factory attach ${identifier}\``

const withMention = (ctx: DecideContext, text: string) =>
  ctx.mention ? `${ctx.mention} ${text}` : text

const answerPrompt = (round: number, comments: HumanComment[]) =>
  [
    `${roundToken(round)} Answer from Linear:`,
    ...comments.map((c) => `${c.author ? `${c.author}: ` : ''}${c.body.trim()}`),
    '',
    'Continue the task with this; the finish steps in the brief still apply.',
  ].join('\n')

/** Build closes the task and stops the agent; Linear itself closes linked PRs on cancel. */
const cancel = (ctx: DecideContext, row: IssueRow, why: string): Action[] => [
  { kind: 'stop_agent' },
  { kind: 'close_task' },
  {
    kind: 'comment',
    key: `closed-${row.round}`,
    body: `${why} The agent was stopped and its task closed.`,
  },
  { kind: 'set_phase', phase: 'closed' },
  { kind: 'event', name: 'closed', detail: why },
]

const merged = (ctx: DecideContext, row: IssueRow, f: Facts): Action[] => {
  const staging = ctx.deliveryMode === 'staging'
  return [
    {
      kind: 'record_evidence',
      stage: 'merge',
      data: {
        sha: f.pr?.mergeSha ?? null,
        reviewedSha: row.reviewedSha,
        prUrl: f.pr?.url ?? row.prUrl,
        deliveryMode: ctx.deliveryMode,
      },
    },
    {
      kind: 'comment',
      key: `merged-${f.pr?.number ?? row.prNumber ?? 0}`,
      body: `Merged: ${f.pr?.url ?? row.prUrl ?? ''}. ${staging ? 'Waiting for deployment and verification of the merged revision before marking Done.' : 'Merge-only delivery is complete; staging was not verified.'}`,
    },
    { kind: 'set_state', state: staging ? 'inReview' : 'done' },
    { kind: 'stop_agent' },
    { kind: 'close_task' },
    {
      kind: 'set_phase',
      phase: staging ? 'merged' : 'closed',
      roundStartSha: f.pr?.mergeSha ?? null,
      roundStartedAt: f.nowIso,
      jobStartedAt: null,
    },
    { kind: 'event', name: 'merged', detail: f.pr?.url ?? '' },
  ]
}

const deliveryConfigurationError = (ctx: DecideContext): string | null =>
  ctx.deliveryMode === 'staging' && (!ctx.tracksDeploy || !ctx.tracksVerification)
    ? 'Staging delivery requires both repo.deployWorkflow and repo.verifyWorkflow. Configure a deployment workflow and a separate verification workflow for the same merged revision, or explicitly choose repo.deliveryMode="merge" for merge-only completion.'
    : null

const deliveryFailure = (
  ctx: DecideContext,
  row: IssueRow,
  key: string,
  message: string,
): Action[] => [
  {
    kind: 'record_evidence',
    stage: 'delivery-blocked',
    data: { sha: row.roundStartSha, reason: message },
  },
  {
    kind: 'comment',
    key,
    body: withMention(
      ctx,
      `${message} Fix or rerun the workflows in GitHub Actions, then reply here or move this issue to ${ctx.states.ready} to recheck delivery. The merged branch will not be sent back to a coding agent.`,
    ),
  },
  { kind: 'set_state', state: 'needsInput' },
  { kind: 'set_phase', phase: 'delivery_failed', jobStartedAt: null },
]

/** Deployment and acceptance verification must attest the same exact revision in that order. */
function delivery(row: IssueRow, f: Facts, ctx: DecideContext): Action[] {
  if (ctx.deliveryMode === 'merge')
    return [
      {
        kind: 'comment',
        key: `merge-only-${row.roundStartSha}`,
        body: 'Merge-only delivery is complete; staging was not verified.',
      },
      { kind: 'set_state', state: 'done' },
      { kind: 'set_phase', phase: 'closed' },
    ]
  const invalid = deliveryConfigurationError(ctx)
  if (invalid) return deliveryFailure(ctx, row, `delivery-config-${row.roundStartSha}`, invalid)
  if (!row.roundStartSha)
    return deliveryFailure(
      ctx,
      row,
      'delivery-no-sha',
      'The merged revision is missing; delivery cannot be verified. Restore the merge commit in the controller delivery record.',
    )
  const sha = row.roundStartSha
  const deployment = f.staging?.headSha === sha ? f.staging : null
  const verification =
    f.verificationRequested && f.verification?.headSha === sha ? f.verification : null
  const evidence: Action[] = []
  if (deployment)
    evidence.push({ kind: 'record_evidence', stage: 'deployment', data: { ...deployment, sha } })
  if (verification)
    evidence.push({
      kind: 'record_evidence',
      stage: 'verification',
      data: { ...verification, sha },
    })
  if (deployment?.status === 'completed' && deployment.conclusion !== 'success')
    return [
      ...evidence,
      ...deliveryFailure(
        ctx,
        row,
        `deploy-failed-${sha}-${deployment.runId}-${deployment.attempt}`,
        `Deployment ${deployment.conclusion ?? 'has no successful conclusion'} for ${sha}: ${deployment.url}.`,
      ),
    ]
  const deployed = deployment?.status === 'completed' && deployment.conclusion === 'success'
  const followsDeployment =
    deployed &&
    deployment.completedAt &&
    verification?.startedAt &&
    Date.parse(verification.startedAt) >= Date.parse(deployment.completedAt)
  if (followsDeployment && verification.status === 'completed') {
    if (verification.conclusion !== 'success')
      return [
        ...evidence,
        ...deliveryFailure(
          ctx,
          row,
          `verify-failed-${sha}-${verification.runId}-${verification.attempt}`,
          `Staging verification ${verification.conclusion ?? 'has no successful conclusion'} for ${sha}: ${verification.url}.`,
        ),
      ]
    return [
      ...evidence,
      {
        kind: 'record_evidence',
        stage: 'delivery',
        data: {
          outcome: 'verified',
          sha,
          deploymentRunId: deployment.runId,
          verificationRunId: verification.runId,
        },
      },
      {
        kind: 'comment',
        key: `verified-${sha}`,
        body: `Verified on staging: ${sha}.\n\nDeployment: ${deployment.url}\nVerification: ${verification.url}\nPR: ${row.prUrl ?? ''}\nReviewed commit: ${row.reviewedSha ?? 'not recorded (external merge)'}`,
      },
      { kind: 'set_state', state: 'done' },
      { kind: 'set_phase', phase: 'closed' },
      { kind: 'event', name: 'staging-verified', detail: sha },
    ]
  }
  const since = row.roundStartedAt
    ? Date.parse(f.nowIso) - Date.parse(row.roundStartedAt)
    : Infinity
  if (since > ctx.limits.deliveryTimeoutMs)
    return [
      ...evidence,
      ...deliveryFailure(
        ctx,
        row,
        `delivery-timeout-${sha}-${row.roundStartedAt}`,
        `Delivery of ${sha} did not finish within ${Math.round(ctx.limits.deliveryTimeoutMs / 60_000)} minutes. ${deployed ? 'A successful verification run must start after deployment completes and report the same revision.' : 'No successful deployment of the exact merged revision was observed.'}`,
      ),
    ]
  if (deployed && row.phase !== 'verifying')
    evidence.push({ kind: 'set_phase', phase: 'verifying' })
  if (deployed && !f.verificationRequested && !f.jobRunning)
    evidence.push({
      kind: 'verify_staging',
      sha,
      deploymentRunId: deployment.runId,
      deploymentAttempt: deployment.attempt,
    })
  return evidence
}

/**
 * The agent touched `done`: either new commits reached the PR, or a later round had nothing to
 * change. `allowNoop` is off in Needs Input, where an old marker without new commits must not
 * pull the issue back to review (it would flip between the two states every tick).
 */
const roundComplete = (row: IssueRow, f: Facts, allowNoop = true): Action[] | null => {
  if (!f.marker || !f.pr || f.pr.state !== 'OPEN') return null
  if (f.pr.headSha !== row.roundStartSha) {
    const actions: Action[] = []
    if (row.prNumber !== f.pr.number) actions.push({ kind: 'link_pr', url: f.pr.url })
    actions.push(
      {
        kind: 'comment',
        key: `pr-${row.round}`,
        body: `${row.round <= 1 ? 'Draft PR' : `Round ${row.round} pushed`}: ${f.pr.url}. Review it on GitHub; review comments and a red CI come back to the agent on their own, and a comment here does too.${fence(f.paneTail, 1200)}`,
      },
      { kind: 'set_state', state: 'inReview' },
      {
        kind: 'set_phase',
        phase: 'review',
        prNumber: f.pr.number,
        prUrl: f.pr.url,
        reviewCursor: f.nowIso,
        roundStartSha: f.pr.headSha,
        roundStartedAt: f.nowIso,
      },
      { kind: 'event', name: 'review', detail: `round ${row.round} ${f.pr.url}` },
    )
    return actions
  }
  if (allowNoop && row.round > 1)
    return [
      {
        kind: 'comment',
        key: `noop-${row.round}`,
        body: `Round ${row.round} ended without new commits; the agent's reply:${fence(f.paneTail, 1200)}`,
      },
      { kind: 'set_state', state: 'inReview' },
      { kind: 'set_phase', phase: 'review', reviewCursor: f.nowIso, roundStartedAt: f.nowIso },
      { kind: 'event', name: 'review', detail: `round ${row.round} (no changes)` },
    ]
  return null
}

const needsInput = (key: string, body: string): Action[] => [
  { kind: 'comment', key, body },
  { kind: 'set_state', state: 'needsInput' },
  { kind: 'set_phase', phase: 'needs_input' },
]

/** A human answered: allow another merge attempt, a fresh review-round budget, a re-run of a failed review. */
const humanRetry = (row: IssueRow) => ({
  mergeSha: null,
  reviewRounds: 0,
  ...(row.reviewVerdict === 'error' ? { reviewedSha: null } : {}),
})

/**
 * Review phase, nothing from humans and CI not red: green CI → automated review of the head;
 * blocking findings → a review round for the agent; a clean review → merge.
 */
function reviewGate(ctx: DecideContext, row: IssueRow, f: Facts): Action[] {
  const pr = f.pr!
  const head = pr.headSha
  if (f.jobRunning) return []
  if (row.mergeSha === head) {
    // A merge was attempted for this head: the job reports a refusal itself, success shows as MERGED.
    if (row.jobStartedAt && f.jobAgeMs > ctx.limits.jobTimeoutMs)
      return [
        ...needsInput(
          `merge-stuck-${head}`,
          withMention(
            ctx,
            `The merge of ${pr.url} started but never finished (the controller restarted?). Check the PR; reply here to retry, or merge it by hand.`,
          ),
        ),
        { kind: 'set_phase', phase: 'needs_input', jobStartedAt: null },
      ]
    return []
  }
  if (!f.ci || f.ci.headSha !== head || f.ci.pending || !f.ci.passed) {
    const waited = row.roundStartedAt ? Date.parse(f.nowIso) - Date.parse(row.roundStartedAt) : 0
    if (waited > ctx.limits.jobTimeoutMs)
      return needsInput(
        `ci-unverified-${head}`,
        withMention(
          ctx,
          `CI for ${pr.url} has not produced successful required checks within ${Math.round(ctx.limits.jobTimeoutMs / 60_000)} minutes.${f.ci?.missing?.length ? ` Missing: ${f.ci.missing.join(', ')}.` : ''} Check GitHub Actions and the repo.requiredChecks configuration, then reply here to retry.`,
        ),
      )
    return []
  }
  if (row.reviewedSha !== head) return [{ kind: 'auto_review', sha: head }]
  if (row.reviewVerdict === 'error')
    return needsInput(
      `review-error-${head}`,
      withMention(
        ctx,
        `The automated review of ${pr.url} failed. Reply here to run it again, or merge by hand.`,
      ),
    )
  if (row.reviewVerdict === 'block') {
    if (row.reviewRoundSha === head)
      return needsInput(
        `review-noop-${head}`,
        withMention(
          ctx,
          `The agent ended the review round without pushing, so the blocking findings stand. Reply here with guidance, push a fix yourself, or merge by hand to override.`,
        ),
      )
    if (row.reviewRounds >= ctx.limits.maxReviewRounds)
      return needsInput(
        `review-limit-${head}`,
        withMention(
          ctx,
          `The automated review still blocks after ${row.reviewRounds} round(s), so automatic rounds stopped. Reply here with guidance, or merge by hand to override.`,
        ),
      )
    if (!f.slotFree) return []
    return [
      {
        kind: 'review_round',
        comments: findingsToComments(head, row.reviewFindings, ctx.blocking, f.nowIso),
        failed: [],
        cursor: f.review.cursor,
        deliver: [],
        reviewSha: head,
      },
    ]
  }
  if (row.reviewVerdict !== 'pass') return []
  const invalid = deliveryConfigurationError(ctx)
  if (invalid) return needsInput(`delivery-config-${head}`, withMention(ctx, invalid))
  // Clean review of the head with green CI.
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return []
  if (pr.mergeable === 'CONFLICTING')
    return needsInput(
      `conflict-${head}`,
      withMention(
        ctx,
        `${pr.url} conflicts with its base branch, so it cannot merge. Reply here (for example "merge the base branch and push"), or resolve it by hand.`,
      ),
    )
  const held = row.labels.some((l) => l.toLowerCase() === ctx.holdLabel.toLowerCase())
  if (held || !ctx.autoMerge) return []
  // CI runs the workflow version from the PR, and the reviewer reads the agent instruction files
  // in it, so a PR that changes either is a human's merge. Not read this tick: wait.
  if (f.protectedChanges === null) return []
  if (f.protectedChanges.length)
    return needsInput(
      `protected-${head}`,
      withMention(
        ctx,
        `${pr.url} changes protected paths (${f.protectedChanges.join(', ')}), which the factory never merges on its own. Review and merge it by hand, or reply here once a push without those changes is in.`,
      ),
    )
  // The merge job re-checks this under the repo lock; deciding it here keeps the tick quiet.
  if (f.deliveryBusy) return []
  return [
    { kind: 'merge', number: pr.number, sha: head, method: ctx.mergeMethod, isDraft: pr.isDraft },
  ]
}

/** Pure: what to do about one issue given what we observed. Order matters: apply runs them in sequence. */
export function decide(row: IssueRow, f: Facts, ctx: DecideContext): Action[] {
  const canceled = row.gone || f.linearKey === 'canceled'
  switch (row.phase) {
    case 'queued': {
      if (canceled || f.linearKey === 'done')
        return [
          { kind: 'set_phase', phase: 'closed' },
          { kind: 'event', name: 'closed', detail: 'before start' },
        ]
      if (f.linearKey !== 'ready' || row.kind !== 'build') return []
      if (f.pr?.state === 'MERGED') return merged(ctx, row, f)
      const invalid = deliveryConfigurationError(ctx)
      if (invalid)
        return [
          ...needsInput(
            'delivery-config',
            withMention(ctx, `${invalid} Then move the issue back to ${ctx.states.ready}.`),
          ),
          { kind: 'set_phase', phase: 'failed' },
        ]
      if (f.vmUp === null)
        return [
          ...needsInput(
            'no-vm',
            withMention(
              ctx,
              `No VM is recorded for repo \`${row.repo}\`; run \`oar vm new ${row.repo}\` and move this back to ${ctx.states.ready}.`,
            ),
          ),
          { kind: 'set_phase', phase: 'failed' },
        ]
      if (f.blocked || f.jobRunning || !f.slotFree) return []
      if (row.taskId && row.prNumber)
        // Moved back to the trigger state after a PR exists: continue the conversation, do not re-brief.
        return [
          {
            kind: 'set_phase',
            phase: 'resuming',
            jobStartedAt: f.nowIso,
            round: row.round + 1,
            roundStartSha: f.pr?.headSha ?? row.roundStartSha,
            ...humanRetry(row),
          },
          {
            kind: 'event',
            name: 'resume',
            detail: `round ${row.round + 1} (moved to ${ctx.states.ready})`,
          },
          {
            kind: 'resume',
            message: `${roundToken(row.round + 1)} The issue was moved back to ${ctx.states.ready}. The PR ${row.prUrl ?? ''} already exists: re-read the brief, finish whatever is left, push to the same branch, \`touch\` the done marker, and reply with a summary.`,
            deliver: f.undelivered,
          },
        ]
      return [
        { kind: 'set_phase', phase: 'dispatching', jobStartedAt: f.nowIso },
        { kind: 'event', name: 'dispatch', detail: `round ${row.round + 1}` },
        { kind: 'dispatch' },
      ]
    }
    case 'dispatching':
    case 'resuming': {
      if (canceled) return cancel(ctx, row, 'Canceled while starting.')
      if (f.jobRunning) return []
      if (f.jobAgeMs > ctx.limits.jobTimeoutMs)
        return [
          ...needsInput(
            `job-timeout-${row.round}`,
            withMention(
              ctx,
              `Starting the agent took longer than ${Math.round(ctx.limits.jobTimeoutMs / 60_000)} minutes and was abandoned. Move the issue back to ${ctx.states.ready} to retry, or attach with ${attachHint(ctx.identifier)}.`,
            ),
          ),
          { kind: 'set_phase', phase: 'failed', jobStartedAt: null },
        ]
      // No job but still in a job phase: the controller restarted mid-way. Run it again (idempotent).
      return row.phase === 'dispatching'
        ? [{ kind: 'dispatch' }]
        : [
            {
              kind: 'resume',
              message: `${roundToken(row.round)} The controller restarted. Continue the task; the brief's finish steps still apply.`,
            },
          ]
    }
    case 'building': {
      if (canceled) return cancel(ctx, row, 'Canceled in Linear.')
      if (f.pr?.state === 'MERGED') return merged(ctx, row, f)
      if (f.linearKey === 'done')
        return cancel(ctx, row, 'Marked Done in Linear before the PR was merged.')
      if (f.agent === 'vm-down' || f.agent === 'exited')
        return [
          { kind: 'set_phase', phase: 'resuming', jobStartedAt: f.nowIso },
          {
            kind: 'resume',
            message: `${roundToken(row.round)} The VM or your pane was restarted. Continue the task; the brief's finish steps still apply.`,
            deliver: f.undelivered,
          },
        ]
      if (f.agent === 'working')
        return f.undelivered.map((c) => ({ kind: 'deliver', comment: c, mode: 'steer' }) as Action)
      if (f.agent === 'blocked')
        return needsInput(
          `dialog-${row.round}`,
          withMention(
            ctx,
            `The agent is waiting at a dialog that needs keys, which I cannot answer from here. Attach with ${attachHint(ctx.identifier)}.${fence(f.paneTail, 800)}`,
          ),
        )
      if (f.agent === 'unknown' || f.agent === null) return []
      // idle or done
      if (f.pr?.state === 'CLOSED')
        return needsInput(
          `pr-closed-${f.pr.number}`,
          withMention(
            ctx,
            `The PR ${f.pr.url} was closed without merging. Reply here with what to do next, or cancel the issue.`,
          ),
        )
      const complete = roundComplete(row, f)
      if (complete) return complete
      if (f.marker)
        return needsInput(
          `nopush-${row.round}`,
          withMention(
            ctx,
            `The agent reported done but nothing new reached GitHub${f.pr ? '' : ' and there is no PR'}. Reply here with what to do, or attach with ${attachHint(ctx.identifier)}.${fence(f.paneTail, 800)}`,
          ),
        )
      if (f.undelivered.length)
        return f.undelivered.map((c) => ({ kind: 'deliver', comment: c, mode: 'prompt' }) as Action)
      if (f.question)
        return needsInput(
          `question-${row.round}`,
          withMention(
            ctx,
            `${f.question.trim()}\n\n_Reply here; your comment goes straight to the agent._`,
          ),
        )
      // Idle without finishing usually means a background job (the gate) is still running; Claude
      // Code wakes up by itself when it ends. Only a long quiet spell counts as a stall.
      if (f.idleForMs < ctx.limits.stallGraceMs) return []
      return needsInput(
        `stalled-${row.round}`,
        withMention(
          ctx,
          `The agent stopped without finishing or asking a question. Reply here to nudge it, or attach with ${attachHint(ctx.identifier)}.${fence(f.paneTail, 1200)}`,
        ),
      )
    }
    case 'needs_input': {
      if (canceled) return cancel(ctx, row, 'Canceled in Linear.')
      if (f.pr?.state === 'MERGED') return merged(ctx, row, f)
      if (f.linearKey === 'done') return cancel(ctx, row, 'Marked Done in Linear.')
      const answers = f.undelivered
      if (!answers.length) {
        if (f.agent === 'working')
          return [
            { kind: 'set_state', state: 'inProgress' },
            { kind: 'set_phase', phase: 'building' },
          ]
        // The agent pushed on its own (its background jobs ended, or a human attached).
        if (f.agent === 'idle' || f.agent === 'done') return roundComplete(row, f, false) ?? []
        return []
      }
      if (f.agent === 'vm-down' || f.agent === 'exited')
        return [
          {
            kind: 'set_phase',
            phase: 'resuming',
            jobStartedAt: f.nowIso,
            round: row.round + 1,
            roundStartSha: f.pr?.headSha ?? null,
            ...humanRetry(row),
          },
          { kind: 'resume', message: answerPrompt(row.round + 1, answers), deliver: answers },
        ]
      if (f.agent === 'blocked')
        return answers.map(
          (c) => ({ kind: 'deliver', comment: c, mode: 'undeliverable' }) as Action,
        )
      if (f.agent === 'working')
        return [
          ...answers.map((c) => ({ kind: 'deliver', comment: c, mode: 'steer' }) as Action),
          { kind: 'set_state', state: 'inProgress' },
          { kind: 'set_phase', phase: 'building' },
        ]
      // idle / done / unknown: a confirmed prompt starts the next round
      return [
        { kind: 'reset_round_files' },
        {
          kind: 'set_phase',
          phase: 'building',
          round: row.round + 1,
          roundStartSha: f.pr?.headSha ?? null,
          roundStartedAt: f.nowIso,
          ...humanRetry(row),
        },
        { kind: 'event', name: 'round', detail: `round ${row.round + 1} (answer)` },
        ...answers.map((c, i) =>
          i === 0
            ? ({
                kind: 'deliver',
                comment: { ...c, body: answerPrompt(row.round + 1, answers) },
                mode: 'prompt',
              } as Action)
            : ({ kind: 'deliver', comment: c, mode: 'steer' } as Action),
        ),
        { kind: 'set_state', state: 'inProgress' },
      ]
    }
    case 'review': {
      if (canceled) return cancel(ctx, row, 'Canceled in Linear.')
      if (!f.pr) return []
      if (f.pr.state === 'MERGED') return merged(ctx, row, f)
      if (f.pr.state === 'CLOSED')
        return needsInput(
          `pr-closed-${f.pr.number}`,
          withMention(
            ctx,
            `The PR ${f.pr.url} was closed without merging. Reply here with what to do next, or cancel the issue.`,
          ),
        )
      if (f.agent === 'working') return []
      const fromLinear: ReviewComment[] = f.undelivered.map((c) => ({
        id: c.id,
        author: c.author,
        body: c.body,
        createdAt: c.createdAt,
        kind: 'conversation',
      }))
      const comments = [...f.review.comments, ...fromLinear]
      const ciFailed = Boolean(
        f.ci &&
        f.ci.headSha === f.pr.headSha &&
        f.ci.failed.length &&
        f.ci.headSha !== row.handledCiSha,
      )
      if (ciFailed && row.ciRounds >= ctx.limits.maxCiRounds)
        return [
          ...needsInput(
            `ci-limit-${f.ci!.headSha}`,
            withMention(
              ctx,
              `CI failed ${row.ciRounds} rounds in a row (${f.ci!.failed.join(', ')}); automatic rounds stopped. Reply here with guidance to continue.`,
            ),
          ),
          { kind: 'set_phase', phase: 'needs_input', handledCiSha: f.ci!.headSha },
        ]
      // Humans and red CI come first; the automated review and the merge only run on a quiet PR.
      if (!comments.length && !ciFailed) return reviewGate(ctx, row, f)
      if (!f.slotFree || f.jobRunning) return []
      return [
        {
          kind: 'review_round',
          comments,
          failed: ciFailed ? f.ci!.failed : [],
          ciSha: ciFailed ? f.ci!.headSha : undefined,
          cursor: f.review.cursor,
          deliver: f.undelivered,
        },
      ]
    }
    case 'merged':
    case 'verifying': {
      if (canceled) return cancel(ctx, row, 'Delivery tracking canceled in Linear.')
      return delivery(row, f, ctx)
    }
    case 'delivery_failed': {
      if (canceled) return cancel(ctx, row, 'Delivery tracking canceled in Linear.')
      if (!f.undelivered.length && !(f.humanMoved && f.linearKey === 'ready')) return []
      return [
        { kind: 'acknowledge', comments: f.undelivered, reason: 'delivery-retry' },
        { kind: 'set_state', state: 'inReview' },
        { kind: 'set_phase', phase: 'merged', roundStartedAt: f.nowIso },
        { kind: 'event', name: 'delivery-retry', detail: row.roundStartSha ?? '' },
      ]
    }
    default:
      return []
  }
}
