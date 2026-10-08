# Planning work into factory tickets

Use this when the user wants work built by the factory: "plan this", "write tickets", "put this
in Linear", or a plan-mode session about a change to a factory repo (nodes-cno → team CNO,
nodes-engine → team ENG).

## The flow

1. **Plan in plan mode.** Read the repo first: its AGENTS.md or CLAUDE.md ("Where to work",
   constraints), and the code the change touches. Send deep exploration to the Explore
   subagent so its output stays out of this context. Discuss with the user and shape the plan
   as tickets from the start: one section per ticket with the headings below, plus a line
   naming the repository or team (nodes-cno → CNO, nodes-engine → ENG).
2. **Present the plan** with one section per ticket: title, goal, jobs to be done,
   functional and non-functional criteria, scope, context, decisions, staging check, depends on.
   The user may edit it in their editor (Ctrl+G) before approving.
3. **Approval saves the artifact.** With the oar hook installed, approving the plan copies it to
   `~/.local/state/oar/plans/<date>-<slug>/plan.md` and the session is told the path. Without
   the hook, save it there yourself. Never put plan files in a repository unless its
   documentation policy allows them (nodes-cno's AGENTS.md does not).
4. **Publishing is a separate step: `/oar-tickets <plan.md>`.** It runs in its own context,
   writes `tickets.json` beside the plan, runs `oar ticket check` and `oar ticket create`, and
   reports the identifiers. The user runs it when ready, in this session or from a fresh
   terminal with `claude -p "/oar-tickets <path>"`. Do not run `oar ticket create` in the
   planning context unless the user asks for exactly that.
5. Tickets land in Backlog; the user moves them to Todo. Never move them yourself.

`check` is read-only and previews the source hash and full Markdown snapshot. `create` persists a
publication ID, immutable content hash, and UUIDs for every issue and dependency link **before**
contacting Linear for mutations. If it fails halfway, rerun the same file: it reconciles those
UUIDs with Linear, including a successful remote create whose response was lost. Labels must
already exist in Linear; missing labels produce a notice and are omitted.

Keep `plan.md` and `tickets.json`, including the generated `publication` and `created` receipts:
they are the record of what was published. The command publishes the plan's Markdown on the
plan issue (unwrapped for Linear), where the builder reads it, and keeps the tickets short; the
source SHA-256 identifies these contents, not a Git revision. `oar ticket refresh <file>`
re-renders published descriptions after a template change, without touching the data. The command never commits or pushes.

Published definitions are immutable, even on a partial run. To change scope, copy the two files to
a `<slug>-v2/` directory next to them, remove `publication` and `created` from the new JSON,
review/check the new revision, and publish it. Explicitly retire superseded Linear tickets; never alter an active run's
instructions silently. New tickets also need a new plan revision.

Only one process can publish a given plan file. A crash may leave `tickets.json.publish.lock`;
inspect its host and PID, confirm that publisher is no longer running, then remove that lock and
resume. Never delete it while a publisher is active. Do not edit or copy a plan while publishing.

## Writing good tickets

- **One ticket is one PR** that one agent can finish in one session. Split by behaviour that can
  be shipped, not by layer, unless a layer must land first (a migration before its use).
- **Every merge must leave the repo releasable.** nodes-cno deploys staging on every merge to
  `dev`, so a ticket may never depend on a later one to be safe.
- **`dependsOn` only when a ticket needs another delivered first.** A repo builds one ticket at a
  time; tickets in different repos build in parallel.
- **Goal**: the outcome in a sentence or two, not the implementation.
- **Jobs to be done**: "When <situation>, I want <capability>, so I can <outcome>", from the
  user's or operator's side.
- **Functional criteria**: observable and testable; each one becomes a test or a check. Never
  "works correctly".
- **Non-functional criteria**: the ones that apply, concretely: security (auth, secrets, private
  data and logs), performance budgets, compatibility (migrations, the API contract, retries and
  idempotency), observability, AI cost. In nodes-cno, PI means Predictive Index, not personal data.
- **Scope**: the files and directories found while planning (`in`), and what must not change
  (`out`), which keeps the agent from drifting.
- **Context**: pointers the agent would otherwise rediscover (file:line, functions, tests, docs).
  Not a full design unless the user decided it.
- **Decisions**: the choices settled during planning, as statements; the builder must not reopen
  them. **Open questions** (`questions`): choices still unresolved, each one a question; the
  builder asks on the issue and pauses, so resolve as many as you can before moving work to Todo.
- **Short criteria.** One checkable sentence per entry, ideally under 160 characters; put the
  detail (table names, columns, thresholds) under Context. `oar ticket check` flags long ones.
- **Staging check**: an observable acceptance check that can run unattended after deployment,
  preferably a committed Playwright test, API assertion, or smoke-test command. For projects
  without staging, specify the app check and configure an explicit delivery policy.
- Leave out branch names, gate commands and finish steps; the factory adds them.
- A plan that spans repos becomes one file per team.

## The plan file

```json
{
  "team": "CNO",
  "document": "plan.md",
  "plan": { "title": "Trace CNO requests end to end", "summary": "Why, in a paragraph or two." },
  "tickets": [
    {
      "key": "request-id",
      "title": "Return an X-Request-ID header on every API response",
      "goal": "Every response carries an X-Request-ID that also appears in the request log lines.",
      "jobs": [
        "When a client reports a failed call, I want to quote one id, so I can find its log lines."
      ],
      "functional": [
        "A safe client value is echoed unchanged.",
        "A missing or unsafe value is replaced by a UUID4."
      ],
      "nonFunctional": ["Unvetted client text never reaches headers or logs."],
      "scope": { "in": ["nodes/core/middleware/"], "out": ["nginx configuration"] },
      "context": "LoggingMiddleware in nodes/core/middleware/logging.py already logs REQ/RESP lines.",
      "decisions": [],
      "stagingCheck": "curl -sI -H 'X-Request-ID: t1' https://staging.api.cno.nodes.inc/swagger.json shows X-Request-ID: t1",
      "dependsOn": []
    }
  ]
}
```

Required per ticket: `key` (lowercase, dashes), `title`, `goal`, `jobs`, `functional`,
`nonFunctional`, `scope.in`, `stagingCheck`. Optional: `context`, `decisions`, `questions`, `dependsOn`,
`priority` (1 urgent to 4 low), `labels`. `plan` is required when there is more than one ticket.
Top-level `document` is an optional Markdown path relative to the JSON file. Legacy JSON-only
plans remain supported. Do not write `created` or `publication` yourself; `oar ticket create`
adds them. Preserve those blocks when committing publication receipts.

## What happens next

The plan becomes a parent issue labelled `spec`, which the factory never builds. Each ticket is a
sub-issue in the same template, linked "blocked by" its dependencies. When the user moves tickets
to Todo, each one waits until its blockers are Done, then an agent builds it with the plan as
context, CI and the automated reviewer check it against its criteria, and a clean review permits
merge. A staging-enabled project is complete only after deployment and configured acceptance
checks pass for the intended revision.
