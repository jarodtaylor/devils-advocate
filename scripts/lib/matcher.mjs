/**
 * @file Finding matcher — groups provider findings into consensus, disagreements,
 * and provider-only buckets based on file path and line-range overlap (R13).
 */

/** @typedef {import('./types.mjs').Finding} Finding */

/**
 * A finding that multiple providers agreed on (same file, overlapping lines, same severity).
 *
 * @typedef {Object} ConsensusFinding
 * @property {Finding} finding - Representative finding (from the first matched provider).
 * @property {string[]} providers - Names of all providers that reported this finding.
 * @property {string} severity - Agreed severity value.
 */

/**
 * A location where providers reported findings but disagreed on severity.
 *
 * @typedef {Object} DisagreementFinding
 * @property {string} file - The file path where the disagreement occurs.
 * @property {number} lineStart - Earliest lineStart among the matched findings.
 * @property {number} lineEnd - Latest lineEnd among the matched findings.
 * @property {Map<string, Finding>} assessments - Each provider's finding at this location.
 */

/**
 * Result of matching provider findings.
 *
 * @typedef {Object} MatchResult
 * @property {ConsensusFinding[]} consensus - Findings all providers agree on (location + severity).
 * @property {DisagreementFinding[]} disagreements - Findings where providers disagree on severity.
 * @property {Map<string, Finding[]>} providerOnly - Findings with no match in any other provider.
 */

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Return true when two line ranges overlap (inclusive boundaries).
 * Touching ranges (e.g. 10-15 and 15-20) count as overlapping.
 *
 * @param {number} aStart
 * @param {number} aEnd
 * @param {number} bStart
 * @param {number} bEnd
 * @returns {boolean}
 */
function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd;
}

/**
 * Return true when a finding has valid line numbers (both present and >= 1).
 *
 * @param {Finding} f
 * @returns {boolean}
 */
function hasLineNumbers(f) {
  return (
    typeof f.lineStart === "number" &&
    typeof f.lineEnd === "number" &&
    f.lineStart >= 1 &&
    f.lineEnd >= 1
  );
}

// ─── Core Matcher ────────────────────────────────────────────────────────────

/**
 * Match findings across N providers.
 *
 * Two findings match when:
 *   1. Same file path (exact string equality)
 *   2. Both have line numbers
 *   3. Their line ranges overlap: `a.lineStart <= b.lineEnd && b.lineStart <= a.lineEnd`
 *
 * Matched findings are classified as:
 *   - consensus  — every provider that reported at this location agrees on severity
 *   - disagreements — at least two providers disagree on severity at the same location
 *
 * Unmatched findings (no counterpart in any other provider, or no line numbers) are
 * placed in providerOnly.
 *
 * V1 note: findings without line numbers are always treated as provider-only
 * (no fallback matching to keep the implementation simple).
 *
 * @param {Map<string, { findings: Finding[] }>} providerResults
 *   Map from provider name → its validated review result.
 * @returns {MatchResult}
 */
export function matchFindings(providerResults) {
  const providerNames = [...providerResults.keys()];

  /** @type {ConsensusFinding[]} */
  const consensus = [];

  /** @type {DisagreementFinding[]} */
  const disagreements = [];

  /** @type {Map<string, Finding[]>} */
  const providerOnly = new Map();

  for (const name of providerNames) {
    providerOnly.set(name, []);
  }

  // Early-exit: no providers or single provider — everything is provider-only.
  if (providerNames.length < 2) {
    for (const name of providerNames) {
      const result = providerResults.get(name);
      if (result) {
        providerOnly.set(name, [...result.findings]);
      }
    }
    return { consensus, disagreements, providerOnly };
  }

  // For each finding in each provider we track whether it has been matched.
  // We use a parallel boolean array indexed alongside the findings arrays.
  /** @type {Map<string, boolean[]>} */
  const matched = new Map();
  for (const name of providerNames) {
    const result = providerResults.get(name);
    matched.set(name, result ? result.findings.map(() => false) : []);
  }

  // Compare every pair of providers (A vs B). For N providers this is O(n^2)
  // which is fine for the 2-3 providers expected in V1.
  for (let i = 0; i < providerNames.length; i++) {
    const nameA = providerNames[i];
    const findingsA = providerResults.get(nameA)?.findings ?? [];
    const matchedA = /** @type {boolean[]} */ (matched.get(nameA) ?? []);

    for (let j = i + 1; j < providerNames.length; j++) {
      const nameB = providerNames[j];
      const findingsB = providerResults.get(nameB)?.findings ?? [];
      const matchedB = /** @type {boolean[]} */ (matched.get(nameB) ?? []);

      for (let ai = 0; ai < findingsA.length; ai++) {
        const fa = findingsA[ai];
        if (!hasLineNumbers(fa)) continue;

        for (let bi = 0; bi < findingsB.length; bi++) {
          const fb = findingsB[bi];
          if (!hasLineNumbers(fb)) continue;

          // Must be the same file.
          if (fa.file !== fb.file) continue;

          // Must have overlapping line ranges.
          if (!rangesOverlap(fa.lineStart, fa.lineEnd, fb.lineStart, fb.lineEnd)) continue;

          // We have a location match — classify by severity agreement.
          matchedA[ai] = true;
          matchedB[bi] = true;

          if (fa.severity === fb.severity) {
            // Check whether fa is already part of an existing consensus group.
            const existing = consensus.find(
              (c) =>
                c.finding.file === fa.file &&
                rangesOverlap(c.finding.lineStart, c.finding.lineEnd, fa.lineStart, fa.lineEnd) &&
                c.severity === fa.severity
            );
            if (existing) {
              if (!existing.providers.includes(nameA)) existing.providers.push(nameA);
              if (!existing.providers.includes(nameB)) existing.providers.push(nameB);
            } else {
              consensus.push({
                finding: fa,
                providers: [nameA, nameB],
                severity: fa.severity,
              });
            }
          } else {
            // Different severity — disagreement.
            const existing = disagreements.find(
              (d) =>
                d.file === fa.file &&
                rangesOverlap(d.lineStart, d.lineEnd, fa.lineStart, fa.lineEnd)
            );
            if (existing) {
              if (!existing.assessments.has(nameA)) existing.assessments.set(nameA, fa);
              if (!existing.assessments.has(nameB)) existing.assessments.set(nameB, fb);
              // Expand the range to encompass both findings.
              existing.lineStart = Math.min(existing.lineStart, fa.lineStart, fb.lineStart);
              existing.lineEnd = Math.max(existing.lineEnd, fa.lineEnd, fb.lineEnd);
            } else {
              const assessments = new Map();
              assessments.set(nameA, fa);
              assessments.set(nameB, fb);
              disagreements.push({
                file: fa.file,
                lineStart: Math.min(fa.lineStart, fb.lineStart),
                lineEnd: Math.max(fa.lineEnd, fb.lineEnd),
                assessments,
              });
            }
          }
        }
      }
    }
  }

  // Anything not matched goes into provider-only.
  for (const name of providerNames) {
    const findings = providerResults.get(name)?.findings ?? [];
    const matchedFlags = matched.get(name) ?? [];
    const unmatched = findings.filter((_, idx) => !matchedFlags[idx]);
    providerOnly.set(name, unmatched);
  }

  return { consensus, disagreements, providerOnly };
}
