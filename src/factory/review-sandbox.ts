import { runCommand, waitUp, type BoatClient, type EnvironmentInfo } from '../boat.js'
import type { RepoConfig } from '../config.js'
import { shq } from '../exec.js'
import {
  parseReviewOutput,
  REVIEW_SCHEMA,
  reviewCommand,
  reviewFiles,
  reviewPrompt,
  type ReviewOutput,
  type ReviewRunner,
} from './review.js'
import type { IssueRow, Severity } from './types.js'

/** Persisted by the controller before the disposable sandbox is stopped. */
export interface ReviewSandboxEvidence {
  sandboxId: string
  environment?: EnvironmentInfo
  headSha: string
  output: string | null
  log: string | null
  diff: string | null
  commits: string | null
  exitCode: number | null
  error?: string
}

export interface IsolatedReviewOptions {
  cfg: RepoConfig
  row: IssueRow
  taskId: string
  headSha: string
  branch: string
  runner: ReviewRunner
  model?: string
  blocking: readonly Severity[]
  timeoutSeconds: number
  /** Dedicated Boat environment with repository read access and model credentials only. */
  environment: string | undefined
  /** The caller durably records this key before invoking create, including on initial attempts. */
  attempt: { idempotencyKey: string; sandboxId?: string }
  onSandbox: (id: string) => Promise<void>
  onEvidence: (evidence: ReviewSandboxEvidence) => Promise<void>
  onStopped?: (id: string) => Promise<void>
}

/**
 * Fresh clone, no builder worktree or snapshot. Boat applies the configured environment, so
 * its administrator must provision only read-scoped repository and model credentials there.
 * Git hooks and repository-owned setup scripts never run during checkout.
 */
export function isolatedReviewCheckout(o: {
  cfg: RepoConfig
  cwd: string
  taskId: string
  headSha: string
  branch: string
}): string {
  const files = reviewFiles(o.taskId)
  const git = 'git -c core.hooksPath=/dev/null'
  const base = `origin/${o.cfg.baseBranch}`
  return [
    `mkdir -p ${shq(files.dir)}`,
    'gh auth setup-git --hostname github.com',
    `${git} clone --no-checkout -- ${shq(`https://github.com/${o.cfg.github}.git`)} ${shq(o.cwd)}`,
    `${git} -C ${shq(o.cwd)} fetch origin -- ${shq(o.headSha)} ${shq(`+refs/heads/${o.cfg.baseBranch}:refs/remotes/origin/${o.cfg.baseBranch}`)} ${shq(`+refs/heads/${o.branch}:refs/remotes/origin/oar-review-head`)}`,
    `${git} -C ${shq(o.cwd)} checkout --detach ${shq(o.headSha)}`,
    `test "$(git -C ${shq(o.cwd)} rev-parse HEAD)" = ${shq(o.headSha)}`,
    `${git} -C ${shq(o.cwd)} log --oneline ${shq(`${base}..HEAD`)} > ${shq(files.commits)}`,
    `${git} -C ${shq(o.cwd)} diff --no-ext-diff --no-textconv ${shq(`${base}...HEAD`)} > ${shq(files.diff)}`,
  ].join(' && ')
}

/** Check environment-provided credentials without printing or transferring them. */
export function reviewPreflight(runner: ReviewRunner): string {
  const modelAuth =
    runner === 'codex'
      ? 'codex login status >/dev/null 2>&1'
      : '(test -n "${ANTHROPIC_API_KEY:-}${CLAUDE_CODE_OAUTH_TOKEN:-}" || claude auth status >/dev/null 2>&1)'
  return `export PATH="$HOME/.local/bin:$PATH"; command -v ${runner} >/dev/null && command -v git >/dev/null && command -v gh >/dev/null && command -v timeout >/dev/null && gh auth status >/dev/null 2>&1 && ${modelAuth}`
}

/**
 * Run a reviewer in a separate, bounded-lifetime Boat sandbox. Callbacks form the durable
 * boundary: IDs are stored before work; artifacts are stored before stop erases the disk.
 * Resuming an attempt only recovers completed output; it never starts a second concurrent run.
 */
export async function runIsolatedReview(
  boat: BoatClient,
  o: IsolatedReviewOptions,
): Promise<{ out: ReviewOutput; sandboxId: string }> {
  if (!o.environment?.trim() || o.environment.trim() === o.cfg.envName.trim())
    throw new Error('isolated review requires reviewEnvName distinct from the builder environment')
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(o.taskId)) throw new Error('invalid review task ID')
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(o.headSha))
    throw new Error('isolated review requires the full PR head commit SHA')
  if (!o.attempt.idempotencyKey || !Number.isFinite(o.timeoutSeconds) || o.timeoutSeconds <= 0)
    throw new Error('isolated review requires an attempt key and positive timeout')
  const timeoutSeconds = Math.ceil(o.timeoutSeconds)
  const ttlSeconds = timeoutSeconds + 900
  if (ttlSeconds > 2_592_000) throw new Error('review timeout exceeds the sandbox TTL limit')

  const files = reviewFiles(o.taskId)
  const cwd = `${files.dir}/checkout`
  const headFile = `${files.dir}/review-head.txt`
  const exitFile = `${files.dir}/review-exit.txt`
  let sandboxId: string | undefined = o.attempt.sandboxId
  let environment: EnvironmentInfo | undefined
  let failure: unknown
  let out: ReviewOutput | undefined
  let evidence: ReviewSandboxEvidence | undefined
  const capture = async (): Promise<ReviewSandboxEvidence> => {
    const errors: string[] = []
    const read = async (path: string) => {
      try {
        return await boat.readFile(sandboxId!, path)
      } catch {
        errors.push(`could not retrieve ${path}`)
        return null
      }
    }
    const [output, log, diff, commits, exit] = await Promise.all([
      read(files.out),
      read(files.log),
      read(files.diff),
      read(files.commits),
      read(exitFile),
    ])
    return {
      sandboxId: sandboxId!,
      environment,
      headSha: o.headSha,
      output,
      log,
      diff,
      commits,
      exitCode: exit?.trim().match(/^\d+$/) ? Number(exit.trim()) : null,
      ...(errors.length ? { error: errors.join('; ') } : {}),
    }
  }

  try {
    environment = (await boat.environments()).find((candidate) => candidate.name === o.environment)
    if (!environment) throw new Error('reviewEnvName does not name an existing Boat environment')
    if (environment.passGithub !== false || environment.passSandboxCredentials !== false)
      throw new Error(
        'review environment must explicitly disable passGithub and passSandboxCredentials; supply a repository read-only token in dedicated environment secrets instead',
      )
    if (
      !environment.latestVersionId ||
      !Number.isInteger(environment.latestVersionNumber) ||
      (environment.latestVersionNumber ?? 0) <= 0
    )
      throw new Error('review environment must expose a concrete version before it can be used')
    const sandbox = sandboxId
      ? await boat.get(sandboxId)
      : await boat.create(
          { environment: o.environment, type: 'small', snapshots: false, ttlSeconds },
          o.attempt.idempotencyKey,
        )
    sandboxId = sandbox.id
    await o.onSandbox(sandboxId)
    if (sandbox.state === 'archived' || sandbox.state === 'archiving')
      throw new Error('previous review sandbox has already stopped; retry with a fresh attempt')
    const expiresAt = sandbox.archiveAfter?.getTime()
    if (
      !expiresAt ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= Date.now() ||
      expiresAt > Date.now() + ttlSeconds * 1000 + 60_000
    )
      throw new Error('review sandbox does not have the required hard auto-stop deadline')
    const ready = await waitUp(boat, sandboxId, { timeoutMs: 180_000 })
    if (
      ready.environment !== environment.name ||
      ready.environmentVersion !== environment.latestVersionNumber
    )
      throw new Error(
        'review sandbox environment/version differs from the inspected policy; retry against a stable dedicated environment',
      )

    const previousHead = await boat.readFile(sandboxId, headFile)
    if (previousHead !== null) {
      if (previousHead.trim() !== o.headSha)
        throw new Error('review sandbox belongs to a different commit')
      evidence = await capture()
      if (evidence.exitCode !== 0 || !evidence.output?.trim())
        throw new Error(
          'previous review attempt was interrupted or failed; retry in a fresh sandbox',
        )
    } else {
      const auth = await runCommand(boat, sandboxId, reviewPreflight(o.runner), {
        timeoutSeconds: 60,
      })
      if (auth.exitCode !== 0 || auth.timedOut)
        throw new Error(
          `review environment needs ${o.runner}, git, gh, timeout, repository read credentials and model authentication`,
        )
      const prep = await runCommand(
        boat,
        sandboxId,
        isolatedReviewCheckout({
          cfg: o.cfg,
          cwd,
          taskId: o.taskId,
          headSha: o.headSha,
          branch: o.branch,
        }),
        { timeoutSeconds: 300 },
      )
      if (prep.exitCode !== 0 || prep.timedOut)
        throw new Error(
          `could not check out review commit ${o.headSha}: ${prep.stderr || prep.stdout}`,
        )
      await boat.writeFile(sandboxId, headFile, o.headSha)
      await boat.writeFile(
        sandboxId,
        files.prompt,
        reviewPrompt(
          o.row,
          o.cfg,
          { url: o.row.prUrl ?? '', headSha: o.headSha },
          o.blocking,
          files,
        ),
      )
      await boat.writeFile(sandboxId, files.schema, JSON.stringify(REVIEW_SCHEMA))
      const command = reviewCommand(o.runner, { cwd, files, timeoutSeconds, model: o.model })
      const r = await runCommand(
        boat,
        sandboxId,
        `( ${command} ); oar_review_exit=$?; printf '%s\\n' "$oar_review_exit" > ${shq(exitFile)}; exit "$oar_review_exit"`,
        { timeoutSeconds: timeoutSeconds + 60 },
      )
      evidence = await capture()
      if (r.exitCode !== 0 || r.timedOut || evidence.exitCode !== 0 || !evidence.output?.trim())
        throw new Error(
          `${o.runner} review ${r.timedOut || r.exitCode === 124 ? 'timed out' : `failed (exit ${r.exitCode ?? '?'})`}\n${evidence.log || r.stderr || r.stdout}`,
        )
    }
    if (evidence.error) throw new Error(evidence.error)
    if (evidence.diff === null || evidence.commits === null)
      throw new Error('review diff or commit evidence is missing')
    out = parseReviewOutput(o.runner, evidence.output!)
  } catch (e) {
    failure = e
  } finally {
    if (sandboxId) {
      try {
        evidence ??= await capture()
        if (failure)
          evidence.error = [
            evidence.error,
            failure instanceof Error ? failure.message : String(failure),
          ]
            .filter(Boolean)
            .join('; ')
        await o.onEvidence(evidence)
      } catch (e) {
        failure ??= e
      }
      try {
        await boat.stop(sandboxId, true)
        await o.onStopped?.(sandboxId)
      } catch (e) {
        // No successful verdict is returned until cleanup is confirmed; the TTL is a backstop.
        failure ??= e
      }
    }
  }
  if (failure) throw failure
  if (!out || !sandboxId) throw new Error('review did not produce a result')
  return { out, sandboxId }
}
