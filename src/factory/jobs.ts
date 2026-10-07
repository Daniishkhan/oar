/**
 * Long-running work (dispatch, resume: minutes) runs outside the tick so Linear sync and the keeper
 * stay responsive. One job per issue, and one job at a time per repo: `ensureUp` rewrites the same
 * ssh alias files and the VM has one screen.
 */
export class Jobs {
  private readonly running = new Map<string, { repo: string; startedAt: number }>()
  private readonly locks = new Map<string, Promise<void>>()

  constructor(private readonly now: () => number = Date.now) {}

  has(issueId: string): boolean {
    return this.running.has(issueId)
  }

  ageMs(issueId: string): number {
    const j = this.running.get(issueId)
    return j ? this.now() - j.startedAt : 0
  }

  count(repo: string): number {
    let n = 0
    for (const j of this.running.values()) if (j.repo === repo) n++
    return n
  }

  /** Run `fn` under the repo's lock; never throws (errors go to `onError`). */
  run(
    issueId: string,
    repo: string,
    fn: () => Promise<void>,
    onError: (e: Error) => void = () => undefined,
  ): Promise<void> {
    if (this.running.has(issueId)) return Promise.resolve()
    this.running.set(issueId, { repo, startedAt: this.now() })
    const done = this.withLock(repo, fn)
      .catch(onError)
      .finally(() => this.running.delete(issueId))
    return done
  }

  /** Serialise work per repo (the keeper's `ensureUp` and a dispatch must not interleave). */
  withLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(repo) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    this.locks.set(
      repo,
      next.then(
        () => undefined,
        () => undefined,
      ),
    )
    return next
  }

  /** Wait for every running job (used by `serve` on shutdown and by tests). */
  async drain(): Promise<void> {
    await Promise.all(this.locks.values())
  }
}
