# Sandbox rules (boat.dev VM managed by oar)

This is a disposable Linux VM. Nothing here is the developer's laptop.

- Tasks arrive as `/home/user/oar/tasks/<id>/brief.md`. The brief's last section, "oar task",
  says where to work (a git worktree on its own branch), the gate, and the finish steps
  (push, draft PR, `touch .../done`). Follow it exactly; it is how progress gets noticed.
- Work on a branch, never on `main`. Commit as you go. Never force-push.
- Before you declare a task finished run the repo's own gate:
  nodes-engine: `pnpm verify`. nodes-cno: `make lint` and `make test`.
- Long jobs (test suites, builds) go through the Bash tool with a timeout; the VM never
  sleeps, so you may wait for them.
- Services you start (`pnpm db:up`, `docker compose up`) do not survive a VM stop. If
  Postgres is missing, start it again instead of debugging.
- If the user is away (Remote Control), prefer finishing with a push and a short summary
  over asking questions. Ask only when a wrong guess would waste the night.
- Factory tasks (the brief names a Linear issue such as ENG-12) are watched by a controller, not
  a person. To ask something: write the question with its options and your recommendation to
  `/home/user/oar/tasks/<id>/question.md`, say it in the terminal, and stop. Never open the
  AskUserQuestion dialog; nobody can click it. The answer arrives as your next prompt.
- boat rotates the injected `GITHUB_TOKEN` while long-lived panes keep the old one. If `gh` fails
  with an auth error but `git push` works, run `unset GITHUB_TOKEN`; `gh` then uses its own saved
  login (`gh auth status`).
- A review round arrives as `/home/user/oar/tasks/<id>/review-<n>.md`: address every item, push
  to the same branch, run the gate, `touch .../done` again, and reply with a summary. Never
  comment on the PR yourself and never open a second PR for the same issue. Items marked
  **blocking** come from the automated reviewer and must be fixed before the PR can merge; a
  clean review merges the PR without anyone clicking, so push only finished work.

# Seeing things

`DISPLAY=:0` is a real Xorg desktop at 1920x1080 that the developer may be watching live
(`oar vm desktop`). There is one screen: run `wmctrl -l` before driving it, and if another task's
window or the NODES app is busy there, do not click into it. One GUI, e2e or desktop run per VM at
a time; everything else goes headless.

- `browser` (MCP): Playwright on the persistent, signed-in agent Chrome (CDP :9222). Use it for
  anything that needs logins or that should be visible. Never call `browser_close` on it.
- `browser-headless` (MCP): an isolated headless Chrome for unattended or parallel checks.
- `chrome-devtools` (MCP): console, network and performance on the agent Chrome.
- `computer` (MCP, boat): screenshot + accessibility tree, click and type on any X window
  (Electron, dialogs). `nodes-desktop` (project MCP) attaches to the NODES app on :9350.
- `shot /tmp/oar/x.png [window-title-substring, e.g. Chromium]` grabs the screen or one window; view it with Read.
- Screenshots belong in the PR body: `pr-shot <png> <label>` prints the markdown; fallback:
  `git add -f test-results/oar/<slug>/*.png` as a separate last commit and say so.

Electron (nodes-engine): `pnpm db:up` → `pnpm dev:services > /tmp/oar/services.log 2>&1 &` →
`curl -s 127.0.0.1:4318/health` → `cd apps/desktop && pnpm exec electron-forge start --
--remote-debugging-port=9350 > /tmp/oar/desktop.log 2>&1 &` → `curl -s 127.0.0.1:9350/json/list`.
Ports 5173/5174/9350/4318 are fixed and `pnpm test:e2e` reuses any Vite already on 5173: check
`ss -ltnp | grep -E ':(5173|5174|9350|4318) '` first and never stop a listener you did not start.
Packaged app on Linux: `pnpm package` → `apps/desktop/out/NODES-linux-x64/NODES`; `pnpm test:desktop`
runs headed on :0 (prefix `xvfb-run -a` when the screen is busy).

# Graft code graph

When a repository has a Graft index (`graft/.graph/wiring.json` at its root), use the `graft` CLI before opening or grepping source files:

- `graft map` at the start of a session for orientation: directories, hub symbols, hotspots.
- `graft callers <symbol>` for who calls or references a symbol; add `--direction out` for what it calls and `--depth N` for the transitive blast radius.
- `graft skeleton <file>` for a file's signatures and spans instead of reading the whole file.
- `graft ask "<question>" --source` for ranked symbols with their code spans; `graft grep "<regex>"` when every occurrence matters.

Open a source file only at the exact `file:line` a hit names, and only when the hit lacks a needed detail. Every query refreshes the graph structurally first; after large edits, `graft build` rebuilds it without a key. Ignore the "tokens saved" footer in graft output and never add a savings line to a reply. Do not run `graft init`, `graft brain` or `graft build --deep` unless asked; the index is a local cache and nothing about it is committed.
