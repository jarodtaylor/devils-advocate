# Devil's Advocate

Multi-model adversarial code review plugin for Claude Code. Sends diffs to external AI tools in parallel, then synthesizes a structured disagreement report — highlighting where reviewers diverge, not flattening to consensus.

## Project State

**First public release: v0.1.0** (2026-04-10) — tagged and released on GitHub. Includes the 3-provider adversarial review pipeline and the layered config system.

See `CHANGELOG.md` for the current release history. The version in `package.json` is the source of truth for the current version — don't hardcode version numbers in docs or code unless you're writing a changelog entry.

Public repo: `jarodtaylor/devils-advocate`. MIT licensed. 265 tests across 59 suites. Full CI (test + CodeQL) + branch protection + Dependabot + automated review (Claude Code Action, Copilot, Greptile).

## Language (Important — not TypeScript)

**This project is ESM JavaScript with JSDoc type annotations, NOT TypeScript.**

- Source files are `.mjs` (ESM JavaScript), not `.ts`
- Types come from JSDoc comments (`/** @type {...} */`, `/** @typedef */`)
- Type checking via `tsc --noEmit --checkJs` catches the same errors as real TypeScript
- devDependencies are only `typescript` and `@types/node` (for the type checker, not for compilation)

**Why not real TypeScript:**
1. **Node 18+ compatibility.** Claude Code's minimum Node version is 18. Node's native type stripping only became default in Node 22.18+ / 23+. Using `.ts` files at runtime would exclude users on Node 18/20/22-pre-22.18.
2. **No build step.** The files in `scripts/` are the exact files Node executes. No `dist/`, no `npm run build`. Matches the "source is the shipped artifact" philosophy for an auditable code-review tool.
3. **Full type safety without compilation.** JSDoc is more verbose than TS syntax for complex types, but the checker catches the same errors.

**This decision is documented in README.md's "Language & Build" section** — contributors who expect `.ts` files should be redirected there, not given ad-hoc explanations.

## Tech Stack

- **Language:** ESM JavaScript (`.mjs` files) with JSDoc type annotations
- **Type checking:** `tsc --noEmit --checkJs` (strict mode via tsconfig.json `"strict": true`)
- **No build step.** Contributors clone and go.
- **Runtime:** Node 18+ (matches Claude Code's minimum)
- **Distribution:** Claude Code plugin (`/da:review` slash command)
- **Testing:** `node --test` (Node.js built-in test runner, `node:assert/strict`)
- **Runtime dependencies:** zero. devDependencies are only `typescript` and `@types/node`.
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
scripts/lib/config.mjs          → config file loading + merging + validation
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
npm run check    # tsc --noEmit type checking (strict mode, checkJs)
npm test         # node --test (265 tests across 59 suites)
```

## Development Rules

- Read existing code before modifying. Follow established patterns.
- Every change needs a clear "why."
- Verify before marking complete — run tests, check types.
- Use `find-docs` skill for library documentation.
- Provider adapters use dependency injection factories (`createCodexProvider(spawnFn)`, `buildGeminiProvider({spawnFn})`, `buildClaudeProvider({spawnFn})`) for testability.

## Planning Documents

- `docs/brainstorms/devils-advocate-v1-requirements.md` — v0.1.0 initial requirements (shipped)
- `docs/plans/2026-04-10-001-feat-adversarial-review-plugin-plan.md` — v0.1.0 initial implementation plan (shipped)
- `docs/brainstorms/config-system-requirements.md` — config system requirements (shipped in v0.1.0)
- `docs/plans/2026-04-10-002-feat-config-system-plan.md` — config system implementation plan (shipped in v0.1.0)

Note: these docs use "V1"/"V1.1" as internal shorthand for what was eventually released as v0.1.0. Future planning documents should use actual version numbers.
