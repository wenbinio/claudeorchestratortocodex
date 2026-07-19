#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fsp } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { startCodexSession } from "../vendor/dynamic-workflows-codex/src/codexSession.js";

const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_MS = 2_000;
const VERIFY_OUTPUT_LIMIT = 64 * 1024;
const REPLAYED_TERMINAL = Symbol("delegate-replayed-terminal");
const TERMINAL_STATUSES = new Set(["done", "interrupted", "failed"]);
const USAGE = [
  "usage: delegate.mjs --start <task.json>",
  "       delegate.mjs --steer <runDir> <text>",
  "       delegate.mjs --status <runDir>",
  "       delegate.mjs --interrupt <runDir>",
].join("\n");
const DEVELOPER_INSTRUCTIONS = [
  "You are a Codex Fleet implementation worker.",
  "Work only inside the assigned working directory.",
  "Do not run git commands, create commits, change branches, or modify another worktree.",
  "Implement only the requested task and summarize the changes in the final answer.",
].join(" ");

class CliError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

function parseDuration(value, fallback) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv) {
  if (argv[0] === "--start" && argv.length === 2) return { mode: "start", taskPath: argv[1] };
  if (argv[0] === "--steer" && argv.length === 3) return { mode: "steer", runDir: argv[1], text: argv[2] };
  if (argv[0] === "--status" && argv.length === 2) return { mode: "status", runDir: argv[1] };
  if (argv[0] === "--interrupt" && argv.length === 2) return { mode: "interrupt", runDir: argv[1] };
  throw new CliError(USAGE);
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

async function pathExists(filePath) {
  try {
    await fsp.access(filePath, fsConstants.F_OK);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function readTask(taskPath) {
  let raw;
  try {
    raw = JSON.parse(await fsp.readFile(path.resolve(taskPath), "utf8"));
  } catch (error) {
    throw new CliError(`cannot read task JSON: ${error?.message ?? String(error)}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new CliError("task JSON must be an object");
  for (const key of ["repo", "codexExe", "task", "runDir"]) {
    if (typeof raw[key] !== "string" || !raw[key].trim()) throw new CliError(`task JSON needs a non-empty ${key}`);
  }
  if (raw.model != null && typeof raw.model !== "string") throw new CliError("model must be a string when provided");
  if (raw.effort != null && typeof raw.effort !== "string") throw new CliError("effort must be a string when provided");
  if (raw.verify != null && typeof raw.verify !== "string") throw new CliError("verify must be a string when provided");
  if (raw.isolated != null && typeof raw.isolated !== "boolean") throw new CliError("isolated must be a boolean when provided");
  if (raw.codexArgs != null && !Array.isArray(raw.codexArgs)) throw new CliError("codexArgs must be an array when provided");
  return raw;
}

function normalizeTokens(params) {
  const total = params?.tokenUsage?.total;
  if (!total || typeof total !== "object") return null;
  const input = total.inputTokens || 0;
  const output = total.outputTokens || 0;
  const reasoning = total.reasoningOutputTokens || 0;
  return {
    input,
    output,
    reasoning,
    total: typeof total.totalTokens === "number" ? total.totalTokens : input + output + reasoning,
  };
}

function normalizedItemType(type) {
  if (type === "commandExecution" || type === "command_execution") return "commandExecution";
  if (type === "fileChange" || type === "file_change") return "fileChange";
  if (type === "agentMessage" || type === "agent_message") return "agentMessage";
  return type ?? "unknown";
}

function normalizeNotification(note) {
  const params = note?.params ?? {};
  const base = {
    at: new Date().toISOString(),
    threadId: params.threadId ?? null,
    turnId: params.turnId ?? params.turn?.id ?? null,
    raw: note,
  };
  if (note?.method === "item/completed" && params.item) {
    const item = params.item;
    const type = normalizedItemType(item.type);
    if (type === "agentMessage") {
      return { ...base, type, itemId: item.id ?? null, status: item.status ?? "completed", text: item.text ?? "", phase: item.phase ?? null };
    }
    if (type === "commandExecution") {
      return {
        ...base,
        type,
        itemId: item.id ?? null,
        status: item.status ?? "completed",
        command: item.command ?? item.cmd ?? "",
        exitCode: item.exitCode ?? item.exit_code ?? null,
        output: item.aggregatedOutput ?? item.aggregated_output ?? "",
      };
    }
    if (type === "fileChange") {
      const changes = item.changes ?? item.files ?? item.paths ?? (item.path ? [item.path] : []);
      return { ...base, type, itemId: item.id ?? null, status: item.status ?? "completed", changes };
    }
    return { ...base, type: "notification", method: note.method };
  }
  if (note?.method === "thread/tokenUsage/updated") {
    return { ...base, type: "tokenUsage", tokenUsage: params.tokenUsage ?? null };
  }
  if (note?.method === "turn/completed") {
    return {
      ...base,
      type: "turn",
      status: params.turn?.status ?? "failed",
      error: params.turn?.error?.message ?? null,
    };
  }
  return { ...base, type: "notification", method: note?.method ?? "unknown" };
}

function denyServerRequest(request) {
  const method = String(request?.method ?? "");
  if (method === "item/tool/call" || /dynamic.?tool/i.test(method)) {
    return {
      success: false,
      contentItems: [{ type: "inputText", text: "Dynamic tools are disabled for fleet workers." }],
    };
  }
  if (/approval|permission|escalat/i.test(method)) return { decision: "decline" };
  throw new Error(`Rejected unsupported app-server request: ${method || "(missing method)"}`);
}

function tailText(text) {
  const bounded = String(text).slice(-VERIFY_OUTPUT_LIMIT);
  return bounded.split(/\r?\n/).slice(-80).join("\n").trim();
}

function startProcess(command, args, options = {}) {
  let child;
  let output = "";
  let settled = false;
  let result;
  const completion = new Promise((resolve) => {
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: { ...process.env, PWD: options.cwd ?? process.cwd() },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ code: null, signal: null, error, output: "" });
      return;
    }
    const collect = (chunk) => { output = (output + chunk.toString("utf8")).slice(-VERIFY_OUTPUT_LIMIT); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", (error) => resolve({ code: null, signal: null, error, output }));
    child.once("close", (code, signal) => resolve({ code, signal, error: null, output }));
  }).then((value) => {
    settled = true;
    result = value;
    return value;
  });
  return { get child() { return child; }, get settled() { return settled; }, get result() { return result; }, completion };
}

function startVerify(command, cwd) {
  const isWindows = process.platform === "win32";
  const shell = isWindows ? "powershell.exe" : "/bin/sh";
  const args = isWindows
    ? ["-NoProfile", "-NonInteractive", "-Command", command]
    : ["-c", command];
  return startProcess(shell, args, { cwd });
}

async function gitStatus(repo) {
  const processHandle = startProcess("git", ["-C", repo, "status", "--porcelain"], { cwd: repo });
  const result = await processHandle.completion;
  if (result.code !== 0) return [];
  return result.output.split(/\r?\n/).filter(Boolean);
}

async function drainMessageInbox(inboxPath, applyMessage, warn) {
  let entries;
  try {
    entries = await fsp.readdir(inboxPath, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }

  const names = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  let applied = 0;
  for (const name of names) {
    const messagePath = path.join(inboxPath, name);
    const processingPath = `${messagePath}.processing`;
    try {
      await fsp.rename(messagePath, processingPath);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "EPERM" || error?.code === "EBUSY") continue;
      throw error;
    }

    let parsed;
    try {
      parsed = JSON.parse(await fsp.readFile(processingPath, "utf8"));
      if (!parsed || typeof parsed.text !== "string" || !parsed.text.trim()) {
        throw new Error("steer message needs non-empty text");
      }
    } catch (error) {
      await fsp.rename(processingPath, `${messagePath}.bad`).catch(() => {});
      await warn({
        type: "warning",
        at: new Date().toISOString(),
        warning: "invalid-steer-message",
        file: name,
        error: error?.message ?? String(error),
      });
      continue;
    }

    await applyMessage(parsed.text);
    await fsp.rm(processingPath, { force: true });
    applied += 1;
  }
  return applied;
}

async function runDelegate(taskPath) {
  const cfg = await readTask(taskPath);
  const repo = await fsp.realpath(path.resolve(cfg.repo));
  const runDir = path.resolve(cfg.runDir);
  const statePath = path.join(runDir, "state.json");
  const eventsPath = path.join(runDir, "events.jsonl");
  const inboxPath = path.join(runDir, "steer.inbox");
  const interruptPath = path.join(runDir, "interrupt.flag");
  const idleTimeoutMs = parseDuration(process.env.DELEGATE_IDLE_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS);
  const pollMs = parseDuration(process.env.DELEGATE_POLL_MS, DEFAULT_POLL_MS);

  await fsp.mkdir(runDir, { recursive: true });
  const eventHandle = await fsp.open(eventsPath, "a");
  const state = {
    threadId: null,
    pid: process.pid,
    status: "starting",
    lastActivityAt: new Date().toISOString(),
    turns: 0,
    tokens: null,
    verify: null,
  };

  let ioTail = Promise.resolve();
  let ioError = null;
  let driver = null;
  let notificationListener = null;
  let transportListener = null;
  let fatalTransport = null;
  let finalStatus = "failed";
  let finalError = null;
  const terminalNotes = new Map();
  const queuedPrompts = [cfg.task];

  const snapshot = () => JSON.parse(JSON.stringify(state));
  const queueIo = (operation) => {
    const next = ioTail.then(operation);
    ioTail = next.catch((error) => { ioError ??= error; });
    return next;
  };
  const persistState = () => {
    const value = snapshot();
    return queueIo(() => atomicWriteJson(statePath, value));
  };
  const transition = async (status, patch = {}) => {
    Object.assign(state, patch, { status, lastActivityAt: new Date().toISOString() });
    await persistState();
  };
  const appendEvent = (event, updateState = false) => {
    const line = `${JSON.stringify(event)}\n`;
    const value = updateState ? snapshot() : null;
    return queueIo(async () => {
      await eventHandle.write(line, null, "utf8");
      if (value) await atomicWriteJson(statePath, value);
    });
  };
  const consumeControls = async (activeTurn) => {
    if (await pathExists(interruptPath)) {
      if (activeTurn) await driver?.interruptCurrent().catch(() => {});
      return { interrupted: true };
    }
    await drainMessageInbox(inboxPath, async (message) => {
      if (activeTurn && typeof driver?.steer === "function") {
        let steered = false;
        try {
          await driver.steer(message, { effort: cfg.effort });
          steered = true;
        } catch {
          // This driver revision may reject active steering; preserve the input as
          // a warm follow-up turn instead of losing it.
        }
        if (steered) {
          await appendEvent({ type: "steer", at: new Date().toISOString(), mode: "active", text: message, threadId: state.threadId });
          return;
        }
      }
      queuedPrompts.push(message);
    }, appendEvent);
    return { interrupted: false };
  };

  await persistState();

  try {
    driver = await startCodexSession({
      cwd: repo,
      model: cfg.model,
      isolation: cfg.isolated ? "worktree" : undefined,
      sandbox: "workspace-write",
      systemPrompt: DEVELOPER_INSTRUCTIONS,
      approvalPolicy: "never",
      clientOptions: {
        command: cfg.codexExe,
        ...(Array.isArray(cfg.codexArgs) && cfg.codexArgs.length ? { args: cfg.codexArgs } : {}),
        cwd: repo,
        approvalPolicy: "never",
        requestHandler: denyServerRequest,
      },
    });
    state.threadId = driver.threadId;
    await transition("working");

    notificationListener = (note) => {
      if (!note || note[REPLAYED_TERMINAL]) return;
      const params = note.params ?? {};
      if (params.threadId && params.threadId !== driver.threadId) return;
      if (note.method === "turn/completed" && params.turn?.id) terminalNotes.set(params.turn.id, note);
      const tokens = note.method === "thread/tokenUsage/updated" ? normalizeTokens(params) : null;
      if (tokens) state.tokens = tokens;
      state.lastActivityAt = new Date().toISOString();
      void appendEvent(normalizeNotification(note), true).catch(() => {});
    };
    transportListener = (event) => {
      if (event?.stage === "exit" || event?.stage === "error") {
        fatalTransport ??= new Error(event.error?.message ?? `app-server transport ${event.stage}`);
      }
    };
    driver.client.on("notification", notificationListener);
    driver.client.on("transport", transportListener);

    let stop = false;
    while (!stop) {
      while (queuedPrompts.length && !stop) {
        if ((await consumeControls(false)).interrupted) {
          finalStatus = "interrupted";
          stop = true;
          break;
        }
        if (fatalTransport) throw fatalTransport;
        const prompt = queuedPrompts.shift();
        state.turns += 1;
        await transition("working");

        const handle = await driver.beginTurn(prompt, { model: cfg.model, effort: cfg.effort });
        if (!handle?.turnId) throw new Error("turn/start did not return turn.id");
        const buffered = terminalNotes.get(handle.turnId);
        if (buffered) {
          Object.defineProperty(buffered, REPLAYED_TERMINAL, { value: true, configurable: true });
          driver.client.emit("notification", buffered);
        }

        let settled = false;
        let outcome = null;
        const completion = handle.completion.then((value) => {
          settled = true;
          outcome = value;
          return value;
        });
        let interrupted = false;
        while (!settled) {
          await Promise.race([completion, delay(pollMs)]);
          if (settled) break;
          const control = await consumeControls(true);
          if (control.interrupted) {
            interrupted = true;
            await driver.interruptCurrent().catch(() => {});
          }
          if (fatalTransport) throw fatalTransport;
        }
        outcome ??= await completion;
        terminalNotes.delete(handle.turnId);
        await ioTail;
        if (ioError) throw ioError;

        if (interrupted || outcome?.status === "interrupted") {
          finalStatus = "interrupted";
          stop = true;
          break;
        }
        if (outcome?.status !== "completed") {
          throw new Error(outcome?.error || `turn ${outcome?.status ?? "failed"}`);
        }
        if ((await consumeControls(false)).interrupted) {
          finalStatus = "interrupted";
          stop = true;
          break;
        }

        if (cfg.verify) {
          await transition("verifying");
          const verifyStartedAt = Date.now();
          const verifyProcess = startVerify(cfg.verify, driver._worktree?.dir ?? repo);
          let verifyInterrupted = false;
          while (!verifyProcess.settled) {
            await Promise.race([verifyProcess.completion, delay(pollMs)]);
            if (verifyProcess.settled) break;
            const control = await consumeControls(false);
            if (control.interrupted) {
              verifyInterrupted = true;
              verifyProcess.child?.kill();
            }
            if (fatalTransport) {
              verifyProcess.child?.kill();
              throw fatalTransport;
            }
          }
          const verifyResult = await verifyProcess.completion;
          state.verify = {
            ran: true,
            passed: verifyResult.code === 0 && !verifyResult.signal && !verifyResult.error,
            tail: tailText(verifyResult.output || verifyResult.error?.message || ""),
          };
          state.lastActivityAt = new Date().toISOString();
          await appendEvent({
            type: "verify",
            at: state.lastActivityAt,
            command: cfg.verify,
            code: verifyResult.code,
            signal: verifyResult.signal,
            durationMs: Date.now() - verifyStartedAt,
            ...state.verify,
          }, true);
          if (verifyInterrupted) {
            finalStatus = "interrupted";
            stop = true;
            break;
          }
        }

        const control = await consumeControls(false);
        if (control.interrupted) {
          finalStatus = "interrupted";
          stop = true;
        }
      }
      if (stop) break;

      await transition("awaiting-steer");
      const idleDeadline = Date.now() + idleTimeoutMs;
      while (!queuedPrompts.length && Date.now() < idleDeadline) {
        if (fatalTransport) throw fatalTransport;
        const control = await consumeControls(false);
        if (control.interrupted) {
          finalStatus = "interrupted";
          stop = true;
          break;
        }
        if (queuedPrompts.length) break;
        await delay(Math.min(pollMs, Math.max(1, idleDeadline - Date.now())));
      }
      if (!stop && !queuedPrompts.length) {
        if (fatalTransport) throw fatalTransport;
        const control = await consumeControls(false);
        if (control.interrupted) {
          finalStatus = "interrupted";
          stop = true;
        } else if (!queuedPrompts.length) {
          finalStatus = "done";
          stop = true;
        }
      }
    }
  } catch (error) {
    finalStatus = "failed";
    finalError = error;
  } finally {
    // Freeze the notification stream before writing the summary so that the
    // delegate-summary record is unconditionally the final JSONL line.
    if (notificationListener) driver?.client.off("notification", notificationListener);
    if (transportListener) driver?.client.off("transport", transportListener);
    await ioTail;
    if (!TERMINAL_STATUSES.has(state.status) || state.status !== finalStatus) {
      await transition(finalStatus).catch((error) => { finalError ??= error; finalStatus = "failed"; });
    }
    const filesChanged = await gitStatus(repo).catch(() => []);
    await appendEvent({ type: "delegate-summary", filesChanged, verify: state.verify }).catch((error) => {
      finalError ??= error;
      finalStatus = "failed";
    });
    await ioTail;
    await driver?.cleanup().catch(() => {});
    await driver?.client.shutdown().catch(() => {});
    await eventHandle.close().catch(() => {});
  }

  if (finalError) process.stderr.write(`delegate: ${finalError?.message ?? String(finalError)}\n`);
  return finalStatus;
}

async function steer(runDir, text) {
  if (typeof text !== "string" || !text.trim()) throw new CliError("--steer requires non-empty text");
  const resolved = path.resolve(runDir);
  const statePath = path.join(resolved, "state.json");
  let state;
  try {
    state = JSON.parse(await fsp.readFile(statePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw new CliError(`delegate run not found: ${resolved}`, 1);
    throw new CliError(`cannot read delegate state: ${error?.message ?? String(error)}`, 1);
  }
  if (TERMINAL_STATUSES.has(state?.status)) {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: `run is ${state.status}` })}\n`);
    process.exitCode = 3;
    return;
  }
  const at = new Date().toISOString();
  const timestamp = at.replaceAll(":", "-");
  const messagePath = path.join(resolved, "steer.inbox", `${timestamp}-${randomUUID()}.json`);
  await atomicWriteJson(messagePath, { text, at });
  process.stdout.write(`${JSON.stringify({ ok: true, action: "steer", runDir: resolved, at })}\n`);
}

async function status(runDir) {
  const statePath = path.join(path.resolve(runDir), "state.json");
  let contents;
  try {
    contents = await fsp.readFile(statePath, "utf8");
    JSON.parse(contents);
  } catch (error) {
    throw new CliError(`cannot read delegate state: ${error?.message ?? String(error)}`, 1);
  }
  process.stdout.write(contents.endsWith("\n") ? contents : `${contents}\n`);
}

async function interrupt(runDir) {
  const resolved = path.resolve(runDir);
  if (!(await pathExists(path.join(resolved, "state.json")))) throw new CliError(`delegate run not found: ${resolved}`, 1);
  const at = new Date().toISOString();
  await atomicWriteJson(path.join(resolved, "interrupt.flag"), { at });
  process.stdout.write(`${JSON.stringify({ ok: true, action: "interrupt", runDir: resolved, at })}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "steer") return steer(args.runDir, args.text);
  if (args.mode === "status") return status(args.runDir);
  if (args.mode === "interrupt") return interrupt(args.runDir);
  const finalStatus = await runDelegate(args.taskPath);
  process.exitCode = finalStatus === "done" ? 0 : finalStatus === "interrupted" ? 130 : 1;
}

main().catch((error) => {
  process.stderr.write(`fatal: ${error?.message ?? String(error)}\n`);
  process.exitCode = error?.exitCode ?? 1;
});
