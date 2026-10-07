# oar

Remote coding on [boat.dev](https://boat.dev) for one developer: one long-lived VM per repo,
the [Herdr](https://herdr.dev) server on the VM, Claude Code tasks dispatched into Herdr panes
and tracked to draft PRs. Close the lid; the agents keep going. Steer from the Claude phone app
through Remote Control.

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

- A Linear issue moved to **Ready** (team `ENG` → engine, `CNO` → cno; `factory.linear.teams`)
  becomes an oar task: brief from the issue and its comments, branch `codex/<team>-<n>-<slug>`,
  a Claude pane on the repo VM. The controller comments "Started…" and moves the card to
  **In Progress**.
- The agent asks by writing `question.md` next to its brief and stopping: the question lands on
  the issue (**Needs Input**), your reply is sent back as the next prompt. Any comment on an
  active issue reaches the agent (steered while it works, prompted when it waits).
- A draft PR with new commits moves the card to **In Review**; review comments, a
  changes-requested review and red CI come back as numbered rounds; a merge moves it to **Done**
  (nodes-cno: the staging workflow result is posted first). Canceling stops the agent.
- The keeper extends worker TTLs while they hold work and stops a worker idle for
  `factory.idleStopMinutes` (no busy Herdr agent, no terminal session). The controller itself
  never auto-stops.

Identity: an OAuth application in Linear ("oar", client credentials enabled) so its comments are
its own and notify you; `LINEAR_CLIENT_ID`/`LINEAR_CLIENT_SECRET` in `~/.config/oar/env`
(`LINEAR_API_KEY` works as a fallback, without notifications). Per Linear team, set the GitHub
PR automation to _merged → Done_ only.

```bash
oar factory setup            # controller VM, bundle, tailnet, worker keys + Herdr profiles, states, service
oar factory status           # phases per issue, VMs, last tick (forwarded over ssh)
oar factory log ENG-12 -f    # the controller's event log
oar factory attach ENG-12    # Herdr on the issue's agent
oar factory pause|resume     # hold new dispatches (running issues continue)
oar factory deploy           # after changing oar: rebuild, copy, restart
```

State on the controller: `~/.local/state/oar/state.json` (tasks, VMs) and `factory.sqlite`
(issues, rounds, comment delivery, idempotency keys, events).

## Development

`pnpm verify` = typecheck, format check, lint, tests. Unit tests use a scripted fake boat client
and a recording fake exec; nothing touches the network. `pnpm dev -- <args>` runs from source.

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
- [ ] Codex is not logged in on the VMs, so nodes-engine's pre-PR Codex review reports "did not run"; `codex login` over `oar vm ssh` if wanted
- [ ] boat `sshKey` appends (not replaces) authorized keys; every host re-appends its own key on `vm up` anyway
- [ ] `ttlSeconds: null` accepted for the controller sandbox (else the keeper pushes its deadline 24 h at a time)
- [ ] Linux Herdr client forwards `--machine` to another VM (controller → workers)
- [ ] Linear client-credentials token works for `viewer`, `issueUpdate`, `commentCreate` with a client id, `workflowStateCreate`
- [ ] A comment from the "oar" app user pushes to the phone
