import { roundToken } from './brief.js'
import type { Action, Facts, HumanComment, IssueRow, Limits, ReviewComment } from './types.js'

export interface DecideContext {
  limits: Limits
  /** Prepended to comments that need the human (a Linear profile URL becomes a mention). */
  mention?: string
  /** The repo has a deploy workflow whose result is worth waiting for after a merge. */
  tracksDeploy: boolean
  identifier: string
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

const merged = (ctx: DecideContext, row: IssueRow, f: Facts): Action[] => [
  {
    kind: 'comment',
    key: `merged-${f.pr?.number ?? row.prNumber ?? 0}`,
    body: `Merged: ${f.pr?.url ?? row.prUrl ?? ''}.${ctx.tracksDeploy ? ' Watching the deploy workflow; its result comes next.' : ''}`,
  },
  { kind: 'set_state', state: 'done' },
  { kind: 'stop_agent' },
  { kind: 'close_task' },
  {
    kind: 'set_phase',
    phase: ctx.tracksDeploy ? 'merged' : 'closed',
    roundStartSha: f.pr?.mergeSha ?? null,
  },
  { kind: 'event', name: 'merged', detail: f.pr?.url ?? '' },
]

/** The agent touched `done`: either new commits reached the PR, or a later round had nothing to change. */
const roundComplete = (row: IssueRow, f: Facts): Action[] | null => {
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
      },
      { kind: 'event', name: 'review', detail: `round ${row.round} ${f.pr.url}` },
    )
    return actions
  }
  if (row.round > 1)
    return [
      {
        kind: 'comment',
        key: `noop-${row.round}`,
        body: `Round ${row.round} ended without new commits; the agent's reply:${fence(f.paneTail, 1200)}`,
      },
      { kind: 'set_state', state: 'inReview' },
      { kind: 'set_phase', phase: 'review', reviewCursor: f.nowIso },
      { kind: 'event', name: 'review', detail: `round ${row.round} (no changes)` },
    ]
  return null
}

const needsInput = (key: string, body: string): Action[] => [
  { kind: 'comment', key, body },
  { kind: 'set_state', state: 'needsInput' },
  { kind: 'set_phase', phase: 'needs_input' },
]

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
      if (f.linearKey !== 'ready') return []
      if (f.vmUp === null)
        return [
          ...needsInput(
            'no-vm',
            withMention(
              ctx,
              `No VM is recorded for repo \`${row.repo}\`; run \`oar vm new ${row.repo}\` and move this back to Ready.`,
            ),
          ),
          { kind: 'set_phase', phase: 'failed' },
        ]
      if (f.blocked || f.jobRunning || !f.slotFree) return []
      if (row.taskId && row.prNumber)
        // Moved back to Ready after a PR exists: continue the conversation, do not re-brief.
        return [
          {
            kind: 'set_phase',
            phase: 'resuming',
            jobStartedAt: f.nowIso,
            round: row.round + 1,
            roundStartSha: f.pr?.headSha ?? row.roundStartSha,
          },
          { kind: 'event', name: 'resume', detail: `round ${row.round + 1} (moved to Ready)` },
          {
            kind: 'resume',
            message: `${roundToken(row.round + 1)} The issue was moved back to Ready. The PR ${row.prUrl ?? ''} already exists: re-read the brief, finish whatever is left, push to the same branch, \`touch\` the done marker, and reply with a summary.`,
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
              `Starting the agent took longer than ${Math.round(ctx.limits.jobTimeoutMs / 60_000)} minutes and was abandoned. Move the issue back to Ready to retry, or attach with ${attachHint(ctx.identifier)}.`,
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
        // The agent finished on its own (its background jobs ended, or a human attached).
        if (f.agent === 'idle' || f.agent === 'done') return roundComplete(row, f) ?? []
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
      const ciFailed = Boolean(f.ci && f.ci.failed.length && f.ci.headSha !== row.handledCiSha)
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
      if (!comments.length && !ciFailed) return []
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
    case 'merged': {
      if (!ctx.tracksDeploy) return [{ kind: 'set_phase', phase: 'closed' }]
      if (f.staging?.conclusion)
        return [
          {
            kind: 'comment',
            key: `deploy-${row.roundStartSha ?? 'x'}`,
            body: `Deploy workflow ${f.staging.conclusion}${f.staging.url ? `: ${f.staging.url}` : ''}.${f.staging.conclusion === 'success' ? ' Staging has this change; validate it there.' : ''}`,
          },
          { kind: 'set_phase', phase: 'closed' },
          { kind: 'event', name: 'deploy', detail: f.staging.conclusion },
        ]
      const since = row.roundStartedAt ? Date.parse(f.nowIso) - Date.parse(row.roundStartedAt) : 0
      if (since > 3 * 3_600_000)
        return [
          {
            kind: 'comment',
            key: `deploy-none-${row.roundStartSha ?? 'x'}`,
            body: 'No deploy workflow run was found for the merge commit after three hours; check GitHub Actions.',
          },
          { kind: 'set_phase', phase: 'closed' },
        ]
      return []
    }
    default:
      return []
  }
}
