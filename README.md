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

Add `OPENAI_API_KEY` as an environment secret. Skills and agents load in cloud sandboxes, but the merge-guard hook is local-only. Without a key, the plugin falls back to Claude subagents implementing the tasks under the same worktree, verification, review, and integration pipeline.

## Merge guard

The merge guard is an advisory seatbelt, not a security boundary. It gates Claude's own shell-tool calls only; it never affects commands you run in your terminal. It matches `git merge` and `git merge --squash` of `codex/*` branches and checks verdicts keyed to the branch tip SHA. Missing or corrupt state, script errors, and SHA mismatches fail open by design. Rebase, cherry-pick, and pull are not matched. The dispatch pipeline's verdict and verification protocol is the real enforcement.

## Costs

Codex worker usage bills to your OpenAI plan. Fleet runs also consume Claude tokens for planning, driver agents, verification, review, and integration.

## Release status

At release, the POSIX driver path, the second-Windows-machine path, and the cloud sandbox surface remain untested by a real run. Those first runs are the validation for those environments; cloud data-directory persistence may require rerunning setup per session.

## Architecture

- Two skills: `setup` and `dispatch`
- One workflow engine: `workflows/codex-fleet.js`
- Two agents: `codex-driver` and `fleet-reviewer`
- One merge-guard hook with Windows and POSIX scripts
- Persistent data-directory files: `config.json`, `fleet-log.jsonl`, `approved.json`, and per-worker files under `transcripts/`

## License

Released under the [MIT License](LICENSE). Copyright 2026 wenbinio.
