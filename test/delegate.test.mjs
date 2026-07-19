import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DELEGATE = path.join(ROOT, "runner", "delegate.mjs");
const MOCK_APP_SERVER = path.join(HERE, "mock-app-server.mjs");

async function run(file, args, options = {}) {
  try {
    return await execFileAsync(file, args, {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      ...options,
    });
  } catch (error) {
    const detail = [error?.message, error?.stdout, error?.stderr].filter(Boolean).join("\n");
    throw new Error(`command failed: ${file} ${args.join(" ")}\n${detail}`, { cause: error });
  }
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function waitFor(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(20);
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ""}`);
}

function waitForExit(child, stderr, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => reject(new Error(`timed out waiting for delegate exit\n${stderr()}`)), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

test("delegate streams events, consumes steering, and reuses its warm thread", { timeout: 30_000 }, async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-fleet-delegate-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  const repo = path.join(tempRoot, "repo");
  const runDir = path.join(tempRoot, "delegate-run");
  await mkdir(repo, { recursive: true });
  await run("git", ["init"], { cwd: repo });

  const taskPath = path.join(tempRoot, "task.json");
  await writeFile(taskPath, JSON.stringify({
    repo,
    codexExe: process.execPath,
    codexArgs: [MOCK_APP_SERVER, "app-server", "--listen", "stdio://"],
    task: [
      "Apply the initial deterministic mock program:",
      "```mock-file initial.txt",
      "initial",
      "```",
    ].join("\n"),
    runDir,
  }, null, 2), "utf8");

  const child = spawn(process.execPath, [DELEGATE, "--start", taskPath], {
    cwd: ROOT,
    env: {
      ...process.env,
      DELEGATE_IDLE_TIMEOUT_MS: "1200",
      DELEGATE_POLL_MS: "20",
    },
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

  const eventsPath = path.join(runDir, "events.jsonl");
  const initialEventSize = await waitFor(async () => {
    if (!(await exists(eventsPath))) return 0;
    const size = (await stat(eventsPath)).size;
    return size > 0 ? size : 0;
  }, "events.jsonl did not grow while delegate was active");
  assert.equal(child.exitCode, null, "events must be observable before the owner process exits");

  const awaiting = await waitFor(async () => {
    const state = await readJson(path.join(runDir, "state.json"));
    return state.status === "awaiting-steer" ? state : null;
  }, "delegate did not settle into awaiting-steer");
  assert.equal(awaiting.turns, 1);
  assert.match(await readFile(path.join(repo, "initial.txt"), "utf8"), /^initial\n$/);

  const steeringText = [
    "Apply this follow-up on the same thread:",
    "```mock-file follow-up.txt",
    "steered",
    "```",
  ].join("\n");
  const acknowledgement = await run(process.execPath, [DELEGATE, "--steer", runDir, steeringText], { cwd: ROOT });
  assert.equal(JSON.parse(acknowledgement.stdout).action, "steer");

  await waitFor(async () => {
    const state = await readJson(path.join(runDir, "state.json"));
    if (state.turns < 2) return false;
    const events = (await readFile(eventsPath, "utf8")).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
    return events.filter((event) => event.type === "turn").length >= 2;
  }, "steered follow-up turn did not complete");
  assert.match(await readFile(path.join(repo, "follow-up.txt"), "utf8"), /^steered\n$/);

  await waitFor(async () => {
    const inboxPath = path.join(runDir, "steer.inbox");
    return !(await exists(inboxPath)) || (await readdir(inboxPath)).length === 0;
  }, "steer inbox message was not consumed");

  const statusResult = await run(process.execPath, [DELEGATE, "--status", runDir], { cwd: ROOT });
  const liveStatus = JSON.parse(statusResult.stdout);
  assert.equal(liveStatus.threadId, awaiting.threadId);
  assert.equal(liveStatus.turns, 2);

  const outcome = await waitForExit(child, () => `${stdout}\n${stderr}`, 10_000);
  assert.deepEqual(outcome, { code: 0, signal: null });
  const finalState = await readJson(path.join(runDir, "state.json"));
  assert.equal(finalState.status, "done");
  assert.equal(finalState.turns, 2);

  const finalEventSize = (await stat(eventsPath)).size;
  assert.ok(finalEventSize > initialEventSize, "events.jsonl should grow incrementally over the run");
  const events = (await readFile(eventsPath, "utf8")).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const turns = events.filter((event) => event.type === "turn");
  assert.equal(turns.length, 2);
  assert.equal(new Set(turns.map((event) => event.threadId)).size, 1);
  assert.equal(events.at(-1).type, "delegate-summary");
});

test("--steer rejects a completed run", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-fleet-delegate-terminal-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  const runDir = path.join(tempRoot, "delegate-run");
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "state.json"), `${JSON.stringify({ status: "done" })}\n`, "utf8");

  let rejection;
  try {
    await execFileAsync(process.execPath, [DELEGATE, "--steer", runDir, "too late"], {
      cwd: ROOT,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.fail("--steer unexpectedly accepted a completed run");
  } catch (error) {
    rejection = error;
  }

  assert.equal(rejection.code, 3);
  assert.deepEqual(JSON.parse(rejection.stdout), { ok: false, reason: "run is done" });
  assert.equal(await exists(path.join(runDir, "steer.inbox")), false);
});
