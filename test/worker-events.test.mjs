import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { createWorker as createExecWorker } from "../runner/transports/exec.mjs";
import { createWorker as createAppWorker } from "../runner/transports/app-server.mjs";
import { classifySandboxFailure } from "../runner/sandbox-failure.mjs";
import { runSetupSmoke } from "../runner/setup-smoke.mjs";
import { parseArgs, probe, validateBatch } from "../runner/fleet-runner.mjs";
import { readTask, runDelegate } from "../runner/delegate.mjs";
import { workerIsolationArgs } from "../runner/codex-flags.mjs";

const ERROR = "Failed to create unified exec process: helper_unknown_error: setup refresh had errors";

// Replay protocol frames in memory as well as testing the executable fixtures.
// This exercises collectors even in environments that forbid child processes.
async function replaySpawn(t, { failed = false, hold = false, chatOnly = false } = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "codex-fleet-replay-"));
  const calls = [];
  const requests = [];
  const children = new Map();
  const original = childProcess.spawn;
  const originalKill = process.kill;
  let nextPid = 1_000_000;
  childProcess.spawn = (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      pid: nextPid++, exitCode: null, signalCode: null });
    const stop = () => {
      if (child.exitCode !== null) return;
      child.exitCode = 0;
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
    };
    child.kill = () => { stop(); return true; };
    children.set(child.pid, child);
    const send = (frame) => child.stdout.write(`${JSON.stringify(frame)}\n`);
    if (command === "taskkill.exe") {
      queueMicrotask(() => { children.get(Number(args[1]))?.kill(); stop(); });
    } else if (command === "git") {
      // Delegate's driver status query is mocked too; no git is executed.
      queueMicrotask(stop);
    } else if (args.includes("app-server")) {
      child.stdin.on("data", (data) => {
        for (const line of data.toString().trim().split("\n")) {
          const { id, method, params = {} } = JSON.parse(line);
          requests.push({ method, params });
          const reply = (result) => send({ id, result });
          queueMicrotask(() => {
            if (method === "initialize") reply({});
            if (method === "model/list") reply({ data: [{ id: "test-model" }] });
            if (method === "thread/start") reply({ thread: { id: "replay-thread" } });
            if (method === "turn/start") {
              const token = /FLEET_SHELL_[a-zA-Z0-9_]+/.exec(params.input?.[0]?.text ?? "")?.[0] ?? "token";
              reply({ turn: { id: "replay-turn" } });
              if (!chatOnly) send({ method: "item/completed", params: { threadId: "replay-thread", turnId: "replay-turn", item: {
                type: "commandExecution", id: "command", command: "echo token", exitCode: failed ? null : 0,
                aggregatedOutput: failed ? ERROR : `${token}\n`,
              } } });
              send({ method: "item/completed", params: { threadId: "replay-thread", turnId: "replay-turn",
                item: { type: "agentMessage", id: "answer", text: token, phase: "final_answer" } } });
              // Arrives before the vendored waiter's registration: test replay.
              send({ method: "turn/completed", params: { threadId: "replay-thread",
                turn: { id: "replay-turn", status: "completed" } } });
            }
          });
        }
      });
    } else {
      child.stdin.resume();
      child.stdin.on("end", () => {
        send({ type: "thread.started", thread_id: "replay-session" });
        send({ type: "item.completed", item: failed
          ? { type: "tool_result", tool: "exec_command", error: { message: ERROR } }
          : { type: "command_execution", id: "command", command: "echo token", exit_code: 0, aggregated_output: "token\n" } });
        if (hold && !args.includes("resume")) return;
        send({ type: "item.completed", item: { type: "agent_message", id: "answer", phase: "final_answer", text: "token" } });
        send({ type: "turn.completed" });
        stop();
      });
    }
    return child;
  };
  syncBuiltinESMExports();
  process.kill = (pid, signal) => {
    const child = children.get(Math.abs(pid));
    if (!child) throw new Error("unknown replay PID");
    return child.kill(signal);
  };
  t.after(async () => {
    childProcess.spawn = original;
    process.kill = originalKill;
    syncBuiltinESMExports();
    await rm(cwd, { recursive: true, force: true });
  });
  return { cwd, calls, requests };
}

test("canned event stream classifies sandbox failure despite completed conversation", () => {
  const events = [{ type: "item.completed", item: { type: "tool_result", tool: "exec_command",
    error: { message: `CreateProcess rejected: ${ERROR}` } } }, { type: "turn.completed" }];
  const result = classifySandboxFailure({ status: "completed" }, events);
  assert.equal(result.status, "failed");
  assert.equal(result.failureReason, "sandbox_setup_failed");
  assert.match(result.remedy, /isolation.*close the Codex desktop app.*windowsSandbox: "unelevated"/);
  assert.deepEqual(classifySandboxFailure({ status: "failed" }, ["ordinary command failure"]), { status: "failed" });
});

test("replayed exec events validate flags on launch/resume and suppress sandbox failure retry", async (t) => {
  const { cwd, calls } = await replaySpawn(t, { hold: true });
  const worker = await createExecWorker({ codexExe: "replay-codex", cwd, model: "test-model", effort: "high", windowsSandbox: "unelevated" });
  try {
    const result = await worker.turn("test", { timeoutMs: 50 });
    assert.equal(result.status, "completed");
    const launches = calls.filter((call) => call.command === "replay-codex");
    assert.equal(launches.length, 2);
    for (const call of launches) {
      assert.ok(call.args.includes("plugins"));
      assert.ok(call.args.includes("mcp_servers.node_repl.enabled=false"));
      assert.ok(call.args.includes('windows.sandbox="unelevated"'));
      assert.ok(call.args.includes("test-model"));
    }
    assert.equal(launches[1].args[1], "resume");
  } finally { await worker.close(); }
});

test("replayed exec rejection is sandbox_setup_failed and never resumes", async (t) => {
  const { cwd, calls } = await replaySpawn(t, { failed: true, hold: true });
  const worker = await createExecWorker({ codexExe: "replay-codex", cwd });
  try {
    const result = await worker.turn("test", { timeoutMs: 50 });
    assert.equal(result.failureReason, "sandbox_setup_failed");
    assert.equal(result.status, "failed");
    assert.equal(calls.filter((call) => call.command === "replay-codex").length, 1);
  } finally { await worker.close(); }
});

test("replayed app-server frames use isolated spawn and report sandbox failure/fallback", async (t) => {
  const { cwd, calls } = await replaySpawn(t, { failed: true });
  const worker = await createAppWorker({ codexExe: "replay-codex", cwd, model: "test-model",
    isolation: "ignore-user-config", windowsSandbox: "unelevated" });
  try {
    const result = await worker.turn("test", { timeoutMs: 1000 });
    assert.equal(result.failureReason, "sandbox_setup_failed");
    assert.equal(result.status, "failed");
    assert.match(result.notes.join(" "), /fell back to plugins-off/);
    assert.deepEqual(calls[0].args, ["app-server", "--listen", "stdio://", "--disable", "plugins", "-c",
      "mcp_servers.node_repl.enabled=false", "-c", 'windows.sandbox="unelevated"']);
  } finally { await worker.close(); }
});

test("setup mode selection requires shell evidence and explicit unelevated opt-in", async () => {
  const seen = [];
  const makeWorker = async (cfg) => ({
    async turn(prompt) {
      const token = /FLEET_SHELL_[a-zA-Z0-9_]+/.exec(prompt)[0];
      seen.push({ isolation: cfg.isolation, windowsSandbox: cfg.windowsSandbox });
      return { status: "completed", finalMessage: token, events: cfg.windowsSandbox === "unelevated"
        ? [{ type: "commandExecution", exitCode: 0, output: `${token}\n` }]
        : [] };
    },
    async close() {},
  });
  const denied = await runSetupSmoke({ model: "test-model" }, { platform: "win32", makeWorker });
  assert.equal(denied.compatible, false);
  assert.equal(denied.failureReason, "sandbox_setup_failed");
  assert.equal(denied.windowsSandbox, undefined);
  assert.match(denied.error, /weaker sandbox.*--allow-unelevated/);
  assert.deepEqual(seen, [
    { isolation: "plugins-off", windowsSandbox: undefined },
    { isolation: "plugins-off", windowsSandbox: "unelevated" },
    { isolation: "ignore-user-config", windowsSandbox: undefined },
  ]);
  const allowed = await runSetupSmoke({ model: "test-model", allowUnelevated: true }, { platform: "win32", makeWorker });
  assert.equal(allowed.compatible, true);
  assert.equal(allowed.isolation, "plugins-off");
  assert.equal(allowed.windowsSandbox, "unelevated");
  assert.match(allowed.notes.join(" "), /weaker/);
});

test("configuration validators reject isolation and sandbox typos before repository access", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "codex-fleet-validation-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const batch = { repo: cwd, codexExe: "codex", backend: "exec", tasks: [{ id: "example", spec: "test" }] };
  const taskPath = path.join(cwd, "task.json");
  for (const [settings, expected] of [
    [{ isolation: "typo" }, /isolation must/],
    [{ windowsSandbox: "typo" }, /windowsSandbox must/],
    [{ isolation: "ignore-user-config" }, /requires an explicit.*model/],
  ]) {
    assert.throws(() => validateBatch({ ...batch, ...settings }), expected);
    await writeFile(taskPath, JSON.stringify({ repo: cwd, codexExe: "codex", task: "test", runDir: cwd, ...settings }));
    await assert.rejects(readTask(taskPath), expected);
  }
  assert.throws(() => parseArgs(["--probe", "--isolation", "typo"]), /isolation must/);
  assert.throws(() => parseArgs(["--smoke", "--isolation", "ignore-user-config"]), /requires an explicit.*model/);
  assert.equal(parseArgs(["--smoke", "--allow-unelevated"]).allowUnelevated, true);
});

test("replayed transports apply every isolation mode and sandbox override with model/effort pinning", async (t) => {
  const { cwd, calls, requests } = await replaySpawn(t);
  for (const isolation of [undefined, "plugins-off", "ignore-user-config", "none"]) {
    for (const windowsSandbox of [undefined, "elevated", "unelevated"]) {
      for (const [createWorker, backend] of [[createExecWorker, "exec"], [createAppWorker, "app-server"]]) {
        const cfg = { codexExe: "replay-codex", cwd, model: "test-model", effort: "xhigh", isolation, windowsSandbox };
        const worker = await createWorker(cfg);
        try {
          assert.equal((await worker.turn("test", { timeoutMs: 1000 })).status, "completed");
          const flags = workerIsolationArgs(cfg, backend);
          const args = calls.at(-1).args;
          const offset = backend === "exec" ? 1 : 3;
          assert.deepEqual(args.slice(offset, offset + flags.length), flags);
          if (backend === "exec") {
            assert.ok(args.includes("test-model"));
            assert.ok(args.includes('model_reasoning_effort="xhigh"'));
          } else {
            assert.equal([...requests].reverse().find((request) => request.method === "thread/start").params.model, "test-model");
            const turn = [...requests].reverse().find((request) => request.method === "turn/start");
            assert.equal(turn.params.model, "test-model");
            assert.equal(turn.params.effort, "xhigh");
          }
        } finally { await worker.close(); }
      }
    }
  }
});

test("replayed probe requires successful shell execution and preserves selected overrides", async (t) => {
  const { cwd, calls } = await replaySpawn(t);
  const result = await probe({ codexExe: "replay-codex", cwd, model: "test-model", effort: "high",
    isolation: "ignore-user-config", windowsSandbox: "unelevated" });
  assert.equal(result.compatible, true);
  assert.equal(result.shellCommandPassed, true);
  assert.match(result.notes.join(" "), /fell back to plugins-off/);
  assert.ok(calls[0].args.includes('windows.sandbox="unelevated"'));
});

test("replayed chat-only probe fails even with the correct token answer", async (t) => {
  const { cwd } = await replaySpawn(t, { chatOnly: true });
  const result = await probe({ codexExe: "replay-codex", cwd, model: "test-model" });
  assert.match(result.finalMessage, /^FLEET_SHELL_/);
  assert.equal(result.compatible, false);
  assert.equal(result.shellCommandPassed, false);
  assert.match(result.error, /close the Codex desktop app.*windowsSandbox/);
});

test("replayed probe classifies a failed shell despite the final token answer", async (t) => {
  const { cwd } = await replaySpawn(t, { failed: true });
  const result = await probe({ codexExe: "replay-codex", cwd, model: "test-model" });
  assert.match(result.finalMessage, /^FLEET_SHELL_/);
  assert.equal(result.compatible, false);
  assert.equal(result.failureReason, "sandbox_setup_failed");
  assert.match(result.remedy, /isolation.*windowsSandbox/);
});

test("replayed delegate records sandbox failure and does not run verification or another turn", async (t) => {
  const { cwd, calls, requests } = await replaySpawn(t, { failed: true });
  const taskPath = path.join(cwd, "task.json");
  const runDir = path.join(cwd, "delegate");
  await writeFile(taskPath, JSON.stringify({ repo: cwd, codexExe: "replay-codex", task: "test", runDir,
    model: "test-model", isolation: "ignore-user-config", windowsSandbox: "unelevated", verify: "exit 0" }));
  assert.equal(await runDelegate(taskPath), "failed");
  const state = JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8"));
  assert.equal(state.failureReason, "sandbox_setup_failed");
  assert.equal(state.verify, null);
  assert.equal(state.turns, 1);
  assert.match(state.notes.join(" "), /fell back/);
  assert.ok(calls[0].args.includes("mcp_servers.node_repl.enabled=false"));
  assert.ok(calls[0].args.includes('windows.sandbox="unelevated"'));
  assert.equal(requests.filter((request) => request.method === "turn/start").length, 1);
  assert.ok(!calls.some((call) => call.command === "powershell.exe" || call.command === "/bin/sh"));
});
