---
allowed-tools: Bash(node:*), Bash(git:*), Read, Glob, Grep
---

Run an adversarial code review using external AI tools (Codex, Gemini CLI).

Each provider independently reviews your changes and returns structured findings.
The results are synthesized into a disagreement report highlighting where providers
diverge — consensus, disagreements, and provider-only findings.

Usage: /da:review [options]

Options:
  --branch <name>       Review a specific branch diff
  --worktree <path>     Review from a specific worktree
  --diff <ref1>..<ref2> Review an explicit diff range
  --files <paths...>    Limit review to specific files
  --verbose             Include raw provider output in the report

Run the Devil's Advocate review by executing the companion script:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/review.mjs $ARGUMENTS
```

Present the output to the user as the adversarial review report.
