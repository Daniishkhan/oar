export type CodingAgent = 'claude' | 'codex'

/** Provider-specific launch arguments; lifecycle control stays in the Herdr adapter. */
export function agentArguments(
  kind: CodingAgent,
  options: { name: string; taskId: string; cwd: string; resume?: boolean; model?: string },
): string[] {
  if (kind === 'claude')
    return [
      ...(options.resume ? ['--continue'] : []),
      '--name',
      options.name,
      '--remote-control',
      options.name,
      ...(options.model ? ['--model', options.model] : []),
    ]
  return [
    ...(options.resume ? ['resume', '--last'] : []),
    '--cd',
    options.cwd,
    // Builders run with full permissions inside their dedicated Boat VM. Git worktree
    // metadata and local development services live outside the worktree directory.
    '--sandbox',
    'danger-full-access',
    '--ask-for-approval',
    'never',
    ...(options.model ? ['--model', options.model] : []),
  ]
}
