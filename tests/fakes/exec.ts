import type { Exec, ExecResult, InteractiveOptions, RunOptions } from '../../src/exec.js'

export interface Call {
  cmd: string
  args: string[]
  opts: RunOptions | InteractiveOptions
  interactive: boolean
}

type Answer = ExecResult | ((call: Call) => ExecResult)

/** Records every spawn and answers by the first matching rule (string prefix of "cmd args…" or regex). */
export class FakeExec implements Exec {
  calls: Call[] = []
  private rules: Array<{ match: (line: string) => boolean; answer: Answer }> = []

  on(pattern: string | RegExp, answer: Partial<ExecResult> | ((call: Call) => ExecResult)): this {
    const match =
      typeof pattern === 'string'
        ? (line: string) => line.startsWith(pattern)
        : (line: string) => pattern.test(line)
    this.rules.push({
      match,
      answer:
        typeof answer === 'function' ? answer : { code: 0, stdout: '', stderr: '', ...answer },
    })
    return this
  }

  line(call: Call) {
    return [call.cmd, ...call.args].join(' ')
  }

  private answer(call: Call): ExecResult {
    const line = this.line(call)
    const rule = this.rules.find((r) => r.match(line))
    if (!rule) return { code: 127, stdout: '', stderr: `fake exec: no rule for ${line}` }
    return typeof rule.answer === 'function' ? rule.answer(call) : rule.answer
  }

  async run(cmd: string, args: string[], opts: RunOptions = {}): Promise<ExecResult> {
    const call: Call = { cmd, args, opts, interactive: false }
    this.calls.push(call)
    return this.answer(call)
  }

  async interactive(cmd: string, args: string[], opts: InteractiveOptions = {}): Promise<number> {
    const call: Call = { cmd, args, opts, interactive: true }
    this.calls.push(call)
    return this.answer(call).code
  }

  lines() {
    return this.calls.map((c) => this.line(c))
  }
}
