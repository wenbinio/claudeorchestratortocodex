import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const FLEET_RUNNER = path.join(ROOT, "runner", "fleet-runner.mjs");
const MOCK_APP_SERVER = path.join(HERE, "mock-app-server.mjs");
const DRIVER_REPORT_KEYS = [
  "baseSha",
  "branch",
  "cacheKey",
  "codexCommandsRun",
  "codexFinalMessage",
  "commitSha",
  "correctionRoundUsed",
  "diffStat",
  "filesChanged",
  "filesPatched",
  "sessionId",
  "status",
  "summary",
  "transcriptPath",
  "unverified",
  "verifyPassed",
  "verifyTail",
  "worktree",
].sort();

async function run(file, args, options = {}) {
  try {
    return await execFileAsync(file, args, {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      ...options,
    });
  } catch (error) {
    const detail = [error?.message, error?.stdout, error?.stderr].filter(Boolean).join("\n");
    throw new Error(`command failed: ${file} ${args.join(" ")}\n${detail}`, { cause: error });
  }
}

async function git(cwd, ...args) {
  return run("git", args, { cwd });
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isInside(parent, candidate) {
  const relation = path.relative(path.resolve(parent), path.resolve(candidate));
  return relation === "" || (!relation.startsWith(`..${path.sep}`) && relation !== ".." && !path.isAbsolute(relation));
}

function assertFrozenReport(report) {
  assert.deepEqual(Object.keys(report).sort(), ["driver", "review", "taskId"]);
  assert.deepEqual(Object.keys(report.driver).sort(), DRIVER_REPORT_KEYS);
  assert.equal(report.review, null);
}

function configureMockExecutable() {
  // Cross-platform: codexExe is node itself, and the transport's codexArgs
  // injection seam names the mock module as the script plus the app-server argv.
  // This avoids shebang/.cmd spawn limits and the worktree-vs-repo cwd trap of a
  // launcher file (an untracked repo file is absent from the clean worktree).
  return {
    codexExe: process.execPath,
    codexArgs: [MOCK_APP_SERVER, "app-server", "--listen", "stdio://"],
  };
}

test("fleet runner is hermetic, externalizes state, commits, and blocks collisions", { timeout: 90_000 }, async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-fleet-runner-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  const repo = path.join(tempRoot, "repo");
  const wtBase = path.join(tempRoot, "worktrees");
  const outDir = path.join(tempRoot, "run-output");
  await mkdir(repo, { recursive: true });

  await writeFile(
    path.join(repo, "fixture.test.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import { readFile } from "node:fs/promises";',
      'import test from "node:test";',
      "",
      'test("solution has been repaired", async () => {',
      '  assert.equal(await readFile(new URL("./solution.txt", import.meta.url), "utf8"), "fixed\\n");',
      "});",
      "",
    ].join("\n"),
    "utf8",
  );

  const { codexExe, codexArgs } = configureMockExecutable();
  await git(repo, "init");
  await git(repo, "config", "user.name", "Codex Fleet Test");
  await git(repo, "config", "user.email", "codex-fleet-test@example.invalid");
  await git(repo, "add", "--", ".");
  await git(repo, "commit", "-m", "failing fixture");
  const baseSha = (await git(repo, "rev-parse", "HEAD")).stdout.trim();
  await git(repo, "branch", "codex/collision", baseSha);

  const batchPath = path.join(tempRoot, "batch.json");
  // PowerShell needs the call operator `&` before a quoted executable path;
  // POSIX `sh -c` must NOT have it (`&` would background the command).
  const nodeQuoted = JSON.stringify(process.execPath);
  const verify = process.platform === "win32"
    ? `& ${nodeQuoted} --test fixture.test.mjs`
    : `${nodeQuoted} --test fixture.test.mjs`;
  await writeFile(batchPath, JSON.stringify({
    repo: await realpath(repo),
    codexExe,
    codexArgs,
    backend: "app-server",
    runId: "runner-test",
    outDir,
    wtBase,
    maxParallel: 1,
    timeoutMinutes: 1,
    tasks: [
      {
        id: "repair",
        spec: [
          "Repair the failing fixture by applying this deterministic mock program:",
          "```mock-file solution.txt",
          "fixed",
          "```",
        ].join("\n"),
        verify,
      },
      {
        id: "collision",
        spec: "This task must be blocked before a worker starts.",
        verify,
      },
    ],
  }, null, 2), "utf8");

  const fleet = await run(process.execPath, [FLEET_RUNNER, "--batch", batchPath], {
    cwd: ROOT,
    timeout: 75_000,
  });
  assert.match(fleet.stdout, /fleet-runner:/);
  assert.match(fleet.stderr, /\[fleet\] repair start/);
  assert.match(fleet.stderr, /\[fleet\] repair done/);
  assert.match(fleet.stderr, /\[fleet\] collision start/);
  assert.match(fleet.stderr, /\[fleet\] collision blocked/);

  const resultsPath = path.join(outDir, "results.json");
  assert.equal(await exists(resultsPath), true, "results.json should be written to the explicit outDir");
  assert.equal(isInside(repo, resultsPath), false, "run state must live outside the repository");
  assert.equal(await exists(path.join(repo, ".codex-fleet", "results.json")), false);

  const payload = JSON.parse(await readFile(resultsPath, "utf8"));
  assert.deepEqual(Object.keys(payload).sort(), ["approvedBranches", "complete", "outDir", "results", "runId", "worktreeBase"]);
  assert.deepEqual(payload.approvedBranches, []);
  assert.equal(payload.complete, true);
  assert.equal(path.resolve(payload.worktreeBase), path.resolve(wtBase));
  assert.equal(payload.results.length, 2);
  for (const report of payload.results) assertFrozenReport(report);

  const repairedResult = payload.results.find((report) => report.taskId === "repair");
  assert.ok(repairedResult);
  const repaired = repairedResult.driver;
  assert.equal(repaired.status, "done");
  assert.equal(repaired.branch, "codex/repair");
  assert.equal(repaired.verifyPassed, true);
  assert.equal(repaired.unverified, false);
  assert.equal(repaired.baseSha, baseSha);
  assert.match(repaired.commitSha, /^[0-9a-f]{40,64}$/i);
  assert.notEqual(repaired.commitSha, repaired.baseSha);
  assert.equal(path.resolve(repaired.worktree), path.resolve(wtBase, "repair"));
  assert.equal((await git(repaired.worktree, "branch", "--show-current")).stdout.trim(), "codex/repair");
  assert.equal((await git(repaired.worktree, "rev-parse", `${repaired.commitSha}^`)).stdout.trim(), baseSha);
  await git(repaired.worktree, "cat-file", "-e", `${repaired.commitSha}^{commit}`);
  assert.equal(await readFile(path.join(repaired.worktree, "solution.txt"), "utf8"), "fixed\n");

  assert.equal(isInside(repo, repaired.transcriptPath), false);
  assert.equal(await exists(repaired.transcriptPath), true);
  const transcript = await readFile(repaired.transcriptPath, "utf8");
  assert.match(transcript, /^# PROMPT$/m);
  assert.match(transcript, /^# TIMELINE$/m);
  assert.match(transcript, /^# FINAL MESSAGE$/m);
  assert.match(transcript, /^# USAGE$/m);
  assert.match(transcript, /Mock wrote solution\.txt\./);

  const collisionResult = payload.results.find((report) => report.taskId === "collision");
  assert.ok(collisionResult);
  const collision = collisionResult.driver;
  assert.equal(collision.status, "blocked");
  assert.equal(collision.branch, "codex/collision");
  assert.equal(collision.baseSha, baseSha);
  assert.equal(collision.commitSha, "");
  assert.match(collision.summary, /already exists/i);

  const keptCleanup = await run(process.execPath, [FLEET_RUNNER, "--cleanup", batchPath], { cwd: ROOT });
  const keptSummary = JSON.parse(keptCleanup.stdout);
  assert.equal(keptSummary.deleteBranches, false);
  assert.equal(keptSummary.pruned, true);
  assert.equal(await exists(path.join(wtBase, "repair")), false);
  assert.deepEqual(keptSummary.kept.branches.sort(), ["codex/collision", "codex/repair"]);
  assert.match((await git(repo, "branch", "--list", "codex/*")).stdout, /codex\/repair/);

  const deletedCleanup = await run(
    process.execPath,
    [FLEET_RUNNER, "--cleanup", batchPath, "--delete-branches"],
    { cwd: ROOT },
  );
  const deletedSummary = JSON.parse(deletedCleanup.stdout);
  assert.equal(deletedSummary.deleteBranches, true);
  assert.deepEqual(deletedSummary.removed.branches.sort(), ["codex/collision", "codex/repair"]);
  assert.equal((await git(repo, "branch", "--list", "codex/*")).stdout.trim(), "");
});

test("fleet runner --resume skips done tasks whose branch tip matches the cached commit", { timeout: 120_000 }, async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-fleet-resume-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  const repo = path.join(tempRoot, "repo");
  const wtBase = path.join(tempRoot, "worktrees");
  const outDir = path.join(tempRoot, "run-output");
  await mkdir(repo, { recursive: true });

  await writeFile(
    path.join(repo, "fixture.test.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import { readFile } from "node:fs/promises";',
      'import test from "node:test";',
      "",
      'test("solution has been repaired", async () => {',
      '  assert.equal(await readFile(new URL("./solution.txt", import.meta.url), "utf8"), "fixed\\n");',
      "});",
      "",
    ].join("\n"),
    "utf8",
  );

  const { codexExe, codexArgs } = configureMockExecutable();
  await git(repo, "init");
  await git(repo, "config", "user.name", "Codex Fleet Test");
  await git(repo, "config", "user.email", "codex-fleet-test@example.invalid");
  await git(repo, "add", "--", ".");
  await git(repo, "commit", "-m", "failing fixture");

  const batchPath = path.join(tempRoot, "batch.json");
  const nodeQuoted = JSON.stringify(process.execPath);
  const verify = process.platform === "win32"
    ? `& ${nodeQuoted} --test fixture.test.mjs`
    : `${nodeQuoted} --test fixture.test.mjs`;
  await writeFile(batchPath, JSON.stringify({
    repo: await realpath(repo),
    codexExe,
    codexArgs,
    backend: "app-server",
    runId: "resume-test",
    outDir,
    wtBase,
    maxParallel: 1,
    timeoutMinutes: 1,
    tasks: [{
      id: "repair",
      spec: [
        "Repair the failing fixture by applying this deterministic mock program:",
        "```mock-file solution.txt",
        "fixed",
        "```",
      ].join("\n"),
      verify,
    }],
  }, null, 2), "utf8");

  const first = await run(process.execPath, [FLEET_RUNNER, "--batch", batchPath], {
    cwd: ROOT,
    timeout: 75_000,
  });
  assert.match(first.stderr, /\[fleet\] repair done/);
  const resultsPath = path.join(outDir, "results.json");
  const firstPayload = JSON.parse(await readFile(resultsPath, "utf8"));
  const firstDriver = firstPayload.results.find((report) => report.taskId === "repair").driver;
  assert.equal(firstDriver.status, "done");
  assert.equal(firstDriver.resumedFromCache, undefined);

  const startedAt = Date.now();
  const resumed = await run(process.execPath, [FLEET_RUNNER, "--batch", batchPath, "--resume"], {
    cwd: ROOT,
    timeout: 30_000,
  });
  const resumeMs = Date.now() - startedAt;
  assert.match(resumed.stderr, /\[fleet\] repair skipped \(cached\)/);
  assert.doesNotMatch(resumed.stderr, /\[fleet\] repair start/);
  assert.match(resumed.stdout, /fleet-runner: 1\/1 done/);

  const resumedPayload = JSON.parse(await readFile(resultsPath, "utf8"));
  assert.equal(resumedPayload.complete, true);
  const resumedReport = resumedPayload.results.find((report) => report.taskId === "repair");
  assert.equal(resumedReport.driver.resumedFromCache, true);
  assert.equal(resumedReport.driver.status, "done");
  assert.equal(resumedReport.driver.commitSha, firstDriver.commitSha);
  assert.ok(resumeMs < 20_000, `resume with a fully cached task should be fast, took ${resumeMs}ms`);
});

test("fleet runner interrupts workers and preserves a partial result", {
  skip: process.platform === "win32" ? "Windows does not deliver child.kill(SIGINT) to a Node signal handler" : false,
  timeout: 45_000,
}, async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-fleet-interrupt-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  const repo = path.join(tempRoot, "repo");
  const wtBase = path.join(tempRoot, "worktrees");
  const outDir = path.join(tempRoot, "run-output");
  await mkdir(repo, { recursive: true });
  await writeFile(path.join(repo, "fixture.txt"), "base\n", "utf8");
  await git(repo, "init");
  await git(repo, "config", "user.name", "Codex Fleet Test");
  await git(repo, "config", "user.email", "codex-fleet-test@example.invalid");
  await git(repo, "add", "--", ".");
  await git(repo, "commit", "-m", "interrupt fixture");

  const { codexExe, codexArgs } = configureMockExecutable();
  const batchPath = path.join(tempRoot, "batch.json");
  await writeFile(batchPath, JSON.stringify({
    repo: await realpath(repo),
    codexExe,
    codexArgs,
    backend: "app-server",
    runId: "interrupt-test",
    outDir,
    wtBase,
    maxParallel: 1,
    timeoutMinutes: 1,
    tasks: [{
      id: "hold",
      spec: [
        "MOCK_WAIT_FOR_INTERRUPT",
        "```mock-file interrupted.txt",
        "waiting",
        "```",
      ].join("\n"),
    }],
  }, null, 2), "utf8");

  const child = spawn(process.execPath, [FLEET_RUNNER, "--batch", batchPath], {
    cwd: ROOT,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });

  const activeMarker = path.join(wtBase, "hold", "interrupted.txt");
  const activeDeadline = Date.now() + 15_000;
  while (!(await exists(activeMarker))) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`fleet runner exited before its worker became active\n${stdout}\n${stderr}`);
    }
    if (Date.now() >= activeDeadline) throw new Error(`timed out waiting for active worker\n${stderr}`);
    await delay(25);
  }

  assert.equal(child.kill("SIGINT"), true);
  const outcome = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for signal shutdown\n${stderr}`)), 15_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  assert.deepEqual(outcome, { code: 130, signal: null });
  assert.match(stderr, /\[fleet\] hold start/);
  assert.match(stderr, /\[fleet\] hold interrupted/);

  const payload = JSON.parse(await readFile(path.join(outDir, "results.json"), "utf8"));
  assert.equal(payload.complete, false);
  assert.equal(payload.results.length, 1);
  assertFrozenReport(payload.results[0]);
  assert.equal(payload.results[0].taskId, "hold");
  assert.equal(payload.results[0].driver.status, "interrupted");
  assert.match(payload.results[0].driver.summary, /SIGINT/);
});
