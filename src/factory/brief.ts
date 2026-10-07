import { vmTaskDir, type FooterOptions } from '../brief.js'
import type { Task } from '../state.js'
import type { HumanComment, IssueRow, ReviewComment } from './types.js'

export const PRIORITY = ['none', 'urgent', 'high', 'medium', 'low'] as const

export const questionPath = (taskId: string) => `${vmTaskDir(taskId)}/question.md`
export const reviewPath = (taskId: string, round: number) =>
  `${vmTaskDir(taskId)}/review-${round}.md`
export const roundToken = (round: number) => `[oar r${round}]`

/** The markdown the agent reads first: the issue as the human wrote it, plus the discussion so far. */
export function issueBrief(issue: IssueRow, comments: HumanComment[], repoName: string): string {
  const lines = [
    `# ${issue.identifier}: ${issue.title}`,
    '',
    `Linear: ${issue.url}`,
    `Repo: ${repoName}`,
    `Priority: ${PRIORITY[issue.priority] ?? 'none'}${issue.labels.length ? `   Labels: ${issue.labels.join(', ')}` : ''}`,
    '',
    '## Issue',
    '',
    issue.description.trim() || '(no description; the title is the whole request)',
    '',
  ]
  if (comments.length) {
    lines.push('## Discussion so far', '')
    for (const c of comments) {
      lines.push(`**${c.author || 'someone'}** (${c.createdAt.slice(0, 16).replace('T', ' ')}):`)
      lines.push(
        ...c.body
          .trim()
          .split('\n')
          .map((l) => `> ${l}`),
        '',
      )
    }
  }
  return lines.join('\n')
}

/** Footer rules the factory adds on top of oar's: PR naming, how to ask, how review rounds arrive. */
export function factoryFooter(task: Task, issue: IssueRow): FooterOptions {
  return {
    prTitle: `${issue.identifier}: <one line>`,
    prBody: `\`Fixes ${issue.identifier}\` on its first line`,
    blockedRule: `- When you need a decision from me, write the question (and the options, with your recommendation) to \`${questionPath(task.id)}\`, say the same question in the terminal, and stop. The factory posts it on the issue and sends my answer back as a prompt. Never open the AskUserQuestion dialog. Do not ask for things you can decide; ask only when a wrong guess would waste the task.`,
    extra: [
      '- Report on the Linear issue, not on the PR: the factory copies your final reply there. Never comment on the PR yourself; every PR comment is treated as my feedback.',
      `- A review round arrives as \`${vmTaskDir(task.id)}/review-<n>.md\`. Address every item, push, run the gate, then \`touch ${vmTaskDir(task.id)}/done\` again and reply with a summary of what changed.`,
    ],
  }
}

/** What the agent reads when review comments or a red CI come back. */
export function reviewBrief(
  issue: IssueRow,
  round: number,
  comments: ReviewComment[],
  failedChecks: string[],
  prUrl: string | null,
): string {
  const lines = [
    `# ${issue.identifier} review round ${round}`,
    '',
    `PR: ${prUrl ?? '(see the branch)'}`,
    '',
  ]
  if (failedChecks.length) {
    lines.push(
      '## CI is red',
      '',
      `Failed checks: ${failedChecks.join(', ')}.`,
      'Find the cause with `gh run list --branch <branch>` and `gh run view <id> --log-failed`, fix it, and make the gate pass locally before pushing.',
      '',
    )
  }
  if (comments.length) {
    lines.push('## Review comments', '')
    for (const c of comments) {
      const where = c.path ? ` on \`${c.path}${c.line ? `:${c.line}` : ''}\`` : ''
      lines.push(`- **${c.author}**${where} (${c.kind}):`)
      lines.push(
        ...c.body
          .trim()
          .split('\n')
          .map((l) => `  > ${l}`),
      )
    }
    lines.push('')
  }
  lines.push(
    '## What to do',
    '',
    '1. Address every item above (or explain in your summary why not).',
    '2. Run the gate, push to the same branch (never a new PR), `touch` the done marker again.',
    '3. Reply with a short summary; it is copied to the issue.',
    '',
  )
  return lines.join('\n')
}

/** The agent's question from question.md, else the pane tail as a fallback. */
export function questionFrom(questionFile: string | null, paneTail: string): string {
  const q = questionFile?.trim()
  if (q) return q
  const tail = paneTail.trim().split('\n').slice(-25).join('\n')
  return tail
    ? `The agent stopped without writing question.md. Its last screen:\n\n\`\`\`\n${tail}\n\`\`\``
    : 'The agent stopped without saying why.'
}
