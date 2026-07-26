---
name: delegate
description: Use when the user wants live, steerable delegation of a coding task to Codex in the current working tree, with progress narrated like a native agent while the user reviews the result.
---

# Delegate Live in the Current Tree

## Configure

1. Resolve `dataDir` to `${CLAUDE_PLUGIN_DATA}` when available; otherwise glob `~/.claude/plugins/data/*codex-fleet*/` (the on-disk id may be plugin-name or marketplace-qualified); otherwise use `~/.claude/plugins/data/codex-fleet/`.
2. Read `${dataDir}/config.json`. If missing, stop, run `/codex-fleet:setup`, then re-read it. Never guess paths or authentication. Require absolute existing `codexExe` and `nodeExe`; if either path no longer exists (the Codex binary path is hash-versioned and drifts on app updates), re-run setup before continuing. Use configured `model` and `effort` verbatim.
3. Delegate requires the app-server backend — it holds one live thread open. If `config.backend !== "app-server"`, stop and tell the user plainly: delegate is unavailable on this machine's backend; use `/codex-fleet:solo` (which works on either) or re-run `/codex-fleet:setup` to re-probe. Do not launch the runner and let it die inside the transport.

## Prepare the direct task

Take the user's description as the task. This mode edits the current working tree directly: create no worktree and use no review gate. The user is the reviewer.

When a project verification command is known, suggest it and include it as advisory verification. Do not imply that it gates or rolls back changes; omit it when none is known.

Before launching, record a baseline: run `git status --porcelain` in the repo and keep the output. The final report must attribute only the *delta* to Codex — never present the user's own pre-existing dirty files as run output.

Create `runDir = ${dataDir}/runs/delegate-<filesystem-safe-timestamp>` and write `<runDir>/task.json` using EXACTLY these keys — the runner validates them and rejects anything else as missing:

```json
{
  "repo": "<absolute current working-tree path>",
  "codexExe": "<absolute configured codexExe>",
  "task": "<the task description>",
  "runDir": "<the runDir path>",
  "model": "<configured model>",
  "effort": "<configured effort>",
  "verify": "<advisory verify command, omit when unknown>"
}
```

`repo`, `codexExe`, `task`, and `runDir` are required; `model`, `effort`, `verify`, and `isolated` are optional. There is no `cwd` key and no `backend` key.

## Spawn one narrator wrapper

Spawn exactly one narrator wrapper agent **in the background** (the main session must stay free to receive and relay your steering). Use a general-purpose agent — do NOT use `codex-fleet:codex-driver`, whose persona forbids prose and demands a structured-only final message, which is the opposite of narration. Give it a prompt containing all of these instructions:

1. Launch `"<absolute nodeExe>" "${CLAUDE_PLUGIN_ROOT}/runner/delegate.mjs" --start "<runDir>/task.json"` **in the background**.
2. Loop until `<runDir>/state.json` has status `done`, `interrupted`, or `failed`. Track the last consumed position and read only newly appended lines from `events.jsonl`. Render each meaningful beat as one line, **passing Codex's own words through verbatim rather than paraphrasing them** — agent messages and reasoning summaries as written, commands as `$ <command> → exit <code>`, file changes as paths, advisory verify as its result line. Your voice is for structure only; Codex's text is the content. Never dump raw JSON, never repeat unchanged state, and coalesce streaming `item/agentMessage/delta` events into the message they compose instead of emitting one line per delta.
3. When `state.json` turns `awaiting-steer`, say so explicitly and name the window — the run idles for a bounded period and then finishes on its own, so the user knows they can redirect it now or let it wrap.
4. Between event polls, check the wrapper's inbox for steering text relayed by the main session. Forward each instruction with `"<absolute nodeExe>" "${CLAUDE_PLUGIN_ROOT}/runner/delegate.mjs" --steer "<runDir>" "<text>"`. Sleep briefly, then repeat.
5. At terminal state, report files changed (the DELTA against the baseline you recorded), the advisory verification outcome (or that none ran), how the user can steer next time by telling the main session `tell it to ...`, and the run-directory path.

The runner owns `events.jsonl`, `state.json`, and the `steer.inbox/` directory (one JSON file per message, written atomically); consume them through this contract rather than inventing another channel.

## Main-session duties

While the wrapper runs, relay user steering such as `tell it to use dataclasses` to the wrapper with `SendMessage`, or invoke `delegate.mjs --steer` directly with the absolute `nodeExe`. Do not spawn another agent.

After completion, show `git status` and `git diff --stat`, summarize the wrapper's result, and remind the user that nothing was auto-committed and they remain responsible for review.

Be honest about the ceiling. Steering currently lands as a follow-up turn on the same warm thread: an instruction sent while Codex is mid-turn applies when that turn ends, not inside it. Say "queued — it'll pick this up next turn," never imply it interrupted the model. (True mid-turn `turn/steer` is specified and mocked but not yet wired.)
