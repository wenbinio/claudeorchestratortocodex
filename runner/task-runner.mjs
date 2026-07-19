import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const TASK_ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const DEFAULT_TIMEOUT_MS = 600_000;
const GIT_TIMEOUT_MS = 60_000;
const GIT_OUTPUT_LIMIT = 32 * 1024 * 1024;
const VERIFY_OUTPUT_LIMIT = 128 * 1024;
const PROCESS_KILL_GRACE_MS = 2_000;
const APPENDED_CONSTRAINTS =
  "Work only inside this directory. Do not run git commands; do not commit. " +
  "Do not create documentation files unless the specification asks. When done, " +
  "summarize what you changed and why.";
const BUILD_DIRECTORY_NAMES = new Set([
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".import",
]);
const BUILD_FILE_RE = /(^|\/)(?:\.coverage(?:\..*)?|[^/]+\.(?:pyc|pyo))$/i;
const BUILD_PATH_RE = /(^|\/)(?:__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.import)(?:\/|$)/;

let worktreeAddTail = Promise.resolve();

export class GitCommandError extends Error {
  constructor(args, cwd, result, message) {
    super(message ?? `git ${args.join(" ")} failed with exit ${result.code ?? "unknown"}`);
    this.name = "GitCommandError";
    this.args = [...args];
    this.cwd = cwd;
    this.exitCode = result.code ?? null;
    this.signal = result.signal ?? null;
    this.timedOut = Boolean(result.timedOut);
    this.stdoutTail = result.stdout ?? "";
    this.stderrTail = result.stderr ?? "";
  }
}

export class RunnerInvariantError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RunnerInvariantError";
    this.code = code;
  }
}

class TailBuffer {
  constructor(limit) {
    this.limit = limit;
    this.buffer = Buffer.alloc(0);
    this.truncated = false;
  }

  push(chunk) {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, next]) : Buffer.from(next);
    if (this.buffer.length > this.limit) {
      this.truncated = true;
      this.buffer = this.buffer.subarray(this.buffer.length - this.limit);
    }
  }

  text() {
    return this.buffer.toString("utf8");
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
  outputLimit = GIT_OUTPUT_LIMIT,
  env,
} = {}) {
  const stdout = new TailBuffer(outputLimit);
  const stderr = new TailBuffer(outputLimit);
  const combined = new TailBuffer(outputLimit);
  const detached = process.platform !== "win32";
  let child;

  try {
    child = spawn(command, args, {
      cwd,
      env: env ?? { ...process.env, ...(cwd ? { PWD: cwd } : {}) },
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
      stderr: error?.message ?? String(error),
      combined: error?.message ?? String(error),
      stdoutTruncated: false,
      stderrTruncated: false,
    };
  }

  child.stdout?.on("data", (chunk) => { stdout.push(chunk); combined.push(chunk); });
  child.stderr?.on("data", (chunk) => { stderr.push(chunk); combined.push(chunk); });
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
    combined: combined.text(),
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
  };
}

async function rawGit(args, cwd) {
  return runProcess("git", args, { cwd, timeoutMs: GIT_TIMEOUT_MS, outputLimit: GIT_OUTPUT_LIMIT });
}

async function mustGit(args, cwd) {
  const result = await rawGit(args, cwd);
  if (result.error || result.timedOut || result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || result.error?.message || "no diagnostic output";
    throw new GitCommandError(args, cwd, result, `git ${args[0] ?? ""} failed: ${detail}`);
  }
  if (result.stdoutTruncated || result.stderrTruncated) {
    throw new GitCommandError(args, cwd, result, `git ${args[0] ?? ""} output exceeded the bounded capture limit`);
  }
  return {
    ...result,
    out: result.stdout.trim(),
    err: result.stderr.trim(),
  };
}

async function withWorktreeAddLock(callback) {
  const previous = worktreeAddTail;
  let release;
  worktreeAddTail = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    return await callback();
  } finally {
    release();
  }
}

function splitNul(text) {
  return text.split("\0").filter(Boolean);
}

function boundedLines(text, count = 60) {
  return text.split(/\r?\n/).filter(Boolean).slice(-count).join("\n");
}

function safeRelativePath(root, relativePath) {
  const normalized = String(relativePath).replaceAll("/", path.sep);
  const absolute = path.resolve(root, normalized);
  const relation = path.relative(path.resolve(root), absolute);
  if (relation && !relation.startsWith(`..${path.sep}`) && relation !== ".." && !path.isAbsolute(relation)) {
    return absolute;
  }
  throw new RunnerInvariantError("unsafe-path", `git reported a path outside the worktree: ${relativePath}`);
}

async function copySnapshotEntry(source, target, entry) {
  const stat = await fsp.lstat(source);
  entry.mode = stat.mode;
  if (stat.isSymbolicLink()) {
    entry.type = "symlink";
    entry.linkTarget = await fsp.readlink(source);
    return;
  }
  if (stat.isDirectory()) {
    entry.type = "directory";
    await fsp.cp(source, target, { recursive: true, dereference: false, force: true });
    return;
  }
  entry.type = "file";
  await fsp.copyFile(source, target);
}

async function snapshotWorkerDiff(worktree, baseCommit) {
  const trackedResult = await mustGit(["diff", "--name-only", "-z", baseCommit, "--"], worktree);
  const untrackedResult = await mustGit(["ls-files", "--others", "--exclude-standard", "-z", "--"], worktree);
  const paths = [...new Set([...splitNul(trackedResult.stdout), ...splitNul(untrackedResult.stdout)])].sort();
  const snapshotDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-fleet-diff-"));
  const entries = [];

  try {
    for (let index = 0; index < paths.length; index += 1) {
      const relativePath = paths[index];
      const source = safeRelativePath(worktree, relativePath);
      const target = path.join(snapshotDir, String(index));
      const entry = { path: relativePath, present: true, type: null, mode: null, linkTarget: null, snapshotPath: target };
      try {
        await copySnapshotEntry(source, target, entry);
      } catch (error) {
        if (error?.code === "ENOENT") entry.present = false;
        else throw error;
      }
      entries.push(entry);
    }
    return { snapshotDir, entries };
  } catch (error) {
    await fsp.rm(snapshotDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function restoreWorkerDiff(worktree, baseCommit, snapshot) {
  await mustGit(["reset", "--hard", baseCommit], worktree);
  await mustGit(["clean", "-ffdx"], worktree);

  for (const entry of snapshot.entries) {
    const destination = safeRelativePath(worktree, entry.path);
    if (!entry.present) {
      await fsp.rm(destination, { recursive: true, force: true });
      continue;
    }
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    if (entry.type === "symlink") {
      await fsp.rm(destination, { recursive: true, force: true });
      await fsp.symlink(entry.linkTarget, destination);
    } else if (entry.type === "directory") {
      await fsp.cp(entry.snapshotPath, destination, { recursive: true, dereference: false, force: true });
    } else {
      await fsp.copyFile(entry.snapshotPath, destination);
      if (entry.mode != null) await fsp.chmod(destination, entry.mode & 0o777).catch(() => {});
    }
  }
}

async function disposeSnapshot(snapshot) {
  if (snapshot?.snapshotDir) await fsp.rm(snapshot.snapshotDir, { recursive: true, force: true }).catch(() => {});
}

async function runVerify(command, cwd, timeoutMs) {
  const isWindows = process.platform === "win32";
  const shell = isWindows ? "powershell.exe" : "/bin/sh";
  const args = isWindows
    ? ["-NoProfile", "-NonInteractive", "-Command", command]
    : ["-c", command];
  const startedAt = Date.now();
  const result = await runProcess(shell, args, {
    cwd,
    timeoutMs,
    outputLimit: VERIFY_OUTPUT_LIMIT,
  });
  return {
    code: result.code ?? 1,
    timedOut: result.timedOut,
    durationMs: Date.now() - startedAt,
    tail: boundedLines(result.combined),
  };
}

async function purgeBuildArtifacts(worktree) {
  async function walk(directory) {
    let entries;
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        if (BUILD_DIRECTORY_NAMES.has(entry.name)) {
          await fsp.rm(absolute, { recursive: true, force: true });
        } else if (entry.name !== ".git") {
          await walk(absolute);
        }
      } else if (entry.isFile() && /\.(?:pyc|pyo)$/i.test(entry.name)) {
        await fsp.rm(absolute, { force: true });
      }
    }
  }
  await walk(worktree);
}

function isBuildStray(relativePath) {
  const portable = relativePath.replaceAll("\\", "/");
  return BUILD_PATH_RE.test(portable) || BUILD_FILE_RE.test(portable);
}

function chunks(values, size = 100) {
  const out = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
  return out;
}

async function stripStagedBuildStrays(worktree, baseCommit) {
  const stagedResult = await mustGit(["diff", "--cached", "--name-only", "-z", baseCommit, "--"], worktree);
  const strays = splitNul(stagedResult.stdout).filter(isBuildStray);
  if (!strays.length) return [];

  const baseFiles = new Set(splitNul((await mustGit(["ls-tree", "-r", "--name-only", "-z", baseCommit], worktree)).stdout));
  for (const group of chunks(strays)) {
    await mustGit(["reset", "-q", baseCommit, "--", ...group], worktree);
  }
  const tracked = strays.filter((file) => baseFiles.has(file));
  for (const group of chunks(tracked)) {
    await mustGit(["restore", `--source=${baseCommit}`, "--worktree", "--", ...group], worktree);
  }
  for (const file of strays.filter((candidate) => !baseFiles.has(candidate))) {
    await fsp.rm(safeRelativePath(worktree, file), { recursive: true, force: true });
  }
  return strays;
}

async function requireStagedDiff(worktree, baseCommit) {
  const check = await rawGit(["diff", "--cached", "--quiet", "--exit-code", baseCommit, "--"], worktree);
  if (check.error || check.timedOut || (check.code !== 0 && check.code !== 1)) {
    throw new GitCommandError(["diff", "--cached", "--quiet", "--exit-code", baseCommit, "--"], worktree, check);
  }
  if (check.code === 0) {
    throw new RunnerInvariantError("empty-staged-diff", "refusing to commit: staged diff is empty");
  }
}

async function assertWorkerBranchAtBase(worktree, branch, baseCommit) {
  const branchTip = (await mustGit(["rev-parse", "--verify", `refs/heads/${branch}^{commit}`], worktree)).out;
  if (branchTip !== baseCommit) {
    throw new RunnerInvariantError(
      "worker-ran-git",
      `worker branch moved from baseSha ${baseCommit} to ${branchTip}; workers may not create commits`,
    );
  }
}

function formatEvent(event) {
  switch (event?.type) {
    case "commandExecution":
      return `command exit=${event.exitCode ?? "unknown"}: ${String(event.command ?? "").replace(/\s+/g, " ").slice(0, 500)}`;
    case "fileChange":
      return `fileChange: ${(event.paths ?? []).join(", ") || "(no paths reported)"}`;
    case "agentMessage":
      return `agentMessage phase=${event.phase ?? "unknown"}: ${String(event.text ?? "").replace(/\s+/g, " ").slice(0, 500)}`;
    case "turn":
      return `turn status=${event.status ?? "unknown"}${event.reason ? ` reason=${event.reason}` : ""}`;
    case "protocolError":
      return `protocolError: ${String(event.line ?? "").slice(0, 500)}`;
    default:
      return null;
  }
}

async function writeTranscript(transcriptPath, { prompt, result, timeline, tokenUsage, usageNote }) {
  const timelineLines = timeline.length
    ? timeline.map((entry, index) => `${index + 1}. ${entry}`)
    : ["(no events captured)"];
  const markdown = [
    "# PROMPT",
    "",
    "```text",
    prompt,
    "```",
    "",
    "# TIMELINE",
    "",
    ...timelineLines,
    "",
    "# FINAL MESSAGE",
    "",
    result.codexFinalMessage || "(none)",
    "",
    "# USAGE",
    "",
    `- status: ${result.status}`,
    `- commandsRun: ${result.codexCommandsRun}`,
    `- filesPatched: ${result.filesPatched.join(", ") || "(none)"}`,
    `- tokens: ${tokenUsage.length ? JSON.stringify(tokenUsage) : "(not reported)"}`,
    `- sessionId: ${result.sessionId || "(not reported)"}`,
    `- verifyPassed: ${result.verifyPassed}`,
    `- unverified: ${result.unverified}`,
    usageNote ? `- note: ${usageNote}` : "",
    "",
    "# RESULT",
    "",
    result.summary || "(no summary)",
    "",
  ].join("\n");
  await fsp.mkdir(path.dirname(transcriptPath), { recursive: true });
  await fsp.writeFile(transcriptPath, `${markdown}\n`, "utf8");
}

function makeReport(taskId, branch, worktree, baseSha, transcriptPath) {
  return {
    taskId,
    status: "failed",
    branch,
    worktree,
    verifyPassed: false,
    unverified: false,
    correctionRoundUsed: false,
    filesChanged: [],
    diffStat: "",
    verifyTail: "",
    codexFinalMessage: "",
    codexCommandsRun: 0,
    filesPatched: [],
    sessionId: "",
    transcriptPath,
    summary: "",
    baseSha,
    commitSha: "",
  };
}

export async function runTask({
  repo,
  baseSha,
  task,
  verify,
  transport,
  wtBase,
  transcriptDir,
  timeoutMs,
} = {}) {
  const taskId = String(task?.id ?? "");
  const branch = TASK_ID_RE.test(taskId) ? `codex/${taskId}` : "";
  const repoPath = repo ? path.resolve(repo) : "";
  const worktreeBase = wtBase ? path.resolve(wtBase) : (repoPath ? `${repoPath}-codex-wt` : "");
  const worktree = branch ? path.join(worktreeBase, taskId) : "";
  const transcriptBase = transcriptDir ? path.resolve(transcriptDir) : worktreeBase;
  const transcriptPath = transcriptBase
    ? path.join(transcriptBase, `${TASK_ID_RE.test(taskId) ? taskId : "invalid-task"}.transcript.md`)
    : "";
  const report = makeReport(taskId, branch, worktree, String(baseSha ?? ""), transcriptPath);
  const prompt = `${String(task?.spec ?? "")}\n\n${APPENDED_CONSTRAINTS}`;
  const timeline = [];
  const tokenUsage = [];
  const filesPatched = new Set();
  let worker = null;
  let usageNote = "";

  function absorbTurn(label, outcome) {
    report.codexCommandsRun += Number(outcome?.commandsRun ?? 0);
    for (const file of outcome?.filesPatched ?? []) filesPatched.add(file);
    if (outcome?.finalMessage) report.codexFinalMessage = String(outcome.finalMessage).slice(0, 1500);
    if (outcome?.sessionId) report.sessionId = outcome.sessionId;
    if (outcome?.tokenUsage != null) tokenUsage.push({ turn: label, usage: outcome.tokenUsage });
    const events = Array.isArray(outcome?.events) ? outcome.events : [];
    if (events.length) {
      for (const event of events) {
        const formatted = formatEvent(event);
        if (formatted) timeline.push(`${label}: ${formatted}`);
      }
    } else {
      timeline.push(`${label}: turn status=${outcome?.status ?? "failed"}; commands=${outcome?.commandsRun ?? 0}`);
      for (const file of outcome?.filesPatched ?? []) timeline.push(`${label}: fileChange: ${file}`);
    }
  }

  try {
    if (!repoPath || !baseSha || !task || !TASK_ID_RE.test(taskId)) {
      report.status = "blocked";
      report.summary = !TASK_ID_RE.test(taskId) ? `invalid task id: ${JSON.stringify(taskId)}` : "runTask requires repo, baseSha, and task";
      return report;
    }
    if (!/^[0-9a-f]{7,64}$/i.test(String(baseSha))) {
      report.status = "blocked";
      report.summary = "baseSha must be a hexadecimal commit id";
      return report;
    }

    await fsp.mkdir(worktreeBase, { recursive: true });
    await fsp.mkdir(transcriptBase, { recursive: true });

    const inside = await rawGit(["rev-parse", "--is-inside-work-tree"], repoPath);
    if (inside.code !== 0 || inside.stdout.trim() !== "true") {
      report.status = "blocked";
      report.summary = "not a git worktree";
      return report;
    }

    const resolved = await mustGit(["rev-parse", "--verify", `${baseSha}^{commit}`], repoPath);
    const baseCommit = resolved.out;
    report.baseSha = baseCommit;

    await withWorktreeAddLock(async () => {
      const collision = await rawGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repoPath);
      if (collision.error || collision.timedOut || (collision.code !== 0 && collision.code !== 1)) {
        throw new GitCommandError(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repoPath, collision);
      }
      if (collision.code === 0) {
        throw new RunnerInvariantError("branch-collision", `branch ${branch} already exists; delete/integrate it or pick a new id`);
      }
      await mustGit(["worktree", "add", "-b", branch, worktree, String(baseSha)], repoPath);
    });

    worker = await transport;
    if (!worker || typeof worker.turn !== "function" || typeof worker.close !== "function") {
      throw new TypeError("transport must implement turn() and close()");
    }

    const turnTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    const implementation = await worker.turn(prompt, { timeoutMs: turnTimeout });
    absorbTurn("implementation", implementation);
    if (implementation?.status !== "completed") {
      report.summary = `implementation turn ${implementation?.status ?? "failed"}`;
      usageNote = "implementation did not complete; verification was not started";
      return report;
    }

    await assertWorkerBranchAtBase(worktree, branch, baseCommit);

    const inspected = await mustGit(["status", "--porcelain=v1", "-z"], worktree);
    if (!inspected.stdout) {
      report.summary = "Codex changed nothing";
      usageNote = "no-change terminal path";
      return report;
    }

    const verifySpec = task.verify ?? verify ?? "";
    const verifyCommand = typeof verifySpec === "string" ? verifySpec : String(verifySpec?.command ?? "");
    const configuredVerifyTimeout = typeof verifySpec === "object" ? verifySpec?.timeoutMs : task.verifyTimeoutMs;
    const verifyTimeout = Number.isFinite(configuredVerifyTimeout) && configuredVerifyTimeout > 0
      ? configuredVerifyTimeout
      : turnTimeout;

    if (!verifyCommand) {
      report.unverified = true;
      report.summary = "UNVERIFIED: no verify command configured; ";
      timeline.push("verify: skipped (no command configured)");
    } else {
      let snapshot = await snapshotWorkerDiff(worktree, baseCommit);
      let verification;
      try {
        verification = await runVerify(verifyCommand, worktree, verifyTimeout);
      } finally {
        try {
          await restoreWorkerDiff(worktree, baseCommit, snapshot);
        } finally {
          await disposeSnapshot(snapshot);
        }
      }
      report.verifyTail = verification.tail;
      timeline.push(`verify round 1: exit=${verification.code}; timedOut=${verification.timedOut}; durationMs=${verification.durationMs}`);

      if (verification.code === 0 && !verification.timedOut) {
        report.verifyPassed = true;
      } else {
        report.correctionRoundUsed = true;
        const correctionPrompt = `${prompt}\n\nA verification run failed. Fix the implementation without breaking the task. Failure output:\n${verification.tail}`;
        const correction = await worker.turn(correctionPrompt, { timeoutMs: turnTimeout });
        absorbTurn("correction", correction);
        if (correction?.status !== "completed") {
          report.summary = `correction turn ${correction?.status ?? "failed"}`;
          usageNote = "correction did not complete; a second verification was not started";
          return report;
        }

        await assertWorkerBranchAtBase(worktree, branch, baseCommit);

        const corrected = await mustGit(["status", "--porcelain=v1", "-z"], worktree);
        if (!corrected.stdout) {
          report.summary = "correction removed all task changes";
          return report;
        }

        snapshot = await snapshotWorkerDiff(worktree, baseCommit);
        try {
          verification = await runVerify(verifyCommand, worktree, verifyTimeout);
        } finally {
          try {
            await restoreWorkerDiff(worktree, baseCommit, snapshot);
          } finally {
            await disposeSnapshot(snapshot);
          }
        }
        report.verifyTail = verification.tail;
        report.verifyPassed = verification.code === 0 && !verification.timedOut;
        timeline.push(`verify round 2: exit=${verification.code}; timedOut=${verification.timedOut}; durationMs=${verification.durationMs}`);
      }
    }

    await purgeBuildArtifacts(worktree);
    await assertWorkerBranchAtBase(worktree, branch, baseCommit);
    await mustGit(["add", "-A", "--", "."], worktree);
    const stripped = await stripStagedBuildStrays(worktree, baseCommit);
    if (stripped.length) timeline.push(`strip build artifacts: ${stripped.join(", ")}`);
    await requireStagedDiff(worktree, baseCommit);

    const trailerValueRe = /^[A-Za-z0-9._:-]{1,128}$/;
    const commitMessageLines = [`${branch}: codex-fleet worker`];
    if (trailerValueRe.test(taskId)) commitMessageLines.push("", `Codex-Fleet-Task: ${taskId}`);
    if (trailerValueRe.test(report.sessionId)) commitMessageLines.push(`Codex-Session: ${report.sessionId}`);
    await mustGit(["commit", "-m", commitMessageLines.join("\n")], worktree);
    const commitSha = (await mustGit(["rev-parse", "--verify", `refs/heads/${branch}^{commit}`], worktree)).out;
    if (commitSha === baseCommit) {
      throw new RunnerInvariantError("commit-equals-base", "commit did not advance beyond baseSha");
    }
    const parentSha = (await mustGit(["rev-parse", "--verify", `${commitSha}^`], worktree)).out;
    if (parentSha !== baseCommit) {
      throw new RunnerInvariantError("unexpected-parent", `commit parent ${parentSha} does not equal baseSha ${baseCommit}`);
    }

    report.commitSha = commitSha;
    report.diffStat = (await mustGit(["show", "--stat", "--format=", commitSha, "--"], worktree)).out;
    report.filesChanged = splitNul((await mustGit(["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", commitSha], worktree)).stdout);
    report.status = report.verifyPassed || report.unverified ? "done" : "failed";
    report.summary += `status ${report.status}; verifyPassed=${report.verifyPassed}; commands=${report.codexCommandsRun}.`;
    return report;
  } catch (error) {
    if (error instanceof RunnerInvariantError && error.code === "branch-collision") {
      report.status = "blocked";
      report.summary = error.message;
    } else {
      report.status = "failed";
      report.summary = `runner error: ${error?.message ?? String(error)}`;
    }
    timeline.push(`${error?.name ?? "Error"}: ${error?.message ?? String(error)}`);
    return report;
  } finally {
    report.filesPatched = [...filesPatched];
    if (!worker && transport) {
      try {
        const candidate = await transport;
        if (candidate && typeof candidate.close === "function") worker = candidate;
      } catch {
        // A transport that never initialized has no live writer to close.
      }
    }
    if (worker) {
      try {
        await worker.close();
      } catch (error) {
        report.status = "failed";
        report.summary = `${report.summary}${report.summary ? "; " : ""}transport close failed: ${error?.message ?? String(error)}`;
        timeline.push(`transport close failed: ${error?.message ?? String(error)}`);
      }
    }
    if (transcriptPath) {
      try {
        await writeTranscript(transcriptPath, { prompt, result: report, timeline, tokenUsage, usageNote });
      } catch (error) {
        report.status = "failed";
        report.transcriptPath = "";
        report.summary = `${report.summary}${report.summary ? "; " : ""}transcript write failed: ${error?.message ?? String(error)}`;
      }
    }
  }
}
