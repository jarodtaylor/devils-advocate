/**
 * Diff Collector — computes the review target diff from git state or explicit overrides.
 *
 * @module diff
 */

import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { resolve, dirname } from "node:path";

/** Maximum file size before truncation (50 KB). */
const MAX_FILE_BYTES = 50 * 1024;

/** Lines of surrounding context to include around diff hunks for oversized files. */
const HUNK_CONTEXT_LINES = 100;

/**
 * Regex that matches characters not valid in a git branch/ref name.
 * Allows: alphanumerics, `/`, `-`, `_`, `.`, `@`, `+`, `~`, `^`, `:`
 * (The full git ref spec is more permissive but these cover every real branch name.)
 */
const INVALID_REF_RE = /[^a-zA-Z0-9/\-_.@+~^:]/;

// ---------------------------------------------------------------------------
// Shell-safe git runner
// ---------------------------------------------------------------------------

/**
 * Run a git command safely (no shell interpolation).
 *
 * @param {string[]} args - Git sub-command and arguments.
 * @param {{ cwd?: string, allowNonZero?: boolean }} [opts]
 * @returns {Promise<{stdout: string, stderr: string, code: number}>}
 */
function git(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn("git", args, {
      shell: false,
      cwd: opts.cwd ?? process.cwd(),
    });

    /** @type {Buffer[]} */
    const out = [];
    /** @type {Buffer[]} */
    const err = [];

    proc.stdout.on("data", (chunk) => out.push(chunk));
    proc.stderr.on("data", (chunk) => err.push(chunk));

    proc.on("error", (e) => reject(new Error(`git spawn failed: ${e.message}`)));

    proc.on("close", (code) => {
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");

      if (code !== 0 && !opts.allowNonZero) {
        const detail = stderr.trim() || stdout.trim();
        reject(new Error(`git ${args[0]} failed (exit ${code}): ${detail}`));
        return;
      }

      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Reject branch/ref names that contain shell metacharacters.
 *
 * @param {string} ref
 * @returns {void}
 */
function validateRef(ref) {
  if (INVALID_REF_RE.test(ref)) {
    throw new Error(
      `Invalid ref name "${ref}": contains disallowed characters. ` +
        `Use only alphanumerics, '/', '-', '_', '.', '@', '+', '~', '^', ':'`
    );
  }
}

// ---------------------------------------------------------------------------
// File content helpers
// ---------------------------------------------------------------------------

/**
 * Parse a unified diff for file paths that are being modified/added.
 * Returns the "b/" (post-patch) path for modifications, and the new path for additions.
 * Deleted files are skipped — they won't exist on disk to read.
 *
 * @param {string} diffText
 * @returns {string[]}
 */
function parseAffectedPaths(diffText) {
  /** @type {Set<string>} */
  const paths = new Set();
  let isDelete = false;

  for (const line of diffText.split("\n")) {
    if (line.startsWith("diff --git ")) {
      isDelete = false;
    }
    if (line.startsWith("deleted file mode")) {
      isDelete = true;
    }
    if (!isDelete && line.startsWith("+++ b/")) {
      const p = line.slice(6).trim();
      if (p && p !== "/dev/null") {
        paths.add(p);
      }
    }
  }

  return [...paths];
}

/**
 * Extract the line numbers touched in a diff hunk for a specific file.
 *
 * @param {string} diffText
 * @param {string} filePath - relative path (no "b/" prefix)
 * @returns {Array<{start: number, end: number}>}
 */
function extractHunkRanges(diffText, filePath) {
  /** @type {Array<{start: number, end: number}>} */
  const ranges = [];
  let inFile = false;

  for (const line of diffText.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inFile = line.includes(` b/${filePath}`);
    }
    if (inFile && line.startsWith("@@ ")) {
      // "@@ -old_start,old_len +new_start,new_len @@"
      const m = line.match(/\+(\d+)(?:,(\d+))?/);
      if (m) {
        const start = parseInt(m[1], 10);
        const len = m[2] !== undefined ? parseInt(m[2], 10) : 1;
        ranges.push({ start, end: start + Math.max(len - 1, 0) });
      }
    }
  }

  return ranges;
}

/**
 * Read a file, truncating to hunk regions + context if it exceeds MAX_FILE_BYTES.
 *
 * @param {string} absPath
 * @param {string} relPath - relative path for hunk lookup
 * @param {string} diffText
 * @returns {Promise<string>}
 */
async function readFileForContext(absPath, relPath, diffText) {
  let raw;
  try {
    raw = await readFile(absPath, "utf8");
  } catch {
    return ""; // file deleted or unreadable — skip silently
  }

  if (Buffer.byteLength(raw, "utf8") <= MAX_FILE_BYTES) {
    return raw;
  }

  // File too large — extract hunk regions + surrounding context
  const lines = raw.split("\n");
  const ranges = extractHunkRanges(diffText, relPath);

  if (ranges.length === 0) {
    // No hunks found — return a header and the first HUNK_CONTEXT_LINES lines
    return `// [truncated: file exceeds ${MAX_FILE_BYTES} bytes, no hunk ranges found]\n` +
      lines.slice(0, HUNK_CONTEXT_LINES).join("\n");
  }

  /** @type {Set<number>} */
  const keep = new Set();
  for (const { start, end } of ranges) {
    // 1-based line numbers → 0-based indices
    const lo = Math.max(0, start - 1 - HUNK_CONTEXT_LINES);
    const hi = Math.min(lines.length - 1, end - 1 + HUNK_CONTEXT_LINES);
    for (let i = lo; i <= hi; i++) {
      keep.add(i);
    }
  }

  const sorted = [...keep].sort((a, b) => a - b);
  const result = [];
  let prev = -1;
  for (const idx of sorted) {
    if (prev !== -1 && idx > prev + 1) {
      result.push(`// ... [${idx - prev - 1} lines omitted] ...`);
    }
    result.push(lines[idx]);
    prev = idx;
  }

  return `// [truncated: file exceeds ${MAX_FILE_BYTES} bytes, showing hunk regions + ${HUNK_CONTEXT_LINES} lines context]\n` +
    result.join("\n");
}

// ---------------------------------------------------------------------------
// Branch discovery
// ---------------------------------------------------------------------------

/**
 * Find the first existing base branch from the candidates list.
 *
 * @param {string} cwd
 * @returns {Promise<string|null>}
 */
async function findBaseBranch(cwd) {
  for (const branch of ["main", "master"]) {
    const { code } = await git(
      ["rev-parse", "--verify", branch],
      { cwd, allowNonZero: true }
    );
    if (code === 0) return branch;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Core diff strategies
// ---------------------------------------------------------------------------

/**
 * Get uncommitted (unstaged + staged) changes.
 *
 * @param {string} cwd
 * @param {string[]} extraArgs - e.g. `["--", "src/a.ts"]`
 * @returns {Promise<string>}
 */
async function uncommittedDiff(cwd, extraArgs = []) {
  const [unstaged, staged] = await Promise.all([
    git(["diff", ...extraArgs], { cwd }),
    git(["diff", "--cached", ...extraArgs], { cwd }),
  ]);
  return (unstaged.stdout + staged.stdout).trim();
}

/**
 * Get diff against a branch via merge-base.
 *
 * @param {string} cwd
 * @param {string} base
 * @param {string[]} extraArgs
 * @returns {Promise<string>}
 */
async function branchDiff(cwd, base, extraArgs = []) {
  const { stdout } = await git(
    ["diff", `${base}...HEAD`, ...extraArgs],
    { cwd }
  );
  return stdout.trim();
}

/**
 * Get diff for an explicit range like `main..HEAD` or `sha1..sha2`.
 *
 * @param {string} cwd
 * @param {string} range
 * @param {string[]} extraArgs
 * @returns {Promise<string>}
 */
async function explicitRangeDiff(cwd, range, extraArgs = []) {
  const { stdout } = await git(
    ["diff", range, ...extraArgs],
    { cwd }
  );
  return stdout.trim();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} DiffArgs
 * @property {string} [branch]   - Diff against this branch via merge-base.
 * @property {string} [worktree] - Run git commands in this directory.
 * @property {string} [diff]     - Explicit diff range (e.g. "main..HEAD").
 * @property {string[]} [files]  - Limit diff to these file paths.
 */

/**
 * @typedef {Object} FileContext
 * @property {string} path    - Repo-relative file path.
 * @property {string} content - Full or truncated file content.
 */

/**
 * @typedef {Object} DiffResult
 * @property {string} diffText       - Unified diff text.
 * @property {FileContext[]} files   - Affected file contents.
 * @property {string} target         - Human-readable description of what was diffed.
 */

/**
 * Collect the diff for the current review target.
 *
 * @param {DiffArgs} [args={}]
 * @returns {Promise<DiffResult>}
 */
export async function collectDiff(args = {}) {
  const { branch, worktree, diff: diffRange, files: limitFiles = [] } = args;

  // Validate all user-supplied refs up-front (before any git calls)
  if (branch) validateRef(branch);
  if (diffRange) {
    // A range like "main..HEAD" or "abc123..def456" — validate each side
    for (const part of diffRange.split(/\.{2,3}/)) {
      if (part) validateRef(part);
    }
  }
  if (limitFiles.length > 0) {
    for (const f of limitFiles) {
      if (f.includes("\0")) {
        throw new Error(`Invalid file path: null byte not allowed`);
      }
    }
  }

  // Resolve working directory
  let cwd = process.cwd();
  if (worktree) {
    // Verify the worktree path exists and is a git repo
    try {
      await stat(worktree);
    } catch {
      throw new Error(`Worktree path does not exist: ${worktree}`);
    }
    cwd = resolve(worktree);
  }

  // Verify we are inside a git repo
  try {
    await git(["rev-parse", "--show-toplevel"], { cwd });
  } catch {
    throw new Error(
      `Not a git repository (or any parent directory): ${cwd}`
    );
  }

  // Verify at least one commit exists
  const headCheck = await git(["rev-parse", "--verify", "HEAD"], {
    cwd,
    allowNonZero: true,
  });
  if (headCheck.code !== 0) {
    throw new Error(
      "Repository has no commits yet. Create an initial commit before running a review."
    );
  }

  // Build the "--" file-limiter suffix
  const fileSuffix =
    limitFiles.length > 0 ? ["--", ...limitFiles] : [];

  // Compute the diff text and target label
  let diffText = "";
  let target = "";

  if (diffRange) {
    // Explicit range wins over everything else
    diffText = await explicitRangeDiff(cwd, diffRange, fileSuffix);
    target = diffRange;
  } else if (branch) {
    // Explicit branch override
    diffText = await branchDiff(cwd, branch, fileSuffix);
    target = `${branch}...HEAD`;
  } else {
    // Auto-detect: check for dirty tree first
    const status = await git(["status", "--porcelain"], { cwd });
    const dirty = status.stdout.trim().length > 0;

    if (dirty) {
      diffText = await uncommittedDiff(cwd, fileSuffix);
      target = "working tree (uncommitted changes)";
    } else {
      // Clean tree — diff against base branch
      const base = await findBaseBranch(cwd);
      if (!base) {
        return {
          diffText: "",
          files: [],
          target: "no base branch found",
        };
      }
      diffText = await branchDiff(cwd, base, fileSuffix);
      target = `${base}...HEAD`;
    }
  }

  if (!diffText) {
    return {
      diffText: "",
      files: [],
      target: target || "no changes detected",
    };
  }

  // Resolve repo root so we can build absolute paths for file reads
  const toplevel = (
    await git(["rev-parse", "--show-toplevel"], { cwd })
  ).stdout.trim();

  // Collect affected file content
  const relativePaths = parseAffectedPaths(diffText);
  const fileContexts = await Promise.all(
    relativePaths.map(async (relPath) => {
      const absPath = resolve(toplevel, relPath);
      const content = await readFileForContext(absPath, relPath, diffText);
      return { path: relPath, content };
    })
  );

  return {
    diffText,
    files: fileContexts,
    target,
  };
}
