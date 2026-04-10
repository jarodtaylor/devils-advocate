# Devil's Advocate

Multi-model adversarial code review plugin for [Claude Code](https://claude.ai/code).

Sends your diffs to external AI coding tools in parallel, then synthesizes a **structured disagreement report** — highlighting where models diverge, not flattening to consensus.

## How It Works

1. You invoke `/da:review` in Claude Code
2. Devil's Advocate collects your diff and sends it to multiple AI reviewers (Codex, Gemini CLI)
3. Each reviewer independently analyzes the code as an adversarial reviewer
4. Results are synthesized into a report showing consensus, disagreements, and provider-only findings

Claude orchestrates and synthesizes — it never reviews. The external tools do the reviewing.

## Requirements

- [Claude Code](https://claude.ai/code) installed
- At least **two** of the following AI CLI tools installed and authenticated:
  - **Codex CLI** — `codex login` (uses your ChatGPT subscription)
  - **Gemini CLI** — `gemini` with Google account login (free tier: 1,000 req/day)

## Installation

```bash
# From the plugin marketplace
/plugin install devils-advocate

# Or directly from GitHub
claude plugin add jarodtaylor/devils-advocate
```

## Usage

```bash
# Review uncommitted changes (auto-detected)
/da:review

# Review a specific branch
/da:review --branch feat/user-auth

# Review an explicit diff range
/da:review --diff main..HEAD

# Include raw provider output
/da:review --verbose
```

## Trust Model

Devil's Advocate sends your code diffs and affected file content to external AI services (OpenAI for Codex, Google for Gemini) for analysis. This uses the same trust model as the provider CLIs themselves — if you trust running `codex exec` or `gemini -p` on your code, you trust this plugin.

**Do not use on codebases containing secrets, credentials, or sensitive data you wouldn't send to these services.**

## License

MIT
