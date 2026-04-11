# Roadmap

This document captures planned, deferred, and explicitly out-of-scope work for Devil's Advocate. It's maintained alongside the code so contributors and users can see where the project is heading.

> **Aspirational, not promissory.** Items on this roadmap represent current thinking about priorities — not commitments. Priorities shift based on real usage, feedback, and what turns out to be harder than expected. If something here matters to you, [open an issue](https://github.com/jarodtaylor/devils-advocate/issues/new/choose) so I know someone wants it.

**Current version:** See [`package.json`](package.json) and [`CHANGELOG.md`](CHANGELOG.md).

## How This Roadmap Is Organized

Items are grouped by SemVer milestone:

- **v0.1.x patches** — bug fixes and documentation corrections. Reactive; driven by real issues.
- **v0.2.0 (next minor)** — backwards-compatible feature additions. Existing config files and CLI invocations should continue to work unchanged.
- **v0.3.0+ (future minors)** — larger feature additions that may introduce new architectural surfaces. Still backwards-compatible per SemVer.
- **v1.0.0 (stability commitment)** — the point at which the config schema, CLI interface, and report format become stable contracts. Pre-1.0 releases may have breaking changes in minor bumps.
- **Unscheduled** — ideas that need more research or design work before they can be scheduled.
- **Permanently out of scope** — things I've decided not to build, with the reason.

## v0.1.x — Patches

No planned patches. Patch releases are reactive — driven by bug reports and documentation corrections.

See [CHANGELOG.md](CHANGELOG.md) for shipped patches.

## v0.2.0 — Next Minor Release

Backwards-compatible feature additions. Users upgrading from v0.1.x should see no breaking changes.

### `/da:setup` interactive wizard

**What:** A new `/da:setup` slash command that walks new users through creating their initial config file, detecting which provider CLIs are installed and authenticated, and offering sensible defaults.

**Why:** The current onboarding is "read the README, create JSON by hand." That works for developers comfortable with config files, but creates unnecessary friction for everyone else. A wizard should take 30 seconds and produce a working setup.

**Status:** Deferred from v0.1.0 planning. Captured in [`docs/brainstorms/config-system-requirements.md`](docs/brainstorms/config-system-requirements.md) as "Deferred to V1.2."

### Codex and Gemini model selection

**What:** Extend `providers.codex.model` and `providers.gemini.model` to be configurable, matching the existing `providers.claude.model` field. Unknown or unsupported models would still produce a stderr warning (the current behavior for non-Claude providers).

**Why:** v0.1.0 deliberately ships Claude-only model selection because Claude's `--model` flag is verified. The Codex and Gemini CLIs have model flags too, but they weren't researched in time for v0.1.0. This item is the research + integration.

**Blocker:** Need to verify the current Codex CLI model flag name, behavior, and supported model identifiers. Same for Gemini.

**Status:** Deferred from v0.1.0. See `[Affects R8][Needs research]` note in the [config system requirements](docs/brainstorms/config-system-requirements.md).

### `--model <provider>:<model>` CLI flag

**What:** A CLI flag for one-off model overrides, e.g. `/da:review --model claude:opus --model codex:gpt-5`. Useful when you want to switch models for a specific review without editing config.

**Why:** Currently, model selection only works through config files. The CLI has `--disable` and `--timeout` but no model override. A `--model <provider>:<model>` flag completes the CLI parity with the config layer.

**Blocker:** Only meaningful once Codex and Gemini support model selection (the item above).

**Status:** Deferred from v0.1.0.

### Per-provider timeout

**What:** Allow `providers.codex.timeout`, `providers.gemini.timeout`, etc. to override the global `timeout` field for specific providers. Useful when one provider is consistently slower or faster.

**Why:** v0.1.0 applies a single global timeout to all providers. In practice, different providers have different performance characteristics — Gemini Pro models can be slower than Sonnet, and vice versa. A global timeout tuned for the slowest provider wastes time on the fastest.

**Design constraint:** Must not break existing configs. Global `timeout` remains the fallback; per-provider overrides only take effect when explicitly set.

**Status:** Listed as "out of scope" in the config system requirements. Revisiting based on actual usage patterns.

### Environment variable config paths

**What:** Support `DEVILS_ADVOCATE_CONFIG` and `DEVILS_ADVOCATE_PROJECT_CONFIG` environment variables to override the default paths (`~/.devils-advocate/config.json` and `.da.json`).

**Why:** The current paths are fixed. Users running in containers, CI, or unconventional setups can't point at alternate locations without filesystem tricks.

**Status:** Noted as a limitation in the v0.1.0 CHANGELOG.

### Review focus / lens

**What:** A config field (e.g., `focus: "security"`, `focus: "performance"`, `focus: "architecture"`) that injects a lens-specific instruction into the adversarial prompt, steering reviewers toward a particular concern.

**Why:** Devil's Advocate currently uses a single adversarial prompt that asks reviewers to find bugs generally. Some reviews benefit from a narrower focus — a security-only pass before deploying auth changes, a performance-only pass before shipping a hot path.

**Design constraint:** Must not break the R10a output trust boundary. Lens instructions go in the prompt, not in how output is parsed.

**Status:** Listed as "out of scope" in v0.1.0 config requirements. Natural fit for v0.2.0 once the foundation is stable.

## v0.3.0+ — Future Minor Releases

Larger feature additions that may introduce new architectural surfaces.

### Roles-based review mode

**What:** Instead of asking all three providers to run the same adversarial review, assign each a specialized role. Example: Claude gets "architecture reviewer," Codex gets "security reviewer," Gemini gets "performance reviewer." Each sees the same diff but with a role-specific prompt and evaluation rubric.

**Why:** v0.1.0 is "parallel independent review" mode. All three providers do the same job and we synthesize disagreements. Roles-based review changes the question from "do they agree?" to "do they together cover all the dimensions a good review should address?"

**How it relates to v0.1.0:** Parallel mode becomes the default; roles-based is opt-in via config. Both modes coexist.

**Design sketch:** Each role is a prompt template + a scoring rubric. Reports group findings by role instead of by provider. Consensus detection works per-role.

**Status:** Mentioned in v0.1.0 brainstorm as "future work alongside debate-style." Becomes compelling specifically because v0.1.0 ships with 3 providers — each one can own a distinct lens.

### Tmux / multiplexer live visibility

**What:** When Devil's Advocate detects it's running inside a terminal multiplexer (tmux, screen, Zellij), optionally spawn each provider review in its own visible pane so power users can watch the work happen in real time.

**Why:** A common frustration with Claude Code plugins is "I don't know what's happening." The synthesized report is the important output, but some users want to see the review CLIs working, not just the final result. This is a power-user feature, not a default.

**Design constraints:**
- Must auto-detect the multiplexer (don't force it on users who aren't using one)
- Must be opt-in via config (don't surprise users with pane creation)
- Must not affect the report output — the panes are purely observational

**Status:** Captured in v0.1.0 brainstorm as "out of scope, future exploration." Differentiating feature vs. other AI review tools.

### Semantic finding matching

**What:** Replace (or augment) the current location-based finding matcher with embedding-based semantic similarity. Two findings at different file locations that describe the same underlying issue should still be detected as consensus.

**Why:** v0.1.0 matches findings by file path + overlapping line range. This works well for "codex and gemini both flagged line 42," but fails when providers describe the same bug at slightly different locations (e.g., one flags the call site, another flags the function definition).

**Trade-off:** Embedding-based matching requires either an embeddings API call (violates "Claude never reviews" architecturally — we'd be adding an LLM call to the synthesis step) or a local embedding model (adds a runtime dependency, breaks zero-deps philosophy).

**Status:** Listed in v0.1.0 brainstorm as "deferred." Needs design work before it's schedulable. The philosophical question "is the synthesis step allowed to call an LLM?" needs a clear answer first.

### PR workflow integration (GitHub Actions helper)

**What:** A pre-built GitHub Actions workflow template that runs Devil's Advocate on every PR and posts the disagreement report as a PR comment. Ships as a separate file in `.github/workflows/` that users can copy into their own repos.

**Why:** Currently, Devil's Advocate runs locally via `/da:review`. CI/CD integration is the natural next step for teams that want adversarial review as part of their PR gate.

**Design question:** Does this ship as a separate repo (`devils-advocate-action`) or as a file in this repo's docs? Precedent: `anthropics/claude-code-action` is a separate repo. That's probably the right pattern.

**Status:** Listed as out of scope for v0.1.0. Could move to v0.2.0 if demand materializes.

## v1.0.0 — Stability Commitment

Pre-1.0 releases may include breaking changes in minor bumps. v1.0.0 is the point at which Devil's Advocate commits to backwards compatibility for its public contracts. Before tagging 1.0, these need to be stable:

### Contracts to freeze

- **Config file schema** — current `.da.json` / `~/.devils-advocate/config.json` format. Any additions after 1.0 must be backwards-compatible.
- **CLI flag interface** — current `/da:review` flags (`--branch`, `--worktree`, `--diff`, `--files`, `--verbose`, `--timeout`, `--disable`). Any additions after 1.0 must not break existing invocations.
- **Report structure** — the four-section disagreement format (Consensus, Disagreements, Provider-only, Summary). Report consumers should be able to rely on these section headers.
- **Finding schema** — the JSON schema in `schemas/finding.schema.json` that providers are expected to produce.

### Features needed before 1.0

These are features that would feel weird to add *after* 1.0 because they affect one of the contracts above:

**API key / OpenRouter integration**

The ability to use API keys (OpenAI, Anthropic, Google) or OpenRouter as an alternative to subscription auth. v0.1.0 is explicitly subscription-only (relies on user-logged-in CLIs). Adding API key support after 1.0 would require a config schema addition that's hard to make feel clean as an afterthought.

**MCP server distribution**

Devil's Advocate could be distributed as an MCP server instead of (or in addition to) a Claude Code plugin. This changes the delivery model significantly and should be sorted before 1.0 so the distribution story is stable.

**Rationale for waiting:** Both of these touch architectural surfaces. It's better to make these decisions before committing to stability than to regret them after.

## Unscheduled

Ideas I want to explore but don't have a clear implementation path for yet.

### Debate-style review mode

**What:** Rather than independent parallel review, reviewers see each other's findings and respond — challenging, agreeing, or refining. The output is a threaded discussion instead of independent reports.

**Why it's interesting:** The disagreements in v0.1.0 are detected after the fact. Debate-style would produce reasoned disagreements where each reviewer has seen the others' positions.

**Why it's unscheduled:** Architecturally expensive. Requires multiple rounds of provider invocations instead of parallel single-shot. Each reviewer consumes every other reviewer's output, multiplying token cost. The protocol for "turn-taking" isn't obvious — do reviewers see each other simultaneously, or in a fixed order? How many rounds?

**Needs:** A design document. Until someone writes one, this stays unscheduled.

### Additional providers

Potential providers mentioned in early planning: Kimi Code, Cursor, Aider. Each would need:
- A provider adapter implementing the `Provider` interface
- Output validation that fits the R10a trust boundary
- A prompt adapter if the CLI doesn't accept the standard adversarial prompt
- Test coverage matching the existing three providers

**Status:** Waiting on mature CLI tools. The moment any of these ship with stable machine-readable output, they become schedulable.

### Prompt customization

**What:** Let users provide a custom adversarial prompt template, overriding the default `prompts/adversarial-review.md`.

**Why I'm hesitant:** Prompt content directly affects what reviewers look for. A custom prompt that subtly biases reviewers toward false positives or false negatives could undermine the tool's value. The R10a output validation doesn't catch this — it validates the *shape* of findings, not their *quality*.

**If someone builds it:** It needs a strong "caveat emptor" warning and probably a way to flag "non-default prompt" in the report header so readers know the baseline is different.

**Status:** Unscheduled. Not convinced this should exist.

## Permanently Out of Scope

Things I've deliberately decided not to build, with the reason.

### Secrets scanning / redaction of diff content

Devil's Advocate sends diffs to external AI services. v0.1.0 relies on the same trust model as the provider CLIs themselves: if you trust `codex exec` with your code, you trust Devil's Advocate to do the same. Adding secrets scanning would create a false sense of security — any scanner is imperfect, and users might assume it's safe to run against codebases that contain secrets.

**Users are responsible for knowing whether their code is safe to send.** This is documented prominently in the README's "Trust Model" section. Devil's Advocate is not the right layer for this concern.

### Cost tracking and usage metering

Each provider CLI handles its own billing and quota. Devil's Advocate would need to duplicate that accounting to track total cost across providers, and it would go stale the moment any provider changes its pricing model. Better to let each provider's native tooling own this.

### Report format customization

The four-section disagreement report is an opinionated default. Letting users customize it (different section headers, different fields, different ordering) would make the report harder to reason about for everyone and would complicate downstream tooling that parses the output. If you want different output, the raw provider output is available via `--verbose`.

### First-run consent / disclosure prompt

Installing the plugin and having provider CLIs authenticated is sufficient informed consent. An additional prompt would be friction without value. This may be revisited if enterprise adoption becomes a goal.

---

## Changing This Roadmap

This file is maintained by the project maintainer and updated as priorities shift. If you think something should be scheduled differently, open an issue with your reasoning. If you want to work on something here, comment on the relevant issue (or open one) so we can coordinate before you spend time on it.

**Last updated:** See `git log -1 ROADMAP.md` for the commit date.
