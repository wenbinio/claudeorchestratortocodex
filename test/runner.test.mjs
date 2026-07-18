import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const FLEET_RUNNER = path.join(ROOT, "runner", "fleet-runner.mjs");
const MOCK_APP_SERVER = path.join(HERE, "mock-app-server.mjs");
const DRIVER_REPORT_KEYS = [
  "baseSha",
  "branch",
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
  "taskId",
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
  assert.deepEqual(Object.keys(report).sort(), DRIVER_REPORT_KEYS);
}

async function configureMockExecutable(t, repo) {
  if (process.platform !== "win32") {
    const originalMode = (await stat(MOCK_APP_SERVER)).mode & 0o777;
    await chmod(MOCK_APP_SERVER, 0o755);
    t.after(() => chmod(MOCK_APP_SERVER, originalMode).catch(() => {}));
    return MOCK_APP_SERVER;
  }

  // Native Windows spawn cannot execute a shebang .mjs directly. Node itself
  // is the executable and its mandatory `app-server` argv names this tiny
  // fixture-local trampoline, which imports the same mock module.
  const launcher = `import(${JSON.stringify(pathToFileURL(MOCK_APP_SERVER).href)});\n`;
  await writeFile(path.join(repo, "app-server"), launcher, "utf8");
  return process.execPath;
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

  const codexExe = await configureMockExecutable(t, repo);
  await git(repo, "init");
  await git(repo, "config", "user.name", "Codex Fleet Test");
  await git(repo, "config", "user.email", "codex-fleet-test@example.invalid");
  await git(repo, "add", "--", ".");
  await git(repo, "commit", "-m", "failing fixture");
  const baseSha = (await git(repo, "rev-parse", "HEAD")).stdout.trim();
  await git(repo, "branch", "codex/collision", baseSha);

  const batchPath = path.join(tempRoot, "batch.json");
  const verify = `${JSON.stringify(process.execPath)} --test fixture.test.mjs`;
  await writeFile(batchPath, JSON.stringify({
    repo: await realpath(repo),
    codexExe,
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

  const resultsPath = path.join(outDir, "results.json");
  assert.equal(await exists(resultsPath), true, "results.json should be written to the explicit outDir");
  assert.equal(isInside(repo, resultsPath), false, "run state must live outside the repository");
  assert.equal(await exists(path.join(repo, ".codex-fleet", "results.json")), false);

  const payload = JSON.parse(await readFile(resultsPath, "utf8"));
  assert.deepEqual(Object.keys(payload).sort(), ["approvedBranches", "results", "worktreeBase"]);
  assert.deepEqual(payload.approvedBranches, []);
  assert.equal(path.resolve(payload.worktreeBase), path.resolve(wtBase));
  assert.equal(payload.results.length, 2);
  for (const report of payload.results) assertFrozenReport(report);

  const repaired = payload.results.find((report) => report.taskId === "repair");
  assert.ok(repaired);
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

  const collision = payload.results.find((report) => report.taskId === "collision");
  assert.ok(collision);
  assert.equal(collision.status, "blocked");
  assert.equal(collision.branch, "codex/collision");
  assert.equal(collision.baseSha, baseSha);
  assert.equal(collision.commitSha, "");
  assert.match(collision.summary, /already exists/i);
});
