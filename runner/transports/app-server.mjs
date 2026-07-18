import { setTimeout as delay } from "node:timers/promises";

import { startCodexSession } from "../../vendor/dynamic-workflows-codex/src/codexSession.js";

const DEFAULT_TIMEOUT_MS = 600_000;
const INTERRUPT_GRACE_MS = 5_000;
const REPLAYED_TERMINAL = Symbol("codex-fleet-replayed-terminal");
const DEVELOPER_INSTRUCTIONS = [
  "You are a Codex Fleet implementation worker.",
  "Work only inside the assigned working directory.",
  "Do not run git commands, create commits, change branches, or modify another worktree.",
  "Implement only the requested task and summarize the changes in the final answer.",
].join(" ");

// codexSession.js deliberately shares one self-healing app-server client. Keep
// it alive until the last worker using it closes, so parallel workers do not
// tear down one another's transport.
const clientReferences = new Map();
let sessionsStarting = 0;
const sessionStartWaiters = new Set();

function beginSessionStart() {
  sessionsStarting += 1;
}

function endSessionStart() {
  sessionsStarting = Math.max(0, sessionsStarting - 1);
  if (sessionsStarting !== 0) return;
  for (const resolve of sessionStartWaiters) resolve();
  sessionStartWaiters.clear();
}

async function waitForSessionStarts() {
  while (sessionsStarting > 0) {
    await new Promise((resolve) => sessionStartWaiters.add(resolve));
  }
}

function retainClient(client) {
  clientReferences.set(client, (clientReferences.get(client) ?? 0) + 1);
}

async function releaseClient(client, force = false) {
  if (!client) return;
  if (force) {
    clientReferences.delete(client);
    await client.shutdown().catch(() => {});
    return;
  }

  const remaining = Math.max(0, (clientReferences.get(client) ?? 1) - 1);
  if (remaining > 0) {
    clientReferences.set(client, remaining);
    return;
  }
  clientReferences.delete(client);
  await waitForSessionStarts();
  if ((clientReferences.get(client) ?? 0) > 0) return;
  await client.shutdown().catch(() => {});
}

function safeOnEvent(onEvent, event) {
  if (typeof onEvent !== "function") return;
  try {
    onEvent(event);
  } catch {
    // Observability must never break the worker lifecycle.
  }
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

function makeTurnState(onEvent) {
  return {
    commandsRun: 0,
    commandIds: new Set(),
    filesPatched: new Set(),
    finalMessage: "",
    latestMessage: "",
    tokenUsage: null,
    events: [],
    onEvent,
  };
}

function recordEvent(state, event) {
  state.events.push(event);
  safeOnEvent(state.onEvent, event);
}

function collectNotification(note, state, threadId) {
  if (!note || note[REPLAYED_TERMINAL]) return;
  const params = note.params ?? {};
  if (params.threadId && params.threadId !== threadId) return;

  if (note.method === "item/completed" && params.item) {
    const item = params.item;
    const type = normalizedItemType(item.type);
    const eventBase = {
      type,
      threadId,
      turnId: params.turnId ?? params.turn?.id ?? null,
      itemId: item.id ?? params.itemId ?? null,
      status: item.status ?? "completed",
      raw: note,
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
        recordEvent(state, {
          ...eventBase,
          text,
          phase,
          final: phase === "final_answer",
        });
        break;
      }
      default:
        break;
    }
  } else if (note.method === "thread/tokenUsage/updated") {
    state.tokenUsage = params.tokenUsage?.total ?? params.tokenUsage ?? state.tokenUsage;
    recordEvent(state, {
      type: "tokenUsage",
      threadId,
      turnId: params.turnId ?? null,
      tokenUsage: state.tokenUsage,
      raw: note,
    });
  } else if (note.method === "turn/completed") {
    const turn = params.turn ?? {};
    recordEvent(state, {
      type: "turn",
      threadId,
      turnId: turn.id ?? null,
      status: turn.status ?? "failed",
      error: turn.error?.message ?? null,
      raw: note,
    });
  }
}

function terminalFor(note, threadId, turnId) {
  return note?.method === "turn/completed" &&
    note.params?.threadId === threadId &&
    note.params?.turn?.id === turnId;
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
  // The core uses this for transcript detail, while the enumerable public shape
  // remains exactly the frozen transport contract.
  Object.defineProperty(result, "events", { value: events, enumerable: false });
  return result;
}

function settledWithin(promise, timeoutMs) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).then(
      (value) => ({ settled: true, value }),
      (error) => ({ settled: true, error }),
    ),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ settled: false }), Math.max(0, timeoutMs));
    }),
  ]).finally(() => clearTimeout(timer));
}

function denyServerRequest(request) {
  const method = String(request?.method ?? "");
  if (method === "item/tool/call" || /dynamic.?tool/i.test(method)) {
    return {
      success: false,
      contentItems: [{ type: "inputText", text: "Dynamic tools are disabled for fleet workers." }],
    };
  }
  if (/approval|permission|escalat/i.test(method)) {
    return { decision: "decline" };
  }
  throw new Error(`Rejected unsupported app-server request: ${method || "(missing method)"}`);
}

export async function createWorker({ codexExe, cwd, model, effort, onEvent } = {}) {
  if (!cwd) throw new TypeError("createWorker requires cwd");

  let driver = null;
  let clientRetained = false;
  let closed = false;
  let broken = false;
  let active = false;

  async function ensureDriver() {
    if (closed) throw new Error("worker is closed");
    if (broken) throw new Error("worker transport is no longer usable");
    if (driver) return driver;

    beginSessionStart();
    try {
      driver = await startCodexSession({
        cwd,
        model,
        sandbox: "workspace-write",
        systemPrompt: DEVELOPER_INSTRUCTIONS,
        approvalPolicy: "never", // buildThreadParams enforces this on thread/start.
        clientOptions: {
          command: codexExe ?? "codex",
          cwd,
          approvalPolicy: "never",
          requestHandler: denyServerRequest,
        },
      });
    } finally {
      endSessionStart();
    }
    retainClient(driver.client);
    clientRetained = true;
    return driver;
  }

  async function forceStop() {
    broken = true;
    if (!driver) return;
    await driver.interruptCurrent().catch(() => {});
    await driver.cleanup().catch(() => {});
    if (clientRetained) {
      clientRetained = false;
      // Ref-counted release only: the app-server client is a process-wide
      // singleton (vendored getClient). A timed-out/broken worker must release
      // its own reference — NEVER force-shutdown, which would tear down the
      // shared client and fail every other concurrent worker in the pool.
      await releaseClient(driver.client);
    }
  }

  async function turn(prompt, { timeoutMs } = {}) {
    if (active) throw new Error("worker already has an active turn");
    const session = await ensureDriver();
    active = true;

    const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    const deadline = Date.now() + limit;
    const state = makeTurnState(onEvent);
    const terminalNotes = [];
    let turnId = null;
    let resolveTerminal;
    const terminalPromise = new Promise((resolve) => { resolveTerminal = resolve; });
    let resolveTransportFailure;
    const transportFailure = new Promise((resolve) => { resolveTransportFailure = resolve; });

    const onNotification = (note) => {
      collectNotification(note, state, session.threadId);
      if (note?.method !== "turn/completed" || note.params?.threadId !== session.threadId) return;
      terminalNotes.push(note);
      if (turnId && terminalFor(note, session.threadId, turnId)) resolveTerminal(note);
    };
    const onTransport = (event) => {
      if (event?.stage === "exit" || event?.stage === "error") resolveTransportFailure(event);
    };

    // Both listeners precede beginTurn(), and therefore precede turn/start. This
    // closes the fast-completion race in the vendored driver's own waiter.
    session.client.on("notification", onNotification);
    session.client.on("transport", onTransport);

    let handle = null;
    try {
      const beginPromise = session.beginTurn(String(prompt), {
        model,
        effort,
        timeoutMs: limit + INTERRUPT_GRACE_MS + 60_000,
      });
      let began = await settledWithin(beginPromise, Math.max(0, deadline - Date.now()));

      if (!began.settled) {
        await session.interruptCurrent();
        began = await settledWithin(beginPromise, INTERRUPT_GRACE_MS);
        if (!began.settled || began.error) {
          recordEvent(state, { type: "turn", threadId: session.threadId, turnId: null, status: "failed", reason: "timeout" });
          await forceStop();
          return contractResult({
            status: "failed",
            finalMessage: state.finalMessage || state.latestMessage,
            commandsRun: state.commandsRun,
            filesPatched: [...state.filesPatched],
            tokenUsage: state.tokenUsage,
            sessionId: session.threadId,
          }, state.events);
        }
      }
      if (began.error) throw began.error;

      handle = began.value;
      turnId = handle?.turnId ?? null;
      if (!turnId) {
        await forceStop();
        throw new Error("turn/start did not return turn.id");
      }

      const buffered = terminalNotes.find((note) => terminalFor(note, session.threadId, turnId));
      if (buffered) resolveTerminal(buffered);

      let completionSettled = false;
      handle.completion.finally(() => { completionSettled = true; });
      await Promise.resolve();
      if (buffered && !completionSettled) {
        Object.defineProperty(buffered, REPLAYED_TERMINAL, { value: true, configurable: true });
        session.client.emit("notification", buffered);
      }

      const remaining = Math.max(0, deadline - Date.now());
      let terminalRace = await Promise.race([
        terminalPromise.then((note) => ({ kind: "terminal", note })),
        transportFailure.then((event) => ({ kind: "transport", event })),
        delay(remaining).then(() => ({ kind: "timeout" })),
      ]);

      if (terminalRace.kind === "timeout") {
        recordEvent(state, { type: "turn", threadId: session.threadId, turnId, status: "interrupted", reason: "timeout" });
        await session.interruptCurrent();
        terminalRace = await Promise.race([
          terminalPromise.then((note) => ({ kind: "terminal", note })),
          transportFailure.then((event) => ({ kind: "transport", event })),
          delay(INTERRUPT_GRACE_MS).then(() => ({ kind: "grace-expired" })),
        ]);
      }

      if (terminalRace.kind !== "terminal") {
        await forceStop();
        return contractResult({
          status: "failed",
          finalMessage: state.finalMessage || state.latestMessage,
          commandsRun: state.commandsRun,
          filesPatched: [...state.filesPatched],
          tokenUsage: state.tokenUsage,
          sessionId: session.threadId,
        }, state.events);
      }

      const completed = await settledWithin(handle.completion, INTERRUPT_GRACE_MS);
      if (!completed.settled) {
        // The terminal event proves the writer stopped, but a missed vendored
        // waiter would leave the session marked active. Replaying is safe and
        // lets CodexSessionDriver perform collector cleanup and token metering.
        const terminal = terminalRace.note;
        Object.defineProperty(terminal, REPLAYED_TERMINAL, { value: true, configurable: true });
        session.client.emit("notification", terminal);
      }
      const outcomeResult = completed.settled ? completed : await settledWithin(handle.completion, INTERRUPT_GRACE_MS);
      const outcome = outcomeResult.value ?? null;
      const rawStatus = terminalRace.note.params?.turn?.status;
      const status = rawStatus === "completed" ? "completed" : rawStatus === "interrupted" ? "interrupted" : "failed";

      return contractResult({
        status,
        finalMessage: state.finalMessage || outcome?.text || state.latestMessage,
        commandsRun: state.commandsRun,
        filesPatched: [...state.filesPatched],
        tokenUsage: outcome?.tokens ?? state.tokenUsage,
        sessionId: session.threadId,
      }, state.events);
    } catch (error) {
      recordEvent(state, {
        type: "turn",
        threadId: session.threadId,
        turnId,
        status: "failed",
        error: error?.message ?? String(error),
      });
      return contractResult({
        status: "failed",
        finalMessage: state.finalMessage || state.latestMessage,
        commandsRun: state.commandsRun,
        filesPatched: [...state.filesPatched],
        tokenUsage: state.tokenUsage,
        sessionId: session.threadId,
      }, state.events);
    } finally {
      session.client.off("notification", onNotification);
      session.client.off("transport", onTransport);
      active = false;
    }
  }

  async function close() {
    if (closed) return;
    closed = true;
    if (!driver) return;
    if (active) {
      await driver.interruptCurrent().catch(() => {});
      await delay(INTERRUPT_GRACE_MS).catch(() => {});
    }
    await driver.cleanup().catch(() => {});
    if (clientRetained) {
      clientRetained = false;
      await releaseClient(driver.client);
    }
  }

  return { turn, close };
}
