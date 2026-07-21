# Codex Fleet

**Claude plans, reviews, and integrates; Codex writes the code — and nothing lands until an adversarial reviewer independently re-runs the tests and passes it.**

Codex Fleet is a Claude Code plugin that treats LLM-generated code as an untrusted supply chain. You describe the work; Claude drafts grounded task specs and dispatches OpenAI Codex (`gpt-5.6-sol`) workers; each worker runs in its own isolated Git worktree; the Claude driver verifies the result *outside* Codex's sandbox; a separate adversarial reviewer re-runs the verification independently before anything is approved; and only approved work is integrated — landing as one verified, staged diff in your working tree, exactly like a native Claude Code edit.

```text
you describe work
   └─ Claude writes grounded, single-concern task specs
        └─ Codex workers (parallel, isolated worktrees) write code
             └─ driver verifies OUTSIDE Codex's sandbox
                  └─ adversarial reviewer re-runs verify independently → approve / needs_work / reject
                       └─ only approved branches integrate → one staged, verified diff in your tree
```

## Why this instead of…

**…just telling Codex to do it?** A bare `codex exec` gives you code and a hope. Codex Fleet gives you code plus an independent, adversarial gate: the reviewer trusts only the diff, re-runs the tests itself, and rejects scope creep — and the SHA-keyed merge guard blocks any `codex/*` branch from merging through Claude's tools until that gate has recorded an `approve` for the branch's exact tip. Work that fails verification is parked on its branch, not silently merged.

**…[scasella/claude-dynamic-workflows-codex](https://github.com/scasella/claude-dynamic-workflows-codex)?** That project — whose app-server transport this one vendors, with attribution intact — is a general workflow-DSL runtime for running fleets of Codex workers over research, triage, and brainstorm tasks. Codex Fleet is narrower and git-native: it is a code-**delivery** pipeline. Isolated worktrees per task, mandatory independent verification, adversarial review, SHA-keyed merge gating, and stage-ladder integration that lands a clean diff in your tree. It answers a different question — not "how do I orchestrate Codex workers?" but "how do I let an LLM write code into my repo without trusting a word of it?"

Nobody else in this niche treats the model's output as an untrusted supply chain. That is the whole point.

## Quickstart

Three commands in Claude Code get you from zero to dispatching:

```text
/plugin marketplace add wenbinio/claudeorchestratortocodex
/plugin install codex-fleet@wenbinio
/codex-fleet:setup
```

The `/plugin` commands need an **interactive** Claude Code session (or use the desktop app's Plugins browser: Code tab → **+** → Plugins — no terminal needed). If the new skills don't appear immediately after install, run `/reload-plugins` or start a fresh session.

For everyday work, delegate one task live and steer it mid-flight:

```text
/codex-fleet:delegate refactor the parser to use dataclasses — watch it work, steer it mid-flight
```

Use dispatch when you want a batch:

```text
/codex-fleet:dispatch
```

### Quick single-task use

```text
/codex-fleet:solo fix the failing date parse in utils/dates.py
```

`solo` trades the multi-branch ladder for speed; review stays on by default.

The three tiers are: `delegate` (live, steerable, your tree, you review) / `solo` (isolated, verified, adversarially reviewed) / `dispatch` (parallel batches, full pipeline).

`setup` runs once per machine: it discovers your Codex CLI, verifies non-interactive auth with a trivial READY smoke, probes the runner backend, and writes machine-local config to the plugin data directory (never into the repo). `dispatch` plans the tasks, runs the fleet, records verdicts, and integrates only approved branches.

## Requirements

- Claude Code
- Codex CLI — installed through the desktop app, or with `npm i -g @openai/codex`
- A ChatGPT login, or an `OPENAI_API_KEY`
- Git
- Node ≥ 18 (optional but recommended — enables the runner and its app-server backend; without it the plugin falls back to Agent-tool orchestration of the same pipeline)

Without any Codex auth at all, the plugin still runs: it falls back to Claude subagents implementing the tasks under the *same* worktree, verification, review, and integration pipeline.

## Architecture at a glance

- **Two skills** — `setup` (once-per-machine bootstrap) and `dispatch` (the orchestrator).
- **One runner-first lifecycle** (`runner/task-runner.mjs`): worktree → Codex turn(s) → quiescence → verify → one correction round → checked commit → transcript. Two transports sit behind it — **app-server** (sessionful Codex threads over `codex app-server` JSON-RPC; selected when Node ≥ 18 and the probe passes) and **exec** (`codex exec` shelling). The former Workflow-tool engine survives only as `docs/reference/v2-workflow-engine.js`, a historical, non-normative reference.
- **Two agents** — `codex-driver` (orchestrates and verifies, never edits source itself) and `fleet-reviewer` (adversarial; tools mechanically restricted to no-write; must re-run verify).
- **One merge-guard hook** (`Bash` + `PowerShell` scripts) — a PreToolUse seatbelt that blocks Claude-tool merges of `codex/*` branches whose tip SHA has no recorded `approve`.
- **Persistent data-directory state** — `config.json`, `fleet-log.jsonl`, `approved.json`, and per-worker files under `transcripts/`, all outside your repo.
- **Vendored third-party code** under `vendor/` (see its `NOTICE.md`).

### How work lands: the stage ladder

The default `stage` integration mode is the flagship behavior. Approved branches are applied in verdict order via a temp-commit ladder; the full project verification runs after each application; a red verify parks that branch and rolls back only its own temp commit; and a final `git reset --soft` collapses everything that passed into one staged, uncommitted diff. (`--skip-reverify-single` skips the redundant post-application verify when exactly one approved branch is staged; multi-branch ladders always re-verify every rung.) **No fleet commits remain in your history** — you inspect the diff and commit when you're ready, just like native in-editor work. (`commit` mode leaves per-branch merge commits; `manual` mode integrates nothing and hands you the branches.)

### Observability

Each Codex worker gets a transcript — prompt, command timeline with exit statuses, patched files, final message, and token/duration usage — and the run report links to each one. Workers are non-ephemeral, so sessions also appear in the Codex app, and you can interrogate one afterward:

```sh
codex exec resume <sessionId>
```

Every fleet commit also carries `Codex-Fleet-Task:` and `Codex-Session:` trailers, so the fleet log and your git history form a traceable audit trail in both directions.

### MCP surface

The plugin ships a zero-dependency Node ≥ 18 MCP server that loads automatically, including in cloud sandboxes. Its six tools list fleet runs (`fleet_runs`), summarize one run (`fleet_run`), read a task transcript (`fleet_transcript`), show delegate state and recent event beats (`delegate_status`), queue steering (`delegate_steer`), and request interruption (`delegate_interrupt`). The server touches only the local plugin data directory and needs no credentials.

## The merge guard

The merge guard is an **advisory seatbelt, not a security boundary.** It gates Claude's own shell-tool calls only; it never touches commands you run in your own terminal. It matches `git merge` and `git merge --squash` of `codex/*` branches and checks verdicts keyed to the branch tip SHA. A recorded branch whose tip no longer matches its reviewed SHA is blocked as unreviewed — the branch changed after review. Fail-open is limited to unknown repositories, unknown branches, missing or corrupt state, and guard errors (a guard bug must never brick an unrelated merge). Rebase, cherry-pick, and pull are not matched. The dispatch pipeline's verdict-and-verification protocol is the real enforcement; the guard is a backstop.

## Cloud sandboxes

Cloud sessions cannot run `/plugin`. To expose Codex Fleet to claude.ai/code sessions, check this exact block into `.claude/settings.json` in any repository that should have access:

```json
{
  "enabledPlugins": { "codex-fleet@wenbinio": true },
  "extraKnownMarketplaces": {
    "wenbinio": {
      "source": { "source": "github", "repo": "wenbinio/claudeorchestratortocodex" }
    }
  }
}
```

Add `OPENAI_API_KEY` as an environment secret. Skills and agents load in cloud sandboxes, and hooks (including the merge guard) fire in cloud sessions with `CLAUDE_CODE_REMOTE=true` set — though cloud guard behavior is on the untested-at-release list below. Without a key, the plugin uses the Claude-only fallback. Cloud data-directory persistence may require rerunning `setup` per session.

## Costs

Codex worker usage bills to your OpenAI plan. Fleet runs also consume Claude tokens for planning, the driver and reviewer agents, verification, and integration.

## Limitations & release status

Honest about what has and hasn't been exercised by a real run:

- **Untested at release:** the POSIX driver path, the second-Windows-machine path, and the cloud sandbox surface (including cloud merge-guard behavior). Those first runs *are* the validation for those environments.
- The merge guard is advisory and covers only `git merge`/`git merge --squash` of `codex/*` through Claude's tools — rebase, cherry-pick, pull, and your own terminal are outside its scope by design.
- Codex's sandbox cannot reliably run local toolchains, so **task specs must never ask Codex to run tests** — the driver verifies outside it. This is baked into the spec-writing rules.
- The `exec` transport feeds the prompt via stdin/temp file (v0.4.1), so the Windows ~32 KB command-line cap no longer applies; the app-server transport sends prompts over JSON-RPC and is preferred when available.
- Single-provider (Codex / `gpt-5.6-sol`). No Gemini/other-CLI support today.

## Development

The runner has a hermetic test suite that needs no real Codex — `test/mock-app-server.mjs` replays a captured app-server wire transcript, and the guard matrix is scripted:

```sh
npm test
```

CI runs the suite on Ubuntu and Windows (`.github/workflows/ci.yml`).

## Standalone runner

The runner works outside a Claude session. It performs only the *dispatch* phase (worktrees, Codex turns, verify, one correction, checked commit, transcripts) — review and integration remain the dispatch skill's job:

```sh
node runner/fleet-runner.mjs --batch batch.json
```

The batch is `{repo, codexExe, backend, tasks:[{id, spec, verify?}], model?, effort?, timeoutMinutes?}`; results are written to the run's external output directory.

## Attribution

The app-server transport and sessionful-worker layer under `vendor/dynamic-workflows-codex/` are **vendored verbatim** from [scasella/claude-dynamic-workflows-codex](https://github.com/scasella/claude-dynamic-workflows-codex) (MIT, © Stephen Casella). Their license and provenance are preserved in [`vendor/dynamic-workflows-codex/LICENSE`](vendor/dynamic-workflows-codex/LICENSE) and [`vendor/dynamic-workflows-codex/NOTICE.md`](vendor/dynamic-workflows-codex/NOTICE.md). Codex Fleet claims no authorship of those files.

## License

Released under the [MIT License](LICENSE). Copyright 2026 wenbinio.
Vendored code under `vendor/` retains its own upstream MIT license and copyright (see `vendor/dynamic-workflows-codex/`).

## Runner CLI modes

The standalone runner (`node runner/fleet-runner.mjs`) has four modes:

- `--batch <batch.json>` — run a fleet batch. Prints one `[fleet] <task> <state>` progress line per task transition on stderr, and rewrites `results.json` atomically after each task completes (`complete: false` until the run ends), so an interrupted run always leaves salvageable state. Ctrl-C interrupts active workers cleanly and records unfinished tasks as `interrupted`.
- `--resume <batch.json>` — re-run a batch, skipping tasks already `done` whose branch tip still matches the recorded commit; stale worktrees/branches of non-done tasks are cleaned before re-dispatch.
- `--probe` — verify the app-server backend end-to-end (initialize, model list, one ephemeral read-only turn); used by `setup`.
- `--cleanup <batch.json>` — remove the batch's worktrees (`--delete-branches` additionally deletes unmerged `codex/*` branches). Prints a JSON summary.
