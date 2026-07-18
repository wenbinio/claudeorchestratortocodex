#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { runTask } from "./task-runner.mjs";

const TASK_ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const DEFAULT_MAX_PARALLEL = 4;
const PROBE_TIMEOUT_MS = 60_000;
const TRANSPORT_URLS = {
  "app-server": new URL("./transports/app-server.mjs", import.meta.url),
  exec: new URL("./transports/exec.mjs", import.meta.url),
};

class CliError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

function parseArgs(argv) {
  const args = { batch: null, probe: false };
  const valueOptions = new Map([
    ["--batch", "batch"],
    ["--codex-exe", "codexExe"],
    ["--cwd", "cwd"],
    ["--model", "model"],
    ["--effort", "effort"],
    ["--timeout-ms", "timeoutMs"],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--probe") {
      args.probe = true;
      continue;
    }
    const key = valueOptions.get(option);
    if (!key) throw new CliError(`unknown option: ${option}`);
    if (index + 1 >= argv.length) throw new CliError(`${option} requires a value`);
    args[key] = argv[index + 1];
    index += 1;
  }

  if (args.probe && args.batch) throw new CliError("use either --probe or --batch, not both");
  return args;
}

function defaultRunId() {
  return `run-${new Date().toISOString().replace(/[-:.]/g, "")}`;
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function canonicalizeFuturePath(target) {
  let cursor = path.resolve(target);
  const missing = [];

  while (true) {
    try {
      const existing = await fsp.realpath(cursor);
      return path.resolve(existing, ...missing.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) return path.resolve(target);
      missing.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

async function assertExternalRunDirectory(repo, outDir) {
  const lexicalRepo = path.resolve(repo);
  const lexicalOut = path.resolve(outDir);
  const canonicalRepo = await fsp.realpath(lexicalRepo);
  const canonicalOut = await canonicalizeFuturePath(lexicalOut);
  if (isWithin(lexicalRepo, lexicalOut) || isWithin(canonicalRepo, canonicalOut)) {
    throw new CliError(`outDir must be outside the target repo: ${lexicalOut}`);
  }
}

function validateBatch(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CliError("batch must be a JSON object");
  }
  if (typeof raw.repo !== "string" || !raw.repo.trim()) {
    throw new CliError("batch needs a non-empty repo");
  }
  if (typeof raw.codexExe !== "string" || !raw.codexExe.trim()) {
    throw new CliError("batch needs a non-empty codexExe");
  }
  if (!Object.hasOwn(TRANSPORT_URLS, raw.backend)) {
    throw new CliError("batch backend must be 'app-server' or 'exec'");
  }
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) {
    throw new CliError("batch needs a non-empty tasks array");
  }
  if (raw.model != null && typeof raw.model !== "string") {
    throw new CliError("batch model must be a string when provided");
  }
  if (raw.effort != null && typeof raw.effort !== "string") {
    throw new CliError("batch effort must be a string when provided");
  }
  if (raw.runId != null && (typeof raw.runId !== "string" || !raw.runId.trim())) {
    throw new CliError("batch runId must be a non-empty string when provided");
  }
  if (raw.outDir != null && (typeof raw.outDir !== "string" || !raw.outDir.trim())) {
    throw new CliError("batch outDir must be a non-empty string when provided");
  }
  if (raw.maxParallel != null && (!Number.isInteger(raw.maxParallel) || raw.maxParallel < 1)) {
    throw new CliError("batch maxParallel must be a positive integer");
  }
  if (raw.timeoutMinutes != null && (!Number.isFinite(raw.timeoutMinutes) || raw.timeoutMinutes <= 0)) {
    throw new CliError("batch timeoutMinutes must be a positive number");
  }

  const seen = new Set();
  for (const task of raw.tasks) {
    if (!task || typeof task !== "object" || Array.isArray(task)) {
      throw new CliError("each task must be an object");
    }
    if (!TASK_ID_RE.test(task.id ?? "")) {
      throw new CliError(`invalid task id: ${JSON.stringify(task.id)}`);
    }
    if (seen.has(task.id)) throw new CliError(`duplicate task id: ${task.id}`);
    if (typeof task.spec !== "string") throw new CliError(`task ${task.id} needs a string spec`);
    seen.add(task.id);
  }
}

async function readBatch(batchPath) {
  if (!batchPath) throw new CliError("usage: fleet-runner.mjs --batch <batch.json> | --probe");
  let text;
  try {
    text = await fsp.readFile(path.resolve(batchPath), "utf8");
  } catch (error) {
    throw new CliError(`cannot read batch: ${error?.message ?? String(error)}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CliError(`invalid batch JSON: ${error?.message ?? String(error)}`);
  }
}

async function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk.toString("utf8")).slice(-64 * 1024); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-64 * 1024); });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function resolveBaseSha(repo) {
  let result;
  try {
    result = await runProcess("git", ["-C", repo, "rev-parse", "HEAD"]);
  } catch (error) {
    throw new CliError(`cannot resolve baseSha: ${error?.message ?? String(error)}`, 1);
  }
  const baseSha = result.stdout.trim();
  if (result.code !== 0 || !/^[0-9a-f]{7,64}$/i.test(baseSha)) {
    const detail = result.stderr.trim() || result.stdout.trim() || `git exited ${result.code ?? result.signal ?? "unknown"}`;
    throw new CliError(`cannot resolve baseSha: ${detail}`, 1);
  }
  return baseSha;
}

async function atomicWrite(filePath, contents) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fsp.open(temporary, "wx");
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(temporary, filePath);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function atomicWriteJson(filePath, value) {
  await atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function atomicAppendJsonLine(filePath, value) {
  let existing = "";
  try {
    existing = await fsp.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (existing && !existing.endsWith("\n")) existing += "\n";
  await atomicWrite(filePath, `${existing}${JSON.stringify(value)}\n`);
}

function failedReport(task, { baseSha, worktreeBase, transcriptDir, summary }) {
  return {
    taskId: task.id,
    status: "failed",
    branch: `codex/${task.id}`,
    worktree: path.join(worktreeBase, task.id),
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
    transcriptPath: path.join(transcriptDir, `${task.id}.transcript.md`),
    baseSha,
    commitSha: "",
    summary,
  };
}

function serializeEvents(events) {
  return events.map((event) => {
    try {
      return JSON.stringify(event);
    } catch (error) {
      return JSON.stringify({ type: "serializationError", error: error?.message ?? String(error) });
    }
  }).join("\n") + (events.length ? "\n" : "");
}

async function pool(items, size, callback) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await callback(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function runBatch(args) {
  const cfg = await readBatch(args.batch);
  validateBatch(cfg);

  const repo = path.resolve(cfg.repo);
  const runId = cfg.runId ?? defaultRunId();
  const dataDir = path.resolve(process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), ".claude", "plugins", "data", "codex-fleet"));
  const outDir = path.resolve(cfg.outDir || path.join(dataDir, "runs", runId));
  await assertExternalRunDirectory(repo, outDir);

  const worktreeBase = cfg.wtBase ? path.resolve(cfg.wtBase) : path.join(outDir, "worktrees");
  const transcriptDir = path.join(outDir, "transcripts");
  const eventsDir = path.join(outDir, "events");
  await Promise.all([
    fsp.mkdir(worktreeBase, { recursive: true }),
    fsp.mkdir(transcriptDir, { recursive: true }),
    fsp.mkdir(eventsDir, { recursive: true }),
  ]);

  const baseSha = await resolveBaseSha(repo);
  const transportModule = await import(TRANSPORT_URLS[cfg.backend]);
  if (typeof transportModule.createWorker !== "function") {
    throw new CliError(`transport ${cfg.backend} does not export createWorker`, 1);
  }

  const timeoutMs = cfg.timeoutMinutes == null ? undefined : cfg.timeoutMinutes * 60_000;
  const maxParallel = cfg.maxParallel ?? DEFAULT_MAX_PARALLEL;
  const results = await pool(cfg.tasks, maxParallel, async (task) => {
    const events = [];
    const worktree = path.join(worktreeBase, task.id);
    let worker = null;
    let report = failedReport(task, {
      baseSha,
      worktreeBase,
      transcriptDir,
      summary: "worker did not start",
    });

    try {
      worker = await transportModule.createWorker({
        codexExe: cfg.codexExe,
        codexArgs: cfg.codexArgs,
        cwd: worktree,
        model: cfg.model,
        effort: cfg.effort,
        onEvent: (event) => events.push(event),
      });
      report = await runTask({
        repo,
        baseSha,
        task,
        verify: cfg.verify,
        transport: worker,
        wtBase: worktreeBase,
        transcriptDir,
        timeoutMs,
      });
      worker = null; // runTask owns and closes an accepted worker.
    } catch (error) {
      await worker?.close?.().catch(() => {});
      report = failedReport(task, {
        baseSha,
        worktreeBase,
        transcriptDir,
        summary: `runner error: ${error?.message ?? String(error)}`,
      });
    }

    try {
      await atomicWrite(path.join(eventsDir, `${task.id}.codex-events.jsonl`), serializeEvents(events));
    } catch (error) {
      report.status = "failed";
      report.summary = `${report.summary}${report.summary ? "; " : ""}event write failed: ${error?.message ?? String(error)}`;
    }
    return report;
  });

  const payload = {
    runId,
    results,
    approvedBranches: [],
    worktreeBase,
    outDir,
  };
  const resultsPath = path.join(outDir, "results.json");
  await atomicWriteJson(resultsPath, payload);
  await atomicAppendJsonLine(path.join(outDir, "runner-journal.jsonl"), {
    ranAt: new Date().toISOString(),
    runId,
    repo,
    baseSha,
    backend: cfg.backend,
    tasks: cfg.tasks.map((task) => task.id),
    statuses: results.map((result) => result.status),
  });

  const done = results.filter((result) => result.status === "done").length;
  console.log(`fleet-runner: ${done}/${results.length} done. results -> ${resultsPath}`);
}

function probeRequestHandler(request) {
  const method = String(request?.method ?? "");
  if (method === "item/tool/call" || /dynamic.?tool/i.test(method)) {
    return {
      success: false,
      contentItems: [{ type: "inputText", text: "Dynamic tools are disabled during the capability probe." }],
    };
  }
  if (/approval|permission|escalat/i.test(method)) return { decision: "decline" };
  throw new Error(`Rejected unsupported app-server request: ${method || "(missing method)"}`);
}

function modelName(model) {
  return model?.id ?? model?.model ?? model?.slug ?? model?.name ?? null;
}

async function probe(args) {
  const result = {
    compatible: false,
    backend: "app-server",
    initialized: false,
    modelsListed: false,
    modelCount: 0,
    models: [],
    ephemeral: true,
    sandbox: "read-only",
    turnStatus: "failed",
    finalMessage: "",
  };
  const codexExe = args.codexExe || process.env.CODEX_EXE || process.env.CODEX_CLI_PATH || "codex";
  const requestedTimeout = Number(args.timeoutMs);
  const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? requestedTimeout : PROBE_TIMEOUT_MS;
  let probeDir = null;
  let client = null;
  let threadId = null;
  let turnId = null;

  try {
    probeDir = args.cwd ? path.resolve(args.cwd) : await fsp.mkdtemp(path.join(os.tmpdir(), "codex-fleet-probe-"));
    const { AppServerClient } = await import("../vendor/dynamic-workflows-codex/src/appServerClient.js");
    client = new AppServerClient({
      command: codexExe,
      cwd: probeDir,
      clientInfo: { name: "codex-fleet-probe", title: "Codex Fleet Probe", version: "0.3.0" },
      capabilities: { experimentalApi: true },
      requestHandler: probeRequestHandler,
    });
    await client.connect();
    result.initialized = true;

    const models = await client.listModels();
    if (!Array.isArray(models)) throw new Error("model/list did not return an array");
    result.modelsListed = true;
    result.modelCount = models.length;
    result.models = models.map(modelName).filter(Boolean);

    const thread = await client.startThread({
      cwd: probeDir,
      ephemeral: true,
      sandbox: "read-only",
      approvalPolicy: "never",
      ...(args.model ? { model: args.model } : {}),
    });
    threadId = thread?.thread?.id;
    if (!threadId) throw new Error("thread/start did not return thread.id");

    const terminalNotes = [];
    let resolveTerminal;
    const terminalPromise = new Promise((resolve) => { resolveTerminal = resolve; });
    let resolveTransportFailure;
    const transportFailure = new Promise((resolve) => { resolveTransportFailure = resolve; });
    const onNotification = (note) => {
      if (note?.method === "item/completed" && note.params?.threadId === threadId) {
        const item = note.params?.item;
        if ((item?.type === "agentMessage" || item?.type === "agent_message") && typeof item.text === "string") {
          result.finalMessage = item.text;
        }
      }
      if (note?.method !== "turn/completed" || note.params?.threadId !== threadId) return;
      terminalNotes.push(note);
      if (turnId && note.params?.turn?.id === turnId) resolveTerminal({ kind: "terminal", note });
    };
    const onTransport = (event) => {
      if (event?.stage === "exit" || event?.stage === "error") {
        resolveTransportFailure({ kind: "transport", event });
      }
    };
    client.on("notification", onNotification);
    client.on("transport", onTransport);

    try {
      const started = await client.startTurn({
        threadId,
        input: [{ type: "text", text: "Reply with exactly the single word: READY" }],
        ...(args.model ? { model: args.model } : {}),
        ...(args.effort ? { effort: args.effort } : {}),
      });
      turnId = started?.turn?.id;
      if (!turnId) throw new Error("turn/start did not return turn.id");

      const buffered = terminalNotes.find((note) => note.params?.turn?.id === turnId);
      let timer;
      const outcome = buffered
        ? { kind: "terminal", note: buffered }
        : await Promise.race([
          terminalPromise,
          transportFailure,
          new Promise((resolve) => { timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs); }),
        ]).finally(() => clearTimeout(timer));
      if (outcome.kind === "timeout") {
        await client.interruptTurn(threadId, turnId).catch(() => {});
        throw new Error("probe turn timed out");
      }
      if (outcome.kind === "transport") {
        const detail = outcome.event?.error?.message || `app-server ${outcome.event?.stage ?? "transport"} failure`;
        throw new Error(detail);
      }

      result.turnStatus = outcome.note.params?.turn?.status ?? "failed";
      result.compatible = result.initialized && result.modelsListed && result.turnStatus === "completed" && result.finalMessage.trim() === "READY";
      if (!result.compatible) result.error = "probe turn did not complete with READY";
    } finally {
      client.off("notification", onNotification);
      client.off("transport", onTransport);
    }
  } catch (error) {
    result.error = error?.message ?? String(error);
  } finally {
    await client?.shutdown().catch(() => {});
    if (probeDir && !args.cwd) await fsp.rm(probeDir, { recursive: true, force: true }).catch(() => {});
  }

  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.probe) {
    const capability = await probe(args);
    console.log(JSON.stringify(capability));
    process.exitCode = capability.compatible ? 0 : 1;
    return;
  }
  await runBatch(args);
  process.exitCode = 0;
}

main().catch((error) => {
  console.error(`fatal: ${error?.message ?? String(error)}`);
  process.exitCode = error?.exitCode ?? 1;
});
