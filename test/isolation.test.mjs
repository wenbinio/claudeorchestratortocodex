import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { appServerArgs, workerIsolationArgs } from "../runner/codex-flags.mjs";
import { createWorker as createExecWorker } from "../runner/transports/exec.mjs";
import { createWorker as createAppWorker } from "../runner/transports/app-server.mjs";
import { runSetupSmoke } from "../runner/setup-smoke.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.resolve(HERE, "../runner/fleet-runner.mjs");
const DELEGATE = path.resolve(HERE, "../runner/delegate.mjs");
const EXEC_MOCK = path.join(HERE, "mock-codex-exec.mjs");
const APP_MOCK = path.join(HERE, "mock-app-server.mjs");
const DEFAULT_FLAGS = ["--disable", "plugins", "-c", "mcp_servers.node_repl.enabled=false"];
const execFileAsync = promisify(execFile);

async function temp(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "codex-fleet-isolation-"));
  t.after(() => rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return cwd;
}

function includesArgs(args, expected) {
  assert.ok(args.some((_, index) => expected.every((value, offset) => args[index + offset] === value)),
    `missing ${JSON.stringify(expected)} in ${JSON.stringify(args)}`);
}

test("isolation helper defaults, modes, sandbox overrides, and validation", () => {
  assert.deepEqual(workerIsolationArgs(), DEFAULT_FLAGS);
  assert.deepEqual(workerIsolationArgs({ isolation: "plugins-off" }), DEFAULT_FLAGS);
  assert.deepEqual(workerIsolationArgs({ isolation: "none" }), []);
  assert.deepEqual(workerIsolationArgs({ isolation: "ignore-user-config", model: "test-model" }), ["--ignore-user-config"]);
  for (const isolation of ["plugins-off", "ignore-user-config", "none"]) {
    for (const windowsSandbox of ["elevated", "unelevated"]) {
      for (const backend of ["exec", "app-server"]) {
        const args = workerIsolationArgs({ isolation, windowsSandbox, model: "test-model" }, backend);
        includesArgs(args, ["-c", `windows.sandbox="${windowsSandbox}"`]);
        if (backend === "app-server") assert.ok(!args.includes("--ignore-user-config"));
      }
    }
  }
  assert.deepEqual(appServerArgs(), ["app-server", "--listen", "stdio://", ...DEFAULT_FLAGS]);
  assert.throws(() => workerIsolationArgs({ isolation: "invalid" }), /isolation must/);
  assert.throws(() => workerIsolationArgs({ isolation: null }), /isolation must/);
  assert.throws(() => workerIsolationArgs({ windowsSandbox: "invalid" }), /windowsSandbox must/);
  for (const model of [undefined, "", "   "]) {
    assert.throws(() => workerIsolationArgs({ isolation: "ignore-user-config", model }), /requires an explicit.*model/);
  }
});

test("exec spawn applies each isolation mode and keeps model/effort pinned", async (t) => {
  const cwd = await temp(t);
  for (const isolation of [undefined, "plugins-off", "ignore-user-config", "none"]) {
    const worker = await createExecWorker({ codexExe: process.execPath, codexArgs: [EXEC_MOCK], cwd,
      isolation, model: "test-model", effort: "xhigh", windowsSandbox: "unelevated" });
    try {
      const result = await worker.turn("test", { timeoutMs: 5000 });
      assert.equal(result.status, "completed");
      const args = JSON.parse(result.events.find((event) => event.command === "mock argv").output);
      includesArgs(args, workerIsolationArgs({ isolation, model: "test-model", windowsSandbox: "unelevated" }));
      includesArgs(args, ["-m", "test-model"]);
      includesArgs(args, ["-c", 'model_reasoning_effort="xhigh"']);
      if (isolation === "none") assert.ok(!args.includes("--disable"));
      if (isolation === "ignore-user-config") assert.ok(!args.includes("--disable"));
    } finally { await worker.close(); }
  }
});

test("exec resume preserves default isolation flags and sandbox/model/effort", { timeout: 15000 }, async (t) => {
  const cwd = await temp(t);
  const worker = await createExecWorker({ codexExe: process.execPath, codexArgs: [EXEC_MOCK, "--mock-resume"], cwd,
    model: "test-model", effort: "high", windowsSandbox: "unelevated" });
  try {
    const result = await worker.turn("test", { timeoutMs: 1500 });
    assert.equal(result.status, "completed");
    const invocations = result.events.filter((event) => event.command === "mock argv").map((event) => JSON.parse(event.output));
    assert.equal(invocations.length, 2);
    includesArgs(invocations[1], ["exec", "resume", ...DEFAULT_FLAGS]);
    includesArgs(invocations[1], ["-c", 'windows.sandbox="unelevated"']);
    includesArgs(invocations[1], ["-m", "test-model"]);
    includesArgs(invocations[1], ["-c", 'model_reasoning_effort="high"']);
  } finally { await worker.close(); }
});

test("app-server spawn applies modes through the mock injection seam and reports fallback", async (t) => {
  const cwd = await temp(t);
  for (const isolation of [undefined, "plugins-off", "ignore-user-config", "none"]) {
    const worker = await createAppWorker({ codexExe: process.execPath,
      codexArgs: [APP_MOCK, "app-server", "--listen", "stdio://"], cwd,
      isolation, model: "test-model", effort: "xhigh", windowsSandbox: "unelevated" });
    try {
      const result = await worker.turn("MOCK_SHOW_ARGS", { timeoutMs: 5000 });
      assert.equal(result.status, "completed");
      const args = JSON.parse(result.finalMessage);
      includesArgs(args, ["app-server", "--listen", "stdio://"]);
      includesArgs(args, workerIsolationArgs({ isolation, model: "test-model", windowsSandbox: "unelevated" }, "app-server"));
      assert.ok(!args.includes("--ignore-user-config"));
      if (isolation === "ignore-user-config") assert.match(result.notes.join(" "), /fell back to plugins-off/);
      if (isolation === "none") assert.ok(!args.includes("--disable"));
    } finally { await worker.close(); }
  }
});

test("workers reject invalid config before spawning", async () => {
  for (const createWorker of [createExecWorker, createAppWorker]) {
    await assert.rejects(createWorker({ cwd: HERE, isolation: "invalid" }), /isolation must/);
    await assert.rejects(createWorker({ cwd: HERE, isolation: "ignore-user-config" }), /requires an explicit.*model/);
    await assert.rejects(createWorker({ cwd: HERE, windowsSandbox: "invalid" }), /windowsSandbox must/);
  }
});

test("batch and delegate validation reject unknown modes and missing ignore-user-config model", async (t) => {
  const cwd = await temp(t);
  for (const fields of [{ isolation: "invalid" }, { isolation: "ignore-user-config" }, { windowsSandbox: "invalid" }]) {
    const expected = fields.windowsSandbox ? /windowsSandbox must/ : fields.isolation === "invalid" ? /isolation must/ : /requires an explicit.*model/;
    const batchPath = path.join(cwd, "batch.json");
    await writeFile(batchPath, JSON.stringify({ repo: cwd, codexExe: process.execPath, backend: "exec",
      tasks: [{ id: "test", spec: "test" }], ...fields }));
    await assert.rejects(execFileAsync(process.execPath, [RUNNER, "--batch", batchPath]), (error) => {
      assert.equal(error.code, 2); assert.match(error.stderr, expected); return true;
    });
    const taskPath = path.join(cwd, "task.json");
    await writeFile(taskPath, JSON.stringify({ repo: cwd, codexExe: process.execPath, task: "test", runDir: cwd, ...fields }));
    await assert.rejects(execFileAsync(process.execPath, [DELEGATE, "--start", taskPath]), (error) => {
      assert.equal(error.code, 2); assert.match(error.stderr, expected); return true;
    });
  }
});

test("exec tool rejection and app-server command error classify sandbox_setup_failed", async (t) => {
  const cwd = await temp(t);
  for (const [createWorker, codexArgs, prompt] of [
    [createExecWorker, [EXEC_MOCK, "--mock-sandbox-error", "--mock-resume"], "test"],
    [createAppWorker, [APP_MOCK, "app-server"], "MOCK_SANDBOX_SETUP_FAILED"],
  ]) {
    const worker = await createWorker({ codexExe: process.execPath, codexArgs, cwd });
    try {
      const result = await worker.turn(prompt, { timeoutMs: 1500 });
      assert.equal(result.status, "failed");
      assert.equal(result.failureReason, "sandbox_setup_failed");
      assert.match(result.remedy, /isolation.*plugins-off/);
      assert.match(result.remedy, /close the Codex desktop app.*node_repl.exe/);
      assert.match(result.remedy, /windowsSandbox: "unelevated".*weaker/);
      assert.equal(result.events.filter((event) => event.status === "continuing").length, 0);
    } finally { await worker.close(); }
  }
});

test("setup shell smoke rejects chat-only workers, selects modes, and requires weaker-sandbox opt-in", async (t) => {
  const cwd = await temp(t);
  const base = { codexExe: process.execPath, cwd, model: "test-model", timeoutMs: 5000 };
  const passing = await runSetupSmoke({ ...base, codexArgs: [EXEC_MOCK] }, { platform: "win32" });
  assert.equal(passing.compatible, true);
  assert.equal(passing.isolation, "plugins-off");
  assert.equal(passing.windowsSandbox, undefined);
  const talking = await runSetupSmoke({ ...base, codexArgs: [EXEC_MOCK, "--mock-chat-only"] }, { platform: "win32" });
  assert.equal(talking.compatible, false);
  assert.equal(talking.failureReason, "shell_smoke_failed");
  assert.match(talking.remedy, /windowsSandbox/);
  const locked = { ...base, codexArgs: [EXEC_MOCK, "--mock-require-unelevated"] };
  const denied = await runSetupSmoke(locked, { platform: "win32" });
  assert.equal(denied.compatible, false);
  assert.equal(denied.windowsSandbox, undefined);
  assert.match(denied.error, /weaker sandbox.*--allow-unelevated/);
  assert.deepEqual(denied.attempts.map((attempt) => attempt.passed), [false, true, false]);
  const allowed = await runSetupSmoke({ ...locked, allowUnelevated: true }, { platform: "win32" });
  assert.equal(allowed.compatible, true);
  assert.equal(allowed.windowsSandbox, "unelevated");
  assert.equal(allowed.isolation, "plugins-off");
  const ignore = await runSetupSmoke({ ...base, codexArgs: [EXEC_MOCK, "--mock-require-ignore"] }, { platform: "win32" });
  assert.equal(ignore.compatible, true);
  assert.equal(ignore.isolation, "ignore-user-config");
  assert.equal(ignore.attempts.length, 3);
});

test("app-server probe requires successful shell output and forwards flags", async (t) => {
  const cwd = await temp(t);
  const args = [RUNNER, "--probe", "--codex-exe", process.execPath, "--cwd", cwd,
    "--model", "test-model", "--isolation", "ignore-user-config", "--windows-sandbox", "unelevated"];
  const passing = await execFileAsync(process.execPath, [...args, "--codex-args", JSON.stringify([APP_MOCK, "app-server"])]);
  const result = JSON.parse(passing.stdout);
  assert.equal(result.compatible, true);
  assert.equal(result.shellCommandPassed, true);
  assert.equal(result.isolation, "plugins-off");
  assert.match(result.notes.join(" "), /fell back/);
  for (const mockFlag of ["--mock-chat-only", "--mock-sandbox-error"]) {
    await assert.rejects(execFileAsync(process.execPath, [...args, "--codex-args", JSON.stringify([APP_MOCK, "app-server", mockFlag])]), (error) => {
      const failed = JSON.parse(error.stdout);
      assert.equal(failed.compatible, false);
      assert.equal(failed.shellCommandPassed, false);
      assert.match(failed.error, /shell smoke/);
      if (mockFlag === "--mock-sandbox-error") assert.equal(failed.failureReason, "sandbox_setup_failed");
      return true;
    });
  }
});
