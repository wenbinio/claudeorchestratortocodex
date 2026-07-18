import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_TIMEOUT_MS = 600_000;
const KILL_GRACE_MS = 2_000;
const STDERR_TAIL_BYTES = 64 * 1024;

class TailBuffer {
  constructor(limit) {
    this.limit = limit;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, next]) : Buffer.from(next);
    if (this.buffer.length > this.limit) this.buffer = this.buffer.subarray(this.buffer.length - this.limit);
  }

  text() {
    return this.buffer.toString("utf8");
  }
}

function safeOnEvent(onEvent, event) {
  if (typeof onEvent !== "function") return;
  try {
    onEvent(event);
  } catch {
    // Event consumers are observational and cannot fail a Codex turn.
  }
}

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function shQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function normalizedItemType(type) {
  if (type === "commandExecution" || type === "command_execution") return "commandExecution";
  if (type === "fileChange" || type === "file_change") return "fileChange";
  if (type === "agentMessage" || type === "agent_message") return "agentMessage";
  return type ?? "unknown";
}

function fileChanges(item) {
  const raw = item?.changes ?? item?.files ?? item?.paths ?? (item?.path ? [item.path] : []);
  const changes = Array.isArray(raw) ? raw : [raw];
  return changes
    .map((change) => {
      if (typeof change === "string") return { path: change, kind: null };
      const filePath = change?.path ?? change?.filePath ?? change?.file_path;
      return filePath ? { path: filePath, kind: change?.kind ?? change?.type ?? null } : null;
    })
    .filter(Boolean);
}

function makeState(onEvent) {
  return {
    commandsRun: 0,
    commandIds: new Set(),
    filesPatched: new Set(),
    finalMessage: "",
    latestMessage: "",
    tokenUsage: null,
    sessionId: "",
    terminalStatus: null,
    events: [],
    onEvent,
  };
}

function recordEvent(state, event) {
  state.events.push(event);
  safeOnEvent(state.onEvent, event);
}

function collectFrame(frame, state) {
  const frameType = frame?.type ?? frame?.method ?? "";
  if (frameType === "thread.started" || frameType === "thread_started") {
    state.sessionId = frame.thread_id ?? frame.threadId ?? frame.thread?.id ?? frame.session_id ?? state.sessionId;
    recordEvent(state, { type: "thread", sessionId: state.sessionId, status: "started", raw: frame });
    return;
  }

  if (frameType === "item.completed" || frameType === "item/completed") {
    const item = frame.item ?? frame.params?.item;
    if (!item) return;
    const type = normalizedItemType(item.type);
    const eventBase = {
      type,
      sessionId: state.sessionId,
      turnId: frame.turn_id ?? frame.turnId ?? frame.params?.turnId ?? null,
      itemId: item.id ?? frame.item_id ?? null,
      status: item.status ?? "completed",
      raw: frame,
    };

    switch (type) {
      case "commandExecution": {
        const key = eventBase.itemId ?? Symbol("command");
        if (!state.commandIds.has(key)) {
          state.commandIds.add(key);
          state.commandsRun += 1;
        }
        recordEvent(state, {
          ...eventBase,
          command: item.command ?? item.cmd ?? "",
          exitCode: item.exitCode ?? item.exit_code ?? null,
          output: item.aggregatedOutput ?? item.aggregated_output ?? "",
        });
        break;
      }
      case "fileChange": {
        const changes = fileChanges(item);
        for (const change of changes) state.filesPatched.add(change.path);
        recordEvent(state, {
          ...eventBase,
          changes,
          paths: changes.map((change) => change.path),
        });
        break;
      }
      case "agentMessage": {
        const text = typeof item.text === "string" ? item.text : "";
        const phase = item.phase ?? null;
        if (text) state.latestMessage = text;
        if (text && phase === "final_answer") state.finalMessage = text;
        recordEvent(state, { ...eventBase, text, phase, final: phase === "final_answer" });
        break;
      }
      default:
        break;
    }
    return;
  }

  if (frameType === "turn.completed" || frameType === "turn/completed") {
    state.terminalStatus = frame.turn?.status ?? frame.params?.turn?.status ?? frame.status ?? "completed";
    state.tokenUsage = frame.usage ?? frame.tokenUsage ?? frame.params?.tokenUsage ?? state.tokenUsage;
    recordEvent(state, {
      type: "turn",
      sessionId: state.sessionId,
      turnId: frame.turn?.id ?? frame.params?.turn?.id ?? frame.turn_id ?? null,
      status: state.terminalStatus,
      tokenUsage: state.tokenUsage,
      raw: frame,
    });
    return;
  }

  if (frameType === "turn.failed" || frameType === "turn/failed") {
    state.terminalStatus = "failed";
    recordEvent(state, { type: "turn", sessionId: state.sessionId, status: "failed", error: frame.error ?? null, raw: frame });
    return;
  }

  if (frameType === "turn.interrupted" || frameType === "turn/interrupted") {
    state.terminalStatus = "interrupted";
    recordEvent(state, { type: "turn", sessionId: state.sessionId, status: "interrupted", raw: frame });
  }
}

function contractResult(values, events) {
  const result = {
    status: values.status,
    finalMessage: values.finalMessage ?? "",
    commandsRun: values.commandsRun ?? 0,
    filesPatched: values.filesPatched ?? [],
    tokenUsage: values.tokenUsage ?? null,
    sessionId: values.sessionId ?? "",
  };
  Object.defineProperty(result, "events", { value: events, enumerable: false });
  return result;
}

function waitForExit(child) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.once("error", (error) => finish({ code: null, signal: null, error }));
    child.once("exit", (code, signal) => finish({ code, signal, error: null }));
  });
}

async function runTaskkill(pid) {
  return new Promise((resolve) => {
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.once("error", () => resolve(false));
    killer.once("exit", (code) => resolve(code === 0));
  });
}

async function killProcessTree(child, exitPromise) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return true;

  if (process.platform === "win32") {
    await runTaskkill(child.pid);
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      try { child.kill("SIGTERM"); } catch {}
    }
  }

  let stopped = await Promise.race([
    exitPromise.then(() => true),
    delay(KILL_GRACE_MS).then(() => false),
  ]);
  if (stopped) return true;

  if (process.platform === "win32") {
    await runTaskkill(child.pid);
    try { child.kill("SIGKILL"); } catch {}
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
  }
  stopped = await Promise.race([
    exitPromise.then(() => true),
    delay(KILL_GRACE_MS).then(() => false),
  ]);
  return stopped;
}

export async function createWorker({ codexExe, cwd, model, effort, onEvent } = {}) {
  if (!cwd) throw new TypeError("createWorker requires cwd");

  let active = null;
  let closed = false;

  async function turn(prompt, { timeoutMs } = {}) {
    if (closed) throw new Error("worker is closed");
    if (active) throw new Error("worker already has an active turn");

    const state = makeState(onEvent);
    const stderrTail = new TailBuffer(STDERR_TAIL_BYTES);
    const args = ["exec", "--json", "--sandbox", "workspace-write"];
    if (model) args.push("-m", String(model));
    if (effort) args.push("-c", `model_reasoning_effort=${JSON.stringify(String(effort))}`);
    args.push(String(prompt));

    const executable = codexExe ?? "codex";
    const isWindows = process.platform === "win32";
    const script = isWindows
      ? `$null | & ${[executable, ...args].map(psQuote).join(" ")}`
      : `${[executable, ...args].map(shQuote).join(" ")} < /dev/null`;
    const shell = isWindows ? "powershell.exe" : "/bin/sh";
    const shellArgs = isWindows
      ? ["-NoProfile", "-NonInteractive", "-Command", script]
      : ["-c", script];

    let child;
    try {
      child = spawn(shell, shellArgs, {
        cwd,
        env: { ...process.env, PWD: cwd },
        detached: !isWindows,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      recordEvent(state, { type: "turn", status: "failed", error: error?.message ?? String(error) });
      return contractResult({ status: "failed" }, state.events);
    }

    const exitPromise = waitForExit(child);
    active = { child, exitPromise };
    let stdoutBuffer = "";
    const acceptStdout = (text, flush = false) => {
      stdoutBuffer += text;
      let newline;
      while ((newline = stdoutBuffer.indexOf("\n")) !== -1) {
        const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          collectFrame(JSON.parse(line), state);
        } catch {
          recordEvent(state, { type: "protocolError", line });
        }
      }
      if (flush && stdoutBuffer.trim()) {
        const line = stdoutBuffer.replace(/\r$/, "");
        stdoutBuffer = "";
        try {
          collectFrame(JSON.parse(line), state);
        } catch {
          recordEvent(state, { type: "protocolError", line });
        }
      }
    };
    child.stdout?.on("data", (chunk) => acceptStdout(chunk.toString("utf8")));
    child.stderr?.on("data", (chunk) => stderrTail.push(chunk));

    const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    let timer;
    try {
      const outcome = await Promise.race([
        exitPromise.then((value) => ({ kind: "exit", value })),
        new Promise((resolve) => { timer = setTimeout(() => resolve({ kind: "timeout" }), limit); }),
      ]);

      if (outcome.kind === "timeout") {
        recordEvent(state, { type: "turn", sessionId: state.sessionId, status: "interrupted", reason: "timeout" });
        const stopped = await killProcessTree(child, exitPromise);
        if (!stopped) throw new Error("timed-out codex exec process tree did not terminate");
        await exitPromise;
        acceptStdout("", true);
        return contractResult({
          status: "interrupted",
          finalMessage: state.finalMessage || state.latestMessage,
          commandsRun: state.commandsRun,
          filesPatched: [...state.filesPatched],
          tokenUsage: state.tokenUsage,
          sessionId: state.sessionId,
        }, state.events);
      }

      acceptStdout("", true);
      const { code, error } = outcome.value;
      if (error) {
        recordEvent(state, { type: "turn", sessionId: state.sessionId, status: "failed", error: error.message });
      } else if (code !== 0 && !state.terminalStatus) {
        recordEvent(state, {
          type: "turn",
          sessionId: state.sessionId,
          status: "failed",
          error: stderrTail.text().trim() || `codex exec exited ${code}`,
        });
      }

      const eventStatus = state.terminalStatus;
      const status = eventStatus === "interrupted"
        ? "interrupted"
        : code === 0 && (!eventStatus || eventStatus === "completed")
          ? "completed"
          : "failed";
      return contractResult({
        status,
        finalMessage: state.finalMessage || state.latestMessage,
        commandsRun: state.commandsRun,
        filesPatched: [...state.filesPatched],
        tokenUsage: state.tokenUsage,
        sessionId: state.sessionId,
      }, state.events);
    } catch (error) {
      recordEvent(state, { type: "turn", sessionId: state.sessionId, status: "failed", error: error?.message ?? String(error) });
      return contractResult({
        status: "failed",
        finalMessage: state.finalMessage || state.latestMessage,
        commandsRun: state.commandsRun,
        filesPatched: [...state.filesPatched],
        tokenUsage: state.tokenUsage,
        sessionId: state.sessionId,
      }, state.events);
    } finally {
      clearTimeout(timer);
      active = null;
    }
  }

  async function close() {
    if (closed) return;
    closed = true;
    if (!active) return;
    const stopped = await killProcessTree(active.child, active.exitPromise);
    if (!stopped) throw new Error("codex exec process tree did not terminate during close");
  }

  return { turn, close };
}
