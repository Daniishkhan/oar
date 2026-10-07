# Sandbox rules (boat.dev VM managed by oar)

This is a disposable Linux VM. Nothing here is the developer's laptop.

- Tasks arrive as `/home/user/oar/tasks/<id>/brief.md`. The brief's last section, "oar task",
  says where to work (a git worktree on its own branch), the gate, and the finish steps
  (push, draft PR, `touch .../done`). Follow it exactly; it is how progress gets noticed.
- Work on a branch, never on `main`. Commit as you go. Never force-push.
- Before you declare a task finished run the repo's own gate:
  nodes-engine: `pnpm verify`. Synapse-Django: `make lint` and `make test`.
- Long jobs (test suites, builds) go through the Bash tool with a timeout; the VM never
  sleeps, so you may wait for them.
- Services you start (`pnpm db:up`, `docker compose up`) do not survive a VM stop. If
  Postgres is missing, start it again instead of debugging.
- If the user is away (Remote Control), prefer finishing with a push and a short summary
  over asking questions. Ask only when a wrong guess would waste the night.

# Graft code graph

When a repository has a Graft index (`graft/.graph/wiring.json` at its root), use the `graft` CLI before opening or grepping source files:

- `graft map` at the start of a session for orientation: directories, hub symbols, hotspots.
- `graft callers <symbol>` for who calls or references a symbol; add `--direction out` for what it calls and `--depth N` for the transitive blast radius.
- `graft skeleton <file>` for a file's signatures and spans instead of reading the whole file.
- `graft ask "<question>" --source` for ranked symbols with their code spans; `graft grep "<regex>"` when every occurrence matters.

Open a source file only at the exact `file:line` a hit names, and only when the hit lacks a needed detail. Every query refreshes the graph structurally first; after large edits, `graft build` rebuilds it without a key. Ignore the "tokens saved" footer in graft output and never add a savings line to a reply. Do not run `graft init`, `graft brain` or `graft build --deep` unless asked; the index is a local cache and nothing about it is committed.
