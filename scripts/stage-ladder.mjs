#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const OUTPUT_LIMIT = 4 * 1024 * 1024;
const DEFAULT_VERIFY_TIMEOUT_MS = 15 * 60_000;
const PROCESS_KILL_GRACE_MS = 2_000;
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

function waitForExit(child) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.once("error", (error) => finish({ code: null, signal: null, error }));
    child.once("close", (code, signal) => finish({ code, signal, error: null }));
  });
}

async function runTaskkill(pid) {
  return new Promise((resolve) => {
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.once("error", () => resolve(false));
    killer.once("close", (code) => resolve(code === 0));
  });
}

async function killProcessTree(child, exitPromise) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return true;

  if (process.platform === "win32") {
    await runTaskkill(child.pid);
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      try { child.kill("SIGTERM"); } catch {}
    }
  }

  let stopped = await Promise.race([
    exitPromise.then(() => true),
    delay(PROCESS_KILL_GRACE_MS).then(() => false),
  ]);
  if (stopped) return true;

  if (process.platform === "win32") {
    await runTaskkill(child.pid);
    try { child.kill("SIGKILL"); } catch {}
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
  }
  stopped = await Promise.race([
    exitPromise.then(() => true),
    delay(PROCESS_KILL_GRACE_MS).then(() => false),
  ]);
  return stopped;
}

async function runProcess(command, args, {
  cwd,
  timeoutMs,
  outputLimit = OUTPUT_LIMIT,
} = {}) {
  const stdout = new TailBuffer(outputLimit);
  const stderr = new TailBuffer(outputLimit);
  const detached = process.platform !== "win32";
  let child;

  try {
    child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...(cwd ? { PWD: cwd } : {}) },
      detached,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return {
      code: null,
      signal: null,
      error,
      timedOut: false,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    };
  }

  child.stdout?.on("data", (chunk) => stdout.push(chunk));
  child.stderr?.on("data", (chunk) => stderr.push(chunk));
  const exitPromise = waitForExit(child);
  let timer;
  const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : null;
  const outcome = limit
    ? await Promise.race([
      exitPromise.then((value) => ({ kind: "exit", value })),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ kind: "timeout" }), limit); }),
    ])
    : { kind: "exit", value: await exitPromise };
  clearTimeout(timer);

  let timedOut = false;
  let exit = outcome.value;
  if (outcome.kind === "timeout") {
    timedOut = true;
    const stopped = await killProcessTree(child, exitPromise);
    if (!stopped) {
      const error = new Error(`process tree did not terminate: ${command}`);
      error.name = "ProcessTreeTerminationError";
      throw error;
    }
    exit = await exitPromise;
  }

  return {
    code: exit.code,
    signal: exit.signal,
    error: exit.error,
    timedOut,
    stdout: stdout.text(),
    stderr: stderr.text(),
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
  };
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
  const options = {
    repo: "",
    verify: "",
    verifyTimeoutMs: DEFAULT_VERIFY_TIMEOUT_MS,
    branches: [],
    skipReverifySingle: false,
  };
  let verifyTimeoutSpecified = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--skip-reverify-single") {
      options.skipReverifySingle = true;
      continue;
    }
    if (!["--repo", "--verify", "--verify-timeout-ms", "--branch"].includes(flag)) {
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
    } else if (flag === "--verify-timeout-ms") {
      if (verifyTimeoutSpecified) {
        throw new TypeError("--verify-timeout-ms may be specified only once");
      }
      const parsed = Number(value);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new TypeError("--verify-timeout-ms requires a positive integer");
      }
      options.verifyTimeoutMs = parsed;
      verifyTimeoutSpecified = true;
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

async function runVerify(command, cwd, timeoutMs) {
  const isWindows = process.platform === "win32";
  // Keep this verify shell invocation in lockstep across worker and ladder gates:
  // one user string must have identical semantics in both.
  const shell = isWindows ? "powershell.exe" : "/bin/sh";
  const args = isWindows
    ? ["-NoProfile", "-NonInteractive", "-Command", command]
    : ["-c", command];
  const result = await runProcess(shell, args, { cwd, timeoutMs });
  if (result.error) {
    throw new Error(`could not start verification shell: ${result.error.message}`);
  }
  return result;
}

function verificationReason(result) {
  if (result.timedOut) return "verify timed out";
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

async function runLadder({
  repo,
  verify,
  verifyTimeoutMs,
  branches,
  skipReverifySingle,
}, report) {
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
        const verification = await runVerify(verify, repo, verifyTimeoutMs);
        await assertHead(repo, tempSha);

        if (verification.timedOut || verification.code !== 0 || verification.signal) {
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
