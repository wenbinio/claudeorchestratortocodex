import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { writeVerdict } from "../scripts/verdict-store.mjs";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const GUARD = path.join(ROOT, "scripts", "merge-guard.ps1");

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

async function initializeRepo(repo) {
  await mkdir(repo, { recursive: true });
  await git(repo, "init");
  await git(repo, "config", "user.name", "Codex Fleet Guard Test");
  await git(repo, "config", "user.email", "codex-fleet-guard@example.invalid");
  await writeFile(path.join(repo, "base.txt"), "base\n", "utf8");
  await git(repo, "add", "--", ".");
  await git(repo, "commit", "-m", "base");
  return (await git(repo, "rev-parse", "HEAD")).stdout.trim();
}

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function mergeCommand(repo, branch, options = "") {
  return `git -C ${quotePowerShell(repo)} merge ${options ? `${options} ` : ""}${branch}`;
}

function runGuard({ command, cwd, dataDir }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", GUARD],
      {
        cwd,
        env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      if (!settled) {
        settled = true;
        reject(new Error("merge-guard.ps1 timed out"));
      }
    }, 20_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ code, signal, stdout, stderr });
      }
    });
    child.stdin.end(JSON.stringify({ tool_input: { command } }));
  });
}

test(
  "PowerShell merge guard verdict matrix",
  { skip: process.platform === "win32" ? false : "merge-guard.ps1 matrix runs only on Windows", timeout: 90_000 },
  async (t) => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-fleet-guard-"));
    t.after(() => rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

    const repo = path.join(tempRoot, "repo");
    const unknownRepo = path.join(tempRoot, "unknown-repo");
    const dataDir = path.join(tempRoot, "plugin-data");
    const approvedPath = path.join(dataDir, "approved.json");
    const sha = await initializeRepo(repo);
    const unknownSha = await initializeRepo(unknownRepo);
    const branches = ["codex/approved", "codex/needs-work", "codex/rejected", "codex/stale"];
    for (const branch of branches) await git(repo, "branch", branch, sha);
    await git(unknownRepo, "branch", "codex/unreviewed", unknownSha);

    const repoKey = (await realpath(path.join(repo, ".git"))).replaceAll("\\", "/");
    const common = { repoKey, driverVerifyPassed: true, reviewVerifyPassed: true, allowUnverified: false };
    await writeVerdict(approvedPath, { ...common, branch: "codex/approved", sha, reviewVerdict: "approve" });
    await writeVerdict(approvedPath, { ...common, branch: "codex/needs-work", sha, reviewVerdict: "needs_work" });
    await writeVerdict(approvedPath, { ...common, branch: "codex/rejected", sha, reviewVerdict: "reject" });
    await writeVerdict(approvedPath, {
      ...common,
      branch: "codex/stale",
      sha: "0".repeat(sha.length),
      reviewVerdict: "approve",
    });

    const matrix = [
      { label: "approved SHA match allows", command: mergeCommand(repo, "codex/approved"), expected: 0 },
      { label: "needs_work blocks", command: mergeCommand(repo, "codex/needs-work"), expected: 2 },
      { label: "reject blocks", command: mergeCommand(repo, "codex/rejected"), expected: 2 },
      { label: "stale SHA blocks", command: mergeCommand(repo, "codex/stale"), expected: 2 },
      {
        label: "--squash form is recognized and blocked",
        command: mergeCommand(repo, "codex/needs-work", "--squash"),
        expected: 2,
      },
      {
        label: "unknown repository allows",
        command: mergeCommand(unknownRepo, "codex/unreviewed"),
        expected: 0,
      },
    ];

    for (const entry of matrix) {
      const outcome = await runGuard({ command: entry.command, cwd: repo, dataDir });
      assert.equal(outcome.code, entry.expected, `${entry.label}: ${outcome.stderr}`);
      if (entry.expected === 2) assert.match(outcome.stderr, /Merge blocked/);
    }

    await writeFile(approvedPath, "{ corrupt verdict state\n", "utf8");
    const corrupt = await runGuard({ command: mergeCommand(repo, "codex/approved"), cwd: repo, dataDir });
    assert.equal(corrupt.code, 0, `corrupt state must fail open: ${corrupt.stderr}`);
  },
);
