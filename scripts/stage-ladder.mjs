#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";

const OUTPUT_LIMIT = 4 * 1024 * 1024;
const BRANCH_PATTERN = /^codex\/[A-Za-z0-9._/-]+$/;

class TailBuffer {
  constructor(limit = OUTPUT_LIMIT) {
    this.limit = limit;
    this.buffer = Buffer.alloc(0);
    this.truncated = false;
  }

  push(chunk) {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.buffer = this.buffer.length
      ? Buffer.concat([this.buffer, next])
      : Buffer.from(next);
    if (this.buffer.length > this.limit) {
      this.truncated = true;
      this.buffer = this.buffer.subarray(this.buffer.length - this.limit);
    }
  }

  text() {
    return this.buffer.toString("utf8");
  }
}

class GitCommandError extends Error {
  constructor(args, result, message) {
    const detail = result.stderr.trim()
      || result.stdout.trim()
      || result.error?.message
      || `exit ${result.code ?? "unknown"}`;
    super(message ?? `git ${args[0] ?? ""} failed: ${detail}`);
    this.name = "GitCommandError";
    this.args = [...args];
    this.result = result;
  }
}

class HeadMovedError extends Error {
  constructor(expected, actual) {
    super(`HEAD moved externally: expected ${expected}, found ${actual}`);
    this.name = "HeadMovedError";
  }
}

function runProcess(command, args, { cwd, outputLimit = OUTPUT_LIMIT } = {}) {
  return new Promise((resolve) => {
    const stdout = new TailBuffer(outputLimit);
    const stderr = new TailBuffer(outputLimit);
    let child;
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve({
        ...result,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      });
    };

    try {
      child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...(cwd ? { PWD: cwd } : {}) },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish({ code: null, signal: null, error });
      return;
    }

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => finish({ code: null, signal: null, error }));
    child.once("close", (code, signal) => finish({ code, signal, error: null }));
  });
}

async function rawGit(args, cwd) {
  return runProcess("git", args, { cwd });
}

function assertUsableGitResult(args, result) {
  if (result.error || result.signal || result.stdoutTruncated || result.stderrTruncated) {
    const message = result.stdoutTruncated || result.stderrTruncated
      ? `git ${args[0] ?? ""} output exceeded the bounded capture limit`
      : undefined;
    throw new GitCommandError(args, result, message);
  }
}

async function mustGit(args, cwd) {
  const result = await rawGit(args, cwd);
  assertUsableGitResult(args, result);
  if (result.code !== 0) throw new GitCommandError(args, result);
  return {
    ...result,
    out: result.stdout.trim(),
    err: result.stderr.trim(),
  };
}

function parseArgs(argv) {
  const options = { repo: "", verify: "", branches: [], skipReverifySingle: false };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--skip-reverify-single") {
      options.skipReverifySingle = true;
      continue;
    }
    if (!["--repo", "--verify", "--branch"].includes(flag)) {
      throw new TypeError(`unknown argument: ${flag}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.includes("\0")) {
      throw new TypeError(`${flag} requires a value without NUL`);
    }
    index += 1;
    if (flag === "--repo") {
      if (options.repo) throw new TypeError("--repo may be specified only once");
      options.repo = value;
    } else if (flag === "--verify") {
      if (options.verify) throw new TypeError("--verify may be specified only once");
      options.verify = value;
    } else {
      options.branches.push(value);
    }
  }

  if (!options.repo) throw new TypeError("--repo is required");
  if (!options.verify) throw new TypeError("--verify is required");
  if (options.branches.length === 0) throw new TypeError("at least one --branch is required");
  if (new Set(options.branches).size !== options.branches.length) {
    throw new TypeError("--branch values must be unique");
  }
  for (const branch of options.branches) {
    if (!BRANCH_PATTERN.test(branch)) {
      throw new TypeError(`branch must be a codex/* branch: ${branch}`);
    }
  }

  return { ...options, repo: path.resolve(options.repo) };
}

function splitNul(value) {
  return value.split("\0").filter(Boolean);
}

async function assertHead(repo, expected) {
  const actual = (await mustGit(["rev-parse", "--verify", "HEAD^{commit}"], repo)).out;
  if (actual !== expected) throw new HeadMovedError(expected, actual);
}

async function runVerify(command, cwd) {
  const shell = process.platform === "win32" ? "powershell.exe" : "sh";
  const args = process.platform === "win32"
    ? ["-NoProfile", "-Command", command]
    : ["-c", command];
  const result = await runProcess(shell, args, { cwd });
  if (result.error) {
    throw new Error(`could not start verification shell: ${result.error.message}`);
  }
  return result;
}

function verificationReason(result) {
  const status = result.signal
    ? `signal ${result.signal}`
    : `exit ${result.code ?? "unknown"}`;
  const detail = result.stderr.trim() || result.stdout.trim();
  return `verification failed (${status})${detail ? `: ${detail}` : ""}`;
}

function parseWorktrees(output) {
  return output
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const entry = {};
      for (const line of block.split(/\r?\n/)) {
        const separator = line.indexOf(" ");
        if (separator !== -1) entry[line.slice(0, separator)] = line.slice(separator + 1);
      }
      return entry;
    })
    .filter((entry) => entry.worktree);
}

async function deleteIntegratedBranches(repo, branches) {
  for (const branch of branches) {
    const worktrees = parseWorktrees((await mustGit(["worktree", "list", "--porcelain"], repo)).stdout);
    const branchRef = `refs/heads/${branch}`;
    for (const worktree of worktrees.filter((entry) => entry.branch === branchRef)) {
      if (path.resolve(worktree.worktree) === repo) {
        throw new Error(`cannot delete the currently checked-out branch: ${branch}`);
      }
      await mustGit(["worktree", "remove", "--force", worktree.worktree], repo);
    }
    await mustGit(["branch", "-D", "--", branch], repo);
  }
}

async function runLadder({ repo, verify, branches, skipReverifySingle }, report) {
  const inside = await mustGit(["rev-parse", "--is-inside-work-tree"], repo);
  if (inside.out !== "true") throw new Error(`not a git worktree: ${repo}`);
  repo = path.resolve((await mustGit(["rev-parse", "--show-toplevel"], repo)).out);

  const status = await mustGit(["status", "--porcelain=v1", "-z"], repo);
  if (status.stdout) {
    throw new Error("working tree must be clean; refusing to stash or integrate changes");
  }

  const origSha = (await mustGit(["rev-parse", "--verify", "HEAD^{commit}"], repo)).out;
  report.origSha = origSha;

  for (const branch of branches) {
    await mustGit(["rev-parse", "--verify", `refs/heads/${branch}^{commit}`], repo);
  }

  let expectedHead = origSha;
  let rollbackRequired = true;

  try {
    for (const branch of branches) {
      await assertHead(repo, expectedHead);

      const squashArgs = ["merge", "--squash", branch];
      const squash = await rawGit(squashArgs, repo);
      assertUsableGitResult(squashArgs, squash);
      if (squash.code !== 0) {
        const conflicts = await mustGit(["ls-files", "-u", "-z"], repo);
        if (!conflicts.stdout) throw new GitCommandError(squashArgs, squash);

        await mustGit(["reset", "--hard", "HEAD"], repo);
        report.parked.push({ branch, reason: "squash conflict" });
        continue;
      }

      const id = branch.slice("codex/".length);
      await mustGit(["commit", "--no-gpg-sign", "-m", `fleet-stage: ${id}`], repo);
      const tempSha = (await mustGit(["rev-parse", "--verify", "HEAD^{commit}"], repo)).out;

      if (skipReverifySingle && branches.length === 1) {
        report.reverifySkipped = true;
      } else {
        const verification = await runVerify(verify, repo);
        await assertHead(repo, tempSha);

        if (verification.code !== 0 || verification.signal) {
          await mustGit(["reset", "--hard", "HEAD~1"], repo);
          report.parked.push({ branch, reason: verificationReason(verification) });
          continue;
        }
      }

      expectedHead = tempSha;
      report.integrated.push(branch);
    }

    await assertHead(repo, expectedHead);
    await mustGit(["reset", "--soft", origSha], repo);
    await deleteIntegratedBranches(repo, report.integrated);
    report.finalStagedFiles = splitNul(
      (await mustGit(["diff", "--cached", "--name-only", "-z", "--"], repo)).stdout,
    );
    rollbackRequired = false;
  } finally {
    if (rollbackRequired) {
      const recovery = await rawGit(["reset", "--hard", origSha], repo);
      if (recovery.error || recovery.code !== 0) {
        const detail = recovery.stderr.trim()
          || recovery.stdout.trim()
          || recovery.error?.message
          || "no diagnostic output";
        process.stderr.write(`stage-ladder recovery failed: ${detail}\n`);
      }
      report.integrated = [];
      report.finalStagedFiles = [];
      report.reverifySkipped = false;
    }
  }
}

const report = {
  integrated: [],
  parked: [],
  origSha: null,
  finalStagedFiles: [],
  reverifySkipped: false,
};

try {
  if (Number.parseInt(process.versions.node.split(".")[0], 10) < 18) {
    throw new Error("stage-ladder requires Node.js 18 or newer");
  }
  const options = parseArgs(process.argv.slice(2));
  await runLadder(options, report);
} catch (error) {
  process.stderr.write(`stage-ladder: ${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
} finally {
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
