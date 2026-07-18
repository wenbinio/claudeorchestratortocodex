# Codex Fleet

## What it is

Codex Fleet is a Claude Code plugin for running coding tasks through a controlled multi-worker pipeline. Claude plans the work, verifies it, reviews it, and integrates it; Codex `gpt-5.6-sol` writes the code. Workers run in parallel in isolated Git worktrees, and an adversarial reviewer independently re-runs each task's tests before approval.

Seamless staged integration is the flagship behavior and the default `stage` mode: approved work is applied in verdict order, the full project verification runs after each application, and passing changes land as one verified staged diff in your working tree. No fleet commits remain in your history; inspect the diff and commit when ready. Work that conflicts or fails verification is parked on its branch instead of being integrated.

## Observability

Each Codex worker gets a transcript containing its prompt, command timeline and exit statuses, patched files, final message, and usage details. The run report links to each transcript. Sessions also remain visible in the Codex app, and you can interrogate a worker afterward with:

```sh
codex exec resume <sessionId>
```

## Install

Run these commands in Claude Code:

```text
/plugin marketplace add wenbinio/claudeorchestratortocodex
/plugin install codex-fleet@wenbinio
```

## First run

Run setup once per machine, then dispatch work:

```text
/codex-fleet:setup
/codex-fleet:dispatch
```

## Requirements

- Claude Code
- Codex CLI, installed through the desktop app or with `npm i -g @openai/codex`
- A ChatGPT login or an `OPENAI_API_KEY`
- Git

## Cloud sandboxes

Cloud sessions cannot run `/plugin`. Check this exact block into `.claude/settings.json` in every repository that should expose Codex Fleet to claude.ai/code sessions:

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

Add `OPENAI_API_KEY` as an environment secret. Skills and agents load in cloud sandboxes, and hooks (including the merge-guard) run in cloud sessions as well, with `CLAUDE_CODE_REMOTE=true` set there — though cloud guard behavior is on the untested-at-release list below. Without a key, the plugin falls back to Claude subagents implementing the tasks under the same worktree, verification, review, and integration pipeline.

## Merge guard

The merge guard is an advisory seatbelt, not a security boundary. It gates Claude's own shell-tool calls only; it never affects commands you run in your terminal. It matches `git merge` and `git merge --squash` of `codex/*` branches and checks verdicts keyed to the branch tip SHA. A recorded branch whose tip no longer matches its reviewed SHA is blocked as unreviewed because the branch changed after review. Fail-open is limited to unknown repositories, unknown branches, missing or corrupt state, and guard errors. Rebase, cherry-pick, and pull are not matched. The dispatch pipeline's verdict and verification protocol is the real enforcement.

## Costs

Codex worker usage bills to your OpenAI plan. Fleet runs also consume Claude tokens for planning, driver agents, verification, review, and integration.

## Release status

At release, the POSIX driver path, the second-Windows-machine path, and the cloud sandbox surface remain untested by a real run. Those first runs are the validation for those environments; cloud data-directory persistence may require rerunning setup per session.

## v0.3: runner-first lifecycle

v0.3 unifies Codex dispatch on one runner-first lifecycle: worktree creation, Codex turns, quiescence, verification, one correction round, checked commit, and transcript generation follow one code path. App-server and `codex exec` are transport choices behind that lifecycle. The former Workflow-tool engine is retained only as [`docs/reference/v2-workflow-engine.js`](docs/reference/v2-workflow-engine.js); it is a historical reference, not a backend or the normative pipeline contract. Stock installations without Node and Claude-only mode continue through the Agent-tool prose fallback.

## v0.2: app-server backend

When Node >= 18 is present and the runner's app-server capability probe succeeds, `setup` selects the `app-server` backend; otherwise it records the `exec` transport. Instead of one-shot `codex exec` processes, app-server workers run as sessionful Codex threads over the `codex app-server` JSON-RPC transport: no stdin-close hang, no 10-minute shell-timeout ceiling (the runner owns its own timeouts), and correction rounds are follow-up turns on the same warm thread rather than cold re-prompts. The runner works independently of the in-editor Workflow tool.

Standalone, outside a Claude session:

```
node runner/fleet-runner.mjs --batch batch.json
```

The batch is `{repo, codexExe, tasks:[{id,spec,verify?}], model?, effort?, timeoutMinutes?}`; it writes `<repo>/.codex-fleet/results.json`. Review and integration remain the dispatch skill's job — the runner performs only the dispatch phase.

The app-server transport and sessionful-worker layer under `vendor/dynamic-workflows-codex/` are **vendored verbatim** from [scasella/claude-dynamic-workflows-codex](https://github.com/scasella/claude-dynamic-workflows-codex) (MIT, © Stephen Casella). Their license and provenance are preserved in [`vendor/dynamic-workflows-codex/LICENSE`](vendor/dynamic-workflows-codex/LICENSE) and [`NOTICE.md`](vendor/dynamic-workflows-codex/NOTICE.md). Node >= 18 is optional but recommended.

## Architecture

- Two skills: `setup` and `dispatch`
- One runner-first lifecycle with app-server and `codex exec` transports; `docs/reference/v2-workflow-engine.js` is reference-only
- Two agents: `codex-driver` and `fleet-reviewer`
- One merge-guard hook with Windows and POSIX scripts
- Persistent data-directory files: `config.json`, `fleet-log.jsonl`, `approved.json`, and per-worker files under `transcripts/`
- Vendored third-party code under `vendor/` (see its `NOTICE.md`)

## License

Released under the [MIT License](LICENSE). Copyright 2026 wenbinio.
Vendored code under `vendor/` retains its own upstream MIT license and copyright (see `vendor/dynamic-workflows-codex/`).
