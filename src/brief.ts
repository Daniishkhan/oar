import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readAsset } from './assets.js'
import type { Paths, RepoConfig } from './config.js'
import { OarError } from './errors.js'
import type { Exec } from './exec.js'
import type { Task } from './state.js'

/** Also the Herdr agent-name alphabet: `[a-z][a-z0-9_-]{0,31}` with room for the id suffix. */
export const SLUG_RE = /^[a-z][a-z0-9-]{1,26}$/

export function validateSlug(slug: string): string {
  if (!SLUG_RE.test(slug)) {
    throw new OarError(
      'usage',
      `slug '${slug}' must match ${SLUG_RE} (lowercase, digits, dashes, 2-27 chars, starts with a letter)`,
    )
  }
  return slug
}

export const newTaskId = (slug: string) => `${slug}-${randomBytes(3).toString('hex').slice(0, 4)}`

export const vmTaskDir = (id: string) => `/home/user/oar/tasks/${id}`
export const vmBriefPath = (id: string) => `${vmTaskDir(id)}/brief.md`
export const vmDoneMarker = (id: string) => `${vmTaskDir(id)}/done`

export function templateFor(repoName: string, repo: RepoConfig, slug: string): string {
  return readAsset('templates', 'brief.md')
    .replace('<task name>', slug)
    .replace('<repo-path>', repo.vmPath)
    .replace('<repo>', repoName)
    .replace('<branch>', `${repo.branchPrefix}${slug}`)
    .replace('<gate>', repo.gate)
}

export interface FooterOptions {
  /** Extra rule lines (markdown list items) inserted before the finish steps. */
  extra?: string[]
  /** Replaces the default "when blocked" rule (the factory relays questions instead). */
  blockedRule?: string
  /** Text for the PR title placeholder, e.g. `ENG-12: <one line>`. */
  prTitle?: string
  /** Lines added to the PR body requirement, e.g. `Fixes ENG-12` on the first line. */
  prBody?: string
}

/** The part oar owns: where to work, how to finish. Appended on dispatch, never stored in the user's brief. */
export function footer(task: Task, repo: RepoConfig, opts: FooterOptions = {}): string {
  const servicesNote = repo.services
    ? `- Services do not survive a VM stop. If something is missing (a database, a dev server), start it with \`${repo.services}\` instead of debugging.`
    : '- Services do not survive a VM stop; start what you need before debugging a missing one.'
  const blocked =
    opts.blockedRule ??
    '- When blocked, do not wait for me: leave a `TODO(danish):` line in the PR body and continue with the rest. Ask only when a wrong guess would waste the whole task.'
  const title = opts.prTitle ?? '<one line>'
  const body = `where the body has: ${opts.prBody ? `${opts.prBody}; then ` : ''}what changed, which checks ran, open TODOs.`
  return [
    '',
    '---',
    `## oar task ${task.id} (added by oar; follow it exactly)`,
    '',
    `- Work only in \`${task.worktreePath}\`, a git worktree on branch \`${task.branch}\` based on \`origin/${repo.baseBranch}\`. Never touch \`${repo.vmPath}\` or \`${repo.baseBranch}\`.`,
    `- Gate before you stop: \`${repo.gate}\` must pass.`,
    servicesNote,
    '- Commit as you go with clear messages. Do not force-push.',
    blocked,
    ...(opts.extra ?? []),
    '- When the gate is green, finish in this order and do not skip a step:',
    `  1. \`git push -u origin ${task.branch}\``,
    `  2. \`gh pr create --draft --base ${repo.baseBranch} --head ${task.branch} --title "${title}" --body-file <file>\` ${body}`,
    `  3. \`touch ${vmDoneMarker(task.id)}\``,
    '  4. Reply with the PR URL and a three-line summary.',
    '',
  ].join('\n')
}

/** Write a brief given as text (the factory builds it from a Linear issue). Returns the path. */
export function writeBrief(p: Paths, id: string, text: string): string {
  const dir = join(p.tasksDir, id)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'brief.md')
  writeFileSync(path, text.endsWith('\n') ? text : `${text}\n`)
  return path
}

export interface BriefSource {
  stdin?: string
  file?: string
}

/** Create the local brief file from stdin, a file, or the template opened in $EDITOR. */
export async function createBrief(
  p: Paths,
  exec: Exec,
  task: { id: string; slug: string },
  repoName: string,
  repo: RepoConfig,
  src: BriefSource,
): Promise<string> {
  const dir = join(p.tasksDir, task.id)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'brief.md')
  if (src.stdin !== undefined) {
    writeFileSync(path, src.stdin.endsWith('\n') ? src.stdin : `${src.stdin}\n`)
    return path
  }
  if (src.file) {
    if (!existsSync(src.file)) throw new OarError('usage', `brief file not found: ${src.file}`)
    writeFileSync(path, readFileSync(src.file, 'utf8'))
    return path
  }
  writeFileSync(path, templateFor(repoName, repo, task.slug))
  const editor = process.env.VISUAL || process.env.EDITOR || 'vi'
  const code = await exec.interactive('/bin/sh', ['-c', `${editor} ${JSON.stringify(path)}`])
  if (code !== 0) throw new OarError('usage', `editor exited ${code}; brief left at ${path}`)
  if (readFileSync(path, 'utf8') === templateFor(repoName, repo, task.slug)) {
    throw new OarError(
      'usage',
      'the brief is still the unedited template',
      `edit ${path} then dispatch`,
    )
  }
  return path
}

export const readBrief = (path: string) => readFileSync(path, 'utf8')
