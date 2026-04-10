# Devil's Advocate

Multi-model adversarial code review plugin for Claude Code. Sends diffs to external AI tools in parallel, then synthesizes a structured disagreement report — highlighting where reviewers diverge, not flattening to consensus.

## Project State

V1 complete and pushed to `main` (public repo: `jarodtaylor/devils-advocate`). 188 tests, 12 commits, 3 providers. First real adversarial review successfully completed.

**Next:** V1.1 config system. Requirements finalized at `docs/brainstorms/config-system-requirements.md`. Ready for `/ce:plan`.

## Tech Stack

- **Language:** ESM JavaScript (`.mjs`) + TypeScript type-checking (`tsc --noEmit --checkJs`)
- **No build step.** Contributors clone and go.
- **Distribution:** Claude Code plugin (`/da:review` slash command)
- **Testing:** `node --test` (Node.js built-in test runner)
- **License:** MIT

## Providers (V1)

| Provider | CLI | Auth | Model Flag | Safety Flag |
|----------|-----|------|-----------|-------------|
| Codex | `codex exec --json --output-schema <schema>` | `codex login status` (exit 0) | None (uses CLI default) | N/A |
| Gemini | `gemini -p "prompt" -o json --sandbox` | `~/.gemini/oauth_creds.json` + `expiry_date` | None verified | `--sandbox` |
| Claude | `claude -p "prompt" --output-format json --model sonnet` | `command -v claude` (always authed in CC) | `--model sonnet` | `--no-input` |

## Architecture

```
skills/review/SKILL.md          → /da:review entry point
scripts/review.mjs              → CLI arg parsing + pipeline orchestration
scripts/lib/config.mjs          → [V1.1] config file loading + merging
scripts/lib/diff.mjs            → git diff with auto-detect + overrides
scripts/lib/prompt.mjs          → adversarial prompt builder
scripts/lib/providers/codex.mjs → Codex CLI adapter
scripts/lib/providers/gemini.mjs→ Gemini CLI adapter
scripts/lib/providers/claude.mjs→ Claude Code adapter
scripts/lib/orchestrate.mjs     → parallel execution + R5 gates
scripts/lib/validate.mjs        → R10a output trust boundary
scripts/lib/matcher.mjs         → location-based finding matching
scripts/lib/report.mjs          → disagreement report synthesis
scripts/lib/types.mjs           → provider interface + finding schema
schemas/finding.schema.json     → JSON schema for Codex --output-schema
prompts/adversarial-review.md   → adversarial review prompt template
```

## Architecture Constraints

- **Claude never reviews.** Claude orchestrates and synthesizes. External tools review. Core invariant.
- **Minimum 2 providers.** Hard fail (R5Error) if fewer than 2 active. Pre-flight AND post-validation checks.
- **Structured disagreement, not consensus.** The disagreements are the signal.
- **Uniform diff delivery.** Orchestrator pre-computes diff, passes as prompt context. Providers don't resolve git state.
- **Output validation is the trust boundary (R10a).** Validate provider-parsed findings before synthesis. Malformed = provider failure.
- **Prompt injection defense.** Diff/file content wrapped in XML delimiter tags (`<diff>`, `<files>`).

## Known Issues / Decisions

- **Gemini uses `--sandbox`** (not `--yolo` or `--approval-mode plan`). `--yolo` auto-approves tool execution (dangerous). `--approval-mode plan` forces heavier pro model that 429s. `--sandbox` restricts execution environment safely.
- **Schema divergence is intentional.** `schemas/finding.schema.json` requires all fields including confidence (for Codex `--output-schema` OpenAI compatibility). `scripts/lib/types.mjs` validator treats confidence as optional (for Gemini prompt-only enforcement). Both are correct for their purpose.
- **Codex JSONL parsing** handles `item.completed` events with text at `event.item.text` (Pattern 2 in `parseCodexJsonl`).

## Commands

```bash
npm run check    # tsc --noEmit type checking
npm test         # node --test (188 tests)
```

## Development Rules

- Read existing code before modifying. Follow established patterns.
- Every change needs a clear "why."
- Verify before marking complete — run tests, check types.
- Use `find-docs` skill for library documentation.
- Provider adapters use dependency injection factories (`createCodexProvider(spawnFn)`, `buildGeminiProvider({spawnFn})`, `buildClaudeProvider({spawnFn})`) for testability.

## Planning Documents

- `docs/brainstorms/devils-advocate-v1-requirements.md` — V1 requirements (complete)
- `docs/plans/2026-04-10-001-feat-adversarial-review-plugin-plan.md` — V1 implementation plan (complete)
- `docs/brainstorms/config-system-requirements.md` — V1.1 config system requirements (ready for `/ce:plan`)
