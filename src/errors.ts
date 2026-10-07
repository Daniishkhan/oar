export type OarCode =
  | 'usage'
  | 'config'
  | 'secrets'
  | 'state_invalid'
  | 'no_vm'
  | 'no_task'
  | 'boat'
  | 'ssh'
  | 'herdr'
  | 'blocked'
  | 'branch_exists'
  | 'not_ready'
  | 'unsupported'

export const EXIT = { ok: 0, error: 1, usage: 2, blocked: 3 } as const

export class OarError extends Error {
  constructor(
    public readonly code: OarCode,
    message: string,
    public readonly hint?: string,
    public readonly exitCode: number = code === 'usage'
      ? EXIT.usage
      : code === 'blocked'
        ? EXIT.blocked
        : EXIT.error,
  ) {
    super(message)
    this.name = 'OarError'
  }
}

export const usage = (message: string, hint?: string) => new OarError('usage', message, hint)
