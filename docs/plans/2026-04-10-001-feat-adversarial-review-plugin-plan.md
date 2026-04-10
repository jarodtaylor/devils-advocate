---
title: "feat: Devil's Advocate — Multi-Model Adversarial Code Review Plugin"
type: feat
status: active
date: 2026-04-10
origin: docs/brainstorms/devils-advocate-v1-requirements.md
---

# Devil's Advocate — Adversarial Code Review Plugin

## Overview

Build an open source Claude Code plugin that sends code diffs to external AI coding tools (Codex CLI, Gemini CLI) in parallel for adversarial review, then synthesizes a structured disagreement report. Claude orchestrates and synthesizes — it never reviews. The core differentiator is surfacing where models disagree, not flattening to consensus.

## Problem Frame

Developers get AI code reviews from the same model that assisted with the code — a sycophancy blind spot. Existing multi-model tools (claude-consensus, multi_mcp, claude-octopus) seek consensus, require API keys, and try to do too much. Devil's Advocate is focused: adversarial review only, subscription auth reuse, structured disagreement as the signal. (see origin: `docs/brainstorms/devils-advocate-v1-requirements.md`)

## Requirements Trace

**Provider System**
- R1. Typed provider interface: capability detection, review invocation, output normalization
- R2. V1 providers: Codex CLI + Gemini CLI
- R3. Subscription auth reuse: `codex login status`, `~/.gemini/oauth_creds.json`
- R4. Parallel, independent provider execution
- R5. Minimum 2 active providers; hard fail otherwise (pre-dispatch + post-validation)

**Review Target**
- R6. Auto-detect diff target from git state
- R7. Explicit overrides: `--branch`, `--worktree`, `--diff`, `--files`
- R8. Git worktree support

**Review Execution**
- R9. Orchestrator pre-computes diff, uniform delivery as prompt context
- R10. Structured findings via prompt engineering + post-receipt validation
- R10a. Output validation trust boundary; post-validation R5 recheck
- R11. Provider timeout → discard + unavailable per R5

**Output & Synthesis**
- R12. Four-section report: Consensus, Disagreements, Provider-only, Summary
- R13. Location-based finding matching (file path + overlapping line range)
- R14. Side-by-side disagreement display
- R15. `--verbose` flag for raw provider output

**Distribution**
- R16. Claude Code plugin distribution (marketplace + GitHub fallback)
- R17. `/da:review` slash command
- R18. MIT license

## Scope Boundaries

- V1: Independent parallel review mode only (no debate/roles modes)
- V1: Codex + Gemini only (Kimi Code, Cursor, Aider are future)
- Out of scope: API keys, OpenRouter, PR workflow, tmux visibility, MCP server, cost tracking, secrets scanning, consent prompt
- (see origin for full rationale on each exclusion)

## Context & Research

### Plugin Architecture (Verified)

Claude Code plugins use this structure:
```
plugin-root/
├── .claude-plugin/plugin.json    # manifest: name, version, description
├── skills/                       # current format (subdirectory per skill)
│   └── review/SKILL.md           # slash command definition
├── scripts/                      # companion Node.js ESM scripts
│   └── lib/                      # shared modules
├── hooks/hooks.json              # lifecycle hooks (optional)
├── prompts/                      # review prompt templates
├── tests/                        # node --test
├── package.json
└── tsconfig.json                 # noEmit type checking only
```

- Skills defined in `skills/<name>/SKILL.md` with YAML frontmatter
- Companion scripts are ESM `.mjs` files invoked via Bash tool
- `$ARGUMENTS` captures user input in skill body
- `${CLAUDE_PLUGIN_ROOT}` env var available in scripts
- Distribution: official marketplace (`claude.ai/plugins`), third-party marketplaces, or direct `claude plugin add`

### Provider CLI Interfaces (Verified)

**Codex:** `codex exec --json "prompt"` — JSONL event stream, `--output-schema` available on `codex exec` (not `codex exec review`). Auth: `codex login status` (exit 0 = authenticated).

**Gemini:** `gemini -p "prompt" -o json` — JSON envelope `{session_id, response, stats}` where `response` is free-form string. No `--json-schema` flag. Auth: `~/.gemini/oauth_creds.json` with `expiry_date` field (no CLI status command exists).

### Adversarial Prompt Patterns (from codex-plugin-cc)

codex-plugin-cc's adversarial prompt uses:
- Explicit adversarial stance: "break confidence in the change, not validate it"
- Prioritized attack surfaces: auth > data loss > rollback > race conditions > null states > schema drift > observability
- Finding bar: each finding must answer what can go wrong, why vulnerable, impact, and concrete fix
- Grounding rules: defensible from provided context only
- Calibration: prefer one strong finding over several weak ones
- JSON output: `{verdict, summary, findings[{severity, title, body, file, line_start, line_end, confidence, recommendation}], next_steps}`
- File-absolute line numbers (not diff-relative)

### Project Setup Pattern

ESM `.mjs` files + `tsc --noEmit --checkJs` for type checking (no build step). Matches codex-plugin-cc and compound-engineering patterns. Node.js runtime, `node --test` for testing.

## Key Technical Decisions

- **ESM JavaScript + TypeScript type-checking (not compiled TS):** No build step. Contributors clone and go. `tsc --noEmit --checkJs --allowJs` catches type errors without compilation. Matches both reference plugins. (see origin: Key Decisions)
- **`codex exec` with custom prompt (not app-server protocol):** Simpler, portable, no dependency on Codex internal RPC. Trade-off: no native `--output-schema` on the review subcommand, but `codex exec --output-schema schema.json` IS available on the general exec command, giving us schema enforcement for Codex. Gemini relies on prompt-only enforcement.
- **Diff + affected file content as prompt context:** Pass both the unified diff AND the full content of affected files so providers can report file-absolute line numbers accurately. For oversized files, truncate to the diff hunks + surrounding context (100 lines above/below).
- **Skills format (not commands):** Use `skills/<name>/SKILL.md` — the current plugin format. Codex plugin uses `commands/` (legacy).
- **Finding matching by file + line overlap:** Two findings match if same file AND line ranges overlap (any intersection). Findings without line numbers match by file + title similarity as fallback.

## Open Questions

### Resolved During Planning

- **Codex exec vs app-server:** Use `codex exec --json --output-schema schema.json "prompt"` for schema-enforced structured output. Simpler than app-server protocol and avoids internal RPC dependency. Verified: `--output-schema` exists on `codex exec` (not on `codex exec review`).
- **Gemini structured output:** No schema enforcement flag. Use prompt engineering with inline schema definition + "return ONLY valid JSON" instruction. Post-process with JSON.parse + schema validation (R10a).
- **Line number coordinate system:** File-absolute. Include affected file content in prompt context alongside the diff. Prompt explicitly instructs: "report line numbers as they appear in the original file, not relative to the diff."
- **Plugin distribution:** Submit to official marketplace (`claude.ai/plugins`). Fallback: direct GitHub install.

### Deferred to Implementation

- Exact prompt wording tuning after testing against real diffs
- Overlap threshold for line-range matching (start with "any overlap" and adjust based on testing)
- Timeout duration (start with 120 seconds, adjustable via future config)
- Maximum diff/file size before truncation (start with 50KB total prompt context budget per provider)
- Generic provider plugin system — future providers (Kimi, Cursor, Aider) will be added as discrete `.mjs` adapter files without a factory or registry pattern. Re-evaluate abstraction in post-V1 when 3+ providers are confirmed

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification.*

```
/da:review [--branch X | --worktree Y | --diff A..B | --files F]
    │
    ▼
┌─────────────────────────┐
│  Skill Entry Point      │  skills/review/SKILL.md
│  Parse args, invoke     │  → scripts/review.mjs
│  companion script       │
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│  Diff Collector         │  scripts/lib/diff.mjs
│  Auto-detect or apply   │  → { files[], diffText, affectedContent }
│  explicit overrides     │
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│  Provider Registry      │  scripts/lib/providers/index.mjs
│  Detect installed &     │  → [codexProvider, geminiProvider]
│  authenticated (R5 pre) │
└────────────┬────────────┘
             │
      ┌──────┴──────┐
      ▼              ▼
┌───────────┐  ┌───────────┐
│ Codex     │  │ Gemini    │  scripts/lib/providers/codex.mjs
│ Provider  │  │ Provider  │  scripts/lib/providers/gemini.mjs
│ (parallel)│  │ (parallel)│
└─────┬─────┘  └─────┬─────┘
      │              │
      └──────┬───────┘
             ▼
┌─────────────────────────┐
│  Output Validator       │  scripts/lib/validate.mjs
│  JSON parse + schema    │  R10a trust boundary
│  Post-validation R5     │  Re-check min 2 active
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│  Finding Matcher        │  scripts/lib/matcher.mjs
│  File + line overlap    │  → { consensus[], disagreements[],
│  matching               │     providerOnly{} }
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│  Report Synthesizer     │  scripts/lib/report.mjs
│  Format disagreement    │  → Markdown report string
│  report (R12-R15)       │
└─────────────────────────┘
```

## Implementation Units

- [ ] **Unit 1: Project Scaffolding**

**Goal:** Set up the plugin directory structure, package.json, tsconfig, plugin manifest, and README stub.

**Requirements:** R16, R17, R18

**Dependencies:** None

**Files:**
- Create: `.claude-plugin/plugin.json`
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `LICENSE`
- Create: `README.md`
- Create: `skills/review/SKILL.md`

**Approach:**
- Plugin manifest: `{"name": "da", "version": "0.1.0", "description": "Multi-model adversarial code review", "author": {"name": "Jarod Taylor"}, "license": "MIT"}`
- Name `da` gives namespace `/da:review`
- Package.json: `"type": "module"`, scripts for `check` (tsc --noEmit) and `test` (node --test)
- tsconfig: `noEmit: true, checkJs: true, allowJs: true, moduleResolution: "node16", target: "ES2022"`
- SKILL.md stub: frontmatter with `allowed-tools`, body referencing companion script
- README: project description, installation instructions, usage, provider requirements

**Patterns to follow:**
- codex-plugin-cc `plugin.json` format
- codex-plugin-cc `package.json` structure

**Test expectation:** none — pure scaffolding, no behavioral code

**Verification:**
- `npm run check` passes (tsc finds no errors)
- Plugin loads in Claude Code via `claude --plugin-dir .`
- `/da:review` is recognized as a valid command

---

- [ ] **Unit 2: Provider Interface & Finding Schema**

**Goal:** Define the typed provider contract and the common finding format that all providers must produce.

**Requirements:** R1, R10

**Dependencies:** Unit 1

**Files:**
- Create: `scripts/lib/types.mjs`
- Create: `schemas/finding.schema.json`
- Test: `tests/types.test.mjs`

**Approach:**
- Define provider interface via JSDoc typedefs:
  - `detect()` → `{installed: boolean, authenticated: boolean, name: string, error?: string}`
  - `review(diff, files, prompt)` → `{findings: Finding[], raw: string}`
- Define Finding schema:
  - `{severity: 'HIGH'|'MEDIUM'|'LOW', title: string, description: string, rationale: string, file: string, lineStart: number, lineEnd: number, confidence: number}`
- Export a JSON Schema object for the finding format (used by Codex `--output-schema` and by output validation in R10a)
- Export a schema validation function that checks parsed JSON against the schema

**Patterns to follow:**
- codex-plugin-cc `schemas/review-output.schema.json` structure

**Test scenarios:**
- Happy path: valid finding object passes schema validation
- Edge case: finding with missing required field (e.g., no `file`) fails validation
- Edge case: finding with invalid severity value fails validation
- Edge case: empty findings array passes validation (valid "no issues found" response)
- Edge case: extra properties on finding object are rejected (strict mode)

**Verification:**
- `npm run check` passes with type annotations
- Schema validation correctly accepts/rejects test fixtures

---

- [ ] **Unit 3: Diff Collector**

**Goal:** Compute the review target diff from git state or explicit overrides, plus collect affected file content for provider context.

**Requirements:** R6, R7, R8, R9

**Dependencies:** Unit 1

**Files:**
- Create: `scripts/lib/diff.mjs`
- Test: `tests/diff.test.mjs`

**Approach:**
- Auto-detect: check `git status --porcelain` for dirty tree. If dirty → uncommitted diff. If clean → branch diff against merge-base with main/master.
- Explicit overrides parsed from `$ARGUMENTS`: `--branch`, `--worktree`, `--diff`, `--files`
- Worktree detection: use `git rev-parse --show-toplevel` and `git rev-parse --git-common-dir` to detect worktree context
- All user-supplied values passed as discrete args to `child_process.spawn` (never shell-interpolated) per R7 security constraint
- Collect affected file content: read each file touched by the diff, include content for provider context. Truncate to hunk regions + 100 lines surrounding context if file exceeds budget
- Return: `{diffText: string, files: {path: string, content: string}[], target: string}`

**Patterns to follow:**
- Standard git diff invocations: `git diff`, `git diff --cached`, `git diff main...HEAD`
- `child_process.spawn` with args array (no shell: true)

**Test scenarios:**
- Happy path: dirty working tree produces uncommitted diff with affected file content
- Happy path: clean branch ahead of main produces branch diff
- Happy path: `--branch feat/x` overrides auto-detection
- Happy path: `--diff main..HEAD` produces explicit range diff
- Happy path: `--files src/a.ts src/b.ts` limits diff to specified files
- Edge case: invoked from a git worktree — correctly resolves paths and git state
- Edge case: `--worktree /path/to/wt` targets a different worktree
- Edge case: no changes detected (clean tree, no branch diff) — returns empty diff with descriptive message
- Error path: invalid branch name → clear error message
- Error path: not inside a git repo → clear error
- Error path: git command fails → propagates error with context

**Verification:**
- Produces correct diff text for uncommitted changes, branch diff, and explicit overrides
- Works correctly when invoked from a worktree
- No shell injection possible via crafted branch names

---

- [ ] **Unit 4: Adversarial Review Prompt Template**

**Goal:** Create the prompt template that instructs providers to perform adversarial review and return structured JSON findings.

**Requirements:** R9, R10, R13 (line-number coordinate system)

**Dependencies:** Unit 2 (finding schema)

**Files:**
- Create: `prompts/adversarial-review.md`
- Create: `scripts/lib/prompt.mjs`
- Test: `tests/prompt.test.mjs`

**Approach:**
- Prompt structure (adapted from codex-plugin-cc pattern):
  1. Role: "You are an adversarial code reviewer. Your job is to find what's wrong, not validate what's right."
  2. Attack surface priorities (ordered): auth/permissions, data loss/corruption, rollback/idempotency, race conditions, null/timeout/degraded deps, schema drift, observability gaps
  3. Finding bar: each finding must answer what can go wrong, why vulnerable, likely impact, concrete fix
  4. Grounding rules: findings must be defensible from provided context, no invented code paths
  5. Calibration: prefer one strong finding over several weak ones; if change is safe, say so
  6. Line number instruction: "Report line numbers as they appear in the original file (file-absolute), not relative to the diff"
  7. Output contract: inline JSON schema, "Return ONLY valid JSON matching this schema. No prose, no markdown fences."
  8. Input injection slots: `{{DIFF}}`, `{{FILES}}`, `{{CONTEXT}}`
- `prompt.mjs` exports a function that fills the template with diff content and file content
- Separate prompt file (`.md`) from the builder function (`.mjs`) for easy iteration

**Patterns to follow:**
- codex-plugin-cc `prompts/adversarial-review.md` structure
- `<structured_output_contract>` labeled block pattern

**Test scenarios:**
- Happy path: template renders with diff and file content injected at correct positions
- Happy path: rendered prompt includes the full JSON schema inline
- Edge case: very large diff — content is present but truncated signal is included
- Edge case: no file content available (deleted files) — template adapts gracefully

**Verification:**
- Rendered prompt is well-formed, contains all required sections
- JSON schema in prompt matches the schema defined in Unit 2

---

- [ ] **Unit 5: Codex Provider Adapter**

**Goal:** Implement the provider interface for Codex CLI, handling auth detection, review invocation, and output normalization.

**Requirements:** R1, R2, R3, R4, R10

**Dependencies:** Unit 2, Unit 4

**Files:**
- Create: `scripts/lib/providers/codex.mjs`
- Test: `tests/providers/codex.test.mjs`

**Approach:**
- `detect()`: spawn `codex login status`, check exit code 0. Also check `command -v codex` for installation.
- `review(diff, files, prompt)`: spawn `codex exec --json --output-schema <path-to-schema.json> "<rendered-prompt>"`. Pass the rendered adversarial prompt with diff/files injected. Use `--output-schema` pointing to the finding schema JSON file for Codex-native enforcement.
- Parse JSONL event stream from stdout. Extract the final assistant message (the structured findings JSON).
- Normalize to common Finding format.
- Return both parsed findings and raw output (for `--verbose`).
- Timeout: AbortController with configurable duration, kill process on timeout.

**Patterns to follow:**
- codex-plugin-cc `scripts/lib/codex.mjs` for auth detection pattern
- `child_process.spawn` with stdout/stderr collection

**Test scenarios:**
- Happy path: Codex installed and authenticated → detect returns `{installed: true, authenticated: true}`
- Happy path: review invocation returns valid JSON findings → parsed and normalized correctly
- Edge case: Codex installed but not authenticated → detect returns `{installed: true, authenticated: false}`
- Edge case: Codex not installed → detect returns `{installed: false, authenticated: false}`
- Error path: Codex exec returns non-zero exit code → wrapped as provider error
- Error path: Codex exec returns malformed JSON → raw output preserved, findings empty
- Error path: timeout reached → process killed, provider treated as unavailable

**Verification:**
- Auth detection correctly distinguishes installed/authenticated/missing states
- Review invocation produces normalized Finding objects from real Codex output
- Timeout kills the process cleanly

---

- [ ] **Unit 6: Gemini Provider Adapter**

**Goal:** Implement the provider interface for Gemini CLI, handling auth detection, review invocation, and output normalization.

**Requirements:** R1, R2, R3, R4, R10

**Dependencies:** Unit 2, Unit 4

**Files:**
- Create: `scripts/lib/providers/gemini.mjs`
- Test: `tests/providers/gemini.test.mjs`

**Approach:**
- `detect()`: check `command -v gemini` for installation. For auth: read `~/.gemini/oauth_creds.json`, check file exists and `expiry_date > Date.now()`. If file missing or expired → not authenticated. (No CLI status command available.)
- `review(diff, files, prompt)`: spawn `gemini -p "<rendered-prompt>" -o json --approval-mode plan`. The `plan` approval mode puts Gemini in read-only mode, preventing it from executing tools that modify the codebase while still allowing analysis. Parse the JSON envelope `{session_id, response, stats}`. Extract `response` field, JSON.parse it to get findings.
- Normalize to common Finding format.
- No `--output-schema` available — structured output is prompt-only. R10a validation catches malformed responses.
- Timeout: same AbortController pattern as Codex.

**Patterns to follow:**
- Gemini CLI `-p` and `-o json` flags (verified from user's CLI output)
- Same timeout/spawn pattern as Codex provider

**Test scenarios:**
- Happy path: Gemini installed, oauth_creds.json present with valid expiry → detect returns authenticated
- Happy path: review invocation returns JSON envelope with valid findings in response field
- Edge case: oauth_creds.json missing → not authenticated
- Edge case: oauth_creds.json present but expiry_date in the past → not authenticated
- Edge case: Gemini returns JSON envelope but response field contains invalid JSON → treated as malformed
- Error path: Gemini CLI not installed → detect returns not installed
- Error path: runtime auth failure (token revoked server-side despite valid file) → caught as provider error per R5
- Error path: rate limit error from Gemini → caught as provider error per R5
- Error path: timeout → process killed, unavailable

**Verification:**
- Auth detection handles all file/expiry states correctly
- JSON envelope parsing extracts findings from nested `response` field
- Provider errors (rate limit, auth failure) are surfaced as structured status, not crashes

---

- [ ] **Unit 7: Orchestrator**

**Goal:** Wire together diff collection, provider detection, parallel execution, output validation, and the minimum-provider gate.

**Requirements:** R4, R5, R9, R10a, R11

**Dependencies:** Units 2, 3, 5, 6

**Files:**
- Create: `scripts/lib/orchestrate.mjs`
- Create: `scripts/lib/validate.mjs`
- Test: `tests/orchestrate.test.mjs`

**Approach:**
- Pre-flight: load provider registry, run `detect()` on each. Check R5 minimum (2 active). Fail early with structured status error if not met.
- Parallel execution: `Promise.allSettled()` on all active providers' `review()` calls. Each wrapped with timeout via AbortController.
- Post-execution: for each result, run R10a validation (JSON schema check via `validate.mjs`). Mark failed validations as provider failures.
- Post-validation R5 recheck: if valid provider count drops below 2, fail with structured error identifying which providers failed and why (not installed / not authenticated / timed out / malformed output / runtime error).
- Return: `{results: Map<providerName, {findings, raw}>, failures: Map<providerName, {reason, details}>}`

**Patterns to follow:**
- `Promise.allSettled` for parallel execution with individual error handling
- AbortController + setTimeout for per-provider timeouts

**Test scenarios:**
- Happy path: 2 providers detected, both return valid findings → results map has both
- Happy path: 3 providers detected (future), all return valid → works with N providers
- Edge case: one provider times out, one succeeds → R5 recheck fails (below min 2), structured error
- Edge case: both providers return valid but one has 0 findings → still valid (0 findings is not an error)
- Error path: pre-flight detects only 1 provider installed → immediate R5 failure with status
- Error path: both providers return malformed JSON → post-validation R5 failure
- Error path: one provider throws unexpected error (crash) → caught by allSettled, treated as failure
- Integration: pre-flight R5 check + post-validation R5 recheck are distinct gates — test that a provider passing pre-flight but failing validation triggers the post-validation path

**Verification:**
- Providers run in parallel (not serial) — observable via timing
- R5 gate fires at both pre-flight and post-validation stages
- Structured error messages clearly identify each provider's state

---

- [ ] **Unit 8: Finding Matcher & Synthesis Engine**

**Goal:** Match findings across providers by file location and generate the four-section disagreement report.

**Requirements:** R12, R13, R14, R15

**Dependencies:** Unit 2

**Files:**
- Create: `scripts/lib/matcher.mjs`
- Create: `scripts/lib/report.mjs`
- Test: `tests/matcher.test.mjs`
- Test: `tests/report.test.mjs`

**Approach:**
- **Matcher** (`matcher.mjs`):
  - Input: findings arrays from each provider
  - For each finding pair across providers: match if same file AND line ranges overlap (any intersection: `a.lineStart <= b.lineEnd && b.lineStart <= a.lineEnd`)
  - Fallback for findings without line numbers: match by file + normalized title similarity (Levenshtein or simple word overlap)
  - Classify matches: consensus (same severity), disagreement (different severity), unmatched → provider-only
  - Output: `{consensus: MatchedFinding[], disagreements: MatchedFinding[], providerOnly: Map<providerName, Finding[]>}`

- **Report** (`report.mjs`):
  - Render Markdown report with four sections per R12
  - Consensus: severity-sorted findings with both providers listed
  - Disagreements: table with each provider's severity and assessment side-by-side (R14)
  - Provider-only: grouped by provider name
  - Summary: provider count, total findings, agreement rate (consensus / total matched)
  - `--verbose` mode: append raw provider output at the bottom (R15)

**Patterns to follow:**
- Line range overlap: standard interval intersection check
- Markdown table formatting for disagreements section

**Test scenarios:**
- Happy path: two findings on same file with overlapping lines, same severity → consensus
- Happy path: two findings on same file with overlapping lines, different severity → disagreement
- Happy path: finding from provider A with no match in provider B → provider-only for A
- Edge case: findings on same file but non-overlapping lines → both provider-only (not matched)
- Edge case: finding without line numbers matched by file + title similarity
- Edge case: one provider returns 0 findings, other returns 5 → all 5 are provider-only
- Edge case: all findings match with same severity → 100% agreement rate, empty disagreements section
- Edge case: no findings from either provider → report says "no issues found by either provider"
- Happy path: `--verbose` flag appends raw output from each provider
- Happy path: report renders valid Markdown with proper table formatting

**Verification:**
- Matching correctly classifies consensus vs disagreement vs provider-only
- Agreement rate calculation is accurate
- Report is well-formed Markdown that renders correctly

---

- [ ] **Unit 9: Slash Command Integration**

**Goal:** Wire the SKILL.md entry point to the orchestrator and synthesis engine, handling argument parsing and output rendering.

**Requirements:** R15, R16, R17

**Dependencies:** Units 7, 8

**Files:**
- Modify: `skills/review/SKILL.md`
- Create: `scripts/review.mjs`
- Test: `tests/review.test.mjs`

**Approach:**
- SKILL.md body: parse `$ARGUMENTS` for flags, invoke `scripts/review.mjs` via Bash tool. Frontmatter: `allowed-tools: Bash(node:*), Bash(git:*), Read, Glob, Grep`
- `review.mjs` (the companion script): orchestrate the full flow:
  1. Parse CLI args (--branch, --worktree, --diff, --files, --verbose)
  2. Collect diff (Unit 3)
  3. Run orchestrator (Unit 7) — detect providers, parallel review, validate
  4. Match findings (Unit 8 matcher)
  5. Generate report (Unit 8 report)
  6. Output report to stdout (Claude reads it back to the user)
- Error handling: orchestrator failures (R5, timeout, validation) produce structured error messages, not stack traces
- Exit codes: 0 = report generated, 1 = provider error (R5 failure), 2 = bad arguments

**Patterns to follow:**
- codex-plugin-cc `scripts/codex-companion.mjs` entry point pattern
- `process.argv` parsing or lightweight arg parser

**Test scenarios:**
- Happy path: `/da:review` with no args → auto-detect diff, run review, output report
- Happy path: `/da:review --branch feat/auth` → review that branch's diff
- Happy path: `/da:review --verbose` → report includes raw provider output
- Edge case: `/da:review --diff main..HEAD --files src/auth.ts` → combined overrides
- Error path: no providers available → R5 error message listing provider statuses
- Error path: no diff found (clean tree, no branch diff) → clear "nothing to review" message
- Integration: full end-to-end flow from argument parsing to report output

**Verification:**
- `/da:review` in Claude Code produces a structured disagreement report
- All argument combinations work correctly
- Error messages are clear and actionable

## System-Wide Impact

- **Interaction graph:** SKILL.md → scripts/review.mjs → orchestrate.mjs → [codex.mjs, gemini.mjs] → validate.mjs → matcher.mjs → report.mjs. Single linear flow, no callbacks or observers.
- **Error propagation:** Provider errors bubble up as structured status objects, never raw exceptions. R5 gate is the single decision point for fail vs continue.
- **State lifecycle risks:** No persistent state. Each `/da:review` invocation is stateless. No cache, no session files, no cross-run state.
- **API surface parity:** `/da:review` is the only user-facing command. No MCP tools, no hooks exposed to other plugins.
- **Integration coverage:** The end-to-end flow (diff → providers → validation → matching → report) should be tested with mock provider outputs to verify the full pipeline without needing real CLI installations.
- **Unchanged invariants:** Does not modify the user's git state, files, or Claude Code configuration. Read-only interaction with the codebase.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Provider CLI interfaces change | Pin to known-working CLI versions in docs. Provider adapters are isolated — one breaking change affects one file. |
| Prompt-only JSON enforcement produces malformed output | R10a validation catches this. Codex has `--output-schema` as a safety net. For Gemini, retry once with a simpler prompt on parse failure. |
| Provider rate limits cause intermittent failures | R5 treats rate limits as provider errors with structured status messages. Error message distinguishes "rate-limited" from "not installed". |
| Gemini agent executes tools during review (unintended side effects) | Use `--approval-mode plan` which puts Gemini in read-only mode. Do NOT use `--yolo` (it auto-approves all tool execution including file writes). Verify during implementation that `plan` mode still allows the model to analyze code and return findings. |
| File-absolute line numbers unreliable with diff-only context | Include affected file content alongside diff to give providers full context for accurate line references. |
| Large diffs exceed provider context windows | Budget 50KB per provider. Truncate with clear signal in prompt. Future: chunk large diffs across multiple invocations. |

## Documentation / Operational Notes

- README must include: installation instructions (marketplace + manual), provider setup guide (Codex login, Gemini login), usage examples, trust model disclosure (diffs sent to external services)
- CHANGELOG.md for release tracking
- CONTRIBUTING.md for open source contribution guide

## Sources & References

- **Origin document:** [docs/brainstorms/devils-advocate-v1-requirements.md](docs/brainstorms/devils-advocate-v1-requirements.md)
- Reference plugin: [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)
- Reference plugin: [nyldn/claude-octopus](https://github.com/nyldn/claude-octopus)
- Claude Code plugin docs: [code.claude.com/docs/en/plugins](https://code.claude.com/docs/en/plugins)
- Claude Code plugin reference: [code.claude.com/docs/en/plugins-reference](https://code.claude.com/docs/en/plugins-reference)
