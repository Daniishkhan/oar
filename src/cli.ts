import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs, type ParseArgsConfig } from 'node:util'
import { doctor } from './commands/doctor.js'
import { factoryCmd } from './commands/factory.js'
import { status } from './commands/status.js'
import { ticketCmd } from './commands/ticket.js'
import * as task from './commands/task.js'
import * as vm from './commands/vm.js'
import { watch } from './commands/watch.js'
import { inferRepo } from './config.js'
import { buildCtx, type Ctx } from './context.js'
import { EXIT, OarError, usage } from './errors.js'
import { redact } from './exec.js'

const HELP = `oar — Claude and Codex coding on boat.dev, from repository plans to verified staging

  oar vm new|up|stop|keep|ssh|tunnel|preview|setup|snapshot|list [repo] [...]
  oar task new|dispatch|status|read|steer|keys|attach|done|resume|close|list [...]
  oar status [--all]            every VM and task on one screen
  oar watch [--until-idle]      poll live tasks, notify on blocked/done, keep the VM alive
  oar doctor [--repo r] [--quiet]
  oar factory setup|deploy|check|status|evidence|log|pause|resume|attach|up|stop|doctor|states
  oar ticket example|check|create|refresh   a planned piece of work → Linear tickets in Backlog

vm
  new <repo> [--no-login] [--type small|default|large]   create from the boat environment, run setup, log Claude in, register in Herdr
  up [repo] [--no-attach]       resume if stopped, refresh ssh + host key, repair Herdr, attach
  stop [repo] [--force-tasks]   snapshot + stop (free); live tasks become suspended
  keep [repo] [hours]           push the auto-stop deadline to now + hours (default from config)
  ssh [repo] [-- cmd...]        shell on the VM
  tunnel [repo] [ports...]      VM ports on localhost here (ssh -L)
  preview [repo] <port> [--public]   stable HTTPS URL (token-protected unless --public)
  serve [repo] <port> [--off]   private tailnet URL https://oar-<repo>.<tailnet> → the VM's port
  desktop [repo] [--vnc] [--public] [--no-open]   stream the VM's desktop (watch the agent's Chrome)
  browser [repo]                boat's Chrome-only stream of the agent profile (needs the boat CLI)
  shot [repo] [--window name] [--out file] [--no-open]   screenshot of the VM desktop, saved locally
  setup [repo]                  re-copy setup/ and vm/ files and run the setup script
  login [repo] [--codex]        claude auth login (or codex login) on the VM, saved so a resume keeps it
  snapshot [repo] <name>        named snapshot (boat new --from <name>)
  list

task
  new <slug> [--repo r] [--hours N] [--brief FILE|-]     brief from a file, stdin (-), or $EDITOR on the template
  dispatch <id|slug> [--reuse-branch]                   worktree + configured agent in a Herdr pane on the VM
  status <id|slug> [--read N]   derived status (agent state, PR, done marker)
  read <id|slug> [--lines N]    the agent's recent output
  steer <id|slug> "message"     send a message to the running agent
  keys <id|slug> <key...>       answer a dialog: enter, esc, y, ctrl+c, ...
  attach <id|slug>              focus the agent and attach Herdr
  done <id|slug>                push + draft PR from the VM when the agent stopped short of it
  resume <id|slug>              re-attach after the VM was stopped and resumed
  close <id|slug>               hide it from lists
  list [--all]

factory (an always-on controller VM turns Linear issues into tasks on the repo VMs)
  setup                         create/resume the controller, copy oar there, join the tailnet, register workers, start the service
  deploy                        rebuild oar, copy it and the config to the controller, restart the service
  status | log [ISSUE] [-f]     what the controller is doing (forwarded over ssh)
  evidence <ISSUE>              JSON history of checks, reviews, deployment, and verification
  check                         validate local staging and reviewer settings before rollout
  pause | resume                stop/allow new dispatches
  attach <ENG-12>               focus the issue's agent on its worker and attach Herdr
  up | stop                     the controller sandbox itself

ticket (turn an approved plan into Linear tickets; see the oar skill's tickets.md)
  example                       print a valid plan file
  check <plan.json>             validate and show the rendered tickets; nothing is sent
  create <plan.json> [--dry-run]   create the plan issue (label spec) and its tickets in Backlog,
                                with blocked-by links; ids are written back so a re-run resumes
  doctor | states               controller health; create missing Linear workflow states

Repo is inferred from the current git checkout's origin when omitted. Exit codes: 1 error, 2 usage, 3 agent blocked.`

type Opts = NonNullable<ParseArgsConfig['options']>

function parse<O extends Opts>(args: string[], options: O) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true })
  } catch (e) {
    throw usage((e as Error).message)
  }
}

async function repoArg(ctx: Ctx, positional: string | undefined, flag: unknown): Promise<string> {
  const name = (typeof flag === 'string' && flag) || positional
  if (name) {
    if (!ctx.config.repos[name])
      throw usage(`unknown repo '${name}'`, `known: ${Object.keys(ctx.config.repos).join(', ')}`)
    return name
  }
  return inferRepo(ctx.config, ctx.exec, process.cwd())
}

const repoOpt = { repo: { type: 'string' as const, short: 'r' } }

async function vmCmd(ctx: Ctx, args: string[]): Promise<number> {
  const [sub, ...rest] = args
  switch (sub) {
    case 'new': {
      const { values, positionals } = parse(rest, {
        ...repoOpt,
        'no-login': { type: 'boolean' },
        type: { type: 'string' },
      })
      const repo = await repoArg(ctx, positionals[0], values.repo)
      await vm.vmNew(ctx, repo, {
        noLogin: Boolean(values['no-login']),
        type: values.type as 'small' | 'default' | 'large' | undefined,
      })
      return 0
    }
    case 'up': {
      const { values, positionals } = parse(rest, { ...repoOpt, 'no-attach': { type: 'boolean' } })
      await vm.vmUp(ctx, await repoArg(ctx, positionals[0], values.repo), {
        attach: values['no-attach'] ? false : undefined,
      })
      return 0
    }
    case 'stop': {
      const { values, positionals } = parse(rest, {
        ...repoOpt,
        'force-tasks': { type: 'boolean' },
      })
      await vm.vmStop(ctx, await repoArg(ctx, positionals[0], values.repo), {
        forceTasks: Boolean(values['force-tasks']),
      })
      return 0
    }
    case 'keep': {
      const { values, positionals } = parse(rest, repoOpt)
      const [a, b] = positionals
      const repoName = a && /^\d+(\.\d+)?$/.test(a) ? undefined : a
      const hoursRaw = a && /^\d+(\.\d+)?$/.test(a) ? a : b
      await vm.vmKeep(
        ctx,
        await repoArg(ctx, repoName, values.repo),
        hoursRaw ? Number(hoursRaw) : undefined,
      )
      return 0
    }
    case 'ssh': {
      const dash = rest.indexOf('--')
      const own = dash === -1 ? rest : rest.slice(0, dash)
      const cmd = dash === -1 ? undefined : rest.slice(dash + 1).join(' ')
      const { values, positionals } = parse(own, repoOpt)
      return vm.vmSsh(ctx, await repoArg(ctx, positionals[0], values.repo), cmd)
    }
    case 'tunnel': {
      const { values, positionals } = parse(rest, repoOpt)
      const repoName = positionals[0] && !/^\d+$/.test(positionals[0]) ? positionals[0] : undefined
      const ports = positionals.filter((p) => /^\d+$/.test(p)).map(Number)
      return vm.vmTunnel(ctx, await repoArg(ctx, repoName, values.repo), ports)
    }
    case 'preview': {
      const { values, positionals } = parse(rest, { ...repoOpt, public: { type: 'boolean' } })
      const repoName = positionals[0] && !/^\d+$/.test(positionals[0]) ? positionals[0] : undefined
      const port = positionals.find((p) => /^\d+$/.test(p))
      if (!port) throw usage('preview needs a port')
      await vm.vmPreview(
        ctx,
        await repoArg(ctx, repoName, values.repo),
        Number(port),
        Boolean(values.public),
      )
      return 0
    }
    case 'setup': {
      const { values, positionals } = parse(rest, repoOpt)
      await vm.vmSetup(ctx, await repoArg(ctx, positionals[0], values.repo))
      return 0
    }
    case 'desktop': {
      const { values, positionals } = parse(rest, {
        ...repoOpt,
        vnc: { type: 'boolean' },
        public: { type: 'boolean' },
        'no-open': { type: 'boolean' },
      })
      await vm.vmDesktop(ctx, await repoArg(ctx, positionals[0], values.repo), {
        vnc: Boolean(values.vnc),
        isPublic: Boolean(values.public),
        open: values['no-open'] ? false : undefined,
      })
      return 0
    }
    case 'browser': {
      const { values, positionals } = parse(rest, repoOpt)
      await vm.vmBrowser(ctx, await repoArg(ctx, positionals[0], values.repo))
      return 0
    }
    case 'shot': {
      const { values, positionals } = parse(rest, {
        ...repoOpt,
        window: { type: 'string', short: 'w' },
        out: { type: 'string', short: 'o' },
        'no-open': { type: 'boolean' },
      })
      await vm.vmShot(ctx, await repoArg(ctx, positionals[0], values.repo), {
        window: values.window,
        out: values.out,
        open: values['no-open'] ? false : undefined,
      })
      return 0
    }
    case 'login': {
      const { values, positionals } = parse(rest, { ...repoOpt, codex: { type: 'boolean' } })
      await vm.vmLogin(ctx, await repoArg(ctx, positionals[0], values.repo), {
        codex: Boolean(values.codex),
      })
      return 0
    }
    case 'serve': {
      const { values, positionals } = parse(rest, { ...repoOpt, off: { type: 'boolean' } })
      const repoName = positionals[0] && !/^\d+$/.test(positionals[0]) ? positionals[0] : undefined
      const port = positionals.find((p) => /^\d+$/.test(p))
      if (!port && !values.off) throw usage('serve needs a port')
      await vm.vmServe(ctx, await repoArg(ctx, repoName, values.repo), Number(port ?? 0), {
        off: Boolean(values.off),
      })
      return 0
    }
    case 'snapshot': {
      const { values, positionals } = parse(rest, repoOpt)
      const [a, b] = positionals
      const name = b ?? a
      if (!name) throw usage('snapshot needs a name')
      await vm.vmSnapshot(ctx, await repoArg(ctx, b ? a : undefined, values.repo), name)
      return 0
    }
    case 'list':
      await vm.vmList(ctx)
      return 0
    default:
      throw usage(`oar vm ${sub ?? ''}: unknown subcommand`)
  }
}

async function taskCmd(ctx: Ctx, args: string[]): Promise<number> {
  const [sub, ...rest] = args
  switch (sub) {
    case 'new': {
      const { values, positionals } = parse(rest, {
        ...repoOpt,
        hours: { type: 'string' },
        brief: { type: 'string', short: 'b' },
      })
      const slug = positionals[0]
      if (!slug) throw usage('task new needs a slug')
      const repo = await repoArg(ctx, undefined, values.repo)
      const brief = values.brief
      await task.taskNew(ctx, {
        repo,
        slug,
        hours: values.hours ? Number(values.hours) : undefined,
        briefFile: brief && brief !== '-' ? brief : undefined,
        briefStdin: brief === '-' ? readFileSync(0, 'utf8') : undefined,
      })
      return 0
    }
    case 'dispatch': {
      const { values, positionals } = parse(rest, { 'reuse-branch': { type: 'boolean' } })
      if (!positionals[0]) throw usage('dispatch needs a task id or slug')
      await task.taskDispatch(ctx, positionals[0], { reuseBranch: Boolean(values['reuse-branch']) })
      return 0
    }
    case 'status': {
      const { values, positionals } = parse(rest, { read: { type: 'string' } })
      if (!positionals[0]) throw usage('status needs a task id or slug')
      const o = await task.taskStatus(ctx, positionals[0], {
        read: values.read ? Number(values.read) : undefined,
      })
      return o.status === 'blocked' ? EXIT.blocked : 0
    }
    case 'read': {
      const { values, positionals } = parse(rest, { lines: { type: 'string', short: 'n' } })
      if (!positionals[0]) throw usage('read needs a task id or slug')
      await task.taskRead(ctx, positionals[0], values.lines ? Number(values.lines) : 60)
      return 0
    }
    case 'steer': {
      const [ref, ...msg] = rest
      if (!ref || !msg.length) throw usage('steer needs a task and a message')
      await task.taskSteer(ctx, ref, msg.join(' '))
      return 0
    }
    case 'keys': {
      const [ref, ...keys] = rest
      if (!ref || !keys.length) throw usage('keys needs a task and at least one key')
      await task.taskKeys(ctx, ref, keys)
      return 0
    }
    case 'attach': {
      if (!rest[0]) throw usage('attach needs a task id or slug')
      return task.taskAttach(ctx, rest[0])
    }
    case 'done': {
      if (!rest[0]) throw usage('done needs a task id or slug')
      await task.taskDone(ctx, rest[0])
      return 0
    }
    case 'resume': {
      if (!rest[0]) throw usage('resume needs a task id or slug')
      await task.taskResume(ctx, rest[0])
      return 0
    }
    case 'close': {
      if (!rest[0]) throw usage('close needs a task id or slug')
      await task.taskClose(ctx, rest[0])
      return 0
    }
    case 'list': {
      const { values } = parse(rest, { all: { type: 'boolean' } })
      await task.taskList(ctx, Boolean(values.all))
      return 0
    }
    default:
      throw usage(`oar task ${sub ?? ''}: unknown subcommand`)
  }
}

export async function main(argv: string[], ctx: Ctx = buildCtx()): Promise<number> {
  const [group, ...rest] = argv
  switch (group) {
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      ctx.io.out(HELP)
      return 0
    case 'vm':
      return vmCmd(ctx, rest)
    case 'task':
      return taskCmd(ctx, rest)
    case 'factory':
      return factoryCmd(ctx, rest)
    case 'ticket':
      return ticketCmd(ctx, rest)
    case 'status': {
      const { values } = parse(rest, { all: { type: 'boolean' } })
      await status(ctx, { all: Boolean(values.all) })
      return 0
    }
    case 'watch': {
      const { values } = parse(rest, { 'until-idle': { type: 'boolean' } })
      await watch(ctx, { untilIdle: Boolean(values['until-idle']) })
      return 0
    }
    case 'doctor': {
      const { values } = parse(rest, { ...repoOpt, quiet: { type: 'boolean', short: 'q' } })
      return (await doctor(ctx, { repo: values.repo, quiet: Boolean(values.quiet) })) ? 0 : 1
    }
    default:
      throw usage(`unknown command '${group}'`, 'oar --help')
  }
}

const entryPath = (() => {
  try {
    return process.argv[1] ? realpathSync(process.argv[1]) : ''
  } catch {
    return ''
  }
})()
if (entryPath === fileURLToPath(import.meta.url) || process.env.OAR_ENTRY === '1') {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      if (e instanceof OarError) {
        process.stderr.write(`oar: ${redact(e.message)}\n`)
        if (e.hint) process.stderr.write(`  → ${redact(e.hint)}\n`)
        process.exit(e.exitCode)
      }
      process.stderr.write(`oar: ${redact((e as Error).stack ?? String(e))}\n`)
      process.exit(EXIT.error)
    },
  )
}
