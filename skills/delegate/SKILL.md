---
name: delegate
description: Use when the user wants live, steerable delegation of a coding task to Codex in the current working tree, with progress narrated like a native agent while the user reviews the result.
---

# Delegate Live in the Current Tree

## Configure

1. Resolve `dataDir` to `${CLAUDE_PLUGIN_DATA}` when available; otherwise glob `~/.claude/plugins/data/*codex-fleet*/` (the on-disk id may be plugin-name or marketplace-qualified); otherwise use `~/.claude/plugins/data/codex-fleet/`.
2. Read `${dataDir}/config.json`. If missing, stop, run `/codex-fleet:setup`, then re-read it. Never guess paths or authentication. Require absolute existing `codexExe` and `nodeExe`; compare their current versions with `codexVersion` and `nodeVersion`, and re-run setup for stale paths or versions. Use configured `backend`, `model`, and `effort` verbatim.

## Prepare the direct task

Take the user's description as the task. This mode edits the current working tree directly: create no worktree and use no review gate. The user is the reviewer.

When a project verification command is known, suggest it and include it as advisory verification. Do not imply that it gates or rolls back changes; omit it when none is known.

Create `runDir = ${dataDir}/runs/delegate-<filesystem-safe-timestamp>` and write `<runDir>/task.json` with `runDir`, the absolute current working-tree path as `cwd`, the task description, absolute configured `codexExe`, and configured `backend`, `model`, `effort`, plus `verify` when known.

## Spawn one narrator wrapper

Spawn exactly one narrator wrapper agent, preferring type `codex-fleet:codex-driver` and falling back to a general agent. Give it a prompt containing all of these instructions:

1. Launch `"<absolute nodeExe>" "${CLAUDE_PLUGIN_ROOT}/runner/delegate.mjs" --start "<runDir>/task.json"` **in the background**.
2. Loop until `<runDir>/state.json` has status `done`, `interrupted`, or `failed`. Track the last consumed position and read only newly appended lines from `events.jsonl`. Narrate every meaningful beat in one terse, natural-language line: commands Codex runs, files it patches, agent messages, and advisory verification results. The narration stream in the harness panel is the product. Never dump raw JSON or repeat unchanged state.
3. Between event polls, check the wrapper's inbox for steering text relayed by the main session. Forward each instruction with `"<absolute nodeExe>" "${CLAUDE_PLUGIN_ROOT}/runner/delegate.mjs" --steer "<runDir>" "<text>"`. Sleep briefly, then repeat.
4. At terminal state, report files changed, the advisory verification outcome (or that none ran), how the user can steer next time by telling the main session `tell it to ...`, and the run-directory path.

The runner owns `events.jsonl`, `state.json`, and `steer.inbox.jsonl`; consume them through this contract rather than inventing another channel.

## Main-session duties

While the wrapper runs, relay user steering such as `tell it to use dataclasses` to the wrapper with `SendMessage`, or invoke `delegate.mjs --steer` directly with the absolute `nodeExe`. Do not spawn another agent.

After completion, show `git status` and `git diff --stat`, summarize the wrapper's result, and remind the user that nothing was auto-committed and they remain responsible for review.

Be honest about the ceiling: this provides narration-beat parity with native agents, not token-level streaming of Codex output into the panel.
