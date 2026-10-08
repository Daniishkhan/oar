# oar

Remote coding agents on [boat.dev](https://boat.dev) VMs, from a one-off task to a software
factory. oar has two layers:

- **The CLI** gives one developer a long-lived VM per repo with the
  [Herdr](https://herdr.dev) server on it. Claude Code tasks are dispatched into Herdr panes and
  tracked to draft PRs. Close the lid; the agents keep going, and you can steer them from the
  Claude phone app through Remote Control.
- **The factory** is an always-on controller VM that turns Linear issues into merged PRs. Move
  an issue to Todo and an agent builds it, CI runs, an automated reviewer checks the PR, and a
  clean review merges it. Your only step is validating on staging. See
  [Factory](#factory-linear--agents-no-mac-in-the-loop).

```
oar vm new engine        # create the VM from boat environment "engine", run setup, log Claude in, register in Herdr
oar vm up engine         # resume if stopped, pin the new host key, attach Herdr
oar task new fix-flaky-test --repo engine --hours 8     # brief in $EDITOR (or --brief FILE | -)
oar task dispatch fix-flaky-test                        # worktree + Claude in a Herdr pane on the VM
oar watch                # in a Herdr pane: notifies on blocked/done, keeps the VM alive while tasks run
oar status               # every VM and task on one screen
```

## How it fits together

| Where       | What                                                                                          |
| ----------- | --------------------------------------------------------------------------------------------- |
| Mac         | `oar` (this CLI), `herdr` client, `~/.claude/skills/oar` so Claude can hand work off          |
| VM `engine` | `/home/user/nodes-engine`, Herdr server (systemd), Claude Code logged in with the Max plan    |
| VM `cno`    | `/home/user/nodes-cno`, same                                                                  |
| Phone       | Claude app → Code tab: every dispatched task is a Remote Control session named after the task |

A task = a brief (`~/.local/state/oar/tasks/<id>/brief.md`) + a branch `codex/<slug>` + a git
worktree `/home/user/worktrees/<repo>/<slug>` + a Herdr pane running `claude --name <id>
--remote-control <id>`. oar appends a footer to the brief with the gate and the finish steps
(push, `gh pr create --draft`, `touch …/done`). Status is derived from three signals: Herdr's
agent state, the PR on GitHub, and the done marker on the VM.

## Setup

1. `pnpm install && pnpm install:local` (links `~/.local/bin/oar`, copies the skill).
2. `~/.config/oar/env` with `BOAT_API_KEY=boat_…` (mode 600). `~/.config/oar/config.json` is
   written with the shipped defaults on first run; edit repos there.
3. In the boat dashboard: connect GitHub and install boat's GitHub App on the organisation, then
   attach each repo to its environment (`engine`, `cno`) and upload the repo's `.env` as a secret
   file. `oar doctor` checks the rest.
4. `oar vm new engine` (interactive: setup output, `claude auth login`, `herdr machine add`). Later logins: `oar vm login engine` (and `--codex`), which also saves them for resumes.

## Playbooks

**Start the day.** `oar vm up engine` → Herdr opens on the VM with yesterday's layout. If the VM
was stopped overnight, running processes are gone: `pnpm db:up` again, `claude --continue` in a
pane. Suspended tasks are resumed automatically.

**Hand off and close the lid.** From a Claude session: "hand this off to the VM" → the `oar`
skill writes the brief, runs `oar task new` + `oar task dispatch`, and tells you the id. Or by
hand: `oar task new <slug> --repo cno --hours 8`, edit the brief, `oar task dispatch <slug>`.
Run `oar watch` in a Herdr pane on the Mac (or leave it; `oar status` in the morning). Close the
lid. On the phone, the task shows in the Claude app's Code tab; you get pushes when it finishes
or needs you. Morning: the draft PR is on GitHub; `oar task status <id> --read 30` for the tail.

**Blocked.** `oar task status <id>` exits 3 and prints the dialog. `oar task keys <id> enter` (or
`esc`, `y`) answers it; `oar task steer <id> "…"` sends a message; `oar task attach <id>` opens
Herdr on that pane.

**Finished without a PR.** `oar task done <id>` pushes and opens the draft PR from the VM.

**VM stopped mid-task** (auto-stop, `oar vm stop --force-tasks`). `oar vm up <repo>` resumes the
VM and every suspended task; `oar task resume <id>` does one.

**Look at the app.** `oar vm tunnel engine 3000` makes the VM's port 3000 `localhost:3000` on the
Mac (OAuth callbacks and `ALLOWED_HOSTS` keep working). `oar vm preview cno 8000` gives a
token-protected public URL for the phone; `oar vm serve cno 8000` a tailnet-only one.

**Watch the agent.** `oar vm desktop engine` streams the VM's desktop (add `--vnc` on a phone),
where the agent's persistent, signed-in Chrome lives; `oar vm shot engine --window Chromium` pulls a
screenshot to the Mac. Agents get `browser`, `browser-headless`, `chrome-devtools` and boat's
`computer` MCP servers, plus `shot`/`pr-shot` helpers; `vm/CLAUDE.md` tells them which to use.

**Cost.** Default VM $0.036/h, free while stopped. Every create/resume gets a 12 h auto-stop;
`oar vm keep <repo> 10` pushes it; `oar watch` extends it while a task is working, within the
task's `--hours` budget. `oar status` shows "$ today" per VM.

## Factory (Linear → agents, no Mac in the loop)

An always-on `small` boat VM, `oar-factory`, runs `oar factory serve` as a systemd unit. It polls
Linear and GitHub and drives the worker VMs with the same code the CLI uses:

- A Linear issue moved to the trigger state (`factory.linear.states.ready`, default **Ready**;
  team `ENG` → engine, `CNO` → cno; `factory.linear.teams`) becomes an oar task: brief from the issue and its comments, branch `codex/<team>-<n>-<slug>`,
  a Claude pane on the repo VM. The controller comments "Started…" and moves the card to
  **In Progress**.
- The agent asks by writing `question.md` next to its brief and stopping: the question lands on
  the issue (**Needs Input**), your reply is sent back as the next prompt. Any comment on an
  active issue reaches the agent (steered while it works, prompted when it waits).
- A draft PR with new commits moves the card to **In Review**; review comments, a
  changes-requested review and red CI come back as numbered rounds; a merge moves it to **Done**
  (nodes-cno: the staging workflow result is posted first). Canceling stops the agent.
- Once the PR's checks are green and nobody has commented, an automated reviewer (Codex by
  default, `factory.review`) reads the head commit in a detached worktree on the repo VM,
  read-only, and posts its findings on the PR and the issue. It checks every functional and
  non-functional criterion a ticket lists; an unmet one is P1, and the builder lists how it met
  each one in the PR body. P0/P1 findings (`review.blocking`)
  go back to the agent as a review round, at most `review.maxRounds` times; a clean review merges
  the PR (`gh pr merge --squash --match-head-commit`, per repo `autoMerge`/`mergeMethod`). Human
  feedback always comes first. A `hold` label on the issue (`factory.holdLabel`) stops the merge;
  a reviewer failure, a conflict, a refused merge or a round that pushes nothing parks the issue
  in **Needs Input**; a reply there retries. Merging by hand overrides the reviewer.
- The keeper extends worker TTLs while they hold work and stops a worker idle for
  `factory.idleStopMinutes` (no busy Herdr agent, no terminal session). The controller itself
  never auto-stops.

Identity: an OAuth application in Linear ("oar", client credentials enabled) so its comments are
its own and notify you; `LINEAR_CLIENT_ID`/`LINEAR_CLIENT_SECRET` in `~/.config/oar/env`
(`LINEAR_API_KEY` works as a fallback, without notifications). Per Linear team, set the GitHub
PR automation to _merged → Done_ only.

Tickets come from a planning session: Claude, using the oar skill's
[tickets.md](skill/tickets.md), writes the approved plan as a JSON file and `oar ticket create`
turns it into a parent issue labelled `spec`, which the controller never builds, and one
sub-issue per ticket in Backlog. Each ticket has Goal, Jobs to be done, Functional and
Non-functional criteria, Scope, Decisions and a Staging check, and "blocked by" links set the
order. A ticket's brief includes its parent plan.

```bash
oar ticket check plan.json   # validate and show the rendered tickets
oar ticket create plan.json  # plan issue + tickets in Backlog; ids written back, a re-run resumes
oar factory setup            # controller VM, bundle, tailnet, worker keys + Herdr profiles, states, service
oar factory status           # phases per issue, VMs, last tick (forwarded over ssh)
oar factory log ENG-12 -f    # the controller's event log
oar factory attach ENG-12    # Herdr on the issue's agent
oar factory pause|resume     # hold new dispatches (running issues continue)
oar factory deploy           # after changing oar or its config: rebuild, copy bundle + config, restart
```

State on the controller: `~/.local/state/oar/state.json` (tasks, VMs) and `factory.sqlite`
(issues, rounds, reviews, merge attempts, comment delivery, idempotency keys, events). Its
config is the Mac's, copied by `setup` and `deploy`; both bring a stored repo entry up to the
shipped defaults first (nodes-cno: base `dev`, deploy workflow `staging.yml`).

## Development

Requirements: Node 24 (the factory uses `node:sqlite`) and pnpm 12, as pinned in `package.json`.

```bash
pnpm install
pnpm dev -- status         # run from source
pnpm verify                # typecheck, format check, lint, tests; must be green before a commit
pnpm install:local         # build dist/oar.mjs, link ~/.local/bin/oar, copy the skill
oar factory deploy         # ship the build and the config to the controller, restart it
```

Unit tests use a scripted fake boat client (`tests/fakes/boat.ts`) and a recording fake exec
(`tests/fakes/exec.ts`); nothing touches the network. `pnpm format` fixes formatting.

### Code map

| Path                                                                                       | What                                                                                              |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| [src/cli.ts](src/cli.ts)                                                                   | Argument parsing, help text, exit codes; the only place that exits                                |
| [src/config.ts](src/config.ts)                                                             | Config schema and shipped defaults, secrets from `~/.config/oar/env`                              |
| [src/boat.ts](src/boat.ts), [src/ssh.ts](src/ssh.ts), [src/herdr.ts](src/herdr.ts)         | boat API client and commands on a VM, ssh aliases and pinned host keys, the Herdr client          |
| [src/runner.ts](src/runner.ts)                                                             | Agents in Herdr panes: dispatch, state, read, prompt, steer, stop, resume                         |
| [src/brief.ts](src/brief.ts), [src/github.ts](src/github.ts), [src/state.ts](src/state.ts) | Task briefs and their footer, PR lookups and `gh` calls, `state.json`                             |
| [src/commands/](src/commands)                                                              | `vm`, `task`, `status`, `watch`, `doctor`, `factory` and `ticket` subcommands                     |
| [src/factory/](src/factory)                                                                | The controller, below                                                                             |
| [setup/](setup), [vm/](vm), [templates/](templates), [skill/](skill)                       | VM setup scripts and units, files copied onto VMs, brief and reviewer templates, the Claude skill |

### The factory controller

One tick every 30 seconds, in [loop.ts](src/factory/loop.ts): sync Linear, then for each active
issue observe, decide and apply, then the keeper.

- [observe.ts](src/factory/observe.ts) gathers facts about an issue and never writes.
- [reconcile.ts](src/factory/reconcile.ts) `decide()` is a pure function from an issue row and
  its facts to actions. Every transition is a row in `tests/factory/reconcile.test.ts`.
- [apply.ts](src/factory/apply.ts) runs the actions. Anything slow (dispatch, resume, a review
  round, the automated review, the merge) is a job under a per-repo lock ([jobs.ts](src/factory/jobs.ts)).
- [db.ts](src/factory/db.ts) is the SQLite store. New columns go in `SCHEMA` and in the additive
  migration list, because the live controller database already exists.
- [linear.ts](src/factory/linear.ts), [github.ts](src/factory/github.ts), [review.ts](src/factory/review.ts),
  [brief.ts](src/factory/brief.ts) and [keeper.ts](src/factory/keeper.ts) hold the Linear client,
  the GitHub feeds, the automated reviewer, the agent-facing text and VM uptime.
  [tickets.ts](src/factory/tickets.ts) is the plan-file schema and the ticket template.

Rules that keep the controller safe to restart at any moment:

- Linear is the only state machine. The controller writes a Linear state only on a phase change.
- Comments are idempotent per issue and key, and every prompt carries an `[oar r<n>]` round token.
- A merge is attempted at most once per head SHA, and a reviewer failure is recorded so it never
  loops.
- Nothing the agent or the PR controls may configure the controller or the reviewer.

To add a repo: a `repos.<key>` entry in the config, its Linear team in `factory.linear.teams`,
`oar vm new <key>`, then `oar factory setup`. No code changes. A new capability should be a new
action and job driven by config, not a per-repo branch in the code.

### Roadmap

Built: the CLI, the controller, questions and replies through Linear, review and CI rounds, the
staging result, automated P0/P1 review and auto-merge, plans turned into tickets. Next: a separate verify sandbox (UI and
end-to-end checks), a `validate` gate after staging and automatic promotion, inspection and spec
recipes that write Linear issues, parallel builds on forked VMs, and HTML or Figma prototyping.

### Confirmed on first real use

Update this list as the end-to-end checks from the plan are run against the real account.

- [x] `sshKey` returns `sshEndpoint` (`host:port`, NATed) and a single-line `ssh-ed25519` `hostKey` (2026-10-07, engine)
- [ ] PATCH `ttlSeconds` anchor (now vs last resume) — `oar vm keep` logs the correction when it happens
- [x] `herdr-server.service` is enabled and active after setup with the socket at `~/.config/herdr/herdr.sock` (2026-10-07)
- [x] `herdr-server.service` comes back after a resume (oar nudges it when `--machine` is not yet answering) (2026-10-07)
- [x] Tailnet identity survives stop→resume with state under `/etc/tailscale`: same 100.x address, `ssh oar-engine` over the tailnet with boat's pinned host key, no re-pin (2026-10-07)
- [x] `/srv/oar/chrome` profile, `~/.local/share/ms-playwright`, lingering and the agent-chrome unit survive stop→resume (2026-10-07)
- [x] Inside a Herdr pane Claude sees DISPLAY/XDG_RUNTIME_DIR/DBUS and `browser`, `browser-headless`, `chrome-devtools`, `computer`, `graft` all connected (2026-10-07)
- [x] boat removes `~/.claude/.credentials.json` and `~/.codex/auth.json` on resume when agent-credential passing is off; `oar-creds` keeps copies under `/srv/oar/creds`, restored at boot and by `oar vm up`; log in with `oar vm login <repo> [--codex]` so the copy is taken (found 2026-10-07 on the first engine resume)
- [ ] Tailnet nodes are user-owned (full member access under the default policy); to isolate them, define `tag:oar` in the policy and re-join with `OAR_TS_TAGS=tag:oar`
- [x] `herdr --machine` works again after the endpoint changes, without `machine reconnect` (2026-10-07, via the tailnet alias)
- [x] `worktree create` result fields mirror `workspace create` (`workspace.workspace_id`, `tab.tab_id`, `root_pane.pane_id`) (2026-10-07)
- [x] the `~/.claude.json` pre-trust suppresses the trust dialog on the VM; what did appear was the
      fullscreen-renderer prompt, now pre-set via `tui` in `vm/claude-settings.json` and answered by the runner (2026-10-07)
- [x] `gh pr create` on the VM works with the injected token: nodes-engine draft PR #149 from the smoke task (2026-10-07)
- [x] `herdr machine add <alias> --label <l> --remote-session default` works non-interactively once the server runs on the VM (2026-10-07)
- [x] Codex CLI is on both worker images (`/usr/local/bin/codex`); engine has a saved login (2026-10-08). The factory's automated reviewer needs it on every repo VM: `oar vm login <repo> --codex`
- [x] boat `sshKey` appends (not replaces) authorized keys: the Mac's and the controller's keys both stay on the workers (2026-10-08); every host re-appends its own key on `vm up` anyway
- [x] `ttlSeconds: null` accepted at creation for the controller sandbox; `archiveAfter` reads null (2026-10-08)
- [x] Factory end to end on nodes-cno: Todo, agent, draft PR to `dev`, green CI, Codex review with no findings, auto-merge, Done, staging deploy success, in 26 minutes with no human click (2026-10-08, CNO-1)
- [x] Linux Herdr client forwards `--machine` to another VM: `herdr machine add oar-engine --label engine --remote-session default` on the controller, then `herdr --machine engine agent list` answers (2026-10-08)
- [x] Linear client-credentials token works for `viewer` (app user "oar"), `issueUpdate`, `commentCreate` with a client id and `attachmentLinkGitHubPR`; `workflowStateCreate` is refused ("not allowed to take action"), so `oar factory setup` reports missing states and they are added in Settings → Teams → Issue statuses (2026-10-08)
- [ ] A comment from the "oar" app user pushes to the phone (it does raise an Inbox notification in Linear, 2026-10-08)
- [x] First live issue ENG-1 → draft PR nodes-engine #151 → In Review in 4 min; a PR comment started round 2 and the agent pushed the fix in 3 min; a merge closed it (2026-10-08). Learned on the way: a cancelled check is not a failure, boat's transient `updating` sandbox state must be waited out, agents pause for their own background shells (one nudge before Needs Input), and a re-queued issue with a PR is resumed rather than re-briefed
