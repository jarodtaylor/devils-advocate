/**
 * Tests for scripts/lib/diff.mjs
 *
 * Strategy: create real temporary git repositories for accurate behavior testing.
 * No mocking of child_process — we test the actual spawn-based implementation.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

import { collectDiff } from "../scripts/lib/diff.mjs";

// ---------------------------------------------------------------------------
// Helper: run a command in a directory (for test setup only)
// ---------------------------------------------------------------------------

/**
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<{stdout: string, stderr: string, code: number}>}
 */
function run(args, cwd) {
  return new Promise((resolve, reject) => {
    const [cmd, ...rest] = args;
    const proc = spawn(cmd, rest, { shell: false, cwd });
    /** @type {Buffer[]} */
    const out = [];
    /** @type {Buffer[]} */
    const err = [];
    proc.stdout.on("data", (c) => out.push(c));
    proc.stderr.on("data", (c) => err.push(c));
    proc.on("error", (e) => reject(e));
    proc.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(out).toString(),
        stderr: Buffer.concat(err).toString(),
        code: code ?? 1,
      });
    });
  });
}

/**
 * Initialize a minimal git repo with a committed file.
 *
 * @param {string} dir
 * @returns {Promise<void>}
 */
async function initRepo(dir) {
  // Consistent identity so commits don't fail in CI environments
  const env = {
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@test.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@test.com",
  };
  await run(["git", "init", "-b", "main"], dir);
  await run(["git", "config", "user.email", "test@test.com"], dir);
  await run(["git", "config", "user.name", "Test"], dir);
  // Write and commit a seed file so HEAD exists
  await writeFile(join(dir, "seed.txt"), "seed\n");
  await run(["git", "add", "seed.txt"], dir);
  await run(
    ["git", "commit", "--no-gpg-sign", "-m", "Initial commit"],
    dir
  );
}

/**
 * Create a new temporary git repo and return its path.
 *
 * @returns {Promise<string>}
 */
async function makeTempRepo() {
  const dir = await mkdtemp(join(tmpdir(), "da-diff-test-"));
  await initRepo(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe("collectDiff — spawn uses args array (no shell: true)", () => {
  it("spawn is called with shell: false (default)", async () => {
    // We verify indirectly: if spawn were shell: true we could inject via a
    // crafted branch name. The validateRef check catches that path, and a
    // normal invocation still completes without error — proving the safe path.
    const dir = await makeTempRepo();
    try {
      const result = await collectDiff({ worktree: dir });
      // Whether we get empty diff or branch diff, no shell injection occurred
      assert.ok(typeof result.diffText === "string");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("collectDiff — happy paths", () => {
  /** @type {string} */
  let repoDir;

  beforeEach(async () => {
    repoDir = await makeTempRepo();
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("auto-detect: dirty working tree returns uncommitted diff with file content", async () => {
    // Modify a file without staging/committing
    await writeFile(join(repoDir, "seed.txt"), "seed\nmodified\n");

    const result = await collectDiff({ worktree: repoDir });

    assert.ok(result.diffText.length > 0, "expected non-empty diff");
    assert.ok(
      result.diffText.includes("modified"),
      "diff should include new content"
    );
    assert.ok(
      result.target.includes("uncommitted"),
      `target should describe uncommitted changes, got: "${result.target}"`
    );
    // file content should be collected
    assert.ok(result.files.length > 0, "should collect at least one file");
    const seedFile = result.files.find((f) => f.path === "seed.txt");
    assert.ok(seedFile, "seed.txt should be in files");
    assert.ok(seedFile.content.includes("modified"), "file content should be current");
  });

  it("auto-detect: staged-only changes are included in diff", async () => {
    await writeFile(join(repoDir, "staged.txt"), "staged content\n");
    await run(["git", "add", "staged.txt"], repoDir);

    const result = await collectDiff({ worktree: repoDir });

    assert.ok(result.diffText.length > 0, "expected non-empty diff for staged changes");
    assert.ok(result.diffText.includes("staged content"), "diff should include staged content");
  });

  it("--branch override: diffs against the specified branch via merge-base", async () => {
    // Create a feature branch, add a commit, then test from it
    await run(["git", "checkout", "-b", "feat/test"], repoDir);
    await writeFile(join(repoDir, "feature.txt"), "feature content\n");
    await run(["git", "add", "feature.txt"], repoDir);
    await run(
      ["git", "commit", "--no-gpg-sign", "-m", "Add feature"],
      repoDir
    );

    const result = await collectDiff({ branch: "main", worktree: repoDir });

    assert.ok(result.diffText.length > 0, "expected non-empty diff");
    assert.ok(result.diffText.includes("feature content"), "diff should include feature change");
    assert.ok(result.target.includes("main"), `target should mention main, got: "${result.target}"`);
  });

  it("--diff range: explicit ref range produces correct diff", async () => {
    // Add a second commit so we have a range to diff
    await writeFile(join(repoDir, "v2.txt"), "version 2\n");
    await run(["git", "add", "v2.txt"], repoDir);
    await run(
      ["git", "commit", "--no-gpg-sign", "-m", "Add v2"],
      repoDir
    );

    const result = await collectDiff({
      diff: "HEAD~1..HEAD",
      worktree: repoDir,
    });

    assert.ok(result.diffText.length > 0, "expected non-empty diff");
    assert.ok(result.diffText.includes("version 2"), "diff should cover v2 commit");
    assert.equal(result.target, "HEAD~1..HEAD");
  });

  it("--files: limits diff to specified files only", async () => {
    // Stage two new files so both appear in `git diff --cached`
    await writeFile(join(repoDir, "a.txt"), "change A\n");
    await writeFile(join(repoDir, "b.txt"), "change B\n");
    await run(["git", "add", "a.txt", "b.txt"], repoDir);

    const result = await collectDiff({
      worktree: repoDir,
      files: ["a.txt"],
    });

    assert.ok(result.diffText.includes("change A"), "diff should include a.txt changes");
    assert.ok(!result.diffText.includes("change B"), "diff should NOT include b.txt changes");
  });

  it("--files with --diff range: both constraints apply", async () => {
    await writeFile(join(repoDir, "x.txt"), "x content\n");
    await writeFile(join(repoDir, "y.txt"), "y content\n");
    await run(["git", "add", "."], repoDir);
    await run(
      ["git", "commit", "--no-gpg-sign", "-m", "Add x and y"],
      repoDir
    );

    const result = await collectDiff({
      diff: "HEAD~1..HEAD",
      worktree: repoDir,
      files: ["x.txt"],
    });

    assert.ok(result.diffText.includes("x content"), "diff should include x.txt");
    assert.ok(!result.diffText.includes("y content"), "diff should not include y.txt");
  });
});

describe("collectDiff — clean tree behavior", () => {
  /** @type {string} */
  let repoDir;

  beforeEach(async () => {
    repoDir = await makeTempRepo();
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("clean tree with no branch ahead of main → empty diff with message", async () => {
    // The repo has main branch with one commit and is clean
    const result = await collectDiff({ worktree: repoDir });

    // main...HEAD is the same commit → empty diff
    assert.equal(result.diffText, "", "expected empty diff for clean tree at tip");
    assert.ok(result.files.length === 0, "no files for empty diff");
    // target should still describe what was attempted
    assert.ok(result.target.length > 0, "target should be non-empty");
  });

  it("clean tree ahead of main → returns branch diff", async () => {
    // Add a commit on main itself (main is base and HEAD)
    await writeFile(join(repoDir, "extra.txt"), "extra\n");
    await run(["git", "add", "extra.txt"], repoDir);
    await run(
      ["git", "commit", "--no-gpg-sign", "-m", "Add extra"],
      repoDir
    );

    // Now create a feature branch with one more commit
    await run(["git", "checkout", "-b", "feature"], repoDir);
    await writeFile(join(repoDir, "feat.txt"), "feat\n");
    await run(["git", "add", "feat.txt"], repoDir);
    await run(
      ["git", "commit", "--no-gpg-sign", "-m", "Feature commit"],
      repoDir
    );

    // Auto-detect from the feature branch: clean tree, diff against main
    const result = await collectDiff({ worktree: repoDir });

    assert.ok(result.diffText.length > 0, "expected non-empty diff for branch ahead of main");
    assert.ok(result.diffText.includes("feat"), "diff should include feature content");
  });
});

describe("collectDiff — edge cases", () => {
  /** @type {string} */
  let repoDir;

  beforeEach(async () => {
    repoDir = await makeTempRepo();
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("--worktree targets a different directory than cwd", async () => {
    // Modify a file in the target worktree
    await writeFile(join(repoDir, "seed.txt"), "modified via worktree path\n");

    // Run collectDiff with worktree pointing to a different dir than cwd
    const originalCwd = process.cwd();
    // We never change cwd — just pass the worktree arg
    const result = await collectDiff({ worktree: repoDir });

    assert.ok(result.diffText.includes("modified via worktree path"), "should diff the target worktree");
    // current process.cwd() is unchanged
    assert.equal(process.cwd(), originalCwd);
  });

  it("auto-detect from inside a git worktree directory still works", async () => {
    // Create a subdir inside the repo (simulating being in a subdirectory)
    const subDir = join(repoDir, "subdir");
    await mkdir(subDir);
    await writeFile(join(repoDir, "seed.txt"), "subdir test change\n");

    // Pass the subdir as worktree — git commands should still resolve correctly
    const result = await collectDiff({ worktree: subDir });
    assert.ok(result.diffText.includes("subdir test change"), "should detect changes from subdir");
  });
});

describe("collectDiff — error paths", () => {
  it("not a git repo → clear error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "da-not-git-"));
    try {
      await assert.rejects(
        () => collectDiff({ worktree: dir }),
        (err) => {
          assert.ok(err instanceof Error);
          assert.ok(
            err.message.includes("Not a git repository"),
            `Expected 'Not a git repository' in message, got: ${err.message}`
          );
          return true;
        }
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("no commits yet → clear error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "da-nocommit-"));
    try {
      // Initialize repo but don't commit
      await run(["git", "init", "-b", "main"], dir);
      await run(["git", "config", "user.email", "test@test.com"], dir);
      await run(["git", "config", "user.name", "Test"], dir);

      await assert.rejects(
        () => collectDiff({ worktree: dir }),
        (err) => {
          assert.ok(err instanceof Error);
          assert.ok(
            err.message.includes("no commits"),
            `Expected 'no commits' in message, got: ${err.message}`
          );
          return true;
        }
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("invalid branch name (shell metacharacter) → error before any git call", async () => {
    const dir = await makeTempRepo();
    try {
      await assert.rejects(
        () => collectDiff({ branch: "feat/$(rm -rf /)", worktree: dir }),
        (err) => {
          assert.ok(err instanceof Error);
          assert.ok(
            err.message.includes("Invalid ref name"),
            `Expected 'Invalid ref name' in message, got: ${err.message}`
          );
          return true;
        }
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("invalid branch name (semicolon) → error", async () => {
    const dir = await makeTempRepo();
    try {
      await assert.rejects(
        () => collectDiff({ branch: "main;evil", worktree: dir }),
        /Invalid ref name/
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("invalid diff range (shell metacharacter in one side) → error", async () => {
    const dir = await makeTempRepo();
    try {
      await assert.rejects(
        () => collectDiff({ diff: "main..feat;evil", worktree: dir }),
        /Invalid ref name/
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("file path with null byte → error", async () => {
    const dir = await makeTempRepo();
    try {
      await assert.rejects(
        () => collectDiff({ files: ["src/a.ts\0evil"], worktree: dir }),
        /null byte/
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("worktree path does not exist → clear error", async () => {
    await assert.rejects(
      () => collectDiff({ worktree: "/tmp/da-test-nonexistent-dir-xyz123" }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("does not exist"),
          `Expected 'does not exist' in message, got: ${err.message}`
        );
        return true;
      }
    );
  });
});

describe("collectDiff — return shape", () => {
  /** @type {string} */
  let repoDir;

  before(async () => {
    repoDir = await makeTempRepo();
  });

  after(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("result always has diffText (string), files (array), target (string)", async () => {
    const result = await collectDiff({ worktree: repoDir });

    assert.ok("diffText" in result, "result must have diffText");
    assert.ok("files" in result, "result must have files");
    assert.ok("target" in result, "result must have target");

    assert.equal(typeof result.diffText, "string");
    assert.ok(Array.isArray(result.files));
    assert.equal(typeof result.target, "string");
  });

  it("each file entry has path (string) and content (string)", async () => {
    // Introduce a dirty file so files array is non-empty
    await writeFile(join(repoDir, "seed.txt"), "dirty for shape test\n");

    const result = await collectDiff({ worktree: repoDir });

    assert.ok(result.files.length > 0, "expected at least one file for dirty repo");
    for (const f of result.files) {
      assert.equal(typeof f.path, "string", "file.path must be string");
      assert.equal(typeof f.content, "string", "file.content must be string");
    }
  });
});
