# Security Policy

## Reporting a Vulnerability

**Do not file a public GitHub issue for security vulnerabilities.**

If you discover a security issue in Devil's Advocate, please report it privately using GitHub's [private vulnerability reporting](https://github.com/jarodtaylor/devils-advocate/security/advisories/new).

I'll acknowledge receipt within 72 hours and work with you on a fix timeline. Reports that include a clear reproduction and suggested remediation will be addressed faster.

## Scope

Devil's Advocate is a Claude Code plugin that executes external AI CLI tools (`codex`, `gemini`, `claude`) against your local code diffs. The following are **in scope**:

- **Prompt injection** via diff content or file contents that could cause a provider to leak sensitive data or execute unintended commands
- **Config file attacks** — malicious `.da.json` or `~/.devils-advocate/config.json` that exploits the config parser (prototype pollution, path traversal, command injection)
- **Provider adapter vulnerabilities** — spawning CLIs with user-controlled arguments in unsafe ways
- **Output trust boundary violations** — provider output that could inject Markdown/HTML into the report in unintended ways (the R10a validation layer)
- **Secret exposure** — any code path that could log, persist, or transmit provider credentials or OAuth tokens

## Out of Scope

- **Vulnerabilities in the external provider CLIs themselves** — report those to OpenAI (Codex), Google (Gemini), or Anthropic (Claude). Devil's Advocate trusts these tools as-is.
- **Theoretical supply chain attacks against `devDependencies`** that are not exploitable at runtime (the plugin has zero runtime dependencies)
- **Denial of service via large diffs** — the plugin has a 120s default timeout and users control the input
- **Attacks requiring a pre-compromised local machine** — if the attacker can write to `~/.devils-advocate/` or modify the plugin code, they already have code execution

## Trust Model

Devil's Advocate sends your code diffs and affected file content to external AI services (OpenAI, Google, Anthropic) for analysis. **This is the same trust model as running the underlying CLIs directly.** Review the [Trust Model section of the README](README.md#trust-model) before using on codebases containing secrets.

## Responsible Disclosure

I follow a [90-day disclosure timeline](https://en.wikipedia.org/wiki/Responsible_disclosure). If I cannot ship a fix within 90 days, I'll coordinate with you on a reasonable extension or public disclosure.

## Past Advisories

None yet. This document will be updated with resolved advisories as they occur.
