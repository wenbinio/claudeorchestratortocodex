#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const TERMINAL_STATUSES = new Set(["done", "interrupted", "failed"]);
const TRANSCRIPT_LIMIT = 40_000;
const TRUNCATION_NOTE = "\n\n[Transcript truncated to 40000 characters.]";

const TOOLS = [
  {
    name: "fleet_runs",
    description: "List the 20 newest Codex Fleet runs and their task statuses.",
    inputSchema: objectSchema({}),
  },
  {
    name: "fleet_run",
    description: "Show the distilled task results for one Codex Fleet run.",
    inputSchema: objectSchema({ runId: stringSchema("Run directory name under the plugin data directory.") }, ["runId"]),
  },
  {
    name: "fleet_transcript",
    description: "Read one task transcript from a Codex Fleet run.",
    inputSchema: objectSchema({
      runId: stringSchema("Run directory name under the plugin data directory."),
      taskId: stringSchema("Task identifier in the run results."),
    }, ["runId", "taskId"]),
  },
  {
    name: "delegate_status",
    description: "Show a delegate run state and its last 10 event beats.",
    inputSchema: objectSchema({ runDir: stringSchema("Delegate run directory inside the plugin data directory.") }, ["runDir"]),
  },
  {
    name: "delegate_steer",
    description: "Queue a durable steering message for an active delegate run.",
    inputSchema: objectSchema({
      runDir: stringSchema("Delegate run directory inside the plugin data directory."),
      text: stringSchema("Non-empty steering message."),
    }, ["runDir", "text"]),
  },
  {
    name: "delegate_interrupt",
    description: "Request interruption of a delegate run.",
    inputSchema: objectSchema({ runDir: stringSchema("Delegate run directory inside the plugin data directory.") }, ["runDir"]),
  },
];

function stringSchema(description) {
  return { type: "string", description };
}

function objectSchema(properties, required = []) {
  const schema = { type: "object", properties, additionalProperties: false };
  if (required.length) schema.required = required;
  return schema;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireObject(value, label) {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function requireOnlyKeys(value, allowed) {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) throw new Error(`unexpected argument: ${unexpected}`);
}

async function dataDirectory() {
  if (process.env.CLAUDE_PLUGIN_DATA) return path.resolve(process.env.CLAUDE_PLUGIN_DATA);

  const parent = path.join(os.homedir(), ".claude", "plugins", "data");
  try {
    const matches = (await fsp.readdir(parent, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.includes("codex-fleet"))
      .map((entry) => entry.name)
      .sort();
    if (matches.length) return path.join(parent, matches[0]);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return path.join(parent, "codex-fleet");
}

function isInside(parent, candidate) {
  const relation = path.relative(path.resolve(parent), path.resolve(candidate));
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${path.sep}`) && !path.isAbsolute(relation));
}

function runDirectory(dataDir, runId) {
  requireString(runId, "runId");
  if (runId !== path.basename(runId) || runId === "." || runId === "..") {
    throw new Error("runId must be a run directory name");
  }
  return path.join(dataDir, "runs", runId);
}

async function delegateDirectory(dataDir, runDir) {
  requireString(runDir, "runDir");
  const candidate = path.resolve(path.isAbsolute(runDir) ? runDir : path.join(dataDir, runDir));
  if (!isInside(dataDir, candidate)) throw new Error("runDir must be inside the plugin data directory");
  let resolved;
  try {
    resolved = await fsp.realpath(candidate);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`delegate run not found: ${candidate}`);
    throw error;
  }
  const resolvedDataDir = await fsp.realpath(dataDir).catch(() => path.resolve(dataDir));
  if (!isInside(resolvedDataDir, resolved)) throw new Error("runDir must be inside the plugin data directory");
  return resolved;
}

async function readJson(filePath, label = filePath) {
  let contents;
  try {
    contents = await fsp.readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`cannot read ${label}: ${error?.message ?? String(error)}`);
  }
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(`cannot parse ${label}: ${error?.message ?? String(error)}`);
  }
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

function reportsFrom(payload) {
  return Array.isArray(payload?.results) ? payload.results : [];
}

function driverFrom(report) {
  return isObject(report?.driver) ? report.driver : isObject(report) ? report : {};
}

function reviewVerdict(review) {
  if (typeof review === "string" && review) return review;
  if (!isObject(review)) return undefined;
  return review.verdict ?? review.reviewVerdict;
}

async function fleetRuns(dataDir) {
  const runsDir = path.join(dataDir, "runs");
  let entries;
  try {
    entries = (await fsp.readdir(runsDir, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const dated = await Promise.all(entries.map(async (entry) => {
    const directory = path.join(runsDir, entry.name);
    const stats = await fsp.stat(directory).catch(() => null);
    return { name: entry.name, mtimeMs: stats?.mtimeMs ?? 0 };
  }));
  dated.sort((left, right) => right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name));

  return Promise.all(dated.slice(0, 20).map(async ({ name }) => {
    let payload = {};
    try {
      payload = JSON.parse(await fsp.readFile(path.join(runsDir, name, "results.json"), "utf8"));
    } catch {
      // A run directory may exist before its first complete results snapshot.
    }
    const reports = reportsFrom(payload);
    return {
      runId: name,
      complete: payload?.complete === true,
      taskCount: reports.length,
      statuses: reports.map((report) => driverFrom(report).status ?? "unknown"),
    };
  }));
}

async function fleetRun(dataDir, runId) {
  const directory = runDirectory(dataDir, runId);
  const payload = await readJson(path.join(directory, "results.json"), `results for ${runId}`);
  const tasks = reportsFrom(payload).map((report) => {
    const driver = driverFrom(report);
    const task = {
      taskId: report?.taskId ?? driver.taskId ?? null,
      status: driver.status ?? null,
      verifyPassed: driver.verifyPassed ?? null,
      commitSha: driver.commitSha ?? null,
      transcriptPath: driver.transcriptPath ?? null,
    };
    const verdict = reviewVerdict(report?.review);
    if (verdict !== undefined) task.reviewVerdict = verdict;
    return task;
  });
  return { runId: payload?.runId ?? runId, complete: payload?.complete === true, tasks };
}

async function fleetTranscript(dataDir, runId, taskId) {
  requireString(taskId, "taskId");
  const directory = runDirectory(dataDir, runId);
  const payload = await readJson(path.join(directory, "results.json"), `results for ${runId}`);
  const report = reportsFrom(payload).find((item) => item?.taskId === taskId || item?.driver?.taskId === taskId);
  if (!report) throw new Error(`task not found in run ${runId}: ${taskId}`);
  const recorded = driverFrom(report).transcriptPath;
  const transcriptPath = path.resolve(recorded || path.join(directory, "transcripts", `${taskId}.transcript.md`));
  if (!isInside(dataDir, transcriptPath)) throw new Error("transcriptPath is outside the plugin data directory");
  const text = await fsp.readFile(transcriptPath, "utf8").catch((error) => {
    throw new Error(`cannot read transcript: ${error?.message ?? String(error)}`);
  });
  if (text.length <= TRANSCRIPT_LIMIT) return text;
  return `${text.slice(0, TRANSCRIPT_LIMIT - TRUNCATION_NOTE.length)}${TRUNCATION_NOTE}`;
}

function oneLine(value, limit = 500) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function eventBeat(event) {
  if (!isObject(event)) return oneLine(event);
  const prefix = event.at ? `${event.at} ` : "";
  if (event.type === "agentMessage") return `${prefix}agent: ${oneLine(event.text)}`.trim();
  if (event.type === "commandExecution") {
    const exit = event.exitCode == null ? "" : ` (exit ${event.exitCode})`;
    return `${prefix}command: ${oneLine(event.command)}${exit}`.trim();
  }
  if (event.type === "fileChange") {
    const changes = Array.isArray(event.changes) ? event.changes.map((item) => item?.path ?? item).join(", ") : event.changes;
    return `${prefix}files: ${oneLine(changes)}`.trim();
  }
  if (event.type === "turn") return `${prefix}turn: ${oneLine(event.status)}${event.error ? ` — ${oneLine(event.error)}` : ""}`.trim();
  if (event.type === "tokenUsage") {
    const total = event.tokenUsage?.total?.totalTokens ?? event.tokenUsage?.total ?? "updated";
    return `${prefix}tokens: ${oneLine(total)}`.trim();
  }
  if (event.type === "verify") return `${prefix}verify: ${event.passed === true || event.code === 0 ? "passed" : "failed"}${event.code == null ? "" : ` (exit ${event.code})`}`.trim();
  if (event.type === "steer") return `${prefix}steer: ${oneLine(event.text)}`.trim();
  if (event.type === "delegate-summary") {
    const count = Array.isArray(event.filesChanged) ? event.filesChanged.length : 0;
    return `${prefix}delegate summary: ${count} file${count === 1 ? "" : "s"} changed`.trim();
  }
  const detail = event.status ?? event.method ?? event.warning ?? event.text ?? event.type ?? "event";
  return `${prefix}${oneLine(event.type ?? "event")}: ${oneLine(detail)}`.trim();
}

async function delegateStatus(dataDir, runDir) {
  const directory = await delegateDirectory(dataDir, runDir);
  const state = await readJson(path.join(directory, "state.json"), "delegate state");
  let lines = [];
  try {
    lines = (await fsp.readFile(path.join(directory, "events.jsonl"), "utf8")).split(/\r?\n/).filter(Boolean).slice(-10);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const beats = lines.map((line) => {
    try {
      return eventBeat(JSON.parse(line));
    } catch {
      return `invalid event: ${oneLine(line)}`;
    }
  });
  return { state, beats };
}

async function delegateSteer(dataDir, runDir, text) {
  requireString(text, "text");
  const directory = await delegateDirectory(dataDir, runDir);
  const state = await readJson(path.join(directory, "state.json"), "delegate state");
  if (TERMINAL_STATUSES.has(state?.status)) throw new Error(`run is ${state.status}`);
  const at = new Date().toISOString();
  const timestamp = at.replaceAll(":", "-");
  const messagePath = path.join(directory, "steer.inbox", `${timestamp}-${randomUUID()}.json`);
  await atomicWriteJson(messagePath, { text, at });
  return { ok: true, action: "steer", runDir: directory, at };
}

async function delegateInterrupt(dataDir, runDir) {
  const directory = await delegateDirectory(dataDir, runDir);
  await fsp.access(path.join(directory, "state.json"), fsConstants.F_OK).catch(() => {
    throw new Error(`delegate run not found: ${directory}`);
  });
  const at = new Date().toISOString();
  await atomicWriteJson(path.join(directory, "interrupt.flag"), { at });
  return { ok: true, action: "interrupt", runDir: directory, at };
}

async function callTool(name, rawArguments) {
  const args = rawArguments === undefined ? {} : requireObject(rawArguments, "arguments");
  const dataDir = await dataDirectory();
  switch (name) {
    case "fleet_runs":
      requireOnlyKeys(args, []);
      return { value: await fleetRuns(dataDir), json: true };
    case "fleet_run":
      requireOnlyKeys(args, ["runId"]);
      return { value: await fleetRun(dataDir, requireString(args.runId, "runId")), json: true };
    case "fleet_transcript":
      requireOnlyKeys(args, ["runId", "taskId"]);
      return { value: await fleetTranscript(dataDir, requireString(args.runId, "runId"), requireString(args.taskId, "taskId")), json: false };
    case "delegate_status":
      requireOnlyKeys(args, ["runDir"]);
      return { value: await delegateStatus(dataDir, requireString(args.runDir, "runDir")), json: true };
    case "delegate_steer":
      requireOnlyKeys(args, ["runDir", "text"]);
      return { value: await delegateSteer(dataDir, requireString(args.runDir, "runDir"), requireString(args.text, "text")), json: true };
    case "delegate_interrupt":
      requireOnlyKeys(args, ["runDir"]);
      return { value: await delegateInterrupt(dataDir, requireString(args.runDir, "runDir")), json: true };
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function rpcError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleMessage(message) {
  if (!isObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    rpcError(isObject(message) && Object.hasOwn(message, "id") ? message.id : null, -32600, "Invalid Request");
    return;
  }
  const hasId = Object.hasOwn(message, "id");
  if (!hasId) return;

  if (message.method === "initialize") {
    result(message.id, {
      protocolVersion: message.params?.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "codex-fleet", version: "0.6.0" },
    });
    return;
  }
  if (message.method === "tools/list") {
    result(message.id, { tools: TOOLS });
    return;
  }
  if (message.method === "tools/call") {
    try {
      const params = requireObject(message.params, "params");
      const name = requireString(params.name, "name");
      const outcome = await callTool(name, params.arguments);
      const text = outcome.json ? JSON.stringify(outcome.value, null, 2) : outcome.value;
      result(message.id, { content: [{ type: "text", text }], isError: false });
    } catch (error) {
      result(message.id, {
        content: [{ type: "text", text: error?.message ?? String(error) }],
        isError: true,
      });
    }
    return;
  }
  rpcError(message.id, -32601, "Method not found");
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    rpcError(null, -32700, "Parse error");
    continue;
  }
  try {
    await handleMessage(message);
  } catch (error) {
    rpcError(isObject(message) && Object.hasOwn(message, "id") ? message.id : null, -32603, error?.message ?? "Internal error");
  }
}
