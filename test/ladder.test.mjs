import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const LADDER = path.join(ROOT, "scripts", "stage-ladder.mjs");

async function run(file, args, options = {}) {
  return execFileAsync(file, args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    ...options,
  });
}

async function git(cwd, ...args) {
  return run("git", args, { cwd });
}

async function commitFile(repo, branch, file, contents) {
  await git(repo, "checkout", "-b", branch);
  await writeFile(path.join(repo, file), contents, "utf8");
  await git(repo, "add", "--", file);
  await git(repo, "commit", "-m", branch);
}

test("stage ladder keeps verified changes staged and parks a red branch", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-fleet-ladder-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  const repo = path.join(tempRoot, "repo");
  await mkdir(repo, { recursive: true });
  await git(repo, "init");
  await git(repo, "config", "user.name", "Codex Fleet Ladder Test");
  await git(repo, "config", "user.email", "codex-fleet-ladder@example.invalid");
  await writeFile(path.join(repo, "base.txt"), "base\n", "utf8");
  await git(repo, "add", "--", "base.txt");
  await git(repo, "commit", "-m", "base");

  const baseBranch = (await git(repo, "branch", "--show-current")).stdout.trim();
  const origSha = (await git(repo, "rev-parse", "HEAD")).stdout.trim();
  const origCommitCount = (await git(repo, "rev-list", "--count", "HEAD")).stdout.trim();

  await commitFile(repo, "codex/good", "good.txt", "good\n");
  await git(repo, "checkout", baseBranch);
  await commitFile(repo, "codex/bad", "bad.txt", "bad\n");
  await git(repo, "checkout", baseBranch);

  const verify = process.platform === "win32"
    ? "if (Test-Path -LiteralPath 'bad.txt') { exit 1 }"
    : "test ! -e bad.txt";
  const outcome = await run(process.execPath, [
    LADDER,
    "--repo", repo,
    "--verify", verify,
    "--branch", "codex/good",
    "--branch", "codex/bad",
  ], { cwd: repo });
  const report = JSON.parse(outcome.stdout);

  assert.deepEqual(report.integrated, ["codex/good"]);
  assert.equal(report.parked.length, 1);
  assert.equal(report.parked[0].branch, "codex/bad");
  assert.match(report.parked[0].reason, /^verification failed \(exit 1\)/);
  assert.equal(report.origSha, origSha);
  assert.deepEqual(report.finalStagedFiles, ["good.txt"]);

  assert.equal((await git(repo, "rev-parse", "HEAD")).stdout.trim(), origSha);
  assert.equal((await git(repo, "rev-list", "--count", "HEAD")).stdout.trim(), origCommitCount);
  assert.deepEqual(
    (await git(repo, "diff", "--cached", "--name-only", "-z", "--")).stdout.split("\0").filter(Boolean),
    ["good.txt"],
  );
  await assert.rejects(git(repo, "show-ref", "--verify", "refs/heads/codex/good"));
  assert.equal(
    (await git(repo, "show-ref", "--verify", "refs/heads/codex/bad")).stdout.trim().endsWith(" refs/heads/codex/bad"),
    true,
  );
});
