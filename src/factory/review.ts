import { z } from 'zod'
import { readAsset } from '../assets.js'
import { vmTaskDir } from '../brief.js'
import type { RepoConfig } from '../config.js'
import { shq } from '../exec.js'
import { OAR_MARKER } from './github.js'
import type { Finding, IssueRow, ReviewComment, ReviewVerdict, Severity } from './types.js'

export type ReviewRunner = 'codex' | 'claude'

const SEVERITIES = ['P0', 'P1', 'P2', 'P3'] as const

const FindingSchema = z.object({
  severity: z.enum(SEVERITIES),
  file: z.string().default(''),
  line: z.number().int().nullable().optional(),
  title: z.string(),
  detail: z.string().default(''),
  fix: z.string().nullable().optional(),
})

export const ReviewOutputSchema = z.object({
  summary: z.string().default(''),
  findings: z.array(FindingSchema).default([]),
})
export type ReviewOutput = z.infer<typeof ReviewOutputSchema>

/** The JSON Schema handed to the runner. Strict: Codex's structured output wants every key required. */
export const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'findings'],
  properties: {
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'file', 'line', 'title', 'detail', 'fix'],
        properties: {
          severity: { type: 'string', enum: [...SEVERITIES] },
          file: { type: 'string' },
          line: { type: ['integer', 'null'] },
          title: { type: 'string' },
          detail: { type: 'string' },
          fix: { type: ['string', 'null'] },
        },
      },
    },
  },
}

/** Where the review's files live on the worker VM (next to the task's brief). */
export const reviewFiles = (taskId: string) => {
  const dir = vmTaskDir(taskId)
  return {
    prompt: `${dir}/review-prompt.md`,
    schema: `${dir}/review-schema.json`,
    out: `${dir}/review-out.json`,
    log: `${dir}/review-log.txt`,
  }
}

/** A detached checkout of the PR head, separate from the builder's worktree. */
export const reviewWorktree = (cfg: RepoConfig, taskId: string) =>
  `${cfg.worktreeRoot}/review-${taskId}`

/** The reviewer's instructions: the shipped template filled with this PR. */
export function reviewPrompt(
  row: IssueRow,
  cfg: RepoConfig,
  pr: { url: string; headSha: string },
  blocking: readonly Severity[],
): string {
  const fill: Array<[string, string]> = [
    ['<pr-url>', pr.url],
    ['<identifier>', row.identifier],
    ['<title>', row.title],
    ['<head-sha>', pr.headSha],
    ['<base>', cfg.baseBranch],
    ['<gate>', cfg.gate],
    ['<blocking>', blocking.join(' and ')],
    // last, so placeholders inside the issue text stay as written
    ['<description>', row.description.trim() || '(no description; the title is the whole request)'],
  ]
  let text = readAsset('templates', 'review-prompt.md')
  for (const [k, v] of fill) text = text.replaceAll(k, () => v)
  return text
}

/** The shell command that runs the reviewer in `cwd`, read-only, under a hard timeout. */
export function reviewCommand(
  runner: ReviewRunner,
  o: {
    cwd: string
    files: ReturnType<typeof reviewFiles>
    timeoutSeconds: number
    model?: string
  },
): string {
  const { prompt, schema, out, log } = o.files
  const pre = `export PATH="$HOME/.local/bin:$PATH"; cd ${shq(o.cwd)} && rm -f ${shq(out)} && timeout ${o.timeoutSeconds}s`
  if (runner === 'codex')
    return `${pre} codex exec -C ${shq(o.cwd)} -s read-only --skip-git-repo-check --ephemeral --color never${o.model ? ` -m ${shq(o.model)}` : ''} --output-schema ${shq(schema)} -o ${shq(out)} - < ${shq(prompt)} > ${shq(log)} 2>&1`
  return `${pre} claude -p --output-format json --json-schema "$(cat ${shq(schema)})" --permission-mode default --allowedTools 'Read,Grep,Glob,Bash(git diff:*),Bash(git log:*),Bash(git show:*),Bash(git status:*)'${o.model ? ` --model ${shq(o.model)}` : ''} < ${shq(prompt)} > ${shq(out)} 2> ${shq(log)}`
}

const stripFences = (text: string) =>
  text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')

/** The runner's output file → findings. Throws when it is not the JSON we asked for. */
export function parseReviewOutput(runner: ReviewRunner, text: string): ReviewOutput {
  let value: unknown = JSON.parse(stripFences(text))
  if (runner === 'claude') {
    const env = value as { structured_output?: unknown; result?: unknown; is_error?: boolean }
    if (env.is_error) throw new Error(`claude: ${String(env.result ?? 'error')}`)
    value =
      env.structured_output ??
      (typeof env.result === 'string' ? (JSON.parse(stripFences(env.result)) as unknown) : null)
  }
  return ReviewOutputSchema.parse(value)
}

export function verdictOf(findings: Finding[], blocking: readonly Severity[]): ReviewVerdict {
  return findings.some((f) => blocking.includes(f.severity)) ? 'block' : 'pass'
}

const where = (f: Finding) => (f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : '')

/** Findings as review-round items for the builder; blocking ones first. */
export function findingsToComments(
  sha: string,
  findings: Finding[],
  blocking: readonly Severity[],
  nowIso: string,
): ReviewComment[] {
  return findings
    .map((f, i) => ({ f, i, b: blocking.includes(f.severity) }))
    .sort((x, y) => Number(y.b) - Number(x.b) || x.f.severity.localeCompare(y.f.severity))
    .map(({ f, i, b }) => ({
      id: `auto-${sha.slice(0, 12)}-${i}`,
      author: 'automated reviewer',
      body: `[${f.severity}] ${f.title}${f.detail ? ` — ${f.detail}` : ''}${f.fix ? ` — fix: ${f.fix}` : ''}`,
      createdAt: nowIso,
      kind: 'review' as const,
      path: f.file || undefined,
      line: f.line ?? undefined,
      severity: f.severity,
      blocking: b,
    }))
}

const counts = (findings: Finding[]) =>
  SEVERITIES.map((s) => [s, findings.filter((f) => f.severity === s).length] as const).filter(
    ([, n]) => n > 0,
  )

/** "1 blocking (P1), 2 advisory (P2 ×1, P3 ×1)" */
export function findingsLine(findings: Finding[], blocking: readonly Severity[]): string {
  const block = findings.filter((f) => blocking.includes(f.severity))
  const rest = findings.filter((f) => !blocking.includes(f.severity))
  const part = (list: Finding[]) =>
    counts(list)
      .map(([s, n]) => `${s} ×${n}`)
      .join(', ')
  if (!findings.length) return 'no findings'
  return [
    block.length ? `${block.length} blocking (${part(block)})` : 'nothing blocking',
    rest.length ? `${rest.length} advisory (${part(rest)})` : '',
  ]
    .filter(Boolean)
    .join(', ')
}

const cell = (s: string) => s.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim()

/** The PR comment: verdict, a findings table and the reviewer's summary, marked as the controller's own. */
export function findingsComment(
  out: ReviewOutput,
  o: { sha: string; runner: ReviewRunner; blocking: readonly Severity[]; next: string },
): string {
  const lines = [
    OAR_MARKER,
    `**Automated review** (${o.runner}) of \`${o.sha.slice(0, 7)}\`: ${findingsLine(out.findings, o.blocking)}. ${o.next}`,
    '',
  ]
  if (out.findings.length) {
    lines.push('| | Where | Finding | Fix |', '|---|---|---|---|')
    for (const f of out.findings)
      lines.push(
        `| ${f.severity}${o.blocking.includes(f.severity) ? ' (blocking)' : ''} | ${where(f) ? `\`${cell(where(f))}\`` : ''} | ${cell(`${f.title}${f.detail ? ` — ${f.detail}` : ''}`)} | ${cell(f.fix ?? '')} |`,
      )
    lines.push('')
  }
  if (out.summary.trim()) lines.push(out.summary.trim(), '')
  return lines.join('\n')
}

/** The Linear comment: the same verdict, blocking items as bullets, and what happens next. */
export function findingsSummary(
  out: ReviewOutput,
  o: {
    sha: string
    runner: ReviewRunner
    blocking: readonly Severity[]
    prUrl: string
    next: string
  },
): string {
  const block = out.findings.filter((f) => o.blocking.includes(f.severity))
  const lines = [
    `Automated review (${o.runner}) of \`${o.sha.slice(0, 7)}\` on ${o.prUrl}: ${findingsLine(out.findings, o.blocking)}.`,
  ]
  if (block.length) {
    lines.push('')
    for (const f of block)
      lines.push(`- [${f.severity}] ${f.title}${where(f) ? ` (\`${where(f)}\`)` : ''}`)
  }
  lines.push('', o.next)
  return lines.join('\n')
}
