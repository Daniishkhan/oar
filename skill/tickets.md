# Planning work into factory tickets

Use this when the user wants work built by the factory: "plan this", "write tickets", "put this
in Linear", or a plan-mode session about a change to a factory repo (nodes-cno → team CNO,
nodes-engine → team ENG).

## The flow

1. **Plan in plan mode.** Read the repo first: its AGENTS.md or CLAUDE.md ("Where to work",
   constraints), and the code the change touches. Discuss with the user and shape the plan as
   tickets from the start.
2. **Present the plan for approval** with one section per ticket: title, goal, jobs to be done,
   functional and non-functional criteria, scope, context, decisions, staging check, depends on.
3. **After approval, write the plan file** to `~/.local/state/oar/plans/<yyyy-mm-dd>-<slug>.json`
   (format below; `oar ticket example` prints a valid one).
4. **`oar ticket check <file>`.** Fix every problem it names. Show the user the ticket titles and
   their order.
5. **`oar ticket create <file>`.** Report the identifiers and links. Tickets land in Backlog;
   the user moves them to Todo. Do not move them yourself unless asked.

If `create` fails halfway, run it again: the ids already created are in the file and are reused.

## Writing good tickets

- **One ticket is one PR** that one agent can finish in one session. Split by behaviour that can
  be shipped, not by layer, unless a layer must land first (a migration before its use).
- **Every merge must leave the repo releasable.** nodes-cno deploys staging on every merge to
  `dev`, so a ticket may never depend on a later one to be safe.
- **`dependsOn` only when a ticket needs another merged first.** A repo builds one ticket at a
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
- **Decisions**: anything the user has not decided and the agent must not guess. The agent asks
  on the issue before acting on each one.
- **Staging check**: one concrete check the user runs after the deploy (a `curl`, a page, a
  query). For nodes-engine, which has no staging, the check in the app.
- Leave out branch names, gate commands and finish steps; the factory adds them.
- A plan that spans repos becomes one file per team.

## The plan file

```json
{
  "team": "CNO",
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
Do not write the `created` block; `oar ticket create` adds it.

## What happens next

The plan becomes a parent issue labelled `spec`, which the factory never builds. Each ticket is a
sub-issue in the same template, linked "blocked by" its dependencies. When the user moves tickets
to Todo, each one waits until its blockers are Done, then an agent builds it with the plan as
context, CI and the automated reviewer check it against its criteria, and a clean review merges it.
