---
name: oar
description: Hand a task to Claude Code or Codex on this repo's boat.dev VM (engine = nodes-engine, cno = nodes-cno) with the `oar` CLI and track it to a draft PR, turn an approved plan into Linear tickets for the factory with `oar ticket`, or inspect factory delivery to staging. Use when the user says "hand off", "run on the VM", "overnight", "on boat", "dispatch", "/oar", "plan this for the factory", "write tickets", "put this in Linear", or asks how a handed-off task or factory issue is going.
---

# oar: hand a task to the VM

`oar` manages a builder boat.dev VM per repo. Tasks run in a git worktree and Herdr pane,
using `repos.<repo>.buildRunner` (`claude` or `codex`) and optional `buildModel`. One-off tasks
end in a draft PR; the factory continues through review, merge, deployment, and verification.
Herdr keeps both runners visible while the Mac sleeps. Claude sessions additionally support
Claude Remote Control; Codex sessions do not inherit that phone integration.

## When to use it

- The task can run unattended for a while and needs the repo's real services (Postgres,
  Docker Compose, the full test suite), or the user wants to close the laptop.
- Only for the repos oar knows: run `oar doctor --quiet`; if it names no VM for this repo, say so
  and offer `oar vm new <repo>` or a local run instead.

## Before dispatching

1. `oar doctor --repo <engine|cno> --quiet` (prints `ok` or the failing checks).
2. The worktree is created on the VM from `origin/<base>`, so the work the task depends on must
   be **pushed**. Local code edits do not reach the builder. Published plan Markdown is an
   exception: the ticket publisher embeds the exact content directly in Linear.
3. Pick a slug: lowercase, dashes, 2-27 chars, starts with a letter (`fix-flaky-delivery-test`).
   It becomes the branch `codex/<slug>` and the worktree name.

## Writing the brief

The VM session has none of this conversation's context. Brief it like a colleague who only has
the repo: goal, the files or areas involved, what is out of scope, the acceptance check. Name the
gate explicitly (`pnpm verify` for engine; `make lint && make test` for cno, plus the focused tests
from AGENTS.md "Where to work"). For research tasks say where to write the report in the repo and
list the questions it must answer. Do **not** write finish steps (push, PR, done marker): oar
appends them. Use the template sections Goal / Scope / Plan / Gate / When blocked.

## The factory (Linear)

When the user wants work queued rather than dispatched by hand, put it in Linear: an issue in
the repo's team (ENG = engine, CNO = cno) moved to the trigger state (`factory.linear.states.ready`)
is picked up by the always-on controller (`oar factory status` shows it). Once CI is green an
independent reviewer checks the exact PR head; P0/P1 findings go back to the builder. A clean
review plus every configured required check permits merge. For `deliveryMode: "staging"`
(the default), Done requires successful deployment and a separate verification workflow for
the same merged SHA; merge alone is not completion.
A `hold` label on the issue stops the merge. Questions from the agent arrive as comments on the
issue; replies there go back to the agent. `oar factory attach ENG-12` opens the agent's pane.
The default reviewer uses a separate sandbox from `reviewEnvName`, with its own read-only
GitHub credential and preinstalled runner. `factory.review.isolation: "worktree"` explicitly
opts into the older shared-VM mode. Keep repository merge/deploy credentials out of reviewers.

Before rolling out controller/config changes, run `oar factory check`. It reports missing
staging workflows or reviewer environment configuration locally. Prefer an explicit repository
`requiredChecks` list so a required check that never reports cannot pass unnoticed.
`oar factory evidence ENG-12` prints the delivery record as JSON. A failed or timed-out deploy
or verification stays unresolved; investigate the evidence before retrying.

Do not also `oar task dispatch` factory-owned work: both would address the same work independently.

## Planning work for the factory

When the user plans a change with you (usually in plan mode) and wants the factory to build it,
follow [tickets.md](tickets.md): shape the plan as tickets, let approval save it under
`~/.local/state/oar/plans/<date>-<slug>/plan.md` (the oar hook does this; otherwise save it
there yourself), and leave publishing to `/oar-tickets <plan.md>`, which runs in its own
context, writes `tickets.json` beside the plan, and runs `oar ticket check` and
`oar ticket create`. The tickets land in Backlog, each with Goal, Jobs to be done, Functional
and Non-functional criteria, Scope, Decisions and a Staging check; the user moves them to Todo.

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
user what it asks, and answer with `oar task keys <id> enter` (or `esc`, `y`, …) when the answer
follows their existing instructions; ask when a consequential choice remains unresolved.

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
| see what it is doing on screen | `oar vm desktop <repo>` (live), `oar vm shot <repo>` (PNG)              |

Never run `oar vm stop` while tasks are live unless the user asks; `--force-tasks` suspends them.
Several independent tasks: one `task new` + `dispatch` each; every task gets its own worktree,
so they do not collide. Keep each brief to one branch's worth of work.
