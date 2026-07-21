import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, "..", "mcp", "fleet-mcp.mjs");

function frozenDriver(transcriptPath) {
  return {
    baseSha: "0".repeat(40),
    branch: "codex/example",
    cacheKey: "fixture-cache-key",
    codexCommandsRun: 1,
    codexFinalMessage: "done",
    commitSha: "1".repeat(40),
    correctionRoundUsed: false,
    diffStat: "1 file changed",
    filesChanged: ["example.txt"],
    filesPatched: ["example.txt"],
    sessionId: "fixture-session",
    status: "done",
    summary: "fixture complete",
    transcriptPath,
    unverified: false,
    verifyPassed: true,
    verifyTail: "ok",
    worktree: "fixture-worktree",
  };
}

function rpcClient(child) {
  let buffer = "";
  const messages = [];
  const waiters = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(message);
      else messages.push(message);
    }
  });

  return {
    request(payload) {
      child.stdin.write(`${JSON.stringify(payload)}\n`);
      if (messages.length) return Promise.resolve(messages.shift());
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    reject(error) {
      while (waiters.length) waiters.shift().reject(error);
    },
  };
}

test("MCP server lists runs and queues only non-terminal delegate steering", { timeout: 20_000 }, async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codex-fleet-mcp-"));
  const runId = "run-20260721T010203004Z";
  const runDir = path.join(dataDir, "runs", runId);
  const transcriptPath = path.join(runDir, "transcripts", "example.transcript.md");
  const activeDelegate = path.join(dataDir, "delegates", "active");
  const doneDelegate = path.join(dataDir, "delegates", "done");
  await Promise.all([
    mkdir(path.dirname(transcriptPath), { recursive: true }),
    mkdir(activeDelegate, { recursive: true }),
    mkdir(doneDelegate, { recursive: true }),
  ]);
  await writeFile(transcriptPath, "# fixture transcript\n", "utf8");
  await writeFile(path.join(runDir, "results.json"), JSON.stringify({
    runId,
    results: [{ taskId: "example", driver: frozenDriver(transcriptPath), review: null }],
    approvedBranches: [],
    worktreeBase: path.join(runDir, "worktrees"),
    outDir: runDir,
    complete: true,
  }, null, 2), "utf8");
  await writeFile(path.join(activeDelegate, "state.json"), JSON.stringify({ status: "awaiting-steer", turns: 1 }), "utf8");
  await writeFile(path.join(activeDelegate, "events.jsonl"), `${JSON.stringify({ type: "agentMessage", at: "2026-07-21T01:02:03.004Z", text: "Ready for direction" })}\n`, "utf8");
  await writeFile(path.join(doneDelegate, "state.json"), JSON.stringify({ status: "done", turns: 1 }), "utf8");

  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const rpc = rpcClient(child);
  child.once("error", (error) => rpc.reject(error));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const initialized = await rpc.request({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "fixture-version" } });
  assert.equal(initialized.result.protocolVersion, "fixture-version");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  const listed = await rpc.request({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  assert.equal(listed.result.tools.length, 6);

  const runs = await rpc.request({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "fleet_runs", arguments: {} } });
  assert.equal(runs.result.isError, false);
  assert.equal(JSON.parse(runs.result.content[0].text)[0].runId, runId);

  const steered = await rpc.request({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "delegate_steer", arguments: { runDir: activeDelegate, text: "Please add the edge case." } } });
  assert.equal(steered.result.isError, false);
  const inboxFiles = await readdir(path.join(activeDelegate, "steer.inbox"));
  assert.equal(inboxFiles.length, 1);
  assert.match(inboxFiles[0], /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[0-9a-f-]+\.json$/i);
  const queued = JSON.parse(await readFile(path.join(activeDelegate, "steer.inbox", inboxFiles[0]), "utf8"));
  assert.equal(queued.text, "Please add the edge case.");
  assert.equal(typeof queued.at, "string");

  const rejected = await rpc.request({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "delegate_steer", arguments: { runDir: doneDelegate, text: "Too late" } } });
  assert.equal(rejected.result.isError, true);
  assert.match(rejected.result.content[0].text, /run is done/);

  child.stdin.end();
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(exitCode, 0, stderr);
});
