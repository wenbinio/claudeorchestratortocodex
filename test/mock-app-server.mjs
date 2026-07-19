#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

const threads = new Map();
const activeTurns = new Map();
let threadSequence = 0;
let turnSequence = 0;
let messageSequence = 0;
let emittedAtMs = 1_000;

function send(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function notify(method, params) {
  send({ jsonrpc: "2.0", method, params, emittedAtMs: emittedAtMs++ });
}

function textFrom(params) {
  return (params?.input ?? [])
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

async function runPromptProgram(prompt, cwd) {
  const match = /```mock-file[ \t]+([^\r\n]+)\r?\n([\s\S]*?)\r?\n```/m.exec(prompt);
  if (!match) return "Mock completed without file changes.";

  const relativePath = match[1].trim();
  const root = path.resolve(cwd);
  const destination = path.resolve(root, relativePath);
  const relation = path.relative(root, destination);
  if (!relativePath || path.isAbsolute(relativePath) || relation === ".." || relation.startsWith(`..${path.sep}`)) {
    throw new Error(`unsafe mock-file path: ${relativePath}`);
  }

  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${match[2].replace(/\r\n/g, "\n")}\n`, "utf8");
  return `Mock wrote ${relativePath}.`;
}

function completeTurn({ threadId, turnId, messageId, finalText, status = "completed", error = null, prompt = "" }) {
  notify("item/completed", {
    item: {
      type: "agentMessage",
      id: messageId,
      text: finalText,
      phase: "final_answer",
      memoryCitation: null,
    },
    threadId,
    turnId,
    completedAtMs: emittedAtMs,
  });

  const inputTokens = Math.max(1, Math.ceil(prompt.length / 4));
  const outputTokens = Math.max(1, Math.ceil(finalText.length / 4));
  const total = {
    totalTokens: inputTokens + outputTokens,
    inputTokens,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens,
    reasoningOutputTokens: 0,
  };
  notify("thread/tokenUsage/updated", {
    threadId,
    turnId,
    tokenUsage: { total, last: total, modelContextWindow: 8_192 },
  });
  notify("turn/completed", {
    threadId,
    turn: {
      id: turnId,
      items: [],
      itemsView: "notLoaded",
      status,
      error,
      startedAt: 1,
      completedAt: 2,
      durationMs: 1,
    },
  });
  activeTurns.delete(turnId);
}

async function handle(frame) {
  const { id, method, params = {} } = frame;
  if (method === "initialized" || (id === undefined && !method)) return;

  if (method === "initialize") {
    respond(id, {
      userAgent: "codex-fleet-mock/1.0.0",
      codexHome: null,
      platformFamily: process.platform === "win32" ? "windows" : "unix",
      platformOs: process.platform,
    });
    return;
  }

  if (method === "thread/start") {
    const threadId = `mock-thread-${++threadSequence}`;
    const cwd = path.resolve(params.cwd ?? process.cwd());
    threads.set(threadId, { cwd });
    respond(id, {
      thread: { id: threadId, cwd, status: { type: "idle" }, turns: [] },
      cwd,
      sandbox: { type: params.sandbox ?? "workspaceWrite", networkAccess: false },
      approvalPolicy: params.approvalPolicy ?? "never",
    });
    return;
  }

  if (method === "turn/start") {
    const thread = threads.get(params.threadId);
    if (!thread) {
      fail(id, -32_602, `unknown thread: ${params.threadId}`);
      return;
    }

    const threadId = params.threadId;
    const turnId = `mock-turn-${++turnSequence}`;
    const messageId = `mock-message-${++messageSequence}`;
    const prompt = textFrom(params);
    let finalText;
    let status = "completed";
    let error = null;
    try {
      finalText = await runPromptProgram(prompt, thread.cwd);
    } catch (caught) {
      status = "failed";
      error = { message: caught?.message ?? String(caught) };
      finalText = `Mock failed: ${error.message}`;
    }

    activeTurns.set(turnId, { threadId, turnId, messageId, prompt });
    respond(id, {
      turn: {
        id: turnId,
        items: [],
        itemsView: "notLoaded",
        status: "inProgress",
        error: null,
      },
    });
    notify("item/started", {
      item: {
        type: "agentMessage",
        id: messageId,
        text: "",
        phase: "final_answer",
        memoryCitation: null,
      },
      threadId,
      turnId,
      startedAtMs: emittedAtMs,
    });

    if (!prompt.includes("MOCK_WAIT_FOR_INTERRUPT")) {
      completeTurn({ threadId, turnId, messageId, finalText, status, error, prompt });
    }
    return;
  }

  if (method === "turn/steer") {
    const thread = threads.get(params.threadId);
    if (!thread) {
      fail(id, -32_602, `unknown thread: ${params.threadId}`);
      return;
    }

    const threadId = params.threadId;
    const turnId = `mock-turn-${++turnSequence}`;
    const messageId = `mock-message-${++messageSequence}`;
    const prompt = textFrom(params);
    let finalText;
    let status = "completed";
    let error = null;
    try {
      const programResult = await runPromptProgram(prompt, thread.cwd);
      finalText = programResult === "Mock completed without file changes."
        ? `Mock applied steer: ${prompt}`
        : programResult;
    } catch (caught) {
      status = "failed";
      error = { message: caught?.message ?? String(caught) };
      finalText = `Mock failed: ${error.message}`;
    }

    activeTurns.set(turnId, { threadId, turnId, messageId, prompt });
    respond(id, {
      turn: {
        id: turnId,
        items: [],
        itemsView: "notLoaded",
        status: "inProgress",
        error: null,
      },
    });
    notify("item/started", {
      item: {
        type: "agentMessage",
        id: messageId,
        text: "",
        phase: "final_answer",
        memoryCitation: null,
      },
      threadId,
      turnId,
      startedAtMs: emittedAtMs,
    });
    completeTurn({ threadId, turnId, messageId, finalText, status, error, prompt });
    return;
  }

  if (method === "turn/interrupt") {
    respond(id, {});
    const active = activeTurns.get(params.turnId);
    if (active && active.threadId === params.threadId) {
      completeTurn({
        ...active,
        finalText: "Mock turn interrupted.",
        status: "interrupted",
        prompt: active.prompt,
      });
    }
    return;
  }

  if (id !== undefined) fail(id, -32_601, `method not found: ${method}`);
}

function isAppServerInvocation() {
  return process.argv.slice(2).includes("app-server") || path.basename(process.argv[1] ?? "") === "app-server";
}

if (isAppServerInvocation()) {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let queue = Promise.resolve();
  input.on("line", (line) => {
    if (!line.trim()) return;
    queue = queue.then(async () => {
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        fail(null, -32_700, "parse error");
        return;
      }
      await handle(frame);
    }).catch((error) => {
      process.stderr.write(`mock app-server error: ${error?.stack ?? error}\n`);
      process.exitCode = 1;
    });
  });
}
