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
4. `oar vm new engine` (interactive: setup output, `claude auth login`, `herdr machine add`).

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
token-protected public URL for the phone. `boat desktop <id>` streams the VM's desktop.

**Cost.** Default VM $0.036/h, free while stopped. Every create/resume gets a 12 h auto-stop;
`oar vm keep <repo> 10` pushes it; `oar watch` extends it while a task is working, within the
task's `--hours` budget. `oar status` shows "$ today" per VM.

## Development

`pnpm verify` = typecheck, format check, lint, tests. Unit tests use a scripted fake boat client
and a recording fake exec; nothing touches the network. `pnpm dev -- <args>` runs from source.

### Confirmed on first real use

Update this list as the end-to-end checks from the plan are run against the real account.

- [x] `sshKey` returns `sshEndpoint` (`host:port`, NATed) and a single-line `ssh-ed25519` `hostKey` (2026-10-07, engine)
- [ ] PATCH `ttlSeconds` anchor (now vs last resume) — `oar vm keep` logs the correction when it happens
- [x] `herdr-server.service` is enabled and active after setup with the socket at `~/.config/herdr/herdr.sock` (2026-10-07)
- [ ] `herdr-server.service` restores the session after a resume and `herdr --remote` attaches to it
- [ ] `herdr --machine` works again after the endpoint changes, without `machine reconnect`
- [x] `worktree create` result fields mirror `workspace create` (`workspace.workspace_id`, `tab.tab_id`, `root_pane.pane_id`) (2026-10-07)
- [x] the `~/.claude.json` pre-trust suppresses the trust dialog on the VM; what did appear was the
      fullscreen-renderer prompt, now pre-set via `tui` in `vm/claude-settings.json` and answered by the runner (2026-10-07)
- [x] `gh pr create` on the VM works with the injected token: nodes-engine draft PR #149 from the smoke task (2026-10-07)
- [x] `herdr machine add <alias> --label <l> --remote-session default` works non-interactively once the server runs on the VM (2026-10-07)
- [ ] Codex is not logged in on the VMs, so nodes-engine's pre-PR Codex review reports "did not run"; `codex login` over `oar vm ssh` if wanted
