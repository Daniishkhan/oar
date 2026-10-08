---
name: oar-tickets
description: Publish a saved plan (plan.md) as Linear tickets for the oar factory. Run it as /oar-tickets <path-to-plan.md>; with no path it takes the newest plan under ~/.local/state/oar/plans that has no tickets.json yet. It writes tickets.json beside the plan, runs oar ticket check and oar ticket create, and reports the identifiers.
disable-model-invocation: true
argument-hint: '[path to plan.md]'
context: fork
background: false
allowed-tools: Read, Glob, Grep, Write, Edit, Bash(oar ticket:*), Bash(oar doctor:*), Bash(ls:*)
---

# /oar-tickets: a saved plan becomes Linear tickets

You run in your own context with one job: turn the plan file into `tickets.json` beside it and
publish it. Do not re-plan, do not explore the codebase beyond what the plan points at, and do
not ask for approval again: invoking this command is the authorization to publish. Tickets land
in Backlog, where nothing happens until a human moves one to Todo.

## Steps

1. **Find the plan.** `$ARGUMENTS` is the path to `plan.md` or to its directory. With no
   argument, take the newest `~/.local/state/oar/plans/*/plan.md` that has no `tickets.json`
   beside it. Read the whole file. If `tickets.json` already exists there, read it too: a
   `publication` block means this plan is already published and immutable; report its
   identifiers instead of publishing again, unless the user passed a new revision directory.
2. **Learn the schema.** Run `oar ticket example`; its output is a valid file. Required per
   ticket: `key` (lowercase, dashes), `title`, `goal`, `jobs`, `functional`, `nonFunctional`,
   `scope.in`, `stagingCheck`. Optional: `scope.out`, `context`, `decisions` (settled, as
   statements), `questions` (still open, as questions), `dependsOn` (keys of tickets that must
   be delivered first), `priority` (1 urgent to 4 low), `labels`. `plan` (title and summary) is
   required when there is more than one ticket. Set `"document": "plan.md"` so the plan's
   Markdown is published on the plan issue, where the builder reads it.
3. **Pick the team.** The plan names its repository or team (nodes-cno → `CNO`,
   nodes-engine → `ENG`). If it does not, use the repository you are in (`oar doctor --quiet`
   names it) and say so in the report.
4. **Write `tickets.json`** beside the plan. Map each ticket section onto the fields in the
   plan's own words: Goal, Jobs to be done, Functional criteria, Non-functional criteria, Scope
   in and out, Context, Decisions, Open questions, Staging check, Depends on. Criteria are
   checkable sentences, one per entry and ideally under 160 characters: a Linear card is read on
   a phone. Move detail (table names, columns, thresholds) into Context. A settled choice goes
   under `decisions`; only a question the user still has to answer goes under `questions`. Where the plan leaves a required field empty, write the most conservative
   reading of the plan and list it under "Inferred" in your report; never add scope or a ticket
   the plan does not describe. Leave out branch names, gate commands and finish steps.
5. **Check.** `oar ticket check <tickets.json>`. Fix every problem it names and run it again
   until it passes.
6. **Publish.** `oar ticket create <tickets.json>`. If it fails halfway, run it again with the
   same file: publication is resumable and never duplicates. Do not move anything to Todo.
7. **Report**, and nothing else: the parent issue and each ticket with identifier, title and
   link, in build order; what you inferred; the two file paths.

## Rules

- A published plan is immutable. To change scope, copy `plan.md` and `tickets.json` to a
  `<slug>-v2` directory beside them, remove `publication` and `created` from the copy, and
  publish that revision; superseded tickets are retired by hand in Linear.
- If `tickets.json.publish.lock` exists, stop and tell the user to confirm that no other
  publisher is running before removing it.
- Labels must already exist in Linear; a missing one produces a notice and is left off.
