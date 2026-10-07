import { spawn } from 'node:child_process'

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export interface RunOptions {
  cwd?: string
  input?: string
  env?: Record<string, string>
  timeoutMs?: number
}

export interface InteractiveOptions {
  cwd?: string
  env?: Record<string, string>
}

/** Everything oar runs on the Mac goes through this, so tests can record and fake it. */
export interface Exec {
  run(cmd: string, args: string[], opts?: RunOptions): Promise<ExecResult>
  /** stdio inherited: ssh sessions, editors, `herdr --remote`, `claude auth login`. */
  interactive(cmd: string, args: string[], opts?: InteractiveOptions): Promise<number>
}

export const realExec: Exec = {
  run(cmd, args, opts = {}) {
    return new Promise((resolve) => {
      const child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
      const timer = opts.timeoutMs
        ? setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs)
        : undefined
      child.on('error', (e) => {
        if (timer) clearTimeout(timer)
        resolve({ code: 127, stdout, stderr: `${stderr}${e.message}` })
      })
      child.on('close', (code) => {
        if (timer) clearTimeout(timer)
        resolve({ code: code ?? 1, stdout, stderr })
      })
      // A child that never reads stdin (`systemctl is-active`, `true`) closes it first; the
      // resulting EPIPE on our end is noise, not a failure, and unhandled it kills the process.
      child.stdin.on('error', () => undefined)
      child.stdin.end(opts.input ?? '')
    })
  },
  interactive(cmd, args, opts = {}) {
    return new Promise((resolve) => {
      const child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        stdio: 'inherit',
      })
      child.on('error', () => resolve(127))
      child.on('close', (code) => resolve(code ?? 1))
    })
  },
}

/** Single-quote a string for a POSIX shell. */
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

const secrets: string[] = []
export const registerSecret = (value: string | undefined) => {
  if (value && value.length >= 8) secrets.push(value)
}
/** Replace every registered secret in a string before it reaches a terminal or a log. */
export const redact = (s: string) => secrets.reduce((acc, v) => acc.split(v).join('<redacted>'), s)

export const commandExists = async (exec: Exec, cmd: string) =>
  (await exec.run('/bin/sh', ['-c', `command -v ${shq(cmd)}`])).code === 0
