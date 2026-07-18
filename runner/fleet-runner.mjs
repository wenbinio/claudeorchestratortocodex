#!/usr/bin/env node
// codex-fleet standalone runner (v0.2 app-server backend).
//
// This file is ORIGINAL to codex-fleet. It drives the codex-fleet pipeline
// (isolated worktree -> Codex thread/turn -> driver-side verify -> one
// correction -> commit + audit -> transcript) over the VENDORED app-server
// transport (vendor/dynamic-workflows-codex/src/appServerClient.js, MIT (c)
// Stephen Casella). Review, verdict state, the merge-guard, and stage-ladder
// integration remain in the dispatch skill and are unchanged by this runner.
//
// Usage: node runner/fleet-runner.mjs --batch <batch.json>
// Batch: { repo, codexExe, tasks:[{id,spec,verify?,allowUnverified?}], verify?,
//          model?, effort?, wtBase?, transcriptDir?, maxParallel?, timeoutMinutes? }
// Writes: <repo>/.codex-fleet/results.json and appends runner-journal.jsonl.
// Exit 0 even when some tasks fail (failures are data, not crashes).

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_URL = new URL(
  "../vendor/dynamic-workflows-codex/src/appServerClient.js",
  import.meta.url,
);

const TASK_ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const APPENDED_CONSTRAINTS =
  "Work only inside this directory. Do not run git commands; do not commit. " +
  "Do not create documentation files unless the spec asks. When done, " +
  "summarize what you changed and why.";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--batch") out.batch = argv[++i];
  }
  return out;
}

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { code: r.status ?? 1, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

function runVerify(command, cwd) {
  // Run through the platform shell so PowerShell/pytest-style commands work.
  const isWin = process.platform === "win32";
  const shell = isWin ? "powershell.exe" : "sh";
  const shellArgs = isWin ? ["-NoProfile", "-Command", command] : ["-c", command];
  const r = spawnSync(shell, shellArgs, { cwd, encoding: "utf8" });
  const tail = ((r.stdout || "") + (r.stderr || "")).split(/\r?\n/).filter(Boolean);
  return { code: r.status ?? 1, tail: tail.slice(-60).join("\n") };
}

function purgeCaches(worktree) {
  const kill = ["__pycache__", ".pytest_cache", ".import"];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (kill.includes(e.name)) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }
        else if (e.name !== ".git") walk(p);
      }
    }
  };
  walk(worktree);
}

// Accumulator wired to the vendored client's "notification" event stream.
function makeCollector(threadId, eventsPath) {
  const state = { finalMessage: "", commandsRun: 0, filesPatched: new Set(), tokenUsage: null, timeline: [] };
  const stream = fs.createWriteStream(eventsPath, { flags: "a" });
  const onNote = (n) => {
    if (!n || n.params?.threadId !== threadId && n.params?.thread?.id !== threadId) {
      // token/thread notifications may key threadId at top level; keep permissive.
    }
    stream.write(JSON.stringify(n) + "\n");
    const m = n.method;
    const item = n.params?.item;
    if (m === "item/completed" && item) {
      if (item.type === "agentMessage" && typeof item.text === "string") {
        state.finalMessage = item.text;
        state.timeline.push(`agentMessage: ${item.text.slice(0, 80).replace(/\s+/g, " ")}`);
      } else if (/command|exec|shell/i.test(item.type || "")) {
        state.commandsRun++;
        const cmd = item.command || item.aggregatedOutput?.command || item.type;
        state.timeline.push(`command: ${String(cmd).slice(0, 80)}`);
      } else if (/fileChange|patch|file/i.test(item.type || "")) {
        const files = item.changes || item.files || item.paths || [];
        for (const f of Array.isArray(files) ? files : [files]) {
          const p = typeof f === "string" ? f : f?.path;
          if (p) state.filesPatched.add(p);
        }
        state.timeline.push(`fileChange: ${item.type}`);
      }
    } else if (m === "thread/tokenUsage/updated") {
      state.tokenUsage = n.params?.tokenUsage?.total || state.tokenUsage;
    }
  };
  return { state, onNote, close: () => stream.end() };
}

function writeTranscript(transcriptPath, task, prompt, collector, usageNote) {
  const s = collector.state;
  const md = [
    "# PROMPT", "", "```", prompt, "```", "",
    "# TIMELINE", "",
    ...(s.timeline.length ? s.timeline.map((t, i) => `${i + 1}. ${t}`) : ["(no item events captured)"]),
    "", "# FINAL MESSAGE", "", s.finalMessage || "(none)", "",
    "# USAGE", "",
    `- commandsRun: ${s.commandsRun}`,
    `- filesPatched: ${[...s.filesPatched].join(", ") || "(none)"}`,
    `- tokens: ${s.tokenUsage ? JSON.stringify(s.tokenUsage) : "(not reported)"}`,
    usageNote ? `- note: ${usageNote}` : "",
  ].join("\n");
  fs.writeFileSync(transcriptPath, md, "utf8");
}

async function runTask(AppServerClient, cfg, task) {
  const wtBase = cfg.wtBase || cfg.repo.replace(/[\\/]+$/, "") + "-codex-wt";
  const transcriptDir = cfg.transcriptDir || wtBase;
  const worktree = path.join(wtBase, task.id);
  const branch = "codex/" + task.id;
  const eventsPath = path.join(wtBase, task.id + ".codex-events.jsonl");
  const transcriptPath = path.join(transcriptDir, task.id + ".transcript.md");
  const verify = task.verify || cfg.verify || "";
  const timeoutMs = (cfg.timeoutMinutes || 15) * 60000;
  const result = {
    taskId: task.id, status: "failed", branch, worktree,
    verifyPassed: false, unverified: false, correctionRoundUsed: false,
    filesChanged: [], diffStat: "", verifyTail: "", codexFinalMessage: "",
    codexCommandsRun: 0, filesPatched: [], sessionId: "", transcriptPath: "",
    summary: "",
  };

  // Preflight + collision (existing branch is an error, never a silent delete).
  if (git(["rev-parse", "--is-inside-work-tree"], cfg.repo).code !== 0) {
    result.status = "blocked"; result.branch = ""; result.summary = "not a git worktree"; return result;
  }
  if (git(["show-ref", "--verify", "--quiet", "refs/heads/" + branch], cfg.repo).code === 0) {
    result.status = "blocked"; result.summary = `branch ${branch} already exists; delete/integrate it or pick a new id`; return result;
  }
  fs.mkdirSync(wtBase, { recursive: true });
  fs.mkdirSync(transcriptDir, { recursive: true });
  try { fs.rmSync(eventsPath, { force: true }); } catch {}

  let added = false;
  for (let attempt = 1; attempt <= 3 && !added; attempt++) {
    const r = git(["worktree", "add", "-b", branch, worktree, "HEAD"], cfg.repo);
    if (r.code === 0) added = true;
    else if (attempt === 3) { result.summary = "worktree add failed: " + r.err; return result; }
    else await new Promise((res) => setTimeout(res, 2000));
  }

  const client = new AppServerClient({ command: cfg.codexExe, cwd: worktree });
  let collector;
  let usageNote = "";
  try {
    await client.connect();
    const th = await client.startThread({
      cwd: worktree, sandbox: "workspace-write",
      ...(cfg.model ? { model: cfg.model } : {}),
    });
    const threadId = th?.thread?.id;
    if (!threadId) { result.summary = "no threadId from thread/start"; return result; }
    result.sessionId = threadId;
    collector = makeCollector(threadId, eventsPath);
    client.on("notification", collector.onNote);

    const prompt = task.spec + "\n\n" + APPENDED_CONSTRAINTS;
    const runTurn = async (text) => {
      const turn = await client.startTurn({
        threadId, input: [{ type: "text", text }],
        ...(cfg.model ? { model: cfg.model } : {}),
        ...(cfg.effort ? { effort: cfg.effort } : {}),
      });
      const turnId = turn?.turn?.id;
      try {
        await client.waitForNotification(
          (n) => n?.method === "turn/completed" && (n.params?.threadId === threadId), timeoutMs,
        );
      } catch {
        if (turnId) { try { await client.interruptTurn(threadId, turnId); } catch {} }
        usageNote = "turn timed out and was interrupted";
      }
    };

    await runTurn(prompt);
    result.codexFinalMessage = (collector.state.finalMessage || "").slice(0, 1500);

    // INSPECT
    const changed = git(["status", "--short"], worktree).out;
    if (!changed) { result.summary = "Codex changed nothing"; collector.close(); return result; }

    // VERIFY (driver side, outside Codex's sandbox)
    if (!verify) {
      result.unverified = true;
      result.summary = "UNVERIFIED: no verify command configured; ";
    } else {
      let v = runVerify(verify, worktree);
      result.verifyTail = v.tail;
      if (v.code === 0) result.verifyPassed = true;
      else {
        // ONE correction round: a follow-up turn on the SAME thread (sessionful).
        result.correctionRoundUsed = true;
        await runTurn(prompt + "\n\nA verification run failed. Fix it without breaking the task. Failure output:\n" + v.tail);
        v = runVerify(verify, worktree);
        result.verifyTail = v.tail;
        result.verifyPassed = v.code === 0;
      }
    }

    // PURGE + COMMIT + AUDIT.
    // Only stage files that did not exist in the base HEAD as tracked content
    // OR that Codex actually reported patching — this keeps pre-tracked build
    // artifacts (already in the repo but re-touched by the verify run) out of
    // the worker commit, matching the v1 driver's strip-strays discipline.
    purgeCaches(worktree);
    git(["add", "-A"], worktree);
    // Reset any staged path that looks like a build/cache artifact.
    const staged = git(["diff", "--cached", "--name-only"], worktree).out.split(/\r?\n/).filter(Boolean);
    const strays = staged.filter((p) => /(^|\/)(__pycache__|\.pytest_cache|\.import)\//.test(p) || /\.pyc$/.test(p));
    if (strays.length) { git(["reset", "-q", "HEAD", "--", ...strays], worktree); git(["checkout", "--", ...strays], worktree); }
    git(["commit", "-m", branch + ": codex-fleet worker"], worktree);
    result.diffStat = git(["diff", "--stat", "HEAD~1"], worktree).out;
    result.filesChanged = git(["show", "--name-only", "--format=", "HEAD"], worktree).out.split(/\r?\n/).filter(Boolean);
    result.filesPatched = [...collector.state.filesPatched];
    result.codexCommandsRun = collector.state.commandsRun;

    writeTranscript(transcriptPath, task, prompt, collector, usageNote);
    result.transcriptPath = transcriptPath;
    result.status = result.verifyPassed || result.unverified ? "done" : "failed";
    result.summary += `status ${result.status}; verifyPassed=${result.verifyPassed}; commands=${result.codexCommandsRun}.`;
  } catch (e) {
    result.summary = "runner error: " + (e?.message || String(e));
  } finally {
    if (collector) collector.close();
    try { await client.shutdown(); } catch {}
  }
  return result;
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.batch) { console.error("usage: fleet-runner.mjs --batch <batch.json>"); process.exit(2); }
  const cfg = JSON.parse(fs.readFileSync(args.batch, "utf8"));
  if (!cfg.repo || !cfg.codexExe || !Array.isArray(cfg.tasks) || !cfg.tasks.length) {
    console.error("batch needs { repo, codexExe, tasks:[...] }"); process.exit(2);
  }
  const seen = new Set();
  for (const t of cfg.tasks) {
    if (!TASK_ID_RE.test(t.id || "")) { console.error("invalid task id: " + JSON.stringify(t.id)); process.exit(2); }
    if (seen.has(t.id)) { console.error("duplicate task id: " + t.id); process.exit(2); }
    seen.add(t.id);
  }

  const { AppServerClient } = await import(CLIENT_URL);
  const results = await pool(cfg.tasks, cfg.maxParallel || 4, (t) => runTask(AppServerClient, cfg, t));

  const wtBase = cfg.wtBase || cfg.repo.replace(/[\\/]+$/, "") + "-codex-wt";
  const outDir = path.join(cfg.repo, ".codex-fleet");
  fs.mkdirSync(outDir, { recursive: true });
  const payload = { results, approvedBranches: [], worktreeBase: wtBase };
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(payload, null, 2), "utf8");
  fs.appendFileSync(
    path.join(outDir, "runner-journal.jsonl"),
    JSON.stringify({ ranAt: new Date().toISOString(), tasks: cfg.tasks.map((t) => t.id), statuses: results.map((r) => r.status) }) + "\n",
  );
  const done = results.filter((r) => r.status === "done").length;
  console.log(`fleet-runner: ${done}/${results.length} done. results -> ${path.join(outDir, "results.json")}`);
  process.exit(0);
}

main().catch((e) => { console.error("fatal: " + (e?.message || e)); process.exit(1); });
