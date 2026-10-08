# Planning work into factory tickets

Use this when the user wants work built by the factory: "plan this", "write tickets", "put this
in Linear", or a plan-mode session about a change to a factory repo (nodes-cno → team CNO,
nodes-engine → team ENG).

## The flow

1. **Plan in plan mode.** Read the repo first: its AGENTS.md or CLAUDE.md ("Where to work",
   constraints), and the code the change touches. Discuss with the user and shape the plan as
   tickets from the start.
2. **Present the plan** with one section per ticket: title, goal, jobs to be done,
   functional and non-functional criteria, scope, context, decisions, staging check, depends on.
3. **Once the user has authorized publication, save the plan as two files** under
   `~/.local/state/oar/plans/<slug>/`: `plan.md` holds the design, decisions and verification
   approach; `tickets.json` holds the tasks and references `"document": "plan.md"`. Put them in
   the repository instead only when its documentation policy allows plan files (nodes-cno's
   AGENTS.md does not). Existing authorization is sufficient; do not ask again.
   `oar ticket example` prints valid JSON.
4. **`oar ticket check <file>`.** Fix every problem it names. Show the user the ticket titles and
   their order.
5. **`oar ticket create <file>`.** Report the identifiers and links. Tickets land in Backlog;
   the user moves them to Todo. Do not move them yourself unless asked.

`check` is read-only and previews the source hash and full Markdown snapshot. `create` persists a
publication ID, immutable content hash, and UUIDs for every issue and dependency link **before**
contacting Linear for mutations. If it fails halfway, rerun the same file: it reconciles those
UUIDs with Linear, including a successful remote create whose response was lost. Labels must
already exist in Linear; missing labels produce a notice and are omitted.

Keep `plan.md` and `tickets.json`, including the generated `publication` and `created` receipts:
they are the record of what was published. The command publishes the exact Markdown inline in
each issue, so the builder reads the plan from Linear and nothing has to be pushed; the source
SHA-256 identifies these contents, not a Git revision. The command never commits or pushes.

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
- **Decisions**: resolve consequential choices during planning before moving work to Todo. If a
  choice remains unresolved, list it explicitly; the worker will ask on the issue and pause.
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
`nonFunctional`, `scope.in`, `stagingCheck`. Optional: `context`, `decisions`, `dependsOn`,
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
