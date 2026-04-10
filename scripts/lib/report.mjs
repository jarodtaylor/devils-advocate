/**
 * @file Report synthesizer — renders the four-section Markdown disagreement report (R12–R15).
 */

/** @typedef {import('./types.mjs').Finding} Finding */
/** @typedef {import('./matcher.mjs').MatchResult} MatchResult */
/** @typedef {import('./matcher.mjs').ConsensusFinding} ConsensusFinding */
/** @typedef {import('./matcher.mjs').DisagreementFinding} DisagreementFinding */

// ─── Severity ordering ────────────────────────────────────────────────────────

const SEVERITY_ORDER = { HIGH: 0, MEDIUM: 1, LOW: 2 };

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareSeverity(a, b) {
  const ao = SEVERITY_ORDER[/** @type {keyof typeof SEVERITY_ORDER} */ (a)] ?? 99;
  const bo = SEVERITY_ORDER[/** @type {keyof typeof SEVERITY_ORDER} */ (b)] ?? 99;
  return ao - bo;
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

/**
 * Format a severity string as a compact badge.
 *
 * @param {string} severity
 * @returns {string}
 */
function severityBadge(severity) {
  const badges = { HIGH: "[HIGH]", MEDIUM: "[MEDIUM]", LOW: "[LOW]" };
  return badges[/** @type {keyof typeof badges} */ (severity)] ?? `[${severity}]`;
}

/**
 * Format a file path + line range as a short location string.
 *
 * @param {string} file
 * @param {number} lineStart
 * @param {number} lineEnd
 * @returns {string}
 */
function locationStr(file, lineStart, lineEnd) {
  if (lineStart === lineEnd) return `${file}:${lineStart}`;
  return `${file}:${lineStart}-${lineEnd}`;
}

/**
 * Escape pipe characters inside a Markdown table cell.
 *
 * @param {string} text
 * @returns {string}
 */
function escapeCell(text) {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

// ─── Section renderers ────────────────────────────────────────────────────────

/**
 * Render the summary stats block.
 *
 * @param {MatchResult} matchResult
 * @param {string[]} providerNames
 * @returns {string}
 */
function renderSummary(matchResult, providerNames) {
  const { consensus, disagreements, providerOnly } = matchResult;

  const totalMatched = consensus.length + disagreements.length;
  const totalProviderOnly = [...providerOnly.values()].reduce((s, f) => s + f.length, 0);
  const totalFindings = totalMatched + totalProviderOnly;

  // Agreement rate = consensus / (consensus + disagreements) when there are matched findings.
  const agreementRate =
    totalMatched === 0
      ? "N/A"
      : `${Math.round((consensus.length / totalMatched) * 100)}%`;

  const lines = [
    `**Providers:** ${providerNames.join(", ")}`,
    `**Total findings:** ${totalFindings}`,
    `**Consensus:** ${consensus.length} | **Disagreements:** ${disagreements.length} | **Provider-only:** ${totalProviderOnly}`,
    `**Agreement rate:** ${agreementRate} (among matched findings)`,
  ];

  return lines.join("  \n");
}

/**
 * Render the consensus section.
 *
 * @param {ConsensusFinding[]} consensusFindings
 * @returns {string}
 */
function renderConsensus(consensusFindings) {
  if (consensusFindings.length === 0) return "";

  const sorted = [...consensusFindings].sort((a, b) => compareSeverity(a.severity, b.severity));

  const items = sorted.map((c) => {
    const loc = locationStr(c.finding.file, c.finding.lineStart, c.finding.lineEnd);
    const badge = severityBadge(c.severity);
    const providerList = c.providers.join(", ");
    return [
      `- ${badge} **${c.finding.title}**`,
      `  - **Location:** \`${loc}\``,
      `  - **Providers:** ${providerList}`,
      `  - ${c.finding.description}`,
    ].join("\n");
  });

  return ["### Consensus", "", ...items].join("\n");
}

/**
 * Render the disagreements section as a Markdown table (R14).
 *
 * @param {DisagreementFinding[]} disagreementFindings
 * @param {string[]} providerNames
 * @returns {string}
 */
function renderDisagreements(disagreementFindings, providerNames) {
  if (disagreementFindings.length === 0) return "";

  // Table header: Finding | Location | <provider1> | <provider2> | ...
  const providerHeaders = providerNames.map((n) => escapeCell(n));
  const header = `| Finding | Location | ${providerHeaders.join(" | ")} |`;
  const separator = `| --- | --- | ${providerNames.map(() => "---").join(" | ")} |`;

  const rows = disagreementFindings.map((d) => {
    const loc = escapeCell(locationStr(d.file, d.lineStart, d.lineEnd));

    // Use the first assessment's title as the finding label.
    const firstAssessment = [...d.assessments.values()][0];
    const title = escapeCell(firstAssessment?.title ?? "(untitled)");

    const providerCells = providerNames.map((name) => {
      const assessment = d.assessments.get(name);
      if (!assessment) return "—";
      return escapeCell(`${severityBadge(assessment.severity)} ${assessment.description}`);
    });

    return `| ${title} | \`${loc}\` | ${providerCells.join(" | ")} |`;
  });

  return ["### Disagreements", "", header, separator, ...rows].join("\n");
}

/**
 * Render the provider-only section.
 *
 * @param {Map<string, Finding[]>} providerOnly
 * @returns {string}
 */
function renderProviderOnly(providerOnly) {
  const sections = [];

  for (const [providerName, findings] of providerOnly) {
    if (findings.length === 0) continue;

    const sorted = [...findings].sort((a, b) => compareSeverity(a.severity, b.severity));

    const items = sorted.map((f) => {
      const loc = locationStr(f.file, f.lineStart, f.lineEnd);
      const badge = severityBadge(f.severity);
      return [
        `- ${badge} **${f.title}**`,
        `  - **Location:** \`${loc}\``,
        `  - ${f.description}`,
      ].join("\n");
    });

    sections.push([`#### ${providerName}`, "", ...items].join("\n"));
  }

  if (sections.length === 0) return "";

  return ["### Provider-only findings", "", ...sections].join("\n\n");
}

/**
 * Render the verbose raw output section using collapsible HTML details blocks (R15).
 *
 * @param {Map<string, string>} rawOutputs
 * @returns {string}
 */
function renderVerbose(rawOutputs) {
  const blocks = [];

  for (const [providerName, raw] of rawOutputs) {
    blocks.push(
      [
        `<details>`,
        `<summary>Raw output: ${providerName}</summary>`,
        ``,
        "```",
        raw,
        "```",
        ``,
        `</details>`,
      ].join("\n")
    );
  }

  if (blocks.length === 0) return "";

  return ["### Raw provider output", "", ...blocks].join("\n\n");
}

// ─── Config header ──────────────────────────────────────────────────────────

/**
 * Render the resolved config as a single-line header (R15).
 * Shows active providers (from matchResult), model info, timeout, and disabled list.
 *
 * @param {import('./config.mjs').ResolvedConfig} config
 * @param {string[]} activeProviderNames - Providers that actually produced results.
 * @returns {string}
 */
function renderConfigHeader(config, activeProviderNames) {
  // Format each active provider name, adding model in parentheses for claude
  const providerParts = activeProviderNames.map((name) => {
    if (name === "claude" && config.providers.claude.model) {
      return `${name} (${config.providers.claude.model})`;
    }
    return name;
  });

  const segments = [`**Providers:** ${providerParts.join(", ")}`];
  segments.push(`**Timeout:** ${config.timeout}s`);

  // List disabled providers
  const disabled = Object.entries(config.providers)
    .filter(([, cfg]) => cfg.enabled === false)
    .map(([name]) => name);
  if (disabled.length > 0) {
    segments.push(`**Disabled:** ${disabled.join(", ")}`);
  }

  return segments.join(" | ");
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Options controlling report generation.
 *
 * @typedef {Object} ReportOptions
 * @property {boolean} [verbose] - When true, append raw provider output at the bottom.
 * @property {Map<string, string>} [rawOutputs] - Map from provider name → raw CLI output.
 *   Required when verbose is true to be useful.
 * @property {import('./config.mjs').ResolvedConfig} [config] - Resolved config for header display.
 */

/**
 * Generate the four-section Markdown disagreement report (R12).
 *
 * Sections included only when non-empty:
 *   - Summary stats (always included)
 *   - Consensus
 *   - Disagreements
 *   - Provider-only
 *   - Raw provider output (only when options.verbose is true)
 *
 * @param {MatchResult} matchResult
 * @param {Map<string, { reason: string, details?: string }>} providerFailures
 *   Providers that failed during this run (for informational display).
 * @param {ReportOptions} [options]
 * @returns {string} Markdown report string.
 */
export function generateReport(matchResult, providerFailures, options = {}) {
  const { consensus, disagreements, providerOnly } = matchResult;
  const providerNames = [...providerOnly.keys()];

  const totalFindings =
    consensus.length +
    disagreements.length +
    [...providerOnly.values()].reduce((s, f) => s + f.length, 0);

  // No findings at all from any provider.
  if (totalFindings === 0 && providerFailures.size === 0) {
    return ["## Devil's Advocate Review", "", "No issues found by any provider."].join("\n");
  }

  const parts = ["## Devil's Advocate Review", ""];

  // Config header (R15) — only when config is provided (backward compat).
  if (options.config) {
    parts.push(renderConfigHeader(options.config, providerNames));
    parts.push("");
  }

  // Summary stats.
  parts.push(renderSummary(matchResult, providerNames));
  parts.push("");

  // Provider failures notice.
  if (providerFailures.size > 0) {
    const failureLines = [...providerFailures.entries()].map(
      ([name, info]) => `- **${name}**: ${info.reason}${info.details ? ` — ${info.details}` : ""}`
    );
    parts.push("### Provider failures", "", ...failureLines, "");
  }

  // Consensus section.
  const consensusSection = renderConsensus(consensus);
  if (consensusSection) {
    parts.push(consensusSection, "");
  }

  // Disagreements section.
  const disagreementsSection = renderDisagreements(disagreements, providerNames);
  if (disagreementsSection) {
    parts.push(disagreementsSection, "");
  }

  // Provider-only section.
  const providerOnlySection = renderProviderOnly(providerOnly);
  if (providerOnlySection) {
    parts.push(providerOnlySection, "");
  }

  // Verbose raw output.
  if (options.verbose && options.rawOutputs && options.rawOutputs.size > 0) {
    const verboseSection = renderVerbose(options.rawOutputs);
    if (verboseSection) {
      parts.push(verboseSection, "");
    }
  }

  return parts.join("\n").trimEnd();
}
