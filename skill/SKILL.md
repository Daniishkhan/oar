---
name: oar
description: Hand a task to Claude Code on this repo's boat.dev VM (engine = nodes-engine, cno = nodes-cno/Synapse-Django) with the `oar` CLI and track it to a draft PR. Use when the user says "hand off", "run on the VM", "overnight", "on boat", "dispatch", "/oar", or asks how a handed-off task is going.
---

# oar: hand a task to the VM

`oar` manages one boat.dev VM per repo. A dispatched task runs as an interactive Claude Code
session in a Herdr pane on that VM, in its own git worktree and branch, and ends in a draft PR.
The session is visible in Herdr and in the Claude iOS app (Remote Control), so the user can
steer it from a phone while the Mac sleeps.

## When to use it

- The task can run unattended for a while and needs the repo's real services (Postgres,
  Docker Compose, the full test suite), or the user wants to close the laptop.
- Only for the repos oar knows: run `oar doctor --quiet`; if it names no VM for this repo, say so
  and offer `oar vm new <repo>` or a local run instead.
- A tiny, isolated change with no services is better as `claude --cloud "…"`.

## Before dispatching

1. `oar doctor --repo <engine|cno> --quiet` (prints `ok` or the failing checks).
2. The worktree is created on the VM from `origin/<base>`, so the work the task depends on must
   be **pushed**. Uncommitted or unpushed local changes never reach the VM; tell the user.
3. Pick a slug: lowercase, dashes, 2-27 chars, starts with a letter (`fix-flaky-delivery-test`).
   It becomes the branch `codex/<slug>` and the worktree name.

## Writing the brief

The VM session has none of this conversation's context. Brief it like a colleague who only has
the repo: goal, the files or areas involved, what is out of scope, the acceptance check. Name the
gate explicitly (`pnpm verify` for engine; `make lint && make test` for cno, plus the focused tests
from AGENTS.md "Where to work"). For research tasks say where to write the report in the repo and
list the questions it must answer. Do **not** write finish steps (push, PR, done marker): oar
appends them. Use the template sections Goal / Scope / Plan / Gate / When blocked.

## Commands

```bash
oar task new <slug> --repo <engine|cno> --hours 8 --brief - <<'EOF'
# <title>
## Goal
…
## Scope
…
## Plan
…
## Gate (must be green before you stop)
…
## When blocked
Do not wait for me. Leave a `TODO(danish):` line in the PR body and continue.
EOF
oar task dispatch <id>          # prints the id, branch and worktree
```

Exit code 3 means the agent is waiting at a dialog: run `oar task read <id> --lines 40`, show the
user what it asks, and answer with `oar task keys <id> enter` (or `esc`, `y`, …) only when they say so.

Report back: the task id, the branch, and that `oar watch` in a Herdr pane will notify on
blocked/done. If `HERDR_ENV=1`, offer to split a pane running `oar watch`.

## Follow-ups

| The user asks                  | Run                                                                     |
| ------------------------------ | ----------------------------------------------------------------------- |
| how is it going                | `oar task status <id> --read 20`                                        |
| change course                  | `oar task steer <id> "…"`                                               |
| it finished but there is no PR | `oar task done <id>`                                                    |
| the VM was stopped             | `oar vm up <repo>` (resumes suspended tasks), or `oar task resume <id>` |
| everything at once             | `oar status`                                                            |

Never run `oar vm stop` while tasks are live unless the user asks; `--force-tasks` suspends them.
Several independent tasks: one `task new` + `dispatch` each; every task gets its own worktree,
so they do not collide. Keep each brief to one branch's worth of work.
