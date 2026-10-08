#!/usr/bin/env python3
"""PostToolUse hook for ExitPlanMode: keep the approved plan where the factory expects it.

Claude Code writes plans to ~/.claude/plans/<random-slug>.md and deletes them after
`cleanupPeriodDays`. This copies the plan to ~/.local/state/oar/plans/<date>-<slug>/plan.md
(OAR_PLANS_DIR overrides the root) and tells the session where it is and how to publish it with
/oar-tickets. A plan that was not approved ("keep planning") is kept as plan.draft.md.

Register it in ~/.claude/settings.json:
  "hooks": {"PostToolUse": [{"matcher": "ExitPlanMode", "hooks": [
    {"type": "command", "command": "python3 \\"$HOME/.claude/skills/oar/hooks/save-plan.py\\""}]}]}
"""

import json
import os
import re
import sys

from datetime import date
from pathlib import Path


def main() -> int:
    try:
        event = json.load(sys.stdin)
    except ValueError:
        return 0
    if not isinstance(event, dict) or event.get("tool_name") != "ExitPlanMode":
        return 0
    response = event.get("tool_response")
    if not isinstance(response, dict):
        response = {}
    tool_input = event.get("tool_input")
    if not isinstance(tool_input, dict):
        tool_input = {}
    source = response.get("filePath") or tool_input.get("planFilePath") or ""
    approved = isinstance(response.get("plan"), str) and response["plan"].strip() != ""
    text = response.get("plan") if approved else None
    if text is None and source and os.path.isfile(source):
        text = Path(source).read_text()
    if not text or not text.strip():
        return 0

    slug = re.sub(r"[^a-z0-9]+", "-", Path(source).stem.lower()).strip("-") if source else "plan"
    root = Path(os.environ.get("OAR_PLANS_DIR") or Path.home() / ".local/state/oar/plans")
    # One directory per plan: approving the same plan again updates it in place.
    existing = sorted(path for path in root.glob(f"*-{slug}") if path.is_dir())
    target = existing[-1] if existing else root / f"{date.today().isoformat()}-{slug}"
    target.mkdir(parents=True, exist_ok=True)
    saved = target / ("plan.md" if approved else "plan.draft.md")
    saved.write_text(text if text.endswith("\n") else text + "\n")
    if approved and (target / "plan.draft.md").exists():
        (target / "plan.draft.md").unlink()

    if approved:
        note = (
            f"The approved plan is saved at {saved}. To publish it as Linear tickets for the factory, "
            f"run `/oar-tickets {saved}` here, or `claude -p \"/oar-tickets {saved}\"` from a fresh terminal."
        )
    else:
        note = f"The plan draft is saved at {saved}; approving the plan replaces it with plan.md."
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": note}}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
