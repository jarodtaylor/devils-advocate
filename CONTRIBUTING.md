# Contributing to Devil's Advocate

Thanks for your interest in contributing. This doc covers dev setup, how to run tests, the PR process, and the project's architectural invariants.

## Quick Start

```bash
# Clone and install devDependencies (zero runtime deps)
git clone https://github.com/jarodtaylor/devils-advocate.git
cd devils-advocate
npm install

# Run the test suite (node --test, 260+ tests)
npm test

# Type check (tsc --noEmit, strict mode on .mjs files via JSDoc)
npm run check
```

You'll need Node.js 22+ and at least **two** of the three provider CLIs (`codex`, `gemini`, `claude`) installed and authenticated if you want to exercise the full review pipeline locally. Unit tests run without any CLI present.

## Project Architecture

Devil's Advocate is a Claude Code plugin that orchestrates multi-model adversarial code review. Read `CLAUDE.md` for the full architecture overview. The short version:

```
skills/review/SKILL.md          → /da:review entry point
scripts/review.mjs              → CLI arg parsing + pipeline orchestration
scripts/lib/config.mjs          → layered config loading + merging
scripts/lib/diff.mjs            → git diff with auto-detect + overrides
scripts/lib/prompt.mjs          → adversarial prompt builder
scripts/lib/providers/*.mjs     → CLI adapters (Codex, Gemini, Claude)
scripts/lib/orchestrate.mjs     → parallel execution + R5 gates
scripts/lib/validate.mjs        → R10a output trust boundary
scripts/lib/matcher.mjs         → location-based finding matching
scripts/lib/report.mjs          → disagreement report synthesis
```

### Architectural Invariants (Non-Negotiable)

These rules define what Devil's Advocate *is*. PRs that violate them will be rejected unless the invariant itself is being deliberately revised.

1. **Claude never reviews.** Claude orchestrates and synthesizes. External CLI tools do the reviewing. Core invariant — the whole point of the tool.
2. **Minimum 2 providers.** Hard fail (R5Error) if fewer than 2 are active. Pre-flight AND post-validation checks.
3. **Structured disagreement, not consensus.** The disagreements are the signal. Do not flatten to "majority rules" output.
4. **Uniform diff delivery.** The orchestrator pre-computes the diff and passes it as prompt context. Providers don't resolve git state themselves.
5. **Output validation is the trust boundary (R10a).** Validate provider-parsed findings before synthesis. Malformed output = provider failure, not user error.
6. **Prompt injection defense.** Diff and file content are wrapped in XML delimiter tags (`<diff>`, `<files>`). Do not pass user content unwrapped.

## Tech Stack

- **Language:** ESM JavaScript (`.mjs`) with TypeScript type-checking via JSDoc (`tsc --noEmit --checkJs`)
- **No build step.** Clone and go.
- **Zero runtime dependencies.** devDependencies are only `@types/node` and `typescript`.
- **Testing:** `node --test` (Node.js built-in test runner, `node:assert/strict`)
- **License:** MIT

Adding a runtime dependency requires a strong justification in the PR description. This is a philosophical choice — the plugin ships with its source and should stay auditable.

## Development Workflow

### 1. Open an Issue First (for non-trivial changes)

For bug fixes and tiny improvements, a PR is fine. For new features, architectural changes, or anything that touches the provider adapters or config system, **open an issue first** so we can discuss the approach before you spend time coding.

### 2. Branch Naming

- `feat/<short-description>` for new features
- `fix/<short-description>` for bug fixes
- `refactor/<short-description>` for refactors
- `docs/<short-description>` for doc-only changes
- `chore/<short-description>` for build/CI/tooling

### 3. Make Your Changes

- **Read existing code before modifying.** Match the patterns in place.
- **Every change needs a clear "why."** If you can't articulate it in the PR description, it's not ready.
- **Keep it simple.** Impact minimal code. Don't add abstractions for hypothetical future needs.
- **Follow the DI pattern for providers.** `buildXProvider({ spawnFn, ... })` makes everything testable without real CLI calls.

### 4. Write Tests

- **Every feature-bearing change needs tests.** New behavior → new tests.
- **Use the existing test patterns.** `tests/providers/*.test.mjs` show the injectable mock approach.
- **Test at the right level.** Unit tests for helpers, integration tests for pipeline behavior.
- **Test scenarios should name specific inputs and expected outcomes.** Not "validates correctly" — say what input, what action, what outcome.

### 5. Verify Before Pushing

```bash
npm test         # all tests pass
npm run check    # no type errors
```

Both commands are gated in CI. If they fail locally, they'll fail the PR build.

### 6. Commit Messages

Use [conventional commits](https://www.conventionalcommits.org/):

- `feat(scope): add X`
- `fix(scope): prevent Y`
- `refactor(scope): extract Z`
- `docs: update ...`
- `chore(ci): bump ...`

Scopes used in this repo: `config`, `cli`, `pipeline`, `providers`, `report`, `ci`, `docs`.

Commit messages should explain **why**, not **what**. The diff shows what changed; the message should explain motivation.

### 7. Open the Pull Request

Fill out the PR template. Include:
- What the change does (1-2 sentences)
- Why it matters (business or technical rationale)
- How it was tested (commands run, coverage added)
- Any architectural decisions that weren't obvious

## Code Review

Your PR will be reviewed by:
- **Automated reviewers** — Claude Code Action and GitHub Copilot leave inline comments on every PR. Address them or explain why they're wrong.
- **CI checks** — tests and type check must pass. CodeQL must not introduce new findings.
- **Human review** — I'll review architectural choices and correctness.

Expect multiple rounds of feedback on non-trivial PRs. That's normal and not a judgment on your work.

## Testing the Plugin Locally

To exercise the full pipeline end-to-end:

```bash
# Make sure you have at least 2 providers authenticated
codex login status     # exit 0 = authed
cat ~/.gemini/oauth_creds.json  # check expiry_date
command -v claude      # claude is always authed inside Claude Code

# Make a test change in any git repo
cd /path/to/some/repo
echo "// test" >> some-file.js

# Run the review directly (not via the /da:review slash command)
node /path/to/devils-advocate/scripts/review.mjs --branch main
```

For faster iteration, the test suite exercises most of the pipeline with mock providers — you rarely need the real CLIs.

## Questions?

- **Architectural questions:** Open a GitHub Discussion or issue
- **Security issues:** See [SECURITY.md](SECURITY.md) — do not file a public issue
- **Feature requests:** File an issue with the `feature request` template

Thanks for contributing.
